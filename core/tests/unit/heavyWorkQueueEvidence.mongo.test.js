'use strict';

jest.mock('../../src/helpers/crossServiceClient', () => ({ requestJson: jest.fn() }));
const { requestJson } = require('../../src/helpers/crossServiceClient');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const Images = require('../../models/ImageOperation');
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const { newPlanRef, planId, planTag } = require('../../../shared/benchmarkBatchPlan.cjs');
const A = 'http://127.0.0.1:11434';
const B = 'http://127.0.0.1:11435';
const request = { host: A, model: 'synthetic:fixture', categories: ['coding'], levels: [1], repeats: 1,
  judgeHost: B, judgeModel: 'synthetic:judge', name: null, tag: null };
const operationId = '000000000000000000000001';
const make = key => ({ key, title: 'Synthetic benchmark receipt fixture', kind: 'benchmark', hosts: [A, B], estimatedMinutes: 10,
  executor: { plan: newPlanRef(request), request } });
async function dispatch(body) {
  const job = await queue.submit(body, 'test');
  const ready = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date(Date.now() - 1000).toISOString() }, 'test');
  return queue.begin(job.id, { expectedRevision: ready.revision }, 'test');
}
beforeEach(async () => {
  await Queue.deleteMany({}); await Archive.deleteMany({}); await Runtime.deleteMany({});
  await Images.deleteMany({});
  jest.restoreAllMocks();
  requestJson.mockReset();
});

it('binds the exact prepared plan and both execution/judge endpoints before dispatch', async () => {
  const body = make('bound');
  const job = await queue.submit(body, 'test');
  await expect(evidence.preDispatch(job)).resolves.toBeUndefined();
  await expect(evidence.preDispatch({ ...job, hosts: [A] })).rejects.toMatchObject({ code: 'HEAVY_QUEUE_EXECUTOR_CHANGED' });
  await expect(evidence.preDispatch({ ...job, executor: { ...job.executor, request: { ...request, repeats: 2 } } })).rejects.toMatchObject({ statusCode: 409 });
  expect(requestJson).not.toHaveBeenCalled();
});

it('queues preparation before its probes and retains its exact plan without starting a batch', async () => {
  const body = { ...make('prepare'), executor: { prepare: true, request } };
  const job = await dispatch(body);
  await expect(evidence.preDispatch(job)).resolves.toBeUndefined();
  const plan = newPlanRef(request);
  await expect(queue.prepared(job.id, { dispatchId: job.dispatchId, plan }, 'native-operator')).resolves.toMatchObject({
    state: 'dispatching', operation: { id: plan, kind: 'benchmark-preparation' }, preparationReceipt: { authority: 'operator-plan-receipt' }
  });
  await expect(evidence.reconcile(job.id, 'observer')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_RELEASE_UNAVAILABLE' });
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  expect(await evidence.reconcile(job.id, 'observer-after-restart')).toMatchObject({ state: 'completed', releaseReceipt: { preparedPlan: plan } });
  expect(requestJson).not.toHaveBeenCalled();
});

const refusal = { code: 'PREFLIGHT_NOT_READY', reason: 'Synthetic profile is not qualified' };
const refusedPreparation = async key => {
  const job = await dispatch({ ...make(key), executor: { prepare: true, request } });
  return queue.prepared(job.id, { dispatchId: job.dispatchId, refusal }, 'native-operator');
};

it('durably records a preparation refusal and frees both hosts only after release is verified', async () => {
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  const job = await refusedPreparation('refused');
  expect(job).toMatchObject({ state: 'dispatching', preparationRefusal: { ...refusal, dispatchId: job.dispatchId } });
  const next = await queue.submit({ ...make('next'), executor: { prepare: true, request } }, 'test');
  const slot = { expectedRevision: next.revision, start: new Date().toISOString() };
  await expect(queue.reserve(next.id, slot, 'test')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_CONFLICT' });
  const settled = await evidence.reconcile(job.id, 'core-queue-observer');
  expect(settled).toMatchObject({ state: 'failed', reason: refusal.reason,
    releaseReceipt: { authority: 'operator-preparation-refusal', refusal: { ...refusal, actor: 'native-operator' } } });
  await expect(queue.reserve(next.id, slot, 'test')).resolves.toMatchObject({ state: 'reserved' });
  const replay = await queue.prepared(job.id, { dispatchId: job.dispatchId, refusal }, 'native-operator');
  expect(replay.revision).toBe(settled.revision);
  expect(requestJson).not.toHaveBeenCalled();
});

it.each(['workloads', 'inferences'])('retains refused preparation evidence while %s remain quarantined, then reconciles the same ID', async field => {
  const job = await refusedPreparation(`refused-held-${field}`);
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [], [field]: [
    { hosts: [B], expiresAt: new Date(0), recoveryState: 'UNKNOWN' }
  ] });
  expect((await evidence.reconcile(job.id, 'observer')).state).toBe('uncertain');
  // Native owner release is simulated; reconciliation itself never clears it.
  expect((await Runtime.findById('runtime').lean())[field]).toHaveLength(1);
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { [field]: [] } });
  expect((await evidence.reconcile(job.id, 'observer-after-restart')).state).toBe('failed');
  expect(requestJson).not.toHaveBeenCalled();
});

