'use strict';

jest.mock('../../src/services/hostPreferenceService', () => ({
  getPinStatus: jest.fn(), getByHost: jest.fn(), updatePinnedModel: jest.fn(),
  updatePreference: jest.fn(), restorePinnedModels: jest.fn()
}));
jest.mock('../../src/services/runtimeMutationLeaseService', () => ({ runRuntimeMutation: jest.fn() }));
jest.mock('../../src/services/runtimeCoordinationService', () => ({
  acquireMaintenance: jest.fn(), heartbeat: jest.fn(), release: jest.fn(), markMaintenanceUnknown: jest.fn()
}));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const service = require('../../src/services/hostPreferenceService');
const { runRuntimeMutation } = require('../../src/services/runtimeMutationLeaseService');
const coordination = require('../../src/services/runtimeCoordinationService');
const realRunRuntimeMutation = jest.requireActual('../../src/services/runtimeMutationLeaseService').runRuntimeMutation;

const app = express();
app.use(express.json());
app.use('/api/nerve-center', require('../../routes/nerve-center-host-pins')(req => decodeURIComponent(req.params.hostUrl)));

const url = '/api/nerve-center/host-preferences/http%3A%2F%2Fhost%3A11434/pin/context';
const gemma = { model: 'gemma4:12b', keepAlive: -1, contextSize: 65536, autoRestore: true };
const bge = { model: 'bge-m3:latest', keepAlive: -1, contextSize: 0, autoRestore: true };
const previous = { maxConcurrentModels: 2, pinnedModels: [gemma, bge] };
const pref = { hostUrl: 'http://host:11434', status: 'ready', ...previous };
const applied = { ...pref, pinnedModels: [{ ...gemma, contextSize: 98304 }, bge] };
const fullResidents = {
  verified: true, gpuVerified: true,
  statuses: [
    { model: 'gemma4:12b', loadedContextLength: 98304, gpuResidency: { status: 'full' } },
    { model: 'bge-m3:latest', loadedContextLength: 8192, gpuResidency: { status: 'full' } }
  ]
};
const body = { model: 'gemma4:12b', contextSize: 98304, expectedContextSize: 65536, operatorDecision: 'apply' };

function generateReply(tokensPerSec) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ done: true, eval_count: 64, eval_duration: Math.round((64 / tokensPerSec) * 1e9) })
  };
}

