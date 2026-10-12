'use strict';
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Runtime = require('../../models/RuntimeCoordination');
const coordination = require('../../src/services/runtimeCoordinationService');
const service = require('../../src/services/pipelineCodingCapacityRecovery');

const REQUEST = '10000000-0000-4000-8000-000000000001';
const HOST = 'http://coding.invalid:11434';
const PRINCIPAL = 'core-trusted-runtime';
const body = { confirm: true, confirmation: service.CONFIRMATION,
  key: 'synthetic-capacity-recovery', workerTerminated: true };
const snapshot = [{ name: 'synthetic-model', digest: 'a'.repeat(64), context_length: 4096,
  size: 1000, size_vram: 1000, expires_at: '2319-01-01T00:00:00Z' }];
let deps, parent, child;
const prepare = input => service.prepare('0001', REQUEST, input || body, deps);
const complete = () => service.complete('0001', REQUEST, body, deps);
const raw = () => Runtime.findById('runtime').select('+releaseReceipts').lean();

beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Settings.deleteMany({}), Runtime.deleteMany({})]);
  await Settings.create({ _id: 'coding-autonomy', enabled: false,
    active: { pipelineId: '0001', requestId: REQUEST, selectedAt: new Date().toISOString() } });
  const end = new Date(Date.now() - 1000);
  await Task.create({ pipelineId: '0001', title: 'Synthetic stopped coding', spec: 'Disposable recovery fixture',
    service: 'agentx-coding', status: 'blocked', assignee: 'coding-team',
    automationAttempts: [{ leaseId: 'synthetic-lease', dispatchRequestId: REQUEST, assignee: 'coding-team', attempt: 1,
      acquiredAt: end, heartbeatAt: end, expiresAt: end, completedAt: end, finalState: 'blocked',
      resultRequestFingerprint: 'b'.repeat(64) }], automationAttemptCount: 1,
    codingCapacity: { requestId: REQUEST, host: HOST, model: 'synthetic-model', digest: 'a'.repeat(64), numCtx: 4096, keepAlive: -1 },
    codingAutonomy: { authorized: false, state: 'blocked', spent: { modelSeconds: 5401 },
      runs: [{ requestId: REQUEST, modelReceipts: [{ callId: 'historical-call', state: 'unknown' }], pendingInferences: ['historical-call'] }] } });
  parent = await coordination.acquireWorkload({ principal: PRINCIPAL, requestId: REQUEST,
    workloadId: `coding:0001:${REQUEST}`, kind: 'coding', hosts: [HOST], ttl: 60000 });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingCapacity.admissionId': parent.admissionId,
    'codingCapacity.generation': parent.generation } });
  child = await coordination.acquireInference({ principal: PRINCIPAL, requestId: 'synthetic-model-call', host: HOST,
    model: 'synthetic-model', workloadAdmissionId: parent.admissionId, workloadGeneration: parent.generation,
    runtimeOptions: { num_ctx: 4096 } });
  expect(child.acquired).toBe(true);
  await coordination.markInferenceUnknown({ id: child.admissionId, generation: child.generation, principal: PRINCIPAL, reason: 'synthetic abort' });
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.expiresAt': end } });
  deps = { control: { status: async () => ({ available: true, busy: false, run: { requestId: REQUEST,
    pipelineId: '0001', phase: 'unknown', progress: { requestId: REQUEST, pipelineId: '0001' } } }) }, readPs: async () => snapshot };
});
afterEach(() => jest.restoreAllMocks());

async function recoverChild() {
  const receipt = { contract: 'agentx.ollama-runtime-restart/v1', runtimeRestarted: true,
    confirmation: 'OLLAMA_RUNTIME_RESTARTED_AND_PRIOR_REQUESTS_TERMINATED', restartedAt: new Date().toISOString() };
  const proof = { id: child.admissionId, generation: child.generation, receipt };
  const result = await coordination.recoverInferenceAfterRuntimeRestart(proof);
  expect(result.recovered).toBe(true);
  return { result, proof };
}

test('original owner adopts an expired fence, preserves UNKNOWN history and releases only after resident restoration', async () => {
  const before = (await Task.findOne({ pipelineId: '0001' }).lean()).codingAutonomy;
  const first = await prepare();
  const again = await prepare();
  expect(again.recoveryGeneration).toBe(first.recoveryGeneration);
  const projected = require('../../src/services/pipelineTaskProjectionReadService').redactTaskLeaseIds(
    await Task.findOne({ pipelineId: '0001' }).lean());
  expect(projected.codingCapacityRecovery).toEqual({ key: body.key, requestId: REQUEST, state: 'prepared' });
  expect((await raw()).workloads[0].recoveryState).toBe('UNKNOWN');
  await expect(complete()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  await recoverChild();
  deps.readPs = async () => [{ ...snapshot[0], context_length: 8192 }];
  await expect(complete()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  expect((await raw()).workloads).toHaveLength(1);
  deps.readPs = async () => snapshot;
  expect(await complete()).toMatchObject({ released: true, admissionId: parent.admissionId, recoveryState: 'RESTORED' });
  expect(await complete()).toMatchObject({ released: true, idempotent: true });
  expect((await raw()).workloads).toHaveLength(0);
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).codingAutonomy).toEqual(before);
  expect((await Settings.findById('coding-autonomy')).active.requestId).toBe(REQUEST);
});

