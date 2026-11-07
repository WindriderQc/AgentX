'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const coordination = require('../../src/services/runtimeCoordinationService');
const { invalidateDriverCaches } = require('../../src/services/gpuDriverCacheInvalidation');
const { GPU_DRIVER_IDENTITY_VERSION } = require('../../../shared/artifactIdentity');
const { operationWorkloadId } = require('../../../shared/gpuDriverTransition');

const host = 'http://synthetic-host.example:11434';
const hostId = 'synthetic-host';
const requestId = 'activate-synthetic-host';
const preparationId = 'prepare-synthetic-host';
const targetFingerprint = 'a'.repeat(64);
let input, deps;

beforeEach(async () => {
  jest.restoreAllMocks();
  await RuntimeCoordination.deleteMany({});
  const workloadId = operationWorkloadId(hostId, requestId);
  const admission = await coordination.acquireWorkload({ principal: 'benchmark-service', requestId: 'synthetic-acquire',
    workloadId, kind: 'gpu-driver-activation', hosts: [host], recoveryRequestId: 'synthetic-recovery-request' });
  expect(admission).toMatchObject({ acquired: true });
  const armed = await coordination.armWorkloadRecovery({ id: admission.admissionId, generation: admission.generation,
    principal: admission.principal, recoveryRequestId: 'synthetic-recovery-request' });
  expect(armed).toMatchObject({ armed: true });
  input = { host, requestId, preparationId, targetFingerprint, principal: 'benchmark-service', authority: {
    workloadId, recoveryId: armed.recoveryId, recoveryGeneration: armed.recoveryGeneration } };
  deps = { client: { getHostProfile: jest.fn(async () => ({ hostId, hostUrl: host,
    gpuDriverIdentityVersion: GPU_DRIVER_IDENTITY_VERSION, gpuDriverActivation: {
      requestId, preparationId, targetFingerprint, state: 'published' } })) },
    clearRouting: jest.fn(() => 1), clearReadiness: jest.fn(() => 2), clearContext: jest.fn(() => 3), clearModels: jest.fn(() => 4) };
});

test('only the exact live native activation reservation confirms all caches and durably records its result', async () => {
  const result = await invalidateDriverCaches(input, deps);
  expect(result).toMatchObject({ contract: 'agentx.gpu-driver-cache-invalidation/v1', requestId, preparationId,
    targetFingerprint, workloadId: input.authority.workloadId, cleared: true, generations: { routing: 1, readiness: 2, context: 3, models: 4 } });
  expect(await invalidateDriverCaches(input, deps)).toEqual(result);
  expect(deps.clearRouting).toHaveBeenCalledTimes(1);
  expect((await RuntimeCoordination.findById('runtime').select('+workloads.gpuDriverCacheReceipt').lean())
    .workloads[0].gpuDriverCacheReceipt).toEqual(result);
  await expect(coordination.acquireInference({ principal: 'synthetic-client', requestId: 'during-activation', host, model: 'synthetic-model' }))
    .resolves.toMatchObject({ acquired: false });
});

test.each(['principal', 'generation', 'workload', 'kind', 'host', 'request', 'preparation', 'fingerprint', 'publication'])
  ('refuses %s mismatches before cache invalidation', async mismatch => {
    if (mismatch === 'principal') input.principal = 'operator';
    if (mismatch === 'generation') input.authority.recoveryGeneration = 'forged-generation';
    if (mismatch === 'workload') input.authority.workloadId = 'other-workload';
    if (mismatch === 'host') input.host = 'http://other-host.example:11434';
    if (mismatch === 'request') input.requestId = 'activate-synthetic-other';
    if (mismatch === 'preparation') input.preparationId = 'prepare-synthetic-other';
    if (mismatch === 'fingerprint') input.targetFingerprint = 'b'.repeat(64);
    if (mismatch === 'kind') await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.kind': 'benchmark' } });
    if (mismatch === 'publication') deps.client.getHostProfile.mockResolvedValue({ hostId, gpuDriverIdentityVersion: GPU_DRIVER_IDENTITY_VERSION,
      gpuDriverActivation: { requestId, preparationId, targetFingerprint, state: 'pending' } });
    await expect(invalidateDriverCaches(input, deps)).rejects.toMatchObject({ code: 'GPU_DRIVER_CACHE_INVALIDATION_REFUSED' });
    expect(deps.clearRouting).not.toHaveBeenCalled();
  });

test('an unconfirmed native cache retains the reservation and writes no success receipt', async () => {
  deps.clearContext.mockReturnValue(undefined);
  await expect(invalidateDriverCaches(input, deps)).rejects.toThrow(/did not acknowledge/);
  const state = await RuntimeCoordination.findById('runtime').select('+workloads.gpuDriverCacheReceipt').lean();
  expect(state.workloads[0].gpuDriverCacheReceipt).toBeUndefined();
  expect(state.workloads[0].recoveryRequired).toBe(true);
  await expect(coordination.acquireMaintenance({ principal: 'operator', requestId: 'synthetic-maintenance', scope: 'deployment' }))
    .resolves.toMatchObject({ acquired: false });
});

test('a lost receipt response reconciles the original result without another flush', async () => {
  const update = RuntimeCoordination.updateOne.bind(RuntimeCoordination);
  jest.spyOn(RuntimeCoordination, 'updateOne').mockImplementationOnce(async (...args) => {
    await update(...args); throw new Error('synthetic receipt response lost');
  });
  await expect(invalidateDriverCaches(input, deps)).rejects.toThrow(/response lost/);
  const recorded = await invalidateDriverCaches(input, deps);
  expect(recorded.cleared).toBe(true);
  expect(deps.clearRouting).toHaveBeenCalledTimes(1);
});

test('only an adopted exact native recovery owner may finish the original invalidation after expiry', async () => {
  await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.expiresAt': new Date(Date.now() - 1000) } });
  await expect(invalidateDriverCaches(input, deps)).rejects.toThrow(/no longer owns/);
  const adopted = await coordination.adoptWorkloadRecovery({ recoveryId: input.authority.recoveryId,
    recoveryRequestId: 'synthetic-recovery-request', principal: 'benchmark-service', ownerId: 'synthetic-recovery-owner' });
  expect(adopted.adopted).toBe(true);
  input.authority.recoveryGeneration = adopted.recoveryGeneration;
  input.authority.recoveryOwnerId = adopted.recoveryOwnerId;
  await expect(invalidateDriverCaches(input, deps)).resolves.toMatchObject({ cleared: true });
});
