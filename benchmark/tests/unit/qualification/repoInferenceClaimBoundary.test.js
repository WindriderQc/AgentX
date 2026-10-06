'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/coreHttp', () => ({ coreRequest: jest.fn(), configuredCoreOrigin: () => 'http://core:3080' }));
jest.mock('../../../../core/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../../core/src/services/hostPreferenceService', () => ({ getByHost: jest.fn(), hasActiveBenchmarkClaim: () => true }));
jest.mock('../../../../core/src/services/hostSessionHoldService', () => ({ activeSessionHold: () => null }));
jest.mock('../../../../core/src/services/interactivePriorityService', () => ({ claimYielded: async () => false }));
jest.mock('../../../../core/src/services/runtimeCoordinationService', () => ({ assertWorkloadAdmission: jest.fn() }));
const { coreRequest } = require('../../../src/clients/coreHttp');
const { claimProofByOwner, workloadAdmissionById, claimOwnerKey } = require('../../../src/clients/coreProofState');
const { generateWithWorkloadAdmission } = require('../../../src/clients/coreWorkloadAdmissions');
const { buildAdmittedCallModel } = require('../../../src/services/qualification/repoLiveAdmission');
const { withBenchmarkServiceAuth } = require('../../../src/helpers/coreServiceAuth');
const { resolveInferenceRequestCaller } = require('../../../../core/src/services/routing/inferenceCallerAccess');
const { resolvePolicyLane } = require('../../../../core/src/services/inferenceLanePolicy');
const { assertHostAvailableForConsumer } = require('../../../../core/src/services/benchmarkClaimGuard');
const hostPrefs = require('../../../../core/src/services/hostPreferenceService');
const coordination = require('../../../../core/src/services/runtimeCoordinationService');
const host = 'http://fixture-host:11434', workloadId = 'repo-fixture-boundary';
const claim = { batchId: workloadId, claimGeneration: 'claim-a', admissionId: 'admission-a', admissionGeneration: 'generation-a', admissionPrincipal: 'benchmark-service' };
let modelDispatches;
beforeEach(() => {
  jest.clearAllMocks();
  claimProofByOwner.clear(); workloadAdmissionById.clear(); modelDispatches = 0;
  claimProofByOwner.set(claimOwnerKey(host, workloadId), { claimGeneration: claim.claimGeneration });
  workloadAdmissionById.set(workloadId, { admissionId: claim.admissionId, generation: claim.admissionGeneration });
  hostPrefs.getByHost.mockResolvedValue({ benchmarkClaim: claim });
  coordination.assertWorkloadAdmission.mockImplementation(async proof => {
    expect(proof).toEqual({ id: claim.admissionId, generation: claim.admissionGeneration, principal: claim.admissionPrincipal, workloadId, host });
    return { admitted: true };
  });
  // Transport and stored authority are synthetic; caller policy and the guard are Core's actual consumer.
  coreRequest.mockImplementation(async (path, options) => {
    expect(path).toBe('/api/inference/generate');
    const body = JSON.parse(options.body), headers = withBenchmarkServiceAuth();
    const caller = resolveInferenceRequestCaller({ body, get: name => Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] });
    const lane = resolvePolicyLane(caller.effectivePolicy);
    await assertHostAvailableForConsumer(body.host, { ...body, benchmarkAuthorized: caller.principal === 'benchmark-service' && lane.name === 'direct' });
    modelDispatches++;
    return { model: body.model, done: true, done_reason: 'stop', message: { content: 'synthetic patch' }, prompt_eval_count: 11, eval_count: 5 };
  });
});
afterEach(() => { claimProofByOwner.clear(); workloadAdmissionById.clear(); });
function callModel() {
  return buildAdmittedCallModel({ host, timeoutMs: 1000, session: { workloadId, signal: new AbortController().signal, assertActive: jest.fn() }, modelConfigs: new Map([['candidate', { artifact_digest: 'fixture-digest', num_ctx: 8192, response_max_tokens: 4096, think: false, temperature: 0.2 }]]) });
}
test('an unclassified request is refused before dispatch even with its owned proof', async () => {
  await expect(generateWithWorkloadAdmission(workloadId, { host, model: 'candidate', prompt: 'repair' })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  expect(modelDispatches).toBe(0);
});
test('the repository adapter reaches Core through the direct Benchmark policy and exact proof', async () => {
  const result = await callModel()({ model: 'candidate', prompt: 'repair', seed: 101 });
  expect(result.metrics).toEqual({ effectiveModel: 'candidate', promptEvalCount: 11, evalCount: 5, totalDuration: null });
  expect(modelDispatches).toBe(1); expect(coordination.assertWorkloadAdmission).toHaveBeenCalledTimes(1);
  const body = JSON.parse(coreRequest.mock.calls[0][1].body);
  expect(body.options).toEqual({ num_ctx: 8192, num_predict: 4096, temperature: 0.2, seed: 101 });
  expect(body).toMatchObject({ claimBatchId: workloadId, claimGeneration: claim.claimGeneration, workloadAdmissionId: claim.admissionId, workloadGeneration: claim.admissionGeneration });
});
test('the Benchmark label does not authorize a different claim generation', async () => {
  hostPrefs.getByHost.mockResolvedValue({ benchmarkClaim: { ...claim, claimGeneration: 'replacement' } });
  await expect(callModel()({ model: 'candidate', prompt: 'repair', seed: 101 })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE', retainAdmission: true });
  expect(modelDispatches).toBe(0); expect(coordination.assertWorkloadAdmission).not.toHaveBeenCalled();
});
test('expired server authority still stops dispatch and retains recovery', async () => {
  coordination.assertWorkloadAdmission.mockRejectedValue(Object.assign(new Error('expired'), { code: 'WORKLOAD_ADMISSION_REQUIRED' }));
  await expect(callModel()({ model: 'candidate', prompt: 'repair', seed: 101 })).rejects.toMatchObject({ code: 'WORKLOAD_ADMISSION_REQUIRED', retainAdmission: true });
  expect(modelDispatches).toBe(0);
});