test.each(['workerTerminated', 'confirm'])('missing %s attestation cannot adopt or alter authority', async field => {
  await expect(prepare({ ...body, [field]: false })).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  expect((await raw()).workloads[0].recoveryOwnerId).toBeNull();
});

test('active original worker, changed key or model history refuses', async () => {
  const status = deps.control.status;
  deps.control.status = async () => ({ ...(await status()), busy: true });
  await expect(prepare()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  deps.control.status = status;
  await prepare();
  await expect(prepare({ ...body, key: 'replacement' })).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.runs.0.modelReceipts.0.state': 'completed' } });
  await expect(complete()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
});

test('adoption fences activation and refuses a substituted original capacity proof', async () => {
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingCapacity.generation': 'substitute' } });
  await expect(prepare()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingCapacity.generation': parent.generation } });
  await prepare();
  const settings = await Settings.findById('coding-autonomy').lean();
  const autonomy = require('../../src/services/pipelineCodingAutonomyService');
  autonomy.configureControl({ target: 'synthetic', status: deps.control.status });
  await expect(autonomy.configure({ confirm: true, enabled: true, expectedRevision: settings.revision })).rejects.toThrow();
});

test('a lost prepared-write acknowledgement is re-acknowledged before any adoption effect', async () => {
  const original = Task.updateOne;
  const mock = jest.spyOn(Task, 'updateOne').mockImplementationOnce(async function (...args) {
    const result = await original.apply(this, args);
    return { ...result, acknowledged: false };
  });
  await expect(prepare()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  expect((await raw()).workloads[0].recoveryOwnerId).toBeNull();
  mock.mockRestore();
  expect(await prepare()).toMatchObject({ prepared: true });
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).codingCapacityRecovery.acknowledgedAt).toBeDefined();
});

test('lost restart acknowledgement replays original durable receipt and refuses changed evidence', async () => {
  const { result, proof } = await recoverChild();
  expect(await coordination.recoverInferenceAfterRuntimeRestart(proof)).toMatchObject({ recovered: true, idempotent: true, receipt: result.receipt });
  expect((await raw()).releaseReceipts).toEqual(expect.arrayContaining([expect.objectContaining({
    admissionId: child.admissionId, recovered: true, state: 'UNKNOWN', unknownReason: 'synthetic abort' })]));
  const changed = { ...proof, receipt: { ...proof.receipt, restartedAt: new Date(Date.now() + 1000).toISOString() } };
  expect(await coordination.recoverInferenceAfterRuntimeRestart(changed)).toMatchObject({ recovered: false });
});

test('coding owner recovers only its journalled children with the same verified restart receipt', async () => {
  await prepare();
  const input = { ...body, restartReceipt: { contract: 'agentx.ollama-runtime-restart/v1', runtimeRestarted: true,
    confirmation: 'OLLAMA_RUNTIME_RESTARTED_AND_PRIOR_REQUESTS_TERMINATED', restartedAt: new Date().toISOString() } };
  expect(await service.recoverChildren('0001', REQUEST, input, deps)).toMatchObject({ recovered: true,
    children: [expect.objectContaining({ admissionId: child.admissionId, state: 'UNKNOWN' })] });
  expect(await service.recoverChildren('0001', REQUEST, input, deps)).toMatchObject({ recovered: true,
    children: [expect.objectContaining({ idempotent: true })] });
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).codingAutonomy.runs[0].pendingInferences).toEqual(['historical-call']);
});

test('an inference racing with recovered workload release retains the native parent atomically', async () => {
  await prepare(); await recoverChild();
  const resolve = coordination.resolveWorkloadRecovery;
  jest.spyOn(coordination, 'resolveWorkloadRecovery').mockImplementationOnce(async proof => {
    await Runtime.updateOne({ _id: 'runtime' }, { $push: { inferences: { admissionId: 'late-child', generation: 'late-generation',
      principal: PRINCIPAL, requestId: 'late-request', host: HOST, model: 'synthetic-model', kind: 'synthetic', residencyKey: 'synthetic',
      workloadAdmissionId: parent.admissionId, workloadGeneration: parent.generation, acquiredAt: new Date(),
      heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60000), state: 'UNKNOWN' } } });
    return resolve(proof);
  });
  await expect(complete()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  expect((await raw()).workloads[0].recoveryState).toBe('RESTORED');
});

test('model journal changes during residency read cannot authorize recovery release', async () => {
  await prepare(); await recoverChild();
  deps.readPs = async () => {
    await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.runs.0.modelReceipts.0.state': 'completed' } });
    return snapshot;
  };
  await expect(complete()).rejects.toMatchObject({ code: 'CODING_CAPACITY_RECOVERY_UNVERIFIED' });
  expect((await raw()).workloads).toHaveLength(1);
  expect((await Settings.findById('coding-autonomy')).active.recovery.kind).toBe('coding-capacity');
});
