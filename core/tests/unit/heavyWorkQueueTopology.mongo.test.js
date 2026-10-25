'use strict';

// Topology windows on the heavy-work queue (#360, phase 5).
const mockSwitches = new Map();
const mockRequests = [];
let mockRefuse = null;
const mockService = {
  async request(body) {
    mockRequests.push(body);
    if (mockRefuse) { const error = mockRefuse(body); if (error) throw error; }
    if (!mockSwitches.has(body.requestId)) {
      mockSwitches.set(body.requestId, { requestId: body.requestId, targetMode: body.targetMode, state: 'draining' });
    }
    return { record: mockSwitches.get(body.requestId), idempotent: false };
  },
  async get(requestId) { return mockSwitches.get(requestId) || null; },
  async openSwitches() {
    return new Map([...mockSwitches.values()].filter(item => !['active', 'refused', 'rolled_back', 'uncertain'].includes(item.state))
      .map(item => ['dual', { id: item.requestId }]));
  }
};
jest.mock('../../src/services/runtimeTopologySwitchService', () => ({ getTopologySwitchService: () => mockService }));
jest.mock('../../src/services/runtimeTopologyActuator', () => ({ createActuatorClient: () => ({ configured: () => true }) }));

const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const windows = require('../../src/services/runtimeTopologyWindow');
const { checkLaneContext } = require('../../src/services/routing/topologyRoleRouting');

const POOLED = 'http://127.0.0.1:11434';
const LANE_A = 'http://127.0.0.1:11437';
const LANE_B = 'http://127.0.0.1:11438';
const TOPOLOGY = JSON.stringify({ groups: [{ id: 'dual', modes: [
  { id: 'lanes', endpoints: [{ url: LANE_A, role: 'conversation' }, { url: LANE_B, role: 'background' }] },
  { id: 'pooled', endpoints: [{ url: POOLED, role: 'pooled' }] }
] }] });
const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const windowRequest = (key, executor = { groupId: 'dual', targetMode: 'pooled', returnTo: 'lanes' }, minutes = 120) => ({
  key, title: 'Pooled window', kind: 'topology', hosts: [POOLED, LANE_A, LANE_B], estimatedMinutes: minutes, executor
});
const bracketed = (key, withinWindow, hosts = [POOLED], minutes = 30) => ({
  key, title: 'Long document batch', kind: 'diagnostic', hosts, estimatedMinutes: minutes, withinWindow,
  executor: { mode: 'operator', receiptRef: 'out-of-git/receipt' }
});

