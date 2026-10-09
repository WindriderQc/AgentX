'use strict';

/**
 * KV cache size from a model's own metadata (Ollama `/api/show` model_info,
 * i.e. its GGUF keys), for fit estimates (#368).
 *
 * Per token, each attention layer stores one key and one value vector per KV
 * head: sum over attention layers of kvHeads × (keyLength + valueLength)
 * elements, times the bytes per element of the server's KV cache type.
 * Grouped-query attention is read from the KV head count, hybrid models count
 * only their full-attention layers, and per-layer arrays are summed as given.
 * The fixed recurrent state of hybrid layers does not grow with context and is
 * not counted. Ollama allocates this per request slot, so a fit multiplies it
 * by the context and by the slots the model actually gets.
 *
 * When the metadata cannot describe the cache (missing keys, latent
 * attention), the result is null and callers fall back to their rule of
 * thumb, saying so. Sliding-window layers are counted at full context, so
 * the estimate is then an upper bound, also said.
 */

// Bytes per cached element by OLLAMA_KV_CACHE_TYPE (ggml block sizes: q8_0
// stores 32 values in 34 bytes, q4_0 in 18).
const KV_CACHE_TYPE_BYTES = Object.freeze({ f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 });
const DEFAULT_KV_CACHE_TYPE = 'f16';

// Runtime default when a hybrid model's GGUF omits full_attention_interval
// (Ollama and llama.cpp read it with this default for these architectures).
const HYBRID_DEFAULT_INTERVAL = Object.freeze({ qwen3next: 4, qwen35: 4, qwen35moe: 4 });

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeIntegers(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const numbers = values.map(Number);
  return numbers.every(value => Number.isSafeInteger(value) && value >= 0) ? numbers : null;
}

/** Normalize an OLLAMA_KV_CACHE_TYPE value; unknown or unset reads as null. */
function normalizeKvCacheType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(KV_CACHE_TYPE_BYTES, type) ? type : null;
}

function attentionLayout(info, arch, blocks) {
  const kvHeadKey = `${arch}.attention.head_count_kv`;
  const perLayer = nonNegativeIntegers(info[kvHeadKey]);
  if (perLayer) {
    // A per-layer array: 0 marks a layer without attention (recurrent).
    const layers = perLayer.filter(heads => heads > 0);
    return layers.length
      ? { attentionLayers: layers.length, kvHeadLayers: layers.reduce((sum, heads) => sum + heads, 0), layout: 'per_layer_array' }
      : null;
  }
  const kvHeads = positiveInteger(info[kvHeadKey]) || positiveInteger(info[`${arch}.attention.head_count`]);
  if (!kvHeads) return null;
  const explicitInterval = positiveInteger(info[`${arch}.full_attention_interval`]);
  const interval = explicitInterval || HYBRID_DEFAULT_INTERVAL[arch] || null;
  if (interval) {
    const attentionLayers = Math.floor(blocks / interval);
    if (!attentionLayers) return null;
    return {
      attentionLayers,
      kvHeadLayers: attentionLayers * kvHeads,
      layout: explicitInterval ? 'hybrid_interval' : 'hybrid_interval_architecture_default',
      fullAttentionInterval: interval,
    };
  }
  return { attentionLayers: blocks, kvHeadLayers: blocks * kvHeads, layout: 'dense' };
}

/**
 * Describe the KV cache of one model.
 * @param {object} modelInfo - Ollama `/api/show` model_info
 * @param {{ kvCacheType?: string }} [options] - the server's OLLAMA_KV_CACHE_TYPE when known
 * @returns {object|null} bytesPerToken and how it was derived, or null
 */
function describeKvCache(modelInfo, { kvCacheType } = {}) {
  const info = modelInfo && typeof modelInfo === 'object' ? modelInfo : {};
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'].trim() : '';
  if (!arch) return null;
  // Multi-head latent attention caches a compressed vector; not modelled here.
  if (info[`${arch}.attention.kv_lora_rank`] != null) return null;
  const blocks = positiveInteger(info[`${arch}.block_count`]);
  if (!blocks) return null;
  const layout = attentionLayout(info, arch, blocks);
  if (!layout) return null;
  const headCount = positiveInteger(info[`${arch}.attention.head_count`]);
  const embedding = positiveInteger(info[`${arch}.embedding_length`]);
  const keyLength = positiveInteger(info[`${arch}.attention.key_length`])
    || (headCount && embedding && embedding % headCount === 0 ? embedding / headCount : null);
  const valueLength = positiveInteger(info[`${arch}.attention.value_length`]) || keyLength;
  if (!keyLength || !valueLength) return null;

  const knownType = normalizeKvCacheType(kvCacheType);
  const type = knownType || DEFAULT_KV_CACHE_TYPE;
  const elementsPerToken = layout.kvHeadLayers * (keyLength + valueLength);
  const slidingWindow = positiveInteger(info[`${arch}.attention.sliding_window`]);
  return {
    basis: 'model_info',
    architecture: arch,
    bytesPerToken: elementsPerToken * KV_CACHE_TYPE_BYTES[type],
    kvCacheType: type,
    kvCacheTypeSource: knownType ? 'observed' : 'ollama_default_assumed',
    blockCount: blocks,
    ...layout,
    keyLength,
    valueLength,
    ...(slidingWindow && { slidingWindow, upperBound: true, note: 'sliding_window_layers_counted_at_full_context' }),
  };
}

/** KV bytes for `numCtx` tokens in each of `requestSlots` slots, or null. */
function kvCacheBytes(descriptor, numCtx, requestSlots = 1) {
  const bytesPerToken = Number(descriptor?.bytesPerToken);
  const tokens = positiveInteger(numCtx);
  const slots = positiveInteger(requestSlots);
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0 || !tokens || !slots) return null;
  return bytesPerToken * tokens * slots;
}

module.exports = {
  DEFAULT_KV_CACHE_TYPE,
  KV_CACHE_TYPE_BYTES,
  describeKvCache,
  kvCacheBytes,
  normalizeKvCacheType,
};