describe('POST pin/context applies an operator-confirmed context proposal', () => {
  let http;
  const originalFetch = global.fetch;
  beforeAll(async () => { http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' }); });
  afterAll(async () => { global.fetch = originalFetch; await http.close(); });
  beforeEach(() => {
    jest.resetAllMocks();
    runRuntimeMutation.mockImplementation(realRunRuntimeMutation);
    coordination.acquireMaintenance.mockResolvedValue({ acquired: true, leaseId: 'lease', generation: 'g', principal: 'benchmark-service' });
    coordination.release.mockResolvedValue({ released: true });
    coordination.markMaintenanceUnknown.mockResolvedValue({ quarantined: true });
    service.getPinStatus.mockResolvedValue(previous);
    service.getByHost.mockResolvedValue(pref);
    service.updatePinnedModel.mockResolvedValue(applied);
    service.restorePinnedModels.mockResolvedValue({ status: 'ready', verified: true, verification: fullResidents });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(generateReply(50))
      .mockResolvedValueOnce(generateReply(50))
      .mockResolvedValueOnce(generateReply(49))
      .mockResolvedValueOnce(generateReply(49));
  });

  it('writes the pin, verifies every resident in VRAM and keeps short-prompt speed', async () => {
    const response = await http.request.post(url).send(body);
    expect(response.status).toBe(200);
    expect(service.updatePinnedModel).toHaveBeenCalledWith('http://host:11434', 'gemma4:12b', { model: 'gemma4:12b', contextSize: 98304 });
    expect(response.body.data.contextApply).toMatchObject({
      previousContextSize: 65536, contextSize: 98304,
      speed: { before: { tokensPerSec: 50 }, after: { tokensPerSec: 49 }, tolerancePct: 10 }
    });
    expect(response.body.data.contextApply.residents).toHaveLength(2);
    // Baseline at the current pin, then the new allocation; never a reload size.
    const sentContexts = global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).options.num_ctx);
    expect(sentContexts).toEqual([65536, 65536, 98304, 98304]);
    expect(service.updatePreference).not.toHaveBeenCalled();
    expect(coordination.release).toHaveBeenCalledTimes(1);
  });

  it('reverts to the previous pin when short-prompt speed regresses', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(generateReply(50)).mockResolvedValueOnce(generateReply(50))
      .mockResolvedValueOnce(generateReply(40)).mockResolvedValueOnce(generateReply(40));
    const response = await http.request.post(url).send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('HOST_PIN_SPEED_REGRESSION');
    expect(response.body.rollback).toBe('verified');
    expect(response.body.details.speed.after.tokensPerSec).toBe(40);
    expect(service.updatePreference).toHaveBeenCalledWith('http://host:11434', previous);
    expect(service.restorePinnedModels).toHaveBeenCalledTimes(2);
    expect(coordination.release).toHaveBeenCalledTimes(1);
    expect(coordination.markMaintenanceUnknown).not.toHaveBeenCalled();
  });

  it('reverts when a resident spills out of VRAM at the new context', async () => {
    service.restorePinnedModels
      .mockResolvedValueOnce({ verified: false, error: 'Pinned model restore did not verify resident model/context/VRAM' })
      .mockResolvedValueOnce({ status: 'ready', verified: true });
    const response = await http.request.post(url).send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('HOST_PIN_RESTORE_FAILED');
    expect(response.body.rollback).toBe('verified');
    expect(service.updatePreference).toHaveBeenCalledWith('http://host:11434', previous);
  });

  it('reverts when residency is loaded but GPU placement is unproven', async () => {
    service.restorePinnedModels
      .mockResolvedValueOnce({ status: 'ready', verified: true, verification: { ...fullResidents, gpuVerified: false } })
      .mockResolvedValueOnce({ status: 'ready', verified: true });
    const response = await http.request.post(url).send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('HOST_PIN_VRAM_UNVERIFIED');
    expect(service.updatePreference).toHaveBeenCalledWith('http://host:11434', previous);
  });

  it('quarantines the lease when the rollback itself cannot be verified', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(generateReply(50)).mockResolvedValueOnce(generateReply(50))
      .mockResolvedValueOnce(generateReply(20)).mockResolvedValueOnce(generateReply(20));
    service.restorePinnedModels
      .mockResolvedValueOnce({ status: 'ready', verified: true, verification: fullResidents })
      .mockResolvedValueOnce({ status: 'error', verified: false });
    const response = await http.request.post(url).send(body);
    expect(response.status).toBe(409);
    expect(response.body.rollback).toBe('unverified');
    expect(response.body.message).toContain('runtime restoration unverified');
    expect(coordination.markMaintenanceUnknown).toHaveBeenCalledTimes(1);
    expect(coordination.release).not.toHaveBeenCalled();
  });

  it.each([
    ['a model that is not pinned', { ...body, model: 'qwen3:8b' }, pref, 'HOST_PIN_NOT_PINNED'],
    ['a pin that changed since the proposal', { ...body, expectedContextSize: 32768 }, pref, 'HOST_PIN_CONTEXT_STALE'],
    ['a pin already at the proposal', { ...body, contextSize: 65536 }, pref, 'HOST_PIN_CONTEXT_UNCHANGED'],
    ['a host held by a benchmark claim', body, { ...pref, status: 'benchmarking', benchmarkClaim: { batchId: 'b1' } }, 'HOST_PIN_OWNER_BUSY'],
    ['a host held by a session', body, { ...pref, sessionHold: { holdId: 'h', model: 'x', expiresAt: new Date(Date.now() + 60_000) } }, 'HOST_PIN_OWNER_BUSY']
  ])('refuses %s without writing', async (_label, request, current, code) => {
    service.getByHost.mockResolvedValue(current);
    const response = await http.request.post(url).send(request);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe(code);
    expect(service.updatePinnedModel).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(coordination.release).toHaveBeenCalledTimes(1);
  });

  it('refuses when the current speed cannot be measured', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ done: true }) });
    const response = await http.request.post(url).send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('HOST_PIN_BASELINE_UNAVAILABLE');
    expect(service.updatePinnedModel).not.toHaveBeenCalled();
  });

  it('requires an explicit operator decision', async () => {
    const response = await http.request.post(url).send({ ...body, operatorDecision: undefined });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('HOST_PIN_DECISION_REQUIRED');
    expect(coordination.acquireMaintenance).not.toHaveBeenCalled();
  });

  it('does not measure or write while another owner holds the maintenance lease', async () => {
    runRuntimeMutation.mockRejectedValue(Object.assign(new Error('Runtime maintenance is held'), { statusCode: 409, code: 'RUNTIME_MAINTENANCE_HELD' }));
    const response = await http.request.post(url).send(body);
    expect(response.status).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(service.updatePinnedModel).not.toHaveBeenCalled();
  });
});
