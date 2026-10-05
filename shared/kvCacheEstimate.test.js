'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeKvCache, kvCacheBytes, normalizeKvCacheType } = require('./kvCacheEstimate');

const KIB = 1024;
const GIB = 1024 ** 3;

// Hybrid 27B (Qwen 3.5 family): 64 blocks, one full-attention layer in four.
const HYBRID_27B = Object.freeze({
  'general.architecture': 'qwen35',
  'qwen35.block_count': 64,
  'qwen35.embedding_length': 5120,
  'qwen35.attention.head_count': 24,
  'qwen35.attention.head_count_kv': 4,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.full_attention_interval': 4,
});

test('a hybrid 27B costs 64 KiB per token in f16 and 34 KiB in q8_0', () => {
  const f16 = describeKvCache(HYBRID_27B);
  assert.equal(f16.bytesPerToken, 64 * KIB);
  assert.deepEqual(
    { layers: f16.attentionLayers, layout: f16.layout, type: f16.kvCacheType, source: f16.kvCacheTypeSource },
    { layers: 16, layout: 'hybrid_interval', type: 'f16', source: 'ollama_default_assumed' }
  );
  const q8 = describeKvCache(HYBRID_27B, { kvCacheType: 'q8_0' });
  assert.equal(q8.bytesPerToken, 34 * KIB);
  assert.equal(q8.kvCacheTypeSource, 'observed');
  assert.equal(describeKvCache(HYBRID_27B, { kvCacheType: 'q4_0' }).bytesPerToken, 18 * KIB);
  // 196,608 tokens in one slot: 12 GiB in f16, 6.375 GiB in q8_0.
  assert.equal(kvCacheBytes(f16, 196608), 12 * GIB);
  assert.equal(kvCacheBytes(q8, 196608, 1), 6.375 * GIB);
});

test('a hybrid model without its interval key uses the runtime default and says so', () => {
  const { 'qwen35.full_attention_interval': _omitted, ...info } = HYBRID_27B;
  const kv = describeKvCache(info);
  assert.equal(kv.bytesPerToken, 64 * KIB);
  assert.equal(kv.layout, 'hybrid_interval_architecture_default');
});

test('a dense GQA model derives its head size from the embedding', () => {
  const kv = describeKvCache({
    'general.architecture': 'llama', 'llama.block_count': 32, 'llama.embedding_length': 4096,
    'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8,
  });
  assert.equal(kv.bytesPerToken, 128 * KIB);
  assert.deepEqual([kv.layout, kv.attentionLayers, kv.keyLength, kv.valueLength], ['dense', 32, 128, 128]);
});

test('experts do not change the cache of an MoE model', () => {
  const kv = describeKvCache({
    'general.architecture': 'qwen3moe', 'qwen3moe.block_count': 48, 'qwen3moe.expert_count': 128,
    'qwen3moe.attention.head_count': 32, 'qwen3moe.attention.head_count_kv': 4,
    'qwen3moe.attention.key_length': 128, 'qwen3moe.attention.value_length': 128,
  });
  assert.equal(kv.bytesPerToken, 48 * 4 * 256 * 2);
});

test('a per-layer KV head array counts only its attention layers', () => {
  const kv = describeKvCache({
    'general.architecture': 'granitehybrid', 'granitehybrid.block_count': 6,
    'granitehybrid.attention.head_count': 32, 'granitehybrid.attention.head_count_kv': [0, 0, 8, 0, 0, 8],
    'granitehybrid.attention.key_length': 128,
  });
  assert.equal(kv.bytesPerToken, 2 * 8 * 256 * 2);
  assert.equal(kv.layout, 'per_layer_array');
});

test('sliding-window layers make the estimate an upper bound', () => {
  const kv = describeKvCache({
    'general.architecture': 'gemma3', 'gemma3.block_count': 48, 'gemma3.attention.head_count': 16,
    'gemma3.attention.head_count_kv': 8, 'gemma3.attention.key_length': 256, 'gemma3.attention.sliding_window': 1024,
  });
  assert.equal(kv.upperBound, true);
  assert.equal(kv.slidingWindow, 1024);
});

test('metadata that cannot describe the cache returns null', () => {
  assert.equal(describeKvCache(null), null);
  assert.equal(describeKvCache({ 'llama.block_count': 32 }), null);
  assert.equal(describeKvCache({ 'general.architecture': 'llama', 'llama.attention.head_count_kv': 8 }), null);
  assert.equal(describeKvCache({
    'general.architecture': 'deepseek2', 'deepseek2.block_count': 61, 'deepseek2.attention.head_count': 128,
    'deepseek2.attention.head_count_kv': 128, 'deepseek2.attention.key_length': 192, 'deepseek2.attention.kv_lora_rank': 512,
  }), null);
  assert.equal(kvCacheBytes(null, 1024), null);
  assert.equal(kvCacheBytes({ bytesPerToken: 10 }, 0), null);
});

test('only the KV cache types Ollama supports are recognized', () => {
  assert.equal(normalizeKvCacheType(' Q8_0 '), 'q8_0');
  assert.equal(normalizeKvCacheType('f16'), 'f16');
  assert.equal(normalizeKvCacheType('bf16'), null);
  assert.equal(normalizeKvCacheType(undefined), null);
});