async function startedWindow(key = 'w1', options = {}) {
  const job = await queue.submit(windowRequest(key, options.executor, options.minutes), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(options.startIn ?? -1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  return queue.get(job.id);
}

function activate(requestId, finishedMinutesAgo = 0) {
  const record = mockSwitches.get(requestId);
  record.state = 'active';
  record.finishedAt = at(-finishedMinutesAgo);
}

const saved = { topology: process.env.AGENTX_RUNTIME_TOPOLOGY_JSON, resources: process.env.AGENTX_RUNTIME_RESOURCES_JSON };
beforeAll(() => {
  process.env.AGENTX_RUNTIME_TOPOLOGY_JSON = TOPOLOGY;
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([
    { id: 'gpu-0', endpoints: [POOLED, LANE_A] }, { id: 'gpu-1', endpoints: [POOLED, LANE_B] }]);
});
afterAll(() => {
  for (const [key, name] of [['topology', 'AGENTX_RUNTIME_TOPOLOGY_JSON'], ['resources', 'AGENTX_RUNTIME_RESOURCES_JSON']]) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
});
beforeEach(async () => {
  await Queue.deleteMany({}); await Archive.deleteMany({}); await Runtime.deleteMany({});
  mockSwitches.clear(); mockRequests.length = 0; mockRefuse = null;
  windows._setWindows([]);
});

it('validates the topology executor and accepts an automatic start', async () => {
  await expect(queue.submit(windowRequest('bad', { groupId: 'dual', targetMode: 'pooled', returnTo: 'pooled' }), 'test'))
    .rejects.toMatchObject({ statusCode: 400 });
  await expect(queue.submit(windowRequest('extra', { groupId: 'dual', targetMode: 'pooled', shell: 'x' }), 'test'))
    .rejects.toMatchObject({ statusCode: 400 });
  const job = await queue.submit(windowRequest('ok'), 'test');
  const booked = await queue.reserve(job.id, { expectedRevision: job.revision, start: at(10), autoStart: true }, 'owner');
  expect(booked.reservation.autoStart).toBe(true);
});

it('runs a pooled window: enter, hold, return, completed', async () => {
  const job = await startedWindow('w1', { executor: { groupId: 'dual', targetMode: 'pooled', returnTo: 'lanes', holdMinutes: 30 } });
  expect(job).toMatchObject({ state: 'running', operation: { id: job.id } });
  expect(mockRequests[0]).toMatchObject({ groupId: 'dual', targetMode: 'pooled', requestId: `${job.id}.enter`, source: 'queue' });

  expect((await evidence.reconcile(job.id, 'observer')).observation).toMatchObject({ phase: 'entering' });
  activate(`${job.id}.enter`, 5);
  expect((await evidence.reconcile(job.id, 'observer')).observation).toMatchObject({ phase: 'holding' });
  expect(mockRequests).toHaveLength(1);

  activate(`${job.id}.enter`, 31);
  expect((await evidence.reconcile(job.id, 'observer')).observation).toMatchObject({ phase: 'returning' });
  expect(mockRequests[1]).toMatchObject({ targetMode: 'lanes', expectedActiveMode: 'pooled', requestId: `${job.id}.return-1` });
  activate(`${job.id}.return-1`);
  const done = await evidence.reconcile(job.id, 'observer');
  expect(done).toMatchObject({ state: 'completed', releaseReceipt: { phase: 'returned', mode: 'lanes', authority: 'core.runtime-topology' } });
  await launcher.dispatchDue();
  expect(mockRequests).toHaveLength(2);
});

it('an enter switch refused at start releases the fence instead of leaving it uncertain', async () => {
  mockRefuse = () => Object.assign(new Error('Group dual has no single active mode'), { statusCode: 409, code: 'TOPOLOGY_GROUP_NOT_STABLE' });
  const job = await queue.submit(windowRequest('refused'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  const after = await queue.get(job.id);
  expect(after.state).not.toBe('uncertain');
  expect(after.state).not.toBe('running');
});

it('waits before the dispatch mark while another switch runs for the group', async () => {
  mockSwitches.set('manual', { requestId: 'manual', state: 'verifying' });
  const job = await queue.submit(windowRequest('busy'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  expect((await queue.get(job.id)).state).toBe('reserved');
  expect(mockRequests).toHaveLength(0);
});

it('a failed enter switch fails the window; an uncertain one makes it uncertain', async () => {
  const first = await startedWindow('fail');
  mockSwitches.get(`${first.id}.enter`).state = 'rolled_back';
  expect(await evidence.reconcile(first.id, 'observer')).toMatchObject({ state: 'failed', releaseReceipt: { phase: 'enter' } });
  const second = await startedWindow('unknown');
  Object.assign(mockSwitches.get(`${second.id}.enter`), { state: 'uncertain', reason: 'actuator_timeout' });
  expect(await evidence.reconcile(second.id, 'observer')).toMatchObject({ state: 'uncertain' });
});

it('requests reserved inside a window share its hosts; outside it they still collide', async () => {
  const job = await queue.submit(windowRequest('w2', undefined, 120), 'test');
  const window = await queue.reserve(job.id, { expectedRevision: job.revision, start: at(30) }, 'owner');
  const inside = await queue.submit(bracketed('inside', window.id), 'test');
  await expect(queue.reserve(inside.id, { expectedRevision: inside.revision, start: at(45) }, 'owner'))
    .resolves.toMatchObject({ state: 'reserved' });
  const late = await queue.submit(bracketed('late', window.id, [POOLED], 120), 'test');
  await expect(queue.reserve(late.id, { expectedRevision: late.revision, start: at(45) }, 'owner'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_INVALID' });
  const lane = await queue.submit(bracketed('lane', window.id, [LANE_A]), 'test');
  await expect(queue.reserve(lane.id, { expectedRevision: lane.revision, start: at(45) }, 'owner'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_INVALID' });
  const stranger = await queue.submit({ ...bracketed('stranger', window.id), withinWindow: undefined }, 'test');
  await expect(queue.reserve(stranger.id, { expectedRevision: stranger.revision, start: at(45) }, 'owner'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_CONFLICT' });
  const placed = await queue.submit(bracketed('placed', window.id, [POOLED], 20), 'test');
  const preview = await queue.preview(placed.id, { when: 'asap' });
  expect(Date.parse(preview.start)).toBeGreaterThanOrEqual(Date.parse(window.reservation.start));
  expect(Date.parse(preview.end)).toBeLessThanOrEqual(Date.parse(window.reservation.end));
  await expect(queue.cancel(window.id, { expectedRevision: window.revision }, 'owner'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_INVALID' });
});

it('does not return while a bracketed request still needs the window', async () => {
  const job = await startedWindow('w3', { executor: { groupId: 'dual', targetMode: 'pooled', returnTo: 'lanes', holdMinutes: 1 } });
  const inside = await queue.submit(bracketed('inside-run', job.id, [POOLED], 30), 'test');
  await expect(evidence.preDispatch(await queue.get(inside.id))).rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_NOT_READY' });
  await queue.reserve(inside.id, { expectedRevision: inside.revision, start: at(0) }, 'owner');
  activate(`${job.id}.enter`, 10);
  await expect(evidence.preDispatch(await queue.get(inside.id))).resolves.toBeUndefined();
  expect((await evidence.reconcile(job.id, 'observer')).observation).toMatchObject({ phase: 'waiting_for_bracketed' });
  expect(mockRequests.filter(item => item.requestId.includes('.return'))).toHaveLength(0);
});

it('two consecutive windows to the same mode do not flap the host', async () => {
  // The next window is planned before the first one starts, as the queue requires.
  const second = await queue.submit(windowRequest('second', undefined, 60), 'test');
  await queue.reserve(second.id, { expectedRevision: second.revision, start: at(60) }, 'owner');
  const first = await startedWindow('first', { executor: { groupId: 'dual', targetMode: 'pooled', returnTo: 'lanes', holdMinutes: 1 }, minutes: 60 });
  activate(`${first.id}.enter`, 50);
  const done = await evidence.reconcile(first.id, 'observer');
  expect(done).toMatchObject({ state: 'completed', releaseReceipt: { phase: 'return_skipped', nextWindow: { id: second.id } } });
  expect(mockRequests.filter(item => item.requestId.includes('.return'))).toHaveLength(0);
});

it('asks for the return again after a refused attempt', async () => {
  const job = await startedWindow('retry', { executor: { groupId: 'dual', targetMode: 'pooled', returnTo: 'lanes', holdMinutes: 1 } });
  activate(`${job.id}.enter`, 10);
  await evidence.reconcile(job.id, 'observer');
  Object.assign(mockSwitches.get(`${job.id}.return-1`), { state: 'refused', reason: 'drain_timeout' });
  expect((await evidence.reconcile(job.id, 'observer')).observation).toMatchObject({ phase: 'returning', attempt: 2 });
  expect(mockSwitches.has(`${job.id}.return-2`)).toBe(true);
});

it('a lane overflow refusal names the next pooled window', async () => {
  const job = await queue.submit(windowRequest('next'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(90) }, 'owner');
  await windows.refreshWindows();
  const refusal = checkLaneContext({ estimatedInputTokens: 100_000, outputBudget: 4096, laneContext: 98_304,
    role: 'conversation', mode: 'lanes', group: 'dual' });
  expect(refusal.data.nextPooledWindow).toMatchObject({ id: job.id, mode: 'pooled' });
  expect(refusal.message).toContain(`queue request ${job.id}`);
  windows._setWindows([]);
  const none = checkLaneContext({ estimatedInputTokens: 100_000, outputBudget: 4096, laneContext: 98_304,
    role: 'conversation', mode: 'lanes', group: 'dual' });
  expect(none.data.nextPooledWindow).toBeUndefined();
  expect(none.suggestion).toBe('queue_for_pooled');
});
