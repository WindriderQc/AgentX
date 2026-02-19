/**
 * Model Parameter Detection
 *
 * Parses model names to extract parameter count and quantization,
 * then calculates optimal execution config (num_ctx) based on
 * model size and host VRAM.
 */

const logger = require('../../../config/logger');

/**
 * Parse parameter count from model name or Ollama details.parameter_size
 * @param {string} raw - e.g. "7B", "1.7b", "32b", "70B", or model name containing these
 * @returns {number|null} Parameter count in billions
 */
function parseParameterCount(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  // Direct match: "7B", "1.7b", "32b"
  const direct = s.match(/^(\d+(?:\.\d+)?)\s*b$/);
  if (direct) return parseFloat(direct[1]);
  // Embedded in model name: "qwen2.5:32b-instruct-q4_K_M"
  const embedded = s.match(/[:\-_](\d+(?:\.\d+)?)b(?:[:\-_]|$)/);
  if (embedded) return parseFloat(embedded[1]);
  // Looser: just find NNb pattern anywhere
  const loose = s.match(/(\d+(?:\.\d+)?)b/);
  if (loose) return parseFloat(loose[1]);
  return null;
}

/**
 * Parse quantization level from model name or Ollama details
 * @param {string} raw - e.g. "Q4_K_M", "q5_K_M", "Q4_0", "F16", or full model name
 * @returns {string|null} Normalized quantization string
 */
function parseQuantization(raw) {
  if (!raw) return null;
  const s = String(raw).toUpperCase();
  const match = s.match(/(Q[0-9]+(?:_[A-Z0-9]+)*|F16|F32|FP16|FP32)/);
  return match ? match[1] : null;
}

/**
 * Bytes per parameter for a given quantization
 * @param {string} quant - e.g. "Q4_0", "Q4_K_M", "Q5_K_M", "Q8_0", "F16"
 * @returns {number} Approximate bytes per parameter
 */
function bytesPerParam(quant) {
  if (!quant) return 0.625; // assume Q5-ish if unknown
  const q = quant.toUpperCase();
  if (q.startsWith('Q2')) return 0.3125;
  if (q.startsWith('Q3')) return 0.4375;
  if (q.startsWith('Q4')) return 0.5625;
  if (q.startsWith('Q5')) return 0.6875;
  if (q.startsWith('Q6')) return 0.8125;
  if (q.startsWith('Q7')) return 0.875;
  if (q.startsWith('Q8')) return 1.0;
  if (q === 'F16' || q === 'FP16') return 2.0;
  if (q === 'F32' || q === 'FP32') return 4.0;
  return 0.625;
}

/**
 * Estimate KV cache size in bytes for a given context window
 * Empirical calibration from real measurements:
 *   qwen2.5:32b-Q4_K_M at 32K ctx: ~11GB KV cache (~11 MB per 1K ctx per 1B params)
 *   Smaller models use GQA more efficiently, so we scale down for <10B
 * @param {number} paramBillions - Parameter count in billions
 * @param {number} numCtx - Context window size
 * @returns {number} Estimated KV cache bytes
 */
function estimateKvCacheBytes(paramBillions, numCtx) {
  if (!Number.isFinite(paramBillions) || paramBillions <= 0) return 0;
  if (!Number.isFinite(numCtx) || numCtx <= 0) return 0;
  // Empirical: ~10 MB per 1K context per 1B params for larger models
  // Scale down for small models (GQA is more effective)
  // 70B+ models use larger KV head dimensions
  const mbPerKCtxPerB = paramBillions >= 70 ? 15 : paramBillions >= 30 ? 10 : paramBillions >= 10 ? 6 : 3;
  return paramBillions * (numCtx / 1024) * mbPerKCtxPerB * 1024 * 1024;
}

/**
 * Estimate total VRAM needed (model weights + KV cache)
 * @param {number} paramBillions
 * @param {string} quantization
 * @param {number} numCtx
 * @returns {number} Total bytes
 */
function estimateTotalVram(paramBillions, quantization, numCtx) {
  if (!Number.isFinite(paramBillions) || paramBillions <= 0) return Infinity;
  const weightBytes = paramBillions * 1e9 * bytesPerParam(quantization);
  const kvBytes = estimateKvCacheBytes(paramBillions, numCtx);
  // Add ~10% overhead for runtime buffers
  return (weightBytes + kvBytes) * 1.1;
}

