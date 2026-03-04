/**
 * Model Sync Orchestrator
 *
 * Discovers models from Ollama hosts and syncs them into the ModelRegistry.
 * Auto-detects per-model execution defaults (num_ctx) based on model size + host VRAM.
 *
 * Called on:
 * 1. Server startup (non-fatal if fails)
 * 2. Manual trigger via POST /api/models/registry/sync
 */

const ModelRegistry = require('../../../models/ModelRegistry');
const ollamaVramService = require('../ollamaVramService');
const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { getHostUrls } = require('../../helpers/ollamaHostConfig');
const {
  parseParameterCount,
  parseQuantization,
  detectOptimalNumCtx,
  inferVendor,
  generateDisplayName
} = require('./parameterDetection');
const { probeModelContext, getConfig: getProbeConfig } = require('../contextProbe/contextProbeService');

/** @type {boolean} Guard against concurrent syncAllHosts calls */
let _syncing = false;

/**
 * Fetch model list from a single Ollama host
 * @param {string} hostUrl - e.g. "http://192.168.2.66:11434"
 * @returns {Promise<Array>} Array of Ollama model objects
 */
async function fetchHostModels(hostUrl) {
  const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
  const response = await fetch(`${hostUrl}/api/tags`, {
    timeout: 10000,
    ...getFetchOptions(hostUrl)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${hostUrl}`);
  }
  const data = await response.json();
  return Array.isArray(data.models) ? data.models : [];
}

/**
 * Get total VRAM (MiB) for a host, or null if unavailable
 * @param {string} hostUrl
 * @returns {Promise<number|null>}
 */
async function getHostVramMiB(hostUrl) {
  try {
    const result = await ollamaVramService.getHostVram(hostUrl);
    const source = result._source || (result.ok ? 'ssh-nvidia-smi' : 'unknown');

    if (result.ok && result.memoryTotalMiBTotal > 0) {
      logger.info('VRAM detected for host', { hostUrl, vramMiB: result.memoryTotalMiBTotal, source });
      return result.memoryTotalMiBTotal;
    }

    logger.warn('VRAM unknown for host — models will use conservative context defaults. Set OLLAMA_HOST_VRAM_MAP or configure in VRAM panel.', {
      hostUrl, source, error: result.error || 'no VRAM data'
    });
  } catch (err) {
    logger.warn('VRAM detection failed for host — models will use conservative context defaults', { hostUrl, error: err.message });
  }
  return null;
}

/**
 * Sync a single model into the registry
 * @param {object} ollamaModel - Model object from Ollama /api/tags
 * @param {string} hostUrl - Host URL where this model lives
 * @param {number|null} hostVramMiB - Host VRAM in MiB
 * @returns {Promise<'created'|'updated'|'unchanged'>}
 */
async function syncModel(ollamaModel, hostUrl, hostVramMiB) {
  // Normalize: strip ":latest" tag since Ollama reports it inconsistently
  const modelName = ollamaModel.name.replace(/:latest$/, '');
  const details = ollamaModel.details || {};
  const parameterSize = details.parameter_size || null;
  const quantization = details.quantization_level || null;
  const family = details.family || null;

  const existing = await ModelRegistry.findOne({ modelName });

  if (existing) {
    let changed = false;
    const updates = {};

    // Only update sourceHost if this host has more VRAM (better for num_ctx calc),
    // or if the current sourceHost is no longer reachable (will be caught by retirement).
    const existingVram = existing.executionDefaults?._hostVramMiB || 0;
    if (existing.sourceHost !== hostUrl && (hostVramMiB || 0) >= existingVram) {
      updates.sourceHost = hostUrl;
      changed = true;
    }
    if (existing.ollamaDigest !== ollamaModel.digest) { updates.ollamaDigest = ollamaModel.digest; changed = true; }
    if (existing.modelSizeBytes !== ollamaModel.size) { updates.modelSizeBytes = ollamaModel.size; changed = true; }
    if (existing.parameterSize !== parameterSize) { updates.parameterSize = parameterSize; changed = true; }
    if (existing.quantization !== quantization) { updates.quantization = quantization; changed = true; }
    if (existing.family !== family) { updates.family = family; changed = true; }

    // Always update lastSeenAt
    updates.lastSeenAt = new Date();
    // Ensure source type is set
    if (existing.sourceType !== 'ollama') { updates.sourceType = 'ollama'; changed = true; }
    // Re-activate if was retired
    if (existing.status === 'retired') {
      updates.status = 'active';
      updates.isActive = true;
      changed = true;
    }

    // Re-detect execution defaults if not user-overridden.
    // Use the best VRAM available (current host vs stored host VRAM).
    const hasUserOverride = existing.executionOverrides?.num_ctx != null;
    const currentSource = existing.executionDefaults?._source;
    const bestVram = Math.max(hostVramMiB || 0, existingVram) || null;
    if (!hasUserOverride && currentSource !== 'user') {
      const detection = detectOptimalNumCtx({
        parameterSize,
        quantization,
        modelSizeBytes: ollamaModel.size,
        hostVramMiB: bestVram
      });
      const currentCtx = existing.executionDefaults?.num_ctx;
      if (currentCtx !== detection.num_ctx) {
        updates['executionDefaults.num_ctx'] = detection.num_ctx;
        updates['executionDefaults._source'] = 'auto';
        updates['executionDefaults._reason'] = detection.reason;
        updates['executionDefaults._detectedAt'] = new Date();
        updates['executionDefaults._hostVramMiB'] = bestVram;
        changed = true;
      }
    }

    if (changed) {
      updates.lastUpdated = new Date();
      await ModelRegistry.updateOne({ modelName }, { $set: updates });
      return 'updated';
    }
    // Still update lastSeenAt even if nothing else changed
    await ModelRegistry.updateOne({ modelName }, { $set: { lastSeenAt: new Date() } });
    return 'unchanged';
  }

  // Create new entry
  const detection = detectOptimalNumCtx({
    parameterSize,
    quantization,
    modelSizeBytes: ollamaModel.size,
    hostVramMiB
  });

  const vendor = inferVendor(modelName, family);
  const displayName = generateDisplayName(modelName);

  await ModelRegistry.create({
    modelName,
    displayName,
    vendor,
    description: '',
    sourceType: 'ollama',
    sourceHost: hostUrl,
    host: hostUrl,
    ollamaDigest: ollamaModel.digest,
    lastSeenAt: new Date(),
    modelSizeBytes: ollamaModel.size,
    parameterSize,
    quantization,
    family,
    categories: [],
    tags: [],
    capabilities: {
      maxContext: detection.num_ctx,
      supportsThinking: /qwen|deepseek/.test(modelName.toLowerCase())
    },
    executionDefaults: {
      num_ctx: detection.num_ctx,
      _source: 'auto',
      _reason: detection.reason,
      _detectedAt: new Date(),
      _hostVramMiB: hostVramMiB || null
    },
    status: 'active',
    isActive: true,
    createdBy: 'auto-sync'
  });

  return 'created';
}

/**
 * Sync all configured Ollama hosts into the registry
 * @returns {Promise<{created: number, updated: number, retired: number, unchanged: number, errors: string[]}>}
 */
async function syncAllHosts() {
  if (_syncing) {
    logger.warn('syncAllHosts already in progress, skipping');
    return { created: 0, updated: 0, retired: 0, unchanged: 0, errors: ['Sync already in progress'] };
  }

  const hosts = getHostUrls();
  if (hosts.length === 0) {
    logger.warn('No Ollama hosts configured, skipping registry sync');
    return { created: 0, updated: 0, retired: 0, unchanged: 0, errors: ['No Ollama hosts configured'] };
  }

  _syncing = true;
  const stats = { created: 0, updated: 0, retired: 0, unchanged: 0, errors: [] };
  const allSeenModels = new Set();
  const successfulHosts = new Set();

  try {
    for (const hostUrl of hosts) {
      try {
        logger.info('Syncing models from Ollama host', { hostUrl });

        const [models, hostVramMiB] = await Promise.all([
          fetchHostModels(hostUrl),
          getHostVramMiB(hostUrl)
        ]);

        successfulHosts.add(hostUrl);

        logger.info('Discovered models on host', {
          hostUrl,
          count: models.length,
          hostVramMiB: hostVramMiB || 'unknown'
        });

        for (const model of models) {
          try {
            allSeenModels.add(model.name.replace(/:latest$/, ''));
            const result = await syncModel(model, hostUrl, hostVramMiB);
            stats[result]++;
          } catch (err) {
            logger.error('Failed to sync model', { model: model.name, hostUrl, error: err.message });
            stats.errors.push(`${model.name}@${hostUrl}: ${err.message}`);
          }
        }
      } catch (err) {
        logger.error('Failed to fetch models from host', { hostUrl, error: err.message });
        stats.errors.push(`${hostUrl}: ${err.message}`);
      }
    }

    // Retire Ollama-sourced models not seen on any reachable host.
    // Only retire models whose sourceHost was successfully queried —
    // if a host is unreachable, its models are left untouched.
    try {
      if (successfulHosts.size === 0) {
        logger.warn('No hosts responded — skipping retirement to avoid false retirements');
      } else {
        const retireQuery = {
          sourceType: 'ollama',
          status: { $ne: 'retired' },
          modelName: { $nin: Array.from(allSeenModels) },
          sourceHost: { $in: Array.from(successfulHosts) }
        };

        const toRetire = await ModelRegistry.find(retireQuery);

        for (const model of toRetire) {
          await ModelRegistry.updateOne(
            { _id: model._id },
            {
              $set: {
                status: 'retired',
                isActive: false,
                lastUpdated: new Date(),
                notes: (model.notes || '') + `\nRetired by auto-sync: ${new Date().toISOString()} — not found on host ${model.sourceHost}`
              }
            }
          );
          stats.retired++;
          logger.info('Retired model not found on its source host', { modelName: model.modelName, sourceHost: model.sourceHost });
        }
      }
    } catch (err) {
      logger.error('Failed to retire missing models', { error: err.message });
      stats.errors.push(`retire: ${err.message}`);
    }

    // Auto-probe newly created models if enabled (sequential, fire-and-forget)
    if (stats.created > 0 && getProbeConfig().autoProbeOnSync) {
      const newModels = await ModelRegistry.find({
        sourceType: 'ollama',
        status: 'active',
        'contextTest.status': null,
        createdBy: 'auto-sync'
      }).select('modelName').lean();

      if (newModels.length > 0) {
        logger.info('Auto-probe queued for newly synced models', { count: newModels.length });
        // Run probes sequentially in background to avoid GPU saturation
        (async () => {
          for (const m of newModels) {
            try {
              logger.info('Auto-probing model', { modelName: m.modelName });
              await probeModelContext(m.modelName);
            } catch (err) {
              logger.warn('Auto-probe failed for model', { modelName: m.modelName, error: err.message });
            }
          }
          logger.info('Auto-probe batch complete', { count: newModels.length });
        })().catch(() => {});
      }
    }

    logger.info('Model registry sync complete', stats);
    return stats;
  } finally {
    _syncing = false;
  }
}

module.exports = {
  syncAllHosts,
  syncModel,
  fetchHostModels,
  getHostVramMiB
};
