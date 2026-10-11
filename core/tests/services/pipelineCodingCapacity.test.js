'use strict';

jest.mock('../../src/extensions/trustedRuntimeServices', () => ({ createTrustedRuntimeServices: jest.fn() }));
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');
const PipelineTask = require('../../models/PipelineTask');
const PipelineAutomationSlot = require('../../models/PipelineAutomationSlot');
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const coordination = require('../../src/services/runtimeCoordinationService');
const capacity = require('../../src/services/pipelineCodingCapacity');
const { claimEligibleTask, heartbeatClaim, releaseAutomationSlot } = require('../../src/services/pipelineTaskService');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const { taskNextAction } = require('../../src/services/pipelineNextAction');
const { redactTaskLeaseIds } = require('../../src/services/pipelineTaskProjectionReadService');

const HOST = 'http://model.test:11434';
const REQUEST = '10000000-0000-4000-8000-000000000001';
const options = { automated: true, capacityTaskType: 'code_generation', dispatchRequestId: REQUEST, leaseDurationMs: 60000 };
let target;

async function newTask(id = '0800') {
  return PipelineTask.create({ pipelineId: id, title: 'Synthetic coding task', spec: 'Edit the permitted source.',
    status: 'queued', assignee: null, service: 'core', risk: 'low', automation: normalizePipelineAutomationIntent({
      schema: 'agentx.pipeline-automation/v1', mode: 'review_only', policyRef: 'product.low-risk-code/v1',
      dataClassification: 'public', operations: ['update'], scope: ['core/src/example.js'], sourceFiles: ['README.md'],
      lockKeys: ['repo:example'], executionProfile: 'file-tools/v1', verificationProfile: 'core-unit/v1',
      budgets: { maxDurationMs: 900000, maxAttempts: 2, maxCostNanodollars: 0 }, humanGates: ['review', 'merge'],
    }) });
}

async function busyHost() {
  return coordination.acquireInference({ principal: 'other-consumer', requestId: 'occupied', host: HOST,
    model: 'reference-model', runtimeOptions: { num_ctx: 32768 } });
}

async function freeHost(admitted) {
  return coordination.releaseInference({ id: admitted.admissionId, generation: admitted.generation, principal: admitted.principal });
}

beforeEach(async () => {
  await Promise.all([PipelineTask.deleteMany({}), PipelineAutomationSlot.deleteMany({}), RuntimeCoordination.deleteMany({})]);
  target = { model: 'reference-model', hostUrl: HOST, contextSize: 32768, keepAlive: -1,
    inferenceContract: { qualification: { qualified: true }, artifact: { digest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64) } } };
  createTrustedRuntimeServices.mockReturnValue({ routing: { getEffectiveSnapshot: async () => ({ tasks: { code_generation: target } }) } });
});
afterEach(() => jest.restoreAllMocks());

test('occupied host keeps a visible durable wait with zero attempts, then exactly one claim wins', async () => {
  await newTask();
  const occupied = await busyHost();
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'CODING_CAPACITY_WAITING' });
  let task = await PipelineTask.findOne({ pipelineId: '0800' }).lean();
  expect(task).toMatchObject({ status: 'queued', assignee: null, automationAttemptCount: 0,
    codingCapacity: { requestId: REQUEST, model: 'reference-model', host: HOST, numCtx: 32768 } });
  expect(task.automationAttempts).toHaveLength(0);
  expect(taskNextAction(task).code).toBe('wait_coding_capacity');
  const waited = task.codingCapacity.waitingSince;
  await freeHost(occupied);
  const results = await Promise.allSettled([claimEligibleTask('0800', 'worker', new Date(), options),
    claimEligibleTask('0800', 'worker', new Date(), options)]);
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  task = await PipelineTask.findOne({ pipelineId: '0800' }).lean();
  expect(task.automationAttemptCount).toBe(1);
  expect(task.codingCapacity.waitingSince).toEqual(waited);
  expect(task.codingCapacity.model).toBe('reference-model');
  const state = await RuntimeCoordination.findById('runtime').lean();
  expect(state.workloads).toHaveLength(1);
  expect(state.workloads[0]).toMatchObject({ kind: 'coding', hosts: [HOST], principal: 'core-trusted-runtime' });
  const denied = await coordination.acquireInference({ principal: 'other-consumer', requestId: 'late-race', host: HOST, model: 'reference-model' });
  expect(denied.acquired).toBe(false);
  const visible = redactTaskLeaseIds(task);
  expect(visible.codingCapacity.admissionId).toBeUndefined();
  expect(visible.codingCapacity.generation).toBeUndefined();
});

