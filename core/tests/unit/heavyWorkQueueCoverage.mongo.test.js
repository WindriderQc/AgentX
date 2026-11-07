'use strict';

const { randomUUID } = require('node:crypto');
jest.mock('../../src/helpers/crossServiceClient', () => ({ requestJson: jest.fn() }));
const { requestJson } = require('../../src/helpers/crossServiceClient');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const { refusal } = require('../../../shared/queueLaunchReceipt.cjs');
const A = 'http://127.0.0.1:11434';
const B = 'http://127.0.0.1:11435';
const nativeId = '123456789012345678901234';
let job;
let manifest;
let native;
let launches;

beforeEach(async () => {
  await Promise.all([Queue.deleteMany({}), Archive.deleteMany({}), Runtime.deleteMany({})]);
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  requestJson.mockReset();
  const requestId = randomUUID();
  manifest = { key: `coverage:${requestId}`, title: 'Synthetic coverage bite', kind: 'benchmark', hosts: [A, B],
    estimatedMinutes: 15, notBefore: new Date(Date.now() - 60000).toISOString(), startBefore: new Date(Date.now() + 60000).toISOString(),
    executor: { mode: 'coverage', requestId } };
  job = await queue.submit(manifest, 'test-coverage');
  job = await queue.reserve(job.id, { expectedRevision: job.revision, start: manifest.notBefore }, 'test-coverage');
  native = { terminal: false, uncertain: true, reason: 'No unique original coverage batch receipt' };
  launches = 0;
  requestJson.mockImplementation(async ({ path, method, body }) => {
    const current = await queue.get(job.id);
    if (method === 'GET' && path === `/api/benchmark/coverage/attempts/${requestId}`) {
      return { data: { requestId, queueId: job.id, dispatchId: current.dispatchId, manifest, ...native } };
    }
    if (method === 'POST' && path === `/api/benchmark/coverage/attempts/${requestId}/launch`) {
      launches++;
      expect(body).toEqual({ queueRequestId: job.id, queueDispatchId: current.dispatchId });
      native = { nativeId, state: 'running', runningConfirmed: true, terminal: false };
      return { data: { requestId, queueId: job.id, dispatchId: current.dispatchId, manifest, ...native } };
    }
    throw new Error(`Unexpected native call: ${method} ${path}`);
  });
});

it('launches the exact immutable native intent once through Core and records its original identity', async () => {
  const result = await launcher.launch(job.id, 'coverage', { expectedRevision: job.revision });
  expect(result).toMatchObject({ state: 'running', operation: { id: manifest.executor.requestId } });
  await expect(launcher.launch(job.id, 'coverage', { expectedRevision: result.revision })).rejects.toThrow();
  expect(launches).toBe(1);
  expect(result.events.map(event => event.action)).toEqual(['requested', 'reserved', 'dispatching', 'running']);
});

it('recovers the original native receipt after a lost response without another start', async () => {
  const send = requestJson.getMockImplementation();
  requestJson.mockImplementation(async options => {
    const result = await send(options);
    if (options.method === 'POST') throw new Error('HTTP response lost after native start');
    return result;
  });
  await expect(launcher.launch(job.id, 'coverage', { expectedRevision: job.revision })).rejects.toMatchObject({ code: 'HEAVY_QUEUE_LAUNCH_UNCERTAIN' });
  const uncertain = await queue.get(job.id);
  expect(uncertain.state).toBe('uncertain');
  expect(await evidence.reconcile(job.id, 'observer-after-restart')).toMatchObject({ state: 'running', operation: { id: manifest.executor.requestId } });
  native = { nativeId, state: 'completed', terminal: true, authority: 'benchmark.batch' };
  expect(await evidence.reconcile(job.id, 'observer-after-restart')).toMatchObject({ state: 'completed',
    releaseReceipt: { authority: 'benchmark.batch', nativeId, terminal: true } });
  expect(launches).toBe(1);
});

