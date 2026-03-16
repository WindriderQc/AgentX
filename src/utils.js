// Helper to sanitize Ollama options
function sanitizeOptions(options = {}) {
  const numericKeys = [
    'temperature', 'top_k', 'top_p', 'num_ctx', 'repeat_penalty',
    'presence_penalty', 'frequency_penalty', 'seed', 'num_predict',
    'typical_p', 'tfs_z', 'mirostat', 'mirostat_eta', 'mirostat_tau'
  ];
  const clean = {};
  numericKeys.forEach((key) => {
    if (options[key] === 0 || options[key]) {
      const parsed = Number(options[key]);
      if (!Number.isNaN(parsed)) clean[key] = parsed;
    }
  });
  if (Array.isArray(options.stop)) clean.stop = options.stop;
  else if (typeof options.stop === 'string' && options.stop.trim()) {
    clean.stop = options.stop.split(',').map((val) => val.trim()).filter(Boolean);
  }
  if (options.keep_alive) clean.keep_alive = options.keep_alive;
  return clean;
}

// Resolve Ollama Target
function resolveTarget(target) {
    const envHost = process.env.OLLAMA_HOST;
    if (!target || typeof target !== 'string') {
        if (envHost) return envHost.replace(/\/+$/, '');
        throw new Error('Ollama host not configured (OLLAMA_HOST env var missing) and no target provided');
    }
    const trimmed = target.trim();
    if (!trimmed) {
        if (envHost) return envHost.replace(/\/+$/, '');
        throw new Error('Ollama host not configured (OLLAMA_HOST env var missing) and no target provided');
    }
    if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
    return `http://${trimmed.replace(/\/+$/, '')}`;
}

/**
 * Resolve num_ctx details for a model, aware of the target host's VRAM.
 *
 * Priority:
 *   1. User override from registry (always wins)
 *   2. Dynamic VRAM-based calculation for the target host
 *   3. Verified context probe result
 *   4. Registry auto-detected default
 *   5. Fallback (8192)
 *
 * @param {string} modelName
 * @param {object} [opts]
 * @param {string} [opts.targetHost] - Ollama host URL the request will be sent to
 * @param {number} [opts.fallback=8192]
 * @returns {Promise<{ num_ctx: number, source: string, targetHost: string|null }>}
 */
async function resolveModelNumCtxDetails(modelName, opts = {}) {
  const fallback = typeof opts === 'number' ? opts : (opts.fallback || 8192);
  const targetHost = typeof opts === 'object' ? opts.targetHost : undefined;

  if (!modelName) {
    return {
      num_ctx: fallback,
      source: 'fallback',
      targetHost: targetHost || null
    };
  }
  try {
    const ModelRegistry = require('../models/ModelRegistry');
    const entry = await ModelRegistry.findOne({ modelName: modelName.replace(/:latest$/, '') })
      .select('executionOverrides executionDefaults parameterSize quantization modelSizeBytes sourceHost contextTest')
      .lean();
    if (!entry) {
      return {
        num_ctx: fallback,
        source: 'fallback',
        targetHost: targetHost || null
      };
    }

    const overrides = entry.executionOverrides || {};
    // User override always wins
    if (overrides.num_ctx != null) {
      return {
        num_ctx: overrides.num_ctx,
        source: 'override',
        targetHost: targetHost || null
      };
    }

    const defaults = entry.executionDefaults || {};
    const ct = entry.contextTest || {};

    // Verified context test result (host-agnostic proven value)
    const testedCtx = (ct.testedNumCtx != null && ct.status === 'completed') ? ct.testedNumCtx : null;

    // If target host differs from source host, recalculate for target VRAM
    if (targetHost && entry.sourceHost && targetHost !== entry.sourceHost) {
      try {
        const ollamaVramService = require('./services/ollamaVramService');
        const vramResult = await ollamaVramService.getHostVram(targetHost);
        if (vramResult.ok && vramResult.memoryTotalMiBTotal > 0) {
          const { detectOptimalNumCtx } = require('./services/modelSync/parameterDetection');
          const detection = detectOptimalNumCtx({
            parameterSize: entry.parameterSize,
            quantization: entry.quantization,
            modelSizeBytes: entry.modelSizeBytes,
            hostVramMiB: vramResult.memoryTotalMiBTotal
          });
          return {
            num_ctx: detection.num_ctx,
            source: 'target_host_vram_estimate',
            targetHost
          };
        }
      } catch { /* fall through to registry default */ }
    }

    if (testedCtx != null) {
      return {
        num_ctx: testedCtx,
        source: 'context_test',
        targetHost: targetHost || null
      };
    }

    if (defaults.num_ctx != null) {
      return {
        num_ctx: defaults.num_ctx,
        source: 'execution_default',
        targetHost: targetHost || null
      };
    }

    return {
      num_ctx: fallback,
      source: 'fallback',
      targetHost: targetHost || null
    };
  } catch {
    return {
      num_ctx: fallback,
      source: 'fallback',
      targetHost: targetHost || null
    };
  }
}

/**
 * Resolve num_ctx for a model, aware of the target host's VRAM.
 *
 * @param {string} modelName
 * @param {object} [opts]
 * @param {string} [opts.targetHost]
 * @param {number} [opts.fallback=8192]
 * @returns {Promise<number>}
 */
async function resolveModelNumCtx(modelName, opts = {}) {
  const details = await resolveModelNumCtxDetails(modelName, opts);
  return details.num_ctx;
}

module.exports = {
  sanitizeOptions,
  resolveTarget,
  resolveModelNumCtx,
  resolveModelNumCtxDetails
};
