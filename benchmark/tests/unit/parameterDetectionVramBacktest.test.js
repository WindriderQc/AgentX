'use strict';

const { estimateTotalVram, estimateVramBreakdown } = require('../../src/services/parameterDetection');
const { describeKvCache } = require('../../../shared/kvCacheEstimate');

/**
 * Calibration provenance: `ollama ps` reported 25 GB total allocation at 32K
 * context and 45 GB at 65K for deepseek-r1:8b Q4_K_M. That change implies a
 * raw total-allocation slope of roughly 78 MiB/B/1K, but 78 is not the KV base:
 * estimateTotalVram also applies 30% overhead to weights plus KV at both points.
 * The 55 MiB/B/1K base composes with that multiplier to estimate 23.9 GiB and
 * 42.2 GiB. Using 78 as the base would count overhead twice and estimate about
 * 57.6 GiB at 65K. These tests lock both halves of that calibration together.
 */
describe('estimateTotalVram back-test against documented measurements', () => {
  const GB = 1024 ** 3;

  it('matches deepseek-r1:8b Q4_K_M at 32K ctx within 10% (measured 25 GB)', () => {
    const estimate = estimateTotalVram(8.2, 'Q4_K_M', 32768) / GB;
    expect(estimate).toBeGreaterThan(25 * 0.9);
    expect(estimate).toBeLessThan(25 * 1.1);
  });

  it('matches deepseek-r1:8b Q4_K_M at 65K ctx within 10% (measured 45 GB)', () => {
    const estimate = estimateTotalVram(8.2, 'Q4_K_M', 65536) / GB;
    expect(estimate).toBeGreaterThan(45 * 0.9);
    expect(estimate).toBeLessThan(45 * 1.1);
  });

  it('never uses the raw 78 slope directly (would double-count overhead)', () => {
    // With a 78 base factor the 65K estimate would be ~58 GB — 29% over the
    // measured 45 GB. Guard the ceiling explicitly.
    const estimate = estimateTotalVram(8.2, 'Q4_K_M', 65536) / GB;
    expect(estimate).toBeLessThan(50);
  });
});

/**
 * The same two measurements, from the model's own metadata (#368). A dense
 * Llama-architecture 8B caches 128 KiB per token in f16. Only about four
 * request slots reproduce the measured allocation, the reading consistent with
 * the rule of thumb's slope; the slot count of that measurement was not
 * recorded.
 */
describe('estimateTotalVram from model metadata', () => {
  const GB = 1024 ** 3;
  const kvCache = describeKvCache({
    'general.architecture': 'llama', 'llama.block_count': 32, 'llama.embedding_length': 4096,
    'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8,
  });

  it.each([[32768, 25], [65536, 45]])('reproduces deepseek-r1:8b at %i ctx within 10% with four slots', (numCtx, measured) => {
    const estimate = estimateTotalVram(8.2, 'Q4_K_M', numCtx, { kvCache, requestSlots: 4 }) / GB;
    expect(estimate).toBeGreaterThan(measured * 0.9);
    expect(estimate).toBeLessThan(measured * 1.1);
  });

  it('states which basis set the KV term', () => {
    expect(estimateVramBreakdown(8.2, 'Q4_K_M', 32768, { kvCache, requestSlots: 4 }))
      .toMatchObject({ kvBasis: 'model_info', requestSlots: 4, kvBytes: 128 * 1024 * 32768 * 4 });
    expect(estimateVramBreakdown(8.2, 'Q4_K_M', 32768))
      .toMatchObject({ kvBasis: 'parameter_rule_of_thumb', requestSlots: null });
    expect(estimateVramBreakdown(null, 'Q4_K_M', 32768)).toBeNull();
  });
});