test.each(['model', 'hostUrl', 'contextSize', 'digest', 'runtimeFingerprint', 'keepAlive'])('a resumed wait refuses changed %s without consuming an attempt', async field => {
  await newTask();
  await busyHost();
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'CODING_CAPACITY_WAITING' });
  if (field === 'digest' || field === 'runtimeFingerprint') target.inferenceContract.artifact[field] = 'c'.repeat(64);
  else target[field] = typeof target[field] === 'number' ? target[field] + 1 : 'other';
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'CODING_CAPACITY_CHANGED' });
  expect((await PipelineTask.findOne({ pipelineId: '0800' })).automationAttemptCount).toBe(0);
});

test('changed request identity and changed task scope cannot adopt an existing wait', async () => {
  await newTask(); await busyHost();
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'CODING_CAPACITY_WAITING' });
  await expect(claimEligibleTask('0800', 'worker', new Date(), { ...options,
    dispatchRequestId: '20000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({ code: 'CODING_CAPACITY_CHANGED' });
  await PipelineTask.updateOne({ pipelineId: '0800' }, { $set: { spec: 'A different request' } });
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'CODING_CAPACITY_CHANGED' });
});

test('cancelling a wait preserves the queued task and zero attempts', async () => {
  await newTask(); await busyHost();
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'CODING_CAPACITY_WAITING' });
  await expect(capacity.cancel('0800', undefined)).rejects.toMatchObject({ code: 'CODING_CAPACITY_CHANGED' });
  await capacity.cancel('0800', REQUEST);
  expect(await PipelineTask.findOne({ pipelineId: '0800' }).lean()).toMatchObject({ status: 'queued', automationAttemptCount: 0 });
  expect((await PipelineTask.findOne({ pipelineId: '0800' })).codingCapacity).toBeUndefined();
});

test('cancellation racing after reservation prevents the claim and releases only that reservation', async () => {
  await newTask();
  const acquire = coordination.acquireWorkload;
  jest.spyOn(coordination, 'acquireWorkload').mockImplementationOnce(async input => {
    const reservation = await acquire(input);
    await capacity.cancel('0800', REQUEST);
    return reservation;
  });
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' });
  expect((await PipelineTask.findOne({ pipelineId: '0800' })).automationAttemptCount).toBe(0);
  expect((await coordination.listActive()).workloads).toHaveLength(0);
});

test('lost accepted acquisition cancels through its original native receipt and preserves another workload', async () => {
  await newTask();
  await coordination.acquireWorkload({ principal: 'other-owner', requestId: 'unrelated-request', workloadId: 'unrelated',
    kind: 'coding', hosts: ['http://unrelated.test:11434'] });
  const acquire = coordination.acquireWorkload;
  jest.spyOn(coordination, 'acquireWorkload').mockImplementationOnce(async input => {
    await acquire(input); throw new Error('Lost accepted acquisition reply');
  });
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toThrow('Lost accepted');
  expect((await PipelineTask.findOne({ pipelineId: '0800' }).lean()).codingCapacity).toMatchObject({
    requestId: REQUEST, admissionState: 'acquiring' });
  await capacity.cancel('0800', REQUEST);
  expect((await PipelineTask.findOne({ pipelineId: '0800' }).lean()).codingCapacity).toBeUndefined();
  const state = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  expect(state.workloads).toHaveLength(1); expect(state.workloads[0].workloadId).toBe('unrelated');
  expect(state.releaseReceipts).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: REQUEST, released: true })]));
});

test('uncertain acquisition without a native receipt retains the cancelled request and refuses false release', async () => {
  await newTask(); jest.spyOn(coordination, 'acquireWorkload').mockRejectedValueOnce(new Error('Transport outcome unknown'));
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toThrow('Transport outcome');
  await expect(capacity.cancel('0800', REQUEST)).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_REQUIRED' });
  expect((await PipelineTask.findOne({ pipelineId: '0800' }).lean()).codingCapacity).toMatchObject({
    requestId: REQUEST, admissionState: 'acquiring', cancelled: true });
  expect((await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean())?.releaseReceipts || []).toHaveLength(0);
});

test('acquisition recovery is read-only and refuses a different host or owner, including after native release', async () => {
  const identity = { principal: 'original-owner', requestId: 'original-request', workloadId: 'original-workload',
    kind: 'coding', hosts: [HOST] };
  const original = await coordination.acquireWorkload(identity);
  await expect(coordination.recoverWorkloadAcquisition({ ...identity, principal: 'another-owner' })).resolves.toMatchObject({ recovered: false });
  await expect(coordination.recoverWorkloadAcquisition({ ...identity, hosts: ['http://another.test:11434'] })).resolves.toMatchObject({ recovered: false });
  await expect(coordination.recoverWorkloadAcquisition(identity)).resolves.toMatchObject({ recovered: true,
    admissionId: original.admissionId, generation: original.generation, released: false });
  expect((await coordination.listActive()).workloads).toHaveLength(1);
  await coordination.release('workload', { id: original.admissionId, generation: original.generation, principal: identity.principal });
  await expect(coordination.recoverWorkloadAcquisition(identity)).resolves.toMatchObject({ recovered: true,
    admissionId: original.admissionId, generation: original.generation, released: true });
  expect((await coordination.listActive()).workloads).toHaveLength(0);
});