it('keeps an unknown preparation or missing release snapshot fenced without guessing a batch result', async () => {
  const unknown = await dispatch({ ...make('unknown-prepare'), executor: { prepare: true, request } });
  await expect(evidence.reconcile(unknown.id, 'observer')).rejects.toThrow('receipt');
  await queue.prepared(unknown.id, { dispatchId: unknown.dispatchId, refusal }, 'native-operator');
  await expect(evidence.reconcile(unknown.id, 'observer')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_RELEASE_UNAVAILABLE' });
  expect((await queue.get(unknown.id)).state).toBe('dispatching');
  expect(requestJson).not.toHaveBeenCalled();
});

it('rechecks a new native holder before committing the refused preparation release', async () => {
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  const job = await refusedPreparation('release-race');
  const observation = await evidence.observe(job);
  expect(observation.terminal).toBe(true);
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { inferences: [{ host: B, state: 'ACTIVE', expiresAt: new Date(Date.now() + 60000) }] } });
  await expect(queue.settle(job.id, observation, 'observer')).rejects.toMatchObject({ statusCode: 409 });
  expect((await queue.get(job.id)).state).toBe('dispatching');
  expect((await Runtime.findById('runtime').lean()).inferences).toHaveLength(1);
});

it('rejects refusal receipts for another dispatch, batch start, plan or prior outcome', async () => {
  const job = await refusedPreparation('bound-refusal');
  for (const body of [{ dispatchId: 'another', refusal }, { dispatchId: job.dispatchId, refusal: { ...refusal, code: 'CHANGED' } },
    { dispatchId: job.dispatchId, refusal, plan: newPlanRef(request) }]) {
    await expect(queue.prepared(job.id, body, 'test')).rejects.toMatchObject({ statusCode: 409 });
  }
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  await evidence.reconcile(job.id, 'observer');
  const batch = await dispatch(make('not-preparation'));
  await expect(queue.prepared(batch.id, { dispatchId: batch.dispatchId, refusal }, 'test')).rejects.toMatchObject({ statusCode: 409 });
});

it('finds a lost launch by its native plan tag and settles only its own terminal receipt', async () => {
  const body = make('lost');
  const job = await dispatch(body);
  requestJson.mockImplementation(async ({ path }) => ({ data: path.includes('/batches?')
    ? { batches: [{ _id: operationId }] }
    : { tags: [planTag(planId(body.executor.plan))], status: 'completed', judge_status: 'completed' } }));
  const settled = await evidence.reconcile(job.id, 'test-observer');
  expect(settled).toMatchObject({ state: 'completed', operation: { id: operationId }, releaseReceipt: { authority: 'benchmark.batch' } });
  expect(requestJson.mock.calls.every(([options]) => options.method === 'GET')).toBe(true);
});

