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
const {
  parseParameterCount,
  parseQuantization,
  detectOptimalNumCtx,
  inferVendor,
  generateDisplayName
} = require('./parameterDetection');

/**
 * Get list of configured Ollama hosts from env
 * @returns {string[]}
 */
function getOllamaHosts() {
  return [
    process.env.OLLAMA_HOST,
    process.env.OLLAMA_HOST_SECONDARY || process.env.OLLAMA_HOST_2,
    process.env.OLLAMA_HOST_TERTIARY || process.env.OLLAMA_HOST_3
  ].filter(Boolean);
}

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
    if (result.ok && result.memoryTotalMiBTotal > 0) {
      return result.memoryTotalMiBTotal;
    }
  } catch (err) {
    logger.info('VRAM detection unavailable for host (using lookup table)', { hostUrl, error: err.message });
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
    // Update source metadata
    let changed = false;
    const updates = {};

    if (existing.sourceHost !== hostUrl) { updates.sourceHost = hostUrl; changed = true; }
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

    // Re-detect execution defaults if not user-overridden
    const hasUserOverride = existing.executionOverrides?.num_ctx != null;
    const currentSource = existing.executionDefaults?._source;
    if (!hasUserOverride && currentSource !== 'user') {
      const detection = detectOptimalNumCtx({
        parameterSize,
        quantization,
        modelSizeBytes: ollamaModel.size,
        hostVramMiB
      });
      const currentCtx = existing.executionDefaults?.num_ctx;
      if (currentCtx !== detection.num_ctx) {
        updates['executionDefaults.num_ctx'] = detection.num_ctx;
        updates['executionDefaults._source'] = 'auto';
        updates['executionDefaults._reason'] = detection.reason;
        updates['executionDefaults._detectedAt'] = new Date();
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
      _detectedAt: new Date()
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
  const hosts = getOllamaHosts();
  if (hosts.length === 0) {
    logger.warn('No Ollama hosts configured, skipping registry sync');
    return { created: 0, updated: 0, retired: 0, unchanged: 0, errors: ['No Ollama hosts configured'] };
  }

  const stats = { created: 0, updated: 0, retired: 0, unchanged: 0, errors: [] };
  const allSeenModels = new Set();

  for (const hostUrl of hosts) {
    try {
      logger.info('Syncing models from Ollama host', { hostUrl });

      const [models, hostVramMiB] = await Promise.all([
        fetchHostModels(hostUrl),
        getHostVramMiB(hostUrl)
      ]);

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

  // Retire Ollama-sourced models not seen on any host
  try {
    const toRetire = await ModelRegistry.find({
      sourceType: 'ollama',
      status: { $ne: 'retired' },
      modelName: { $nin: Array.from(allSeenModels) }
    });

    for (const model of toRetire) {
      await ModelRegistry.updateOne(
        { _id: model._id },
        {
          $set: {
            status: 'retired',
            isActive: false,
            lastUpdated: new Date(),
            notes: (model.notes || '') + `\nRetired by auto-sync: ${new Date().toISOString()} — not found on any host`
          }
        }
      );
      stats.retired++;
      logger.info('Retired model not found on any host', { modelName: model.modelName });
    }
  } catch (err) {
    logger.error('Failed to retire missing models', { error: err.message });
    stats.errors.push(`retire: ${err.message}`);
  }

  logger.info('Model registry sync complete', stats);
  return stats;
}

module.exports = {
  syncAllHosts,
  syncModel,
  fetchHostModels,
  getOllamaHosts,
  getHostVramMiB
};