/**
 * Detect optimal num_ctx for a model on a given host
 * @param {object} params
 * @param {string} params.parameterSize - e.g. "7B" or "32B"
 * @param {string} params.quantization - e.g. "Q4_K_M"
 * @param {number|null} params.modelSizeBytes - From Ollama /api/tags (weights on disk)
 * @param {number|null} params.hostVramMiB - Total GPU VRAM in MiB (null if unknown)
 * @returns {{ num_ctx: number, reason: string }}
 */
function detectOptimalNumCtx({ parameterSize, quantization, modelSizeBytes, hostVramMiB }) {
  const paramB = parseParameterCount(parameterSize);

  // If we have VRAM info, calculate dynamically
  if (paramB && hostVramMiB) {
    const vramBytes = hostVramMiB * 1024 * 1024;
    const budget = vramBytes * 0.90; // 90% target utilization
    // Try context sizes from large to small
    const candidates = [65536, 32768, 16384, 8192, 4096, 2048];
    for (const ctx of candidates) {
      const needed = estimateTotalVram(paramB, quantization, ctx);
      if (needed <= budget) {
        return {
          num_ctx: ctx,
          reason: `${paramB}B ${quantization || '?'} on ${hostVramMiB}MiB VRAM → ${ctx} ctx (${Math.round(needed / 1024 / 1024)}MiB / ${hostVramMiB}MiB)`
        };
      }
    }
    return {
      num_ctx: 2048,
      reason: `${paramB}B ${quantization || '?'} too large for ${hostVramMiB}MiB VRAM → minimum 2048 ctx`
    };
  }

  // Fallback: lookup table based on parameter count alone
  if (paramB) {
    const table = [
      { maxB: 3,   ctx: 32768 },
      { maxB: 10,  ctx: 16384 },
      { maxB: 30,  ctx: 8192 },
      { maxB: 70,  ctx: 4096 },
      { maxB: Infinity, ctx: 2048 }
    ];
    const entry = table.find(t => paramB <= t.maxB);
    return {
      num_ctx: entry.ctx,
      reason: `${paramB}B model → ${entry.ctx} ctx (lookup table, VRAM unknown)`
    };
  }

  // Last resort: use modelSizeBytes as rough indicator
  if (modelSizeBytes) {
    const sizeGB = modelSizeBytes / (1024 * 1024 * 1024);
    if (sizeGB < 5) return { num_ctx: 16384, reason: `${sizeGB.toFixed(1)}GB model → 16384 ctx (size-based estimate)` };
    if (sizeGB < 15) return { num_ctx: 8192, reason: `${sizeGB.toFixed(1)}GB model → 8192 ctx (size-based estimate)` };
    if (sizeGB < 40) return { num_ctx: 4096, reason: `${sizeGB.toFixed(1)}GB model → 4096 ctx (size-based estimate)` };
    return { num_ctx: 2048, reason: `${sizeGB.toFixed(1)}GB model → 2048 ctx (size-based estimate)` };
  }

  return { num_ctx: 8192, reason: 'No model info available → system default 8192' };
}

/**
 * Infer vendor from model name
 * @param {string} modelName
 * @param {string|null} family - Ollama details.family
 * @returns {string}
 */
function inferVendor(modelName, family) {
  const name = (modelName + ' ' + (family || '')).toLowerCase();
  if (name.includes('qwen')) return 'alibaba';
  if (name.includes('llama')) return 'meta';
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('mistral') || name.includes('mixtral')) return 'mistral';
  if (name.includes('gemma')) return 'google';
  if (name.includes('phi')) return 'microsoft';
  if (name.includes('nomic') || name.includes('mxbai') || name.includes('smollm')) return 'community';
  return 'unknown';
}

/**
 * Generate a human-readable display name from a model name
 * @param {string} modelName - e.g. "qwen2.5:32b-instruct-q4_K_M"
 * @returns {string}
 */
function generateDisplayName(modelName) {
  return String(modelName).replace(/:/g, ' ').replace(/-/g, ' ').replace(/_/g, ' ')
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

module.exports = {
  parseParameterCount,
  parseQuantization,
  bytesPerParam,
  estimateKvCacheBytes,
  estimateTotalVram,
  detectOptimalNumCtx,
  inferVendor,
  generateDisplayName
};
