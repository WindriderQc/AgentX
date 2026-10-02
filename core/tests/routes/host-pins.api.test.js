'use strict';

jest.mock('../../src/services/hostPreferenceService', () => ({
  getPinStatus: jest.fn(), setPinnedModel: jest.fn(), addPinnedModel: jest.fn(),
  updatePinnedModel: jest.fn(), removePinnedModel: jest.fn(), clearPinnedModel: jest.fn(),
  updatePreference: jest.fn(), restorePinnedModels: jest.fn()
}));
jest.mock('../../src/services/runtimeMutationLeaseService', () => ({ runRuntimeMutation: jest.fn() }));
jest.mock('../../src/services/runtimeCoordinationService', () => ({
  acquireMaintenance: jest.fn(), heartbeat: jest.fn(), release: jest.fn(), markMaintenanceUnknown: jest.fn()
}));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../config/logger', () => ({ info: jest.fn(), error: jest.fn() }));

const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const service = require('../../src/services/hostPreferenceService');
const { runRuntimeMutation } = require('../../src/services/runtimeMutationLeaseService');
const coordination = require('../../src/services/runtimeCoordinationService');
const realRunRuntimeMutation = jest.requireActual('../../src/services/runtimeMutationLeaseService').runRuntimeMutation;
const app = express();
app.use(express.json());
app.use('/api/nerve-center', require('../../routes/nerve-center-host-pins')(req => decodeURIComponent(req.params.hostUrl)));

describe('individual host pin mutations', () => {
  const url = '/api/nerve-center/host-preferences/http%3A%2F%2Fhost%3A11434/pin';
  const previous = {
    maxConcurrentModels: 1,
    pinnedModels: [{ model: 'gemma:latest', keepAlive: -1, contextSize: 32768, autoRestore: true }]
  };
  const updated = {
    ...previous,
    maxConcurrentModels: 2,
    pinnedModels: [...previous.pinnedModels, { model: 'qllama/bge-m3:f16', keepAlive: -1, contextSize: 0, autoRestore: true }],
    benchmarkClaim: { claimGeneration: 'private-generation' }
  };
  let http;
  beforeAll(async () => { http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' }); });
  afterAll(async () => { await http.close(); });
  beforeEach(() => {
    jest.resetAllMocks();
    runRuntimeMutation.mockImplementation(async (_options, operation) => operation({
      signal: new AbortController().signal, assertActive() {}
    }));
    service.getPinStatus.mockResolvedValue(previous);
    service.addPinnedModel.mockResolvedValue(updated);
    service.setPinnedModel.mockResolvedValue(updated);
    service.updatePinnedModel.mockResolvedValue(updated);
    service.removePinnedModel.mockResolvedValue(previous);
    service.restorePinnedModels.mockResolvedValue({ status: 'ready', verified: true });
    coordination.acquireMaintenance.mockResolvedValue({ acquired: true, leaseId: 'lease', generation: 'generation', principal: 'operator' });
    coordination.release.mockResolvedValue({ released: true });
    coordination.markMaintenanceUnknown.mockResolvedValue({ quarantined: true });
  });

  it('adds a resident and verifies all pins under the mutation lease', async () => {
    const response = await http.request.post(url).send({ model: 'qllama/bge-m3:f16' });
    expect(response.status).toBe(200);
    expect(response.body.data.pinnedModels).toHaveLength(2);
    expect(response.body.data.benchmarkClaim.claimGeneration).toBeUndefined();
    expect(service.addPinnedModel).toHaveBeenCalledWith('http://host:11434', 'qllama/bge-m3:f16', { model: 'qllama/bge-m3:f16' });
    expect(service.restorePinnedModels).toHaveBeenCalledTimes(1);
  });

  it('changes only the named pin through PATCH', async () => {
    const response = await http.request.patch(url).send({ model: 'gemma:latest', keepAlive: 600 });
    expect(response.status).toBe(200);
    expect(service.updatePinnedModel).toHaveBeenCalledWith('http://host:11434', 'gemma:latest', { model: 'gemma:latest', keepAlive: 600 });
    expect(service.updatePreference).not.toHaveBeenCalled();
  });

  it('removes a single pin without clearing or unloading the remaining residents', async () => {
    const response = await http.request.delete(url).send({ model: 'qllama/bge-m3:f16' });
    expect(response.status).toBe(200);
    expect(response.body.data.pinnedModels).toHaveLength(1);
    expect(service.clearPinnedModel).not.toHaveBeenCalled();
    expect(service.restorePinnedModels).not.toHaveBeenCalled();
  });

  it('restores the previous settings and runtime if co-residency cannot be verified', async () => {
    runRuntimeMutation.mockImplementation(realRunRuntimeMutation);
    service.restorePinnedModels.mockResolvedValueOnce({ verified: false, error: 'Embedding pin was evicted' });
    const response = await http.request.post(url).send({ model: 'qllama/bge-m3:f16' });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('previous pins restored');
    expect(service.updatePreference).toHaveBeenCalledWith('http://host:11434', previous);
    expect(service.restorePinnedModels).toHaveBeenCalledTimes(2);
    expect(coordination.release).toHaveBeenCalledTimes(1);
    expect(coordination.markMaintenanceUnknown).not.toHaveBeenCalled();
  });

  it('releases the lease when pin validation refused the write', async () => {
    runRuntimeMutation.mockImplementation(realRunRuntimeMutation);
    service.addPinnedModel.mockRejectedValue(Object.assign(new Error('Invalid context'), { code: 'HOST_PIN_INVALID', statusCode: 400 }));
    const response = await http.request.post(url).send({ model: 'qllama/bge-m3:f16', contextSize: -1 });
    expect(response.status).toBe(400);
    expect(coordination.release).toHaveBeenCalledTimes(1);
    expect(coordination.markMaintenanceUnknown).not.toHaveBeenCalled();
  });

  it('does not dispatch a pin mutation while maintenance is denied', async () => {
    runRuntimeMutation.mockRejectedValue(Object.assign(new Error('Host busy'), { statusCode: 409 }));
    const response = await http.request.post(url).send({ model: 'qllama/bge-m3:f16' });
    expect(response.status).toBe(409);
    expect(service.addPinnedModel).not.toHaveBeenCalled();
  });

  it('preserves UNKNOWN quarantine instead of starting a rollback mutation', async () => {
    runRuntimeMutation.mockImplementation(realRunRuntimeMutation);
    service.restorePinnedModels.mockRejectedValue(Object.assign(new Error('Unknown outcome'), { code: 'RUNTIME_MUTATION_OUTCOME_UNKNOWN' }));
    const response = await http.request.post(url).send({ model: 'qllama/bge-m3:f16' });
    expect(response.status).toBe(500);
    expect(service.updatePreference).not.toHaveBeenCalled();
    expect(service.restorePinnedModels).toHaveBeenCalledTimes(1);
    expect(coordination.markMaintenanceUnknown).toHaveBeenCalledTimes(1);
    expect(coordination.release).not.toHaveBeenCalled();
  });
});
