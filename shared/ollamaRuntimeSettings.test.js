'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeSettingsFromObservation, normalizeRuntimeSettings, sameRuntimeSettings } = require('./ollamaRuntimeSettings');
const { buildRuntimeFingerprint } = require('./artifactIdentity');

const observed = (values) => ({ source: 'systemd', ok: true, observedAt: '2026-10-05T00:00:00.000Z', values });
const TWO_GPUS = [{ index: 0, name: 'RTX 3090' }, { index: 1, name: 'RTX 3090' }];

test('settings name what an observation set and read unset keys as the default', () => {
  assert.deepEqual(runtimeSettingsFromObservation({
    environment: observed({ OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_SCHED_SPREAD: 'true' }),
    gpus: TWO_GPUS,
  }), { kvCacheType: 'q8_0', flashAttention: 'on', visibleDevices: 'default', schedSpread: 'on', gpuCount: 2 });
  assert.deepEqual(runtimeSettingsFromObservation({ environment: observed({}), gpus: [] }),
    { kvCacheType: 'default', flashAttention: 'default', visibleDevices: 'default', schedSpread: 'default', gpuCount: null });
});

test('visible devices limit the GPU count Ollama sees', () => {
  const settings = runtimeSettingsFromObservation({
    environment: observed({ CUDA_VISIBLE_DEVICES: ' 1 ', OLLAMA_KV_CACHE_TYPE: 'BF16' }), gpus: TWO_GPUS,
  });
  assert.equal(settings.visibleDevices, '1');
  assert.equal(settings.gpuCount, 1);
  assert.equal(settings.kvCacheType, 'other');
  assert.equal(runtimeSettingsFromObservation({ environment: observed({ CUDA_VISIBLE_DEVICES: '-1' }), gpus: TWO_GPUS }).gpuCount, 0);
});

test('a failed or missing observation gives no settings', () => {
  assert.equal(runtimeSettingsFromObservation({ environment: { ok: false, error: 'unit not found' } }), null);
  assert.equal(runtimeSettingsFromObservation({}), null);
  assert.equal(normalizeRuntimeSettings(null), null);
  assert.equal(sameRuntimeSettings(null, null), false);
});

test('a host never observed keeps its fingerprint; settings and their changes alter it', () => {
  const host = { hostId: 'ugalien', hostUrl: 'http://ugalien:11434', gpu: { vramTotalMiB: 49152 }, ollama: { backend: 'Unknown' } };
  const before = buildRuntimeFingerprint(host);
  assert.equal(buildRuntimeFingerprint({ ...host, ollama: { backend: 'Unknown', settings: null } }), before);
  const f16 = { kvCacheType: 'default', flashAttention: 'on', visibleDevices: 'default', schedSpread: 'on', gpuCount: 2 };
  const withSettings = buildRuntimeFingerprint({ ...host, ollama: { backend: 'Unknown', settings: f16 } });
  assert.notEqual(withSettings, before);
  assert.notEqual(buildRuntimeFingerprint({ ...host, ollama: { backend: 'Unknown', settings: { ...f16, kvCacheType: 'q8_0' } } }), withSettings);
  // Extra stored keys do not enter the fingerprint.
  assert.equal(buildRuntimeFingerprint({ ...host, ollama: { backend: 'Unknown', settings: { ...f16, note: 'x' } } }), withSettings);
  assert.equal(sameRuntimeSettings(f16, { ...f16, note: 'x' }), true);
});
