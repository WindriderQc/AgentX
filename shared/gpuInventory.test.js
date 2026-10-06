'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGpuInventory } = require('./gpuInventory');
const { buildRuntimeFingerprint } = require('./artifactIdentity');

const gpus = [
  { index: 0, uuid: 'GPU-A', busId: '0000:01:00.0', name: 'Synthetic GPU A', memoryTotalMiB: 24576 },
  { index: 1, uuid: 'GPU-B', busId: '0000:02:00.0', name: 'Synthetic GPU B', memoryTotalMiB: 24576 }
];
const host = { hostId: 'gpu-pool', hostUrl: 'http://gpu-pool:11434' };

test('complete multi-GPU identity changes when either GPU changes, without depending on sample order or load', () => {
  const original = buildRuntimeFingerprint({ ...host, gpus });
  assert.equal(buildRuntimeFingerprint({ ...host, gpus: [...gpus].reverse() }), original);
  assert.equal(buildRuntimeFingerprint({ ...host, gpus: gpus.map(gpu => ({ ...gpu, utilizationPct: 99, memoryUsedMiB: 123 })) }), original);
  for (const field of ['uuid', 'busId', 'name', 'memoryTotalMiB']) {
    const changed = structuredClone(gpus);
    changed[1][field] = field === 'memoryTotalMiB' ? 12288 : 'changed';
    assert.notEqual(buildRuntimeFingerprint({ ...host, gpus: changed }), original);
  }
  assert.notEqual(buildRuntimeFingerprint({ ...host, gpus: gpus.slice(0, 1) }), original);
});

test('legacy hosts keep their exact fingerprint until inventory is observed', () => {
  assert.equal(buildRuntimeFingerprint({ ...host, gpus: [] }), buildRuntimeFingerprint(host));
  assert.equal(buildRuntimeFingerprint({ ...host, gpus: null }), buildRuntimeFingerprint(host));
  assert.notEqual(buildRuntimeFingerprint({ ...host, gpus }), buildRuntimeFingerprint(host));
});

test('collector and stored inventory have the same canonical shape', () => {
  const stored = normalizeGpuInventory(gpus);
  assert.equal(stored.length, 2);
  assert.deepEqual(normalizeGpuInventory(stored), stored);
  assert.equal(stored[1].vramTotalMiB, 24576);
});
