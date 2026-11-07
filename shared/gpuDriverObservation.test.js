'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preserveInventoryDrivers } = require('./gpuDriverObservation');
const { buildRuntimeFingerprint } = require('./artifactIdentity');
const { buildMeasuredRuntime } = require('./measuredRuntime');

const host = { hostId: 'gpu-a', hostUrl: 'http://gpu-a.example:11434' };
const inventory = [0, 1].map(index => ({
  index, uuid: `GPU-${index}`, model: 'Synthetic GPU', vramTotalMiB: 24576
}));

test('driver observations preserve exact existing hashes and record new measurement metadata', () => {
  for (const existingDriver of [null, '570.1']) {
    const previous = inventory.map(gpu => ({ ...gpu, driver: existingDriver }));
    const observed = inventory.map(gpu => ({ ...gpu, driver: '580.95.05' }));
    const before = { ...host, gpus: previous };
    const after = { ...host, gpus: preserveInventoryDrivers(previous, observed),
      gpuDriverObservation: { gpus: observed, observedAt: '2026-11-07T12:00:00Z', staleAfterMs: 90000, status: 'observed' } };
    assert.equal(buildRuntimeFingerprint(after), buildRuntimeFingerprint(before));
    assert.equal(buildMeasuredRuntime({ hostProfile: after, observedAt: '2026-11-07T12:00:01Z' }).gpuDriver, '580.95.05');
    assert.equal(buildMeasuredRuntime({ hostProfile: before }).gpuDriver, existingDriver);
    assert.deepEqual(previous.map(gpu => gpu.driver), [existingDriver, existingDriver]);
  }
});

test('preserving drivers never masks physical inventory changes or depends on order', () => {
  const before = { ...host, gpus: inventory };
  const observed = inventory.map(gpu => ({ ...gpu, driver: '580.95.05' })).reverse();
  assert.equal(buildRuntimeFingerprint({ ...host, gpus: preserveInventoryDrivers(inventory, observed) }), buildRuntimeFingerprint(before));
  for (const field of ['uuid', 'vramTotalMiB']) {
    const changed = structuredClone(observed);
    changed[0][field] = field === 'uuid' ? 'GPU-replaced' : 12288;
    assert.notEqual(buildRuntimeFingerprint({ ...host, gpus: preserveInventoryDrivers(inventory, changed) }), buildRuntimeFingerprint(before));
  }
});

test('unknown or partial observation never claims an old driver as newly measured', () => {
  const legacy = { ...host, gpu: { driver: '570.1' }, gpus: inventory };
  for (const gpus of [[], inventory, [{ ...inventory[0], driver: '580.95.05' }, inventory[1]]]) {
    assert.equal(buildMeasuredRuntime({ hostProfile: { ...legacy, gpuDriverObservation: { gpus } } }).gpuDriver, null);
  }
  assert.equal(buildMeasuredRuntime({ hostProfile: legacy }).gpuDriver, '570.1');
});


test('Data freshness, unknown windows and failed observations cannot date an old driver as current', () => {
  const observation = { gpus: inventory.map(gpu => ({ ...gpu, driver: '580.95.05' })),
    observedAt: '2026-11-07T12:00:00Z', staleAfterMs: 90000, status: 'observed' };
  const measure = (observedAt, overrides = {}) => buildMeasuredRuntime({ observedAt,
    hostProfile: { ...host, gpuDriverObservation: { ...observation, ...overrides } } }).gpuDriver;
  assert.equal(measure('2026-11-07T12:01:30Z'), '580.95.05');
  assert.equal(measure('2026-11-07T12:01:30.001Z'), null);
  assert.equal(measure('2026-11-07T11:59:59Z'), null);
  assert.equal(measure('2026-11-08T12:00:00Z'), null);
  for (const status of ['stale', 'unavailable', 'no_data', 'no_host', 'not_configured']) {
    assert.equal(measure('2026-11-07T12:00:01Z', { status }), null);
  }
  for (const staleAfterMs of [undefined, null, 0, -1, Infinity, 'unknown']) {
    assert.equal(measure('2026-11-07T12:00:01Z', { staleAfterMs }), null);
  }
});