it.each(['workloads', 'inferences'])('keeps unknown native %s held after a terminal result and says so', async field => {
  const body = make('held');
  const job = await dispatch(body);
  await queue.record(job.id, { state: 'running', dispatchId: job.dispatchId, operationId }, 'test');
  requestJson.mockResolvedValue({ data: { tags: [planTag(planId(body.executor.plan))], status: 'completed', judge_status: 'completed' } });
  await Runtime.collection.insertOne({ _id: 'runtime', [field]: [{ hosts: [A], expiresAt: new Date(0), recoveryRequired: true }] });
  // A quarantine waits for an operator: the request turns uncertain, which
  // raises the queue notification, instead of looking like a run in progress.
  const held = await evidence.reconcile(job.id, 'test');
  expect(held).toMatchObject({ state: 'uncertain', reason: expect.stringContaining('recovery quarantine') });
  await Runtime.deleteMany({});
  expect((await evidence.reconcile(job.id, 'test')).state).toBe('completed');
});

it('keeps a request running while its runtime release is still ordinary', async () => {
  const body = make('releasing');
  const job = await dispatch(body);
  await queue.record(job.id, { state: 'running', dispatchId: job.dispatchId, operationId }, 'test');
  requestJson.mockResolvedValue({ data: { tags: [planTag(planId(body.executor.plan))], status: 'completed', judge_status: 'completed' } });
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [{ hosts: [A], expiresAt: new Date(Date.now() + 60_000), recoveryState: 'PREPARED' }] });
  expect((await evidence.reconcile(job.id, 'test')).state).toBe('running');
});

it('turns a failed Profiler run held in UNKNOWN recovery into an uncertain request (2026-10-20)', async () => {
  const job = await dispatch({ key: 'profiler-held', title: 'Synthetic profiler fixture', kind: 'profiler', hosts: [A],
    estimatedMinutes: 90, executor: { hostId: 'primary' } });
  requestJson.mockImplementation(async ({ path }) => ({ data: path.includes('/progress')
    ? { queueStatus: 'failed', queueRequestId: job.id, hostId: 'primary' }
    : { active: [{ queueRequestId: job.id, queueId: 'q-held' }] } }));
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [{ hosts: [A], kind: 'profiler',
    expiresAt: new Date(Date.now() + 60_000), recoveryState: 'UNKNOWN' }] });
  const held = await evidence.reconcile(job.id, 'test');
  expect(held).toMatchObject({ state: 'uncertain', reason: expect.stringContaining('Native outcome failed') });
});

it('never attaches an unrelated native batch or infers completion from a read failure', async () => {
  const body = make('foreign');
  const job = await dispatch(body);
  await queue.record(job.id, { state: 'running', dispatchId: job.dispatchId, operationId }, 'test');
  requestJson.mockResolvedValue({ data: { tags: ['another-plan'], status: 'completed' } });
  await expect(evidence.reconcile(job.id, 'test')).rejects.toMatchObject({ statusCode: 409 });
  requestJson.mockRejectedValue(new Error('Synthetic service unavailable'));
  await expect(evidence.reconcile(job.id, 'test')).rejects.toThrow('unavailable');
  expect((await queue.get(job.id)).state).toBe('running');
});

it('refuses an image action identity already used for a different prompt before dispatch', async () => {
  const config = { ollamaHosts: [A], defaultProfile: 'synthetic',
    profiles: { synthetic: { family: 'klein', maxPixels: 262144 } } };
  jest.spyOn(require('../../src/services/images/config'), 'loadConfig').mockReturnValue(config);
  const executor = { actionKey: 'synthetic-image-action', prompt: 'Synthetic fixture', width: 512, height: 512, seed: 1 };
  const job = await queue.submit({ key: 'image-bound', title: 'Synthetic image fixture', kind: 'image',
    hosts: [A], estimatedMinutes: 5, executor }, 'test');
  await expect(evidence.preDispatch(job)).resolves.toBeUndefined();
  await Images.collection.insertOne({ _id: 'synthetic-image-receipt', actionKey: executor.actionKey, requestHash: 'another-request' });
  await expect(evidence.preDispatch(job)).rejects.toMatchObject({ statusCode: 409 });
  expect((await queue.get(job.id)).state).toBe('requested');
});