it('an empty or unavailable original receipt remains uncertain, with no operation invented or expiration release', async () => {
  const send = requestJson.getMockImplementation();
  requestJson.mockImplementation(async options => {
    if (options.method === 'POST') { launches++; throw new Error('dispatch response lost'); }
    return send(options);
  });
  await expect(launcher.launch(job.id, 'coverage', { expectedRevision: job.revision })).rejects.toThrow();
  expect(await evidence.reconcile(job.id, 'observer')).toMatchObject({ state: 'uncertain', operation: null });
  await expect(queue.reserve(job.id, { expectedRevision: (await queue.get(job.id)).revision, start: new Date().toISOString() }, 'coverage')).rejects.toThrow();
  await expect(launcher.launch(job.id, 'coverage', { expectedRevision: (await queue.get(job.id)).revision })).rejects.toThrow();
  expect(launches).toBe(1);
});

it('recovers a native persisted refusal when both receipt publication and HTTP response were lost', async () => {
  const send = requestJson.getMockImplementation();
  requestJson.mockImplementation(async options => {
    if (options.method === 'POST') {
      launches++;
      const current = await queue.get(job.id);
      native = { terminal: true, launchReceipt: refusal(job.id, 'benchmark', Object.assign(new Error('judge busy'), {
        notStarted: true, code: 'JUDGE_NOT_READY'
      })) };
      expect(current.dispatchId).toBeTruthy();
      throw new Error('native refusal reply lost');
    }
    return send(options);
  });
  await expect(launcher.launch(job.id, 'coverage', { expectedRevision: job.revision })).rejects.toThrow();
  expect(await evidence.reconcile(job.id, 'observer-after-restart')).toMatchObject({ state: 'failed',
    launchRefusal: { code: 'JUDGE_NOT_READY', reason: 'judge busy' } });
  expect(launches).toBe(1);
  expect((await queue.get(job.id)).events.filter(event => event.action === 'launch-refused')).toHaveLength(1);
});

it.each(['absent', 'partial'])('requires a complete native runtime snapshot (%s) before terminal release', async shape => {
  await launcher.launch(job.id, 'coverage', { expectedRevision: job.revision });
  native = { nativeId, state: 'completed', terminal: true, authority: 'benchmark.batch' };
  if (shape === 'absent') await Runtime.deleteMany({});
  else await Runtime.collection.updateOne({ _id: 'runtime' }, { $unset: { inferences: '' } });
  await expect(evidence.reconcile(job.id, 'observer')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_RELEASE_UNAVAILABLE' });
  expect((await queue.get(job.id)).state).toBe('running');
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { workloads: [], inferences: [] } }, { upsert: true });
  expect((await evidence.reconcile(job.id, 'observer')).state).toBe('completed');
});

it('keeps a terminal result fenced under foreign quarantine and leaves that native owner untouched', async () => {
  await launcher.launch(job.id, 'coverage', { expectedRevision: job.revision });
  native = { nativeId, state: 'failed', terminal: true, authority: 'benchmark.batch' };
  const holder = { workloadId: 'foreign-owner', hosts: [B], recoveryState: 'UNKNOWN', expiresAt: new Date(Date.now() - 1000) };
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { workloads: [holder] } });
  expect(await evidence.reconcile(job.id, 'observer')).toMatchObject({ state: 'uncertain' });
  expect((await Runtime.findById('runtime').lean()).workloads[0].workloadId).toBe('foreign-owner');
  expect((await queue.get(job.id)).releaseReceipt).toBeUndefined();
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { workloads: [] } });
  expect((await evidence.reconcile(job.id, 'observer')).state).toBe('failed');
  expect(launches).toBe(1);
});

it('rechecks runtime authority at terminal CAS when a holder arrives after the native observation', async () => {
  await launcher.launch(job.id, 'coverage', { expectedRevision: job.revision });
  native = { nativeId, state: 'completed', terminal: true, authority: 'benchmark.batch' };
  const observation = await evidence.observe(await queue.get(job.id));
  expect(observation.terminal).toBe(true);
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { inferences: [{ host: A, state: 'UNKNOWN', inferenceId: 'late-owner' }] } });
  await expect(queue.settle(job.id, observation, 'observer')).rejects.toThrow('native runtime authority');
  expect((await queue.get(job.id)).state).toBe('running');
  expect((await Runtime.findById('runtime').lean()).inferences[0].inferenceId).toBe('late-owner');
});

