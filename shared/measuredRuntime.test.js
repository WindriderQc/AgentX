'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMeasuredRuntime,
  gpuDriverOf,
  normalizeMeasuredRuntime,
  runtimeVersionDrift
} = require('./measuredRuntime');
const { buildRuntimeFingerprint } = require('./artifactIdentity');

test('records the Ollama version and the collector-reported driver', () => {
  const runtime = buildMeasuredRuntime({
    ollamaVersion: ' 0.40.8 ',
    hostProfile: { gpus: [{ driver: '580.95.05' }, { driver: '580.95.05' }] },
    observedAt: '2026-10-21T22:00:00.000Z'
  });
  assert.deepEqual(runtime, { ollamaVersion: '0.40.8', gpuDriver: '580.95.05', observedAt: '2026-10-21T22:00:00.000Z' });
});

test('an unreported driver or version stays null rather than guessed', () => {
  assert.equal(gpuDriverOf({ gpus: [{ model: 'RTX 3090' }] }), null);
  const runtime = buildMeasuredRuntime({ ollamaVersion: '', hostProfile: null });
  assert.equal(runtime.ollamaVersion, null);
  assert.equal(runtime.gpuDriver, null);
  assert.equal(normalizeMeasuredRuntime(runtime), null);
});

test('reports drift only when the installed version is known and differs', () => {
  const measured = { ollamaVersion: '0.34.4', observedAt: '2026-10-01T00:00:00.000Z' };
  assert.deepEqual(runtimeVersionDrift(measured, { ollamaVersion: '0.40.8' }), { measured: '0.34.4', installed: '0.40.8' });
  assert.equal(runtimeVersionDrift(measured, { ollamaVersion: '0.34.4' }), null);
  assert.equal(runtimeVersionDrift(measured, { ollamaVersion: null }), null);
  assert.equal(runtimeVersionDrift(measured, '0.34.4'), null);
});

test('evidence written before the version was recorded shows as unrecorded drift', () => {
  assert.deepEqual(runtimeVersionDrift(null, { ollamaVersion: '0.40.8' }), { measured: null, installed: '0.40.8' });
});

test('the runtime fingerprint does not depend on a recorded evidence version', () => {
  const host = { hostId: 'gpu-a', hostUrl: 'http://gpu-a:11434', gpus: [{ index: 0, model: 'RTX 3090', vramTotalMiB: 24576 }] };
  const before = buildRuntimeFingerprint(host);
  buildMeasuredRuntime({ ollamaVersion: '0.40.8', hostProfile: host });
  assert.equal(buildRuntimeFingerprint({ ...host, measuredRuntime: { ollamaVersion: '0.40.8' } }), before);
});
