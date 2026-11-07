'use strict';
const crypto = require('node:crypto');
jest.mock('../../src/helpers/crossServiceClient', () => ({ requestJson: jest.fn() }));
const { requestJson } = require('../../src/helpers/crossServiceClient');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const { presentation } = require('../../src/services/heavyWorkQueueReadModel');
const { autoStartable } = require('../../src/services/heavyWorkQueueCapabilities');
const HOST = 'http://127.0.0.1:11434';
let fitId, fit, starts;
const request = () => ({ key: `fixture-fit:${fitId}`, title: 'Synthetic pinned fit', kind: 'profiler', hosts: [HOST],
  estimatedMinutes: 5, executor: { mode: 'pinned-fit', hostId: 'fixture', fitCheckId: fitId } });
beforeEach(async () => {
  await Queue.deleteMany({}); await Archive.deleteMany({}); await Runtime.deleteMany({});
  fitId = crypto.randomUUID(); fit = { id: fitId, hostId: 'fixture', state: 'requested', runtimeReleased: false };
  starts = 0;
  requestJson.mockReset(); requestJson.mockImplementation(async ({ path, method, body }) => {
    if (method === 'GET' && path === '/api/profiler/hosts/fixture') return { data: { hostUrl: HOST } };
    if (method === 'GET' && path === `/api/profiler/fit-checks/${fitId}`) return { data: fit };
    if (method === 'POST' && path === '/api/profiler/fit-checks/start') {
      starts++;
      fit = { ...fit, queueRequestId: body.queueRequestId, queueDispatchId: body.queueDispatchId, state: 'dispatching' };
      return { data: fit };
    }
    throw new Error(`Unexpected fixture call ${method} ${path}`);
  });
});
async function book() {
  const job = await queue.submit(request(), 'owner'); fit.queueRequestId = job.id;
  return queue.reserve(job.id, { expectedRevision: job.revision, start: new Date(Date.now() - 1000).toISOString() }, 'owner');
}
test('only manual Run now is supported; reservation and observer cannot opt into autoStart', async () => {
  const job = await book();
  expect(autoStartable(job)).toBe(false);
  expect(presentation(job)).toMatchObject({ startMode: 'manual', capabilities: { configureAutoStart: false, runNow: true } });
  await expect(queue.reserve(job.id, { expectedRevision: job.revision, start: job.reservation.start, autoStart: true }, 'owner'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_AUTO_START_UNSUPPORTED' });
  expect(await launcher.dispatchDue()).toEqual([]); expect(starts).toBe(0);
  expect(await launcher.launch(job.id, 'owner', { expectedRevision: job.revision }))
    .toMatchObject({ state: 'running', operation: { id: fitId } });
  expect(starts).toBe(1);
  const running = await queue.get(job.id);
  expect(await queue.assertDispatch(job.id, running.dispatchId)).toMatchObject({ admitted: true, id: job.id });
  await expect(queue.assertDispatch(job.id, crypto.randomUUID())).rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_CLOSED' });
  await Queue.updateOne({ _id: 'heavy-work' }, { $set: { 'jobs.$[job].reservation.end': new Date(Date.now() - 1).toISOString() } }, { arrayFilters: [{ 'job.id': job.id }] });
  await expect(queue.assertDispatch(job.id, running.dispatchId)).rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_CLOSED' });
});
test('reads/reconciliation never launch; final receipt requires original dispatch and native release', async () => {
  const job = await book();
  await launcher.launch(job.id, 'owner', { expectedRevision: job.revision });
  let current = await queue.get(job.id);
  fit = { ...fit, state: 'unknown', status: 'unknown' };
  expect(await evidence.observe(current)).toMatchObject({ terminal: false, uncertain: true, operationId: fitId });
  fit = { ...fit, state: 'completed', runtimeReleased: false };
  expect(await evidence.observe(current)).toMatchObject({ terminal: false, uncertain: true });
  fit.runtimeReleased = true;
  await Runtime.create({ _id: 'runtime', workloads: [], inferences: [] });
  expect(await evidence.observe(current)).toMatchObject({ terminal: true, state: 'completed', authority: 'profiler.pinned-context-fit' });
  fit.queueDispatchId = crypto.randomUUID();
  await expect(evidence.observe(current)).rejects.toThrow('another request');
  expect(starts).toBe(1);
});
test('a lost start ACK discovers the same durable native fit receipt without a second launch', async () => {
  const job = await book();
  const original = requestJson.getMockImplementation();
  requestJson.mockImplementation(async options => {
    const response = await original(options);
    if (options.method === 'POST') throw new Error('Synthetic lost ACK');
    return response;
  });
  await expect(launcher.launch(job.id, 'owner', { expectedRevision: job.revision })).rejects.toThrow();
  const current = await queue.get(job.id);
  expect(current.state).toBe('uncertain');
  expect(await evidence.observe(current)).toMatchObject({ operationId: fitId, terminal: false, runningConfirmed: true });
  expect(await launcher.dispatchDue()).toEqual([]); expect(starts).toBe(1);
});
test('unknown native recovery holders prevent settlement of a passed fit', async () => {
  const job = await book(); await launcher.launch(job.id, 'owner', { expectedRevision: job.revision });
  fit = { ...fit, state: 'completed', runtimeReleased: true };
  await Runtime.create({ _id: 'runtime', workloads: [{ id: 'held', workloadId: 'fixture', requestId: 'fixture', kind: 'profiler',
    admissionId: 'fixture', acquiredAt: new Date(), heartbeatAt: new Date(),
    principal: 'fixture', generation: 'fixture', hosts: [HOST], recoveryState: 'UNKNOWN', expiresAt: new Date(Date.now() + 60000) }], inferences: [] });
  expect(await evidence.observe(await queue.get(job.id))).toMatchObject({ terminal: false, uncertain: true });
  expect(starts).toBe(1);
});
test('mismatched host receipt refuses before dispatch', async () => {
  const job = await book(); fit.hostId = 'other';
  await expect(launcher.launch(job.id, 'owner', { expectedRevision: job.revision })).rejects.toThrow('changed');
  expect((await queue.get(job.id)).state).toBe('reserved'); expect(starts).toBe(0);
});