it('refuses changed or foreign intent/hosts before dispatch instead of broadening coverage', async () => {
  manifest = { ...manifest, hosts: [A] };
  await expect(launcher.launch(job.id, 'coverage', { expectedRevision: job.revision })).rejects.toMatchObject({ code: 'HEAVY_QUEUE_EXECUTOR_CHANGED' });
  expect((await queue.get(job.id)).dispatchId).toBe(null);
  expect(launches).toBe(0);
});

it.each([true, false])('rechecks native coverage policy before a Profiler start (admitted=%s)', async admitted => {
  await queue.cancel(job.id, { expectedRevision: job.revision }, 'test');
  const requestId = randomUUID();
  manifest = { ...manifest, key: `coverage:${requestId}`, kind: 'profiler', hosts: [A],
    source: { type: 'operator', ref: `benchmark-coverage:${requestId}` },
    executor: { hostId: 'fixture-a', depth: 'standard', skipRecentDays: 0, modelNames: ['fixture:model'] } };
  job = await queue.submit(manifest, 'test');
  job = await queue.reserve(job.id, { expectedRevision: job.revision, start: manifest.notBefore, autoStart: true }, 'test');
  requestJson.mockImplementation(async ({ path, method }) => {
    if (path === '/api/profiler/hosts/fixture-a') return { data: { hostUrl: A } };
    if (path === `/api/benchmark/coverage/attempts/${requestId}/admission`) {
      if (!admitted) throw new Error('coverage quiet window closed');
      return { data: { requestId, queueId: job.id, manifest, admitted: true } };
    }
    if (method === 'POST' && path === '/api/profiler/pipeline/profile-host') {
      launches++;
      return { data: { queueId: 'native-profile' } };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  if (admitted) {
    expect(await launcher.launch(job.id, 'coverage', { expectedRevision: job.revision })).toMatchObject({ state: 'running', operation: { id: 'native-profile' } });
    expect(launches).toBe(1);
    const previousRead = requestJson.getMockImplementation();
    requestJson.mockImplementation(options => options.path === '/api/profiler/pipeline/profile-host/native-profile/progress'
      ? { data: { queueRequestId: job.id, hostId: 'fixture-a', queueStatus: 'completed' } } : previousRead(options));
    await Runtime.deleteMany({});
    await expect(evidence.reconcile(job.id, 'observer')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_RELEASE_UNAVAILABLE' });
    await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
    expect((await evidence.reconcile(job.id, 'observer')).state).toBe('completed');
  } else {
    await expect(launcher.launch(job.id, 'coverage', { expectedRevision: job.revision })).rejects.toThrow('did not start');
    expect(await queue.get(job.id)).toMatchObject({ state: 'failed', launchRefusal: { reason: 'coverage quiet window closed' } });
    expect(launches).toBe(0);
  }
});

it.each(['completed', 'failed'])('publishes the native %s outcome once in the existing Core/Nestor inbox', async state => {
  const Alert = require('../../models/Alert');
  const notices = require('../../src/services/heavyWorkQueueNotifications');
  await Alert.deleteMany({});
  await launcher.launch(job.id, 'coverage', { expectedRevision: job.revision });
  native = { nativeId, state, terminal: true, authority: 'benchmark.batch' };
  const result = await evidence.reconcile(job.id, 'observer');
  await notices.publishJobs([result]);
  await notices.publishJobs([await queue.get(job.id)]);
  const inbox = await notices.inbox();
  expect(inbox.notifications.filter(row => row.queueRequestId === job.id)).toEqual([
    expect.objectContaining({ queueRequestId: job.id, state })
  ]);
  const stored = await Alert.findOne({ 'context.additionalData.queueRequestId': job.id }).lean();
  expect(stored.channels.includes('telegram')).toBe(state === 'failed');
  expect(result.events.filter(event => event.action === 'reconciled')).toHaveLength(1);
  expect(launches).toBe(1);
});
