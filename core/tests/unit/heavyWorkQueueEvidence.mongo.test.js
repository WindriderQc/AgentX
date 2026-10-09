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
    state: 'completed', operation: { id: plan, kind: 'benchmark-preparation' }, releaseReceipt: { authority: 'operator-plan-receipt' }
  });
  expect(requestJson).not.toHaveBeenCalled();
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

it.each(['workloads', 'inferences'])('keeps unknown native %s held even after a terminal benchmark result', async field => {
  const body = make('held');
  const job = await dispatch(body);
  await queue.record(job.id, { state: 'running', dispatchId: job.dispatchId, operationId }, 'test');
  requestJson.mockResolvedValue({ data: { tags: [planTag(planId(body.executor.plan))], status: 'completed', judge_status: 'completed' } });
  await Runtime.collection.insertOne({ _id: 'runtime', [field]: [{ hosts: [A], expiresAt: new Date(0), recoveryRequired: true }] });
  expect((await evidence.reconcile(job.id, 'test')).state).toBe('running');
  await Runtime.deleteMany({});
  expect((await evidence.reconcile(job.id, 'test')).state).toBe('completed');
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
