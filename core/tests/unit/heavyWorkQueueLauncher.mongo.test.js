'use strict';

jest.mock('../../src/helpers/crossServiceClient', () => ({ requestJson: jest.fn() }));
const { requestJson } = require('../../src/helpers/crossServiceClient');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const A = 'http://127.0.0.1:11434';
const B = 'http://127.0.0.1:11435';
const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const profile = (key, host = A) => ({ key, title: 'Synthetic Profiler fixture', kind: 'profiler', hosts: [host], estimatedMinutes: 30,
  executor: { hostId: host === A ? 'fixture-a' : 'fixture-b', depth: 'full', skipRecentDays: 0, modelNames: ['synthetic:model'] } });
// Benchmark answers its host lookup (pre-dispatch) and the profile start.
function benchmarkAnswers({ start = { queueId: 'profile-1' } } = {}) {
  requestJson.mockImplementation(async ({ path, method }) => {
    if (method === 'GET' && path.startsWith('/api/profiler/hosts/fixture-a')) return { data: { hostUrl: A } };
    if (method === 'GET' && path.startsWith('/api/profiler/hosts/fixture-b')) return { data: { hostUrl: B } };
    if (method === 'POST' && path === '/api/profiler/pipeline/profile-host') {
      if (start instanceof Error) throw start;
      return { status: 'success', data: start };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
}
const starts = () => requestJson.mock.calls.filter(([options]) => options.method === 'POST');

beforeEach(async () => {
  await Queue.deleteMany({}); await Archive.deleteMany({}); await Runtime.deleteMany({});
  requestJson.mockReset();
});

it('records the owner opt-in on the reservation and refuses it for kinds Core cannot launch', async () => {
  const job = await queue.submit(profile('opt-in'), 'test');
  const booked = await queue.reserve(job.id, { expectedRevision: job.revision, start: at(10), autoStart: true }, 'owner');
  expect(booked.reservation).toMatchObject({ autoStart: true, estimated: true });
  expect(booked.events.at(-1)).toMatchObject({ action: 'reserved', details: { autoStart: true } });
  const plain = await queue.reserve(job.id, { expectedRevision: booked.revision, start: at(10) }, 'owner');
  expect(plain.reservation.autoStart).toBe(false);
  await expect(queue.reserve(job.id, { expectedRevision: plain.revision, start: at(10), autoStart: 'yes' }, 'owner')).rejects.toMatchObject({ statusCode: 400 });
  const custom = await queue.submit({ key: 'custom', title: 'Synthetic operator fixture', kind: 'diagnostic', hosts: [B], estimatedMinutes: 5,
    executor: { mode: 'operator', receiptRef: '/outside/git/receipt.json' } }, 'test');
  await expect(queue.reserve(custom.id, { expectedRevision: custom.revision, start: at(10), autoStart: true }, 'owner'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_AUTO_START_UNSUPPORTED' });
});

it('starts only opted-in reservations whose slot is open, once, and records the Profiler identity', async () => {
  benchmarkAnswers();
  const due = await queue.submit(profile('due'), 'test');
  await queue.reserve(due.id, { expectedRevision: due.revision, start: at(-1), autoStart: true }, 'owner');
  const manual = await queue.submit(profile('manual', B), 'test');
  await queue.reserve(manual.id, { expectedRevision: manual.revision, start: at(-1) }, 'owner');
  const later = await queue.submit(profile('later', B), 'test');
  await queue.reserve(later.id, { expectedRevision: later.revision, start: at(60), autoStart: true }, 'owner');

  const launched = await launcher.dispatchDue();
  expect(launched.map(job => job.id)).toEqual([due.id]);
  expect(await queue.get(due.id)).toMatchObject({ state: 'running', operation: { id: 'profile-1' } });
  expect(starts()).toHaveLength(1);
  expect(starts()[0][0].body).toEqual({ hostId: 'fixture-a', depth: 'full', skipRecentDays: 0,
    modelNames: ['synthetic:model'], queueRequestId: due.id });
  expect((await queue.get(due.id)).events.map(item => item.actor)).toContain('core-auto-start');
  expect((await queue.get(manual.id)).state).toBe('reserved');
  expect((await queue.get(later.id)).state).toBe('reserved');

  await launcher.dispatchDue();
  expect(starts()).toHaveLength(1);
});

it('leaves a lost launch uncertain and never retries it on the next sweep', async () => {
  benchmarkAnswers({ start: new Error('Synthetic socket hang up') });
  const job = await queue.submit(profile('lost'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  const after = await queue.get(job.id);
  expect(after.state).toBe('uncertain');
  expect(after.reason).toMatch(/not retried/);
  await launcher.dispatchDue();
  expect(starts()).toHaveLength(1);
});

it('waits without a dispatch mark while another request holds the same host', async () => {
  benchmarkAnswers();
  const first = await queue.submit(profile('first'), 'test');
  await queue.reserve(first.id, { expectedRevision: first.revision, start: at(-1), autoStart: true }, 'owner');
  const held = await queue.get(first.id);
  await queue.begin(first.id, { expectedRevision: held.revision }, 'operator');
  const second = await queue.submit(profile('second'), 'test');
  // The overlap check refuses a reservation beside active work on this host.
  await expect(queue.reserve(second.id, { expectedRevision: second.revision, start: at(-1), autoStart: true }, 'owner'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_CONFLICT' });
  expect(await launcher.dispatchDue()).toEqual([]);
  expect(starts()).toHaveLength(0);
});

it('lets the owner run a reserved Profiler request now, with its revision, and nothing else', async () => {
  benchmarkAnswers({ start: { queueId: 'profile-now' } });
  const job = await queue.submit(profile('now'), 'test');
  const booked = await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1) }, 'owner');
  await expect(launcher.launch(job.id, 'owner', {})).rejects.toMatchObject({ statusCode: 400 });
  await expect(launcher.launch(job.id, 'owner', { expectedRevision: booked.revision - 1 })).rejects.toMatchObject({ code: 'HEAVY_QUEUE_STALE' });
  await expect(launcher.launch(job.id, 'owner', { expectedRevision: booked.revision })).resolves.toMatchObject({ state: 'running', operation: { id: 'profile-now' } });
  const early = await queue.submit(profile('early', B), 'test');
  const future = await queue.reserve(early.id, { expectedRevision: early.revision, start: at(30) }, 'owner');
  await expect(launcher.launch(early.id, 'owner', { expectedRevision: future.revision })).rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_CLOSED' });
  expect((await queue.get(early.id)).state).toBe('reserved');
  const custom = await queue.submit({ key: 'custom-run', title: 'Synthetic operator fixture', kind: 'diagnostic', hosts: [B], estimatedMinutes: 5,
    executor: { mode: 'operator', receiptRef: '/outside/git/receipt.json' } }, 'test');
  await expect(launcher.launch(custom.id, 'owner', { expectedRevision: custom.revision })).rejects.toMatchObject({ code: 'HEAVY_QUEUE_LAUNCH_UNSUPPORTED' });
});
