'use strict';
jest.mock('../../src/services/hostPreferenceService', () => ({ getAll: jest.fn(), detectHostPreferenceIdentityDrift: () => [],
  normalizeHostPreferenceIdentity: value => value, getPinnedEntries: value => value.pinnedModels, getHealthCheckIntervalMs: () => 60000 }));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ ...jest.requireActual('../../src/helpers/ollamaHostConfig'), validateHostUrl: host => ({ valid: true, host }) }));
jest.mock('../../src/services/gpuTelemetryService', () => ({ getGpuTelemetryForHosts: jest.fn() }));
jest.mock('../../src/services/ollamaModelParallelismService', () => ({ readModelParallelism: jest.fn() }));
jest.mock('../../src/services/runtimeTopologyParking', () => {
  const actual = jest.requireActual('../../src/services/runtimeTopologyParking');
  return { ...actual, defaultParking: actual.createParking() };
});
const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const preferences = require('../../src/services/hostPreferenceService');
const telemetry = require('../../src/services/gpuTelemetryService');
const parallelism = require('../../src/services/ollamaModelParallelismService');
const { defaultParking } = require('../../src/services/runtimeTopologyParking');
let http;
const originalFetch = global.fetch;
beforeAll(async () => { const app = express(); app.use('/api/nerve-center', require('../../routes/nerve-center-host-read')); http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' }); });
afterAll(async () => { global.fetch = originalFetch; await http?.close(); });
beforeEach(() => {
  defaultParking._setDescription(null);
  parallelism.readModelParallelism.mockClear();
  preferences.getAll.mockResolvedValue([{ hostUrl: 'http://synthetic-host:11434', status: 'ready',
    pinnedModels: [{ model: 'synthetic-embedder', contextSize: 0 }] }]);
  telemetry.getGpuTelemetryForHosts.mockResolvedValue(new Map([['http://synthetic-host:11434', { telemetry: { status: 'fresh' }, gpus: [{}] }]]));
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'synthetic-embedder', size: 100, size_vram: 50 }] }) }));
  parallelism.readModelParallelism.mockResolvedValue([{ model: 'synthetic-embedder', family: 'bert', architecture: 'bert', requestSlots: 1, reason: 'no_completion' }]);
});
test('reports the request slots Ollama gives each pinned and loaded model', async () => {
  const response = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(parallelism.readModelParallelism).toHaveBeenCalledWith('http://synthetic-host:11434', ['synthetic-embedder', 'synthetic-embedder']);
  expect(response.body.data[0].live.modelParallelism).toEqual([{ model: 'synthetic-embedder', family: 'bert', architecture: 'bert', requestSlots: 1, reason: 'no_completion' }]);
});
test('HTTP reachability does not hide a partially CPU-resident embedding pin', async () => {
  const response = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(response.body.data[0].live).toMatchObject({ online: true, gpuHealth: { status: 'degraded', reason: 'pinned_model_gpu_spill', entries: [{ model: 'synthetic-embedder', status: 'partial' }] } });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('a rejected model inventory remains unavailable, rather than an empty successful observation', async () => {
  global.fetch.mockResolvedValue({ ok: false });
  const response = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(response.body.data[0].live).toMatchObject({ online: false, gpuHealth: { status: 'unknown' } });
});
test('a benchmark owner prevents pin qualification while preserving reachability', async () => {
  preferences.getAll.mockResolvedValue([{ hostUrl: 'http://synthetic-host:11434', status: 'benchmark',
    benchmarkClaim: { batchId: 'operation-1', claimedAt: new Date() }, pinnedModels: [{ model: 'synthetic-embedder' }] }]);
  const response = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(response.body.data[0].live).toMatchObject({ online: true, gpuHealth: { status: 'unknown', reason: 'runtime_owner_active' } });
});

test('inactive endpoints retain persisted hints separately and expose no live residents', async () => {
  preferences.getAll.mockResolvedValue([{ hostUrl: 'http://synthetic-host:11434', status: 'ready',
    loadedModels: ['saved-resident'], pinnedModels: [{ model: 'desired-resident' }],
    tags: ['synthetic-service'], vramReservedMiB: 64 }]);
  defaultParking._setDescription({ configured: true, valid: true, groups: [{ id: 'synthetic', activeMode: 'other', modes: [
    { id: 'inactive', endpoints: [{ url: 'http://synthetic-host:11434' }] }, { id: 'other', endpoints: [] }
  ] }] });
  const response = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(response.body.data[0]).toMatchObject({
    loadedModels: ['saved-resident'], persistedState: { loadedModels: ['saved-resident'], freshness: 'unverified' },
    declaredMetadata: { kind: 'operator_notes', tags: ['synthetic-service'], vramReservedMiB: 64,
      declaredAt: null, declaredBy: null, freshness: 'unverified' },
    live: { online: false, status: 'inactive', runningModels: [],
      observation: { status: 'not_applicable', reason: 'inactive_topology_mode' } }
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(parallelism.readModelParallelism).not.toHaveBeenCalled();
});

test('failed inventory does not erase independently computed pin routing drift', async () => {
  const healthy = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(healthy.body.data[0].driftModels).toEqual(['synthetic-embedder']);
  global.fetch.mockRejectedValue(new Error('Inventory unavailable'));
  const failed = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(failed.body.data[0].driftModels).toEqual(['synthetic-embedder']);
  expect(failed.body.data[0].live).toMatchObject({ online: false,
    observation: { status: 'unavailable', observedAt: null } });
});

test('the resident model alias accepted by the shared reader stays readable in Nerve Center', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ models: [
    { model: 'synthetic-embedder', size: 100, size_vram: 100 }
  ] }) });
  const response = await http.request.get('/api/nerve-center/host-preferences').expect(200);
  expect(response.body.data[0].live).toMatchObject({ online: true, pinnedLoaded: true,
    runningModels: [{ name: 'synthetic-embedder', matchedPinned: 'synthetic-embedder' }] });
});
