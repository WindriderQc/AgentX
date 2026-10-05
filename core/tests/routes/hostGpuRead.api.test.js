'use strict';
jest.mock('../../src/services/hostPreferenceService', () => ({ getAll: jest.fn(), detectHostPreferenceIdentityDrift: () => [],
  normalizeHostPreferenceIdentity: value => value, getPinnedEntries: value => value.pinnedModels, getHealthCheckIntervalMs: () => 60000 }));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ ...jest.requireActual('../../src/helpers/ollamaHostConfig'), validateHostUrl: host => ({ valid: true, host }) }));
jest.mock('../../src/services/gpuTelemetryService', () => ({ getGpuTelemetryForHosts: jest.fn() }));
jest.mock('../../src/services/ollamaModelParallelismService', () => ({ readModelParallelism: jest.fn() }));
const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const preferences = require('../../src/services/hostPreferenceService');
const telemetry = require('../../src/services/gpuTelemetryService');
const parallelism = require('../../src/services/ollamaModelParallelismService');
let http;
const originalFetch = global.fetch;
beforeAll(async () => { const app = express(); app.use('/api/nerve-center', require('../../routes/nerve-center-host-read')); http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' }); });
afterAll(async () => { global.fetch = originalFetch; await http?.close(); });
beforeEach(() => {
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