it('lets a profiler request cover sibling endpoints of its own machine and nothing else', async () => {
  requestJson.mockResolvedValue({ data: { hostUrl: A } });
  const profile = (key, hostList) => ({ key, title: 'Synthetic profiler fixture', kind: 'profiler', hosts: hostList,
    estimatedMinutes: 10, executor: { hostId: 'gpu', depth: 'full', skipRecentDays: 0, modelNames: ['synthetic:fixture'] } });
  await expect(evidence.preDispatch(await queue.submit(profile('lane-only', [A]), 'test'))).resolves.toBeUndefined();
  await expect(evidence.preDispatch(await queue.submit(profile('lane-and-sibling', [A, B]), 'test'))).resolves.toBeUndefined();
  await expect(evidence.preDispatch(await queue.submit(profile('other-machine', [A, 'http://127.0.0.2:11434']), 'test')))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_EXECUTOR_CHANGED' });
  await expect(evidence.preDispatch(await queue.submit(profile('sibling-only', [B]), 'test')))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_EXECUTOR_CHANGED' });
});

it('persists a launch refusal before checking release and accepts only the same dispatch and outcome', async () => {
  const job = await dispatch(make('batch-refused'));
  const body = { dispatchId: job.dispatchId, code: 'PLAN_STALE', reason: 'Synthetic stale plan before batch POST' };
  const saved = await queue.refused(job.id, body, 'native-operator');
  expect(saved).toMatchObject({ state: 'dispatching', launchRefusal: body });
  expect((await queue.refused(job.id, body, 'native-operator')).revision).toBe(saved.revision);
  for (const changed of [{ ...body, dispatchId: 'foreign' }, { ...body, reason: 'changed' }]) {
    await expect(queue.refused(job.id, changed, 'native-operator')).rejects.toMatchObject({ statusCode: 409 });
  }
  await expect(evidence.reconcile(job.id, 'observer')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_RELEASE_UNAVAILABLE' });
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  const proof = await evidence.observe(saved);
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { inferences: [{ host: A, state: 'ACTIVE', expiresAt: new Date(Date.now() + 60000) }] } });
  await expect(queue.settle(job.id, proof, 'observer')).rejects.toMatchObject({ statusCode: 409 });
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { inferences: [] } });
  expect(await evidence.reconcile(job.id, 'observer')).toMatchObject({ state: 'failed', releaseReceipt: { authority: 'operator-launch-refusal' } });
  expect(requestJson).not.toHaveBeenCalled();
});

it('rejects a no-start verdict after native operation bookkeeping already exists', async () => {
  const job = await dispatch(make('already-started'));
  await queue.record(job.id, { dispatchId: job.dispatchId, state: 'running', operationId }, 'native-operator');
  await expect(queue.refused(job.id, { dispatchId: job.dispatchId, code: 'REFUSED', reason: 'Cannot erase launch' }, 'native-operator'))
    .rejects.toMatchObject({ statusCode: 409 });
  expect((await queue.get(job.id)).operation.id).toBe(operationId);
});

it('restores running observation from the same native receipt after an attached receipt outage, without relaunch', async () => {
  const job = await dispatch({ key: 'native-receipt-returned', title: 'Synthetic recovering profiler', kind: 'profiler', hosts: [A],
    estimatedMinutes: 480, executor: { hostId: 'primary' } });
  await queue.record(job.id, { state: 'running', dispatchId: job.dispatchId, operationId: 'original-profile' }, 'test');
  await queue.record(job.id, { state: 'uncertain', dispatchId: job.dispatchId, reason: 'Synthetic receipt read outage' }, 'observer');
  requestJson.mockResolvedValue({ data: { queueRequestId: job.id, hostId: 'primary', queueStatus: 'running', launchConfirmed: true } });
  expect(await evidence.reconcile(job.id, 'observer')).toMatchObject({ state: 'running', operation: { id: 'original-profile' } });
  expect(requestJson.mock.calls).toHaveLength(1);
  expect(requestJson.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/api/profiler/pipeline/profile-host/original-profile/progress' });
});
