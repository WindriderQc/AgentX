'use strict';

/**
 * Shared model metadata and VRAM-estimation primitives.
 *
 * These functions describe artifacts and estimate memory use. They do not
 * choose a runtime context window: runtime context comes from an operator pin,
 * the deployed Modelfile/model metadata, or a measured host/model profile.
 */

const { kvCacheBytes } = require('./kvCacheEstimate');

function parseParameterCount(raw) {
  if (!raw) return null;
  const value = String(raw).toLowerCase();
  const direct = value.match(/^(\d+(?:\.\d+)?)\s*b$/);
  if (direct) return parseFloat(direct[1]);
  const embedded = value.match(/[:\-_](\d+(?:\.\d+)?)b(?:[:\-_]|$)/);
  if (embedded) return parseFloat(embedded[1]);
  const loose = value.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?:[^a-z]|$)/);
  return loose ? parseFloat(loose[1]) : null;
}

function parseQuantization(raw) {
  if (!raw) return null;
  const match = String(raw).toUpperCase().match(/(Q[0-9]+(?:_[A-Z0-9]+)*|F16|F32|FP16|FP32)/);
  return match ? match[1] : null;
}

function bytesPerParam(quant) {
  if (!quant) return 0.625;
  const normalized = String(quant).toUpperCase();
  if (normalized.startsWith('Q2')) return 0.3125;
  if (normalized.startsWith('Q3')) return 0.4375;
  if (normalized.startsWith('Q4')) return 0.5625;
  if (normalized.startsWith('Q5')) return 0.6875;
  if (normalized.startsWith('Q6')) return 0.8125;
  if (normalized.startsWith('Q7')) return 0.875;
  if (normalized.startsWith('Q8')) return 1.0;
  if (normalized === 'F16' || normalized === 'FP16') return 2.0;
  if (normalized === 'F32' || normalized === 'FP32') return 4.0;
  return 0.625;
}

/**
 * Estimate KV cache and compute-buffer bytes at a caller-selected context.
 * This is a fit estimate, not a context recommendation.
 *
 * The <30B base factor is deliberately 55 MiB/B/1K, not the roughly 78
 * MiB/B/1K slope observed in total allocation: estimateTotalVram separately
 * applies tiered overhead to weights plus this estimate. Using 78 here would
 * count that overhead twice. The paired factors and measurements are locked by
 * parameterDetectionVramBacktest.test.js.
 */
function ruleOfThumbKvBytes(paramBillions, numCtx) {
  const mbPerKCtxPerB = paramBillions >= 70 ? 45 : paramBillions >= 30 ? 35 : 55;
  return paramBillions * (numCtx / 1024) * mbPerKCtxPerB * 1024 * 1024;
}

/**
 * With `kvCache` (shared/kvCacheEstimate.js describeKvCache), the model's own
 * metadata sets the KV size, times `requestSlots` (Ollama allocates the
 * context once per slot). Without it, the rule of thumb above applies; its
 * calibration point matches a dense 8B at about four slots.
 */
function estimateKvCacheBytes(paramBillions, numCtx, { kvCache = null, requestSlots = 1 } = {}) {
  if (!Number.isFinite(numCtx) || numCtx <= 0) return 0;
  const exact = kvCacheBytes(kvCache, numCtx, requestSlots);
  if (exact != null) return exact;
  if (!Number.isFinite(paramBillions) || paramBillions <= 0) return 0;
  return ruleOfThumbKvBytes(paramBillions, numCtx);
}

/** Weights, KV and tiered overhead, with the basis of the KV term. */
function estimateVramBreakdown(paramBillions, quantization, numCtx, options = {}) {
  if (!Number.isFinite(paramBillions) || paramBillions <= 0) return null;
  const weightBytes = paramBillions * 1e9 * bytesPerParam(quantization);
  const kvFromModel = kvCacheBytes(options.kvCache, numCtx, options.requestSlots ?? 1) != null;
  const kvBytes = estimateKvCacheBytes(paramBillions, numCtx, options);
  const overheadPct = numCtx >= 32768 ? 0.30 : numCtx >= 16384 ? 0.20 : 0.10;
  return {
    weightBytes,
    kvBytes,
    overheadBytes: (weightBytes + kvBytes) * overheadPct,
    totalBytes: (weightBytes + kvBytes) * (1 + overheadPct),
    kvBasis: kvFromModel ? 'model_info' : 'parameter_rule_of_thumb',
    requestSlots: kvFromModel ? Number(options.requestSlots ?? 1) : null,
  };
}

function estimateTotalVram(paramBillions, quantization, numCtx, options = {}) {
  return estimateVramBreakdown(paramBillions, quantization, numCtx, options)?.totalBytes ?? Infinity;
}

function inferVendor(modelName, family) {
  const name = `${modelName || ''} ${family || ''}`.toLowerCase();
  if (name.includes('qwen')) return 'alibaba';
  if (name.includes('llama')) return 'meta';
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('mistral') || name.includes('mixtral')) return 'mistral';
  if (name.includes('gemma')) return 'google';
  if (name.includes('phi')) return 'microsoft';
  if (name.includes('nomic') || name.includes('mxbai') || name.includes('smollm')) return 'community';
  return 'unknown';
}

function generateDisplayName(modelName) {
  return String(modelName).replace(/:/g, ' ').replace(/-/g, ' ').replace(/_/g, ' ')
    .split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

module.exports = {
  parseParameterCount,
  parseQuantization,
  bytesPerParam,
  estimateKvCacheBytes,
  estimateTotalVram,
  estimateVramBreakdown,
  inferVendor,
  generateDisplayName
};