test('lost acquisition whose original native receipt is quarantined cannot be declared cancelled', async () => {
  await newTask(); const acquire = coordination.acquireWorkload;
  jest.spyOn(coordination, 'acquireWorkload').mockImplementationOnce(async input => {
    const original = await acquire(input);
    await RuntimeCoordination.updateOne({ _id: 'runtime', 'workloads.admissionId': original.admissionId },
      { $set: { 'workloads.$.recoveryState': 'UNKNOWN' } });
    throw new Error('Lost accepted acquisition reply');
  });
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toThrow('Lost accepted');
  await expect(capacity.cancel('0800', REQUEST)).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_REQUIRED' });
  expect((await PipelineTask.findOne({ pipelineId: '0800' }).lean()).codingCapacity).toMatchObject({
    requestId: REQUEST, admissionState: 'admitted', cancelled: true });
  expect((await coordination.listActive()).workloads).toHaveLength(1);
});

test('only the exact active task, host, artifact and context can borrow the reservation', async () => {
  await newTask();
  const task = await claimEligibleTask('0800', 'worker', new Date(), options);
  const identity = { pipelineId: '0800', leaseId: task.automationLease.leaseId };
  const input = { model: target.model, hostUrl: HOST, numCtx: 32768, inferenceContract: target.inferenceContract };
  const authority = await capacity.authorizeInference(identity, input);
  expect(authority).toMatchObject({ principal: 'core-trusted-runtime', workloadAdmissionId: task.codingCapacity.admissionId });
  await expect(capacity.authorizeInference({ ...identity, leaseId: 'foreign' }, input)).rejects.toMatchObject({ code: 'CODING_CAPACITY_PROOF_INVALID' });
  await expect(capacity.authorizeInference(identity, { ...input, numCtx: 8192 })).rejects.toMatchObject({ code: 'CODING_CAPACITY_PROOF_INVALID' });
  const admitted = await coordination.acquireInference({ ...authority, principal: authority.principal,
    host: HOST, model: target.model, requestId: 'worker-turn', runtimeOptions: { num_ctx: 32768 } });
  expect(admitted.acquired).toBe(true);
  await heartbeatClaim('0800', { assignee: 'worker', leaseId: identity.leaseId });
  expect((await coordination.listActive()).workloads).toHaveLength(1);
  await expect(capacity.release(task.codingCapacity)).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_REQUIRED' });
  await freeHost(admitted);
  await PipelineTask.updateOne({ pipelineId: '0800' }, { $set: { status: 'review' }, $unset: { automationLease: 1 } });
  await releaseAutomationSlot({ pipelineId: '0800', leaseId: identity.leaseId, assignee: 'worker' });
  expect((await coordination.listActive()).workloads).toHaveLength(0);
  expect((await PipelineTask.findOne({ pipelineId: '0800' })).codingCapacity).toBeUndefined();
});

test('unknown inference retains capacity and prevents another dispatch even after a task verdict', async () => {
  await newTask();
  const task = await claimEligibleTask('0800', 'worker', new Date(), options);
  const admitted = await coordination.acquireInference({ principal: 'core-trusted-runtime', requestId: 'unknown-turn',
    workloadAdmissionId: task.codingCapacity.admissionId, workloadGeneration: task.codingCapacity.generation,
    host: HOST, model: target.model });
  await coordination.markInferenceUnknown({ id: admitted.admissionId, generation: admitted.generation, principal: admitted.principal });
  await PipelineTask.updateOne({ pipelineId: '0800' }, { $set: { status: 'blocked' } });
  await expect(releaseAutomationSlot({ pipelineId: '0800', leaseId: task.automationLease.leaseId, assignee: 'worker' }))
    .rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_REQUIRED' });
  expect((await coordination.listActive()).workloads).toHaveLength(1);
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' });
});


test('autonomous capacity outside the approved campaign refuses before acquiring any workload', async () => {
  await newTask(); await PipelineTask.updateOne({ pipelineId: '0800' }, { $set: { codingAutonomy: { authorized: true } } });
  const autonomy = require('../../src/services/pipelineCodingAutonomyService');
  jest.spyOn(autonomy, 'workerManifest').mockResolvedValue({});
  jest.spyOn(autonomy, 'campaign').mockRejectedValue(Object.assign(new Error('Host outside campaign'), { code: 'CODING_AUTONOMY_QUEUE_WAIT' }));
  const acquire = jest.spyOn(coordination, 'acquireWorkload');
  await expect(claimEligibleTask('0800', 'worker', new Date(), options)).rejects.toMatchObject({ code: 'CODING_AUTONOMY_QUEUE_WAIT' });
  expect(acquire).not.toHaveBeenCalled();
  expect((await PipelineTask.findOne({ pipelineId: '0800' }).lean()).automationAttemptCount).toBe(0);
});
