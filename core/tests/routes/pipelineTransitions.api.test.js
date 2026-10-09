const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const routes = require('../../routes/pipeline');
const { MAX_TRANSITIONS, TIMELINE_TRANSITIONS } = require('../../src/services/pipelineTaskTransitions');

let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  app.use('/api/pipeline', routes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
afterEach(() => jest.restoreAllMocks());

async function create(input = {}) {
  const response = await harness.request.post('/api/pipeline/tasks').send({ title: 'Transition task', spec: '', ...input }).expect(201);
  return response.body.data.task.pipelineId;
}
async function read(id) { return (await harness.request.get(`/api/pipeline/tasks/${id}`).expect(200)).body.data.task; }
const status = (id, body) => harness.request.post(`/api/pipeline/tasks/${id}/status`).send(body);
const raw = (id) => PipelineTask.findOne({ pipelineId: id }).lean();

function expectLogMatchesStatus(task) {
  expect(task.transitions.at(-1).to).toBe(task.status);
  expect(task.transitionSeq).toBe(task.transitions.at(-1).seq);
  task.transitions.forEach((event, index) => {
    if (index > 0) {
      expect(event.seq).toBe(task.transitions[index - 1].seq + 1);
      expect(event.from).toBe(task.transitions[index - 1].to);
    }
  });
}

test('creation, claim and worker verdict each write one event with the status change', async () => {
  const id = await create();
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'worker-a' }).expect(200);
  await harness.request.post(`/api/pipeline/tasks/${id}/feedback`).send({ by: 'worker-a', status: 'done', text: 'Ready' }).expect(200);
  const task = await read(id);
  expect(task.transitions.map((event) => [event.seq, event.from, event.to, event.kind])).toEqual([
    [1, null, 'queued', 'created'],
    [2, 'queued', 'in_progress', 'claimed'],
    [3, 'in_progress', 'review', 'worker_verdict'],
  ]);
  expect(task.transitions[1].actor).toEqual({ declared: 'worker-a', authenticated: null, channel: 'worker_api' });
  expect(task.transitionLog).toMatchObject({ coverage: 'complete', retained: 3, firstSeq: 1, lastSeq: 3 });
  expectLogMatchesStatus(task);

  // A partial verdict leaves the status unchanged, so no event is written.
  await status(id, { status: 'in_progress', by: 'operator' }).expect(200);
  await harness.request.post(`/api/pipeline/tasks/${id}/feedback`).send({ by: 'worker-a', status: 'partial', text: 'Still going' }).expect(200);
  expect((await raw(id)).transitions).toHaveLength(4);
});

test('a declared actor never becomes an authenticated identity', async () => {
  const id = await create();
  await status(id, { status: 'blocked', by: 'Operator', reason: 'Waiting on a decision', actor: { authenticated: 'root' } }).expect(200);
  const event = (await raw(id)).transitions.at(-1);
  expect(event).toMatchObject({ kind: 'operator_set', reason: 'Waiting on a decision' });
  expect(event.actor).toEqual({ declared: 'Operator', authenticated: null, channel: 'operator_api' });
});

test('concurrent status changes: exactly the applied change is logged, the stale one is refused', async () => {
  const id = await create();
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'worker-a' }).expect(200);
  const stale = await PipelineTask.findOne({ pipelineId: id });
  await status(id, { status: 'blocked', by: 'first' }).expect(200);

  // The second operator decided from the same in_progress version.
  jest.spyOn(PipelineTask, 'findOne').mockResolvedValueOnce(stale);
  const refused = await status(id, { status: 'queued', by: 'second' }).expect(409);
  expect(refused.body.code).toBe('TASK_TRANSITION_CONFLICT');

  const task = await raw(id);
  expect(task.status).toBe('blocked');
  expect(task.transitions.map((event) => event.actor.declared)).toEqual([null, 'worker-a', 'first']);
  expectLogMatchesStatus(task);

  // Truly parallel requests keep the same invariant whatever the interleaving.
  const results = await Promise.all(['queued', 'done', 'in_progress'].map((to) => status(id, { status: to, by: `racer-${to}` })));
  const applied = results.filter((response) => response.status === 200).length;
  expect(results.every((response) => [200, 409].includes(response.status))).toBe(true);
  const after = await raw(id);
  expect(after.transitions).toHaveLength(3 + applied);
  expectLogMatchesStatus(after);
});

test('a failed write leaves neither the status nor an event behind', async () => {
  const id = await create();
  const before = await raw(id);
  const spy = jest.spyOn(PipelineTask, 'findOneAndUpdate').mockRejectedValueOnce(new Error('connection lost'));
  await status(id, { status: 'blocked', by: 'operator' }).expect(500);
  expect(spy).toHaveBeenCalledTimes(1); // status and event travel in the one update
  const after = await raw(id);
  expect(after.status).toBe('queued');
  expect(after.transitions).toEqual(before.transitions);
  expect(after.transitionSeq).toBe(before.transitionSeq);
});

test('requeue after review is logged against the reviewed attempt and leaves the task claimable', async () => {
  const id = await create();
  await PipelineTask.updateOne({ pipelineId: id }, { $set: {
    status: 'review',
    assignee: 'worker-a',
    automationAttempts: [{
      leaseId: 'lease-review', assignee: 'worker-a', attempt: 1,
      acquiredAt: new Date('2026-09-01'), heartbeatAt: new Date('2026-09-01'), expiresAt: new Date('2026-09-01'),
      completedAt: new Date('2026-09-02'), finalState: 'review',
    }],
  } });
  await status(id, { status: 'queued', by: 'reviewer', reason: 'Tests missing' }).expect(200);
  const task = await raw(id);
  expect(task.transitions.at(-1)).toMatchObject({
    from: 'review', to: 'queued', kind: 'requeued', attempt: 1, reason: 'Tests missing',
    evidence: { attemptRef: `task-${id}/attempt-1`, leaseRef: expect.stringMatching(/^lease-[a-f0-9]{16}$/) },
  });
  expect(JSON.stringify(task.transitions)).not.toContain('lease-review');
  expect(task.automationAttempts[0].reviewOutcome).toBe('requeued');
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'worker-b' }).expect(200);
  // The fixture moved the task to review without a logged mutation, so the log
  // shows that gap (queued -> review is absent) instead of filling it in.
  const claimed = await raw(id);
  expect(claimed.transitions.map((event) => `${event.from}>${event.to}`)).toEqual(['null>queued', 'review>queued', 'queued>in_progress']);
});

test('supersession and deliberate reopening are typed events', async () => {
  const id = await create();
  const replacement = await create({ title: 'Replacement' });
  await harness.request.post(`/api/pipeline/tasks/${id}/supersede`)
    .send({ supersededBy: replacement, reason: 'Replaced by a narrower task', by: 'reviewer', confirm: true }).expect(200);
  await status(id, { status: 'queued', reopen: true, by: 'reviewer' }).expect(200);
  const [superseded, reopened] = (await raw(id)).transitions.slice(-2);
  expect(superseded).toMatchObject({
    from: 'queued', to: 'done', kind: 'superseded', reason: 'Replaced by a narrower task',
    evidence: { supersededByRef: `task-${replacement}` },
  });
  expect(reopened).toMatchObject({ from: 'done', to: 'queued', kind: 'reopened' });
  // The replacement only receives an audit line; its status did not change.
  expect((await raw(replacement)).transitions).toHaveLength(1);
});

test('an old document without a log gets no invented history', async () => {
  const pipelineId = '9901';
  await PipelineTask.collection.insertOne({
    pipelineId, title: 'Legacy', spec: '', status: 'blocked', assignee: null, feedback: [
      { by: 'operator', text: 'Moved queued -> blocked yesterday', at: new Date('2026-09-01') },
    ], automationAttempts: [], createdAt: new Date('2026-08-01'), updatedAt: new Date('2026-09-01'),
  });
  const legacy = await read(pipelineId);
  expect(legacy.transitions).toBeUndefined();
  expect(legacy.transitionLog).toMatchObject({ coverage: 'none', retained: 0 });
  const summary = (await harness.request.get('/api/pipeline/tasks?view=summary&includeDone=true').expect(200))
    .body.data.tasks.find((task) => task.pipelineId === pipelineId);
  expect(summary.timeline.filter((event) => event.kind === 'transition')).toEqual([]);
  expect(summary.transitions).toBeUndefined();

  await status(pipelineId, { status: 'queued', by: 'operator' }).expect(200);
  const after = await read(pipelineId);
  expect(after.transitions).toEqual([expect.objectContaining({ seq: 1, from: 'blocked', to: 'queued', kind: 'requeued' })]);
  expect(after.transitionLog).toMatchObject({ coverage: 'partial', firstSeq: 1 });
});

test('volume is capped in the store and in summary reads', async () => {
  const id = await create();
  for (let index = 0; index < MAX_TRANSITIONS + 5; index += 1) {
    await status(id, { status: index % 2 ? 'queued' : 'blocked', by: 'loop' }).expect(200);
  }
  const task = await read(id);
  expect(task.transitions).toHaveLength(MAX_TRANSITIONS);
  expect(task.transitionSeq).toBe(MAX_TRANSITIONS + 6);
  expect(task.transitionLog).toMatchObject({ coverage: 'partial', retained: MAX_TRANSITIONS, firstSeq: 7, lastSeq: MAX_TRANSITIONS + 6 });
  expectLogMatchesStatus(task);
  const summary = (await harness.request.get('/api/pipeline/tasks?view=summary&includeDone=true').expect(200))
    .body.data.tasks.find((row) => row.pipelineId === id);
  const rows = summary.timeline.filter((event) => event.kind === 'transition');
  expect(rows).toHaveLength(TIMELINE_TRANSITIONS);
  expect(rows.at(-1)).toMatchObject({ label: expect.stringContaining('declared by loop'), transition: { seq: MAX_TRANSITIONS + 6 } });
});

test.each(['review', 'done'])('preflight feedback keeps its queued guard: a %s task is not moved to blocked', async (from) => {
  const id = await create();
  const version = (await read(id)).updatedAt;
  await PipelineTask.collection.updateOne({ pipelineId: id }, { $set: { status: from } }); // updatedAt unchanged
  const response = await harness.request.post(`/api/pipeline/tasks/${id}/feedback`)
    .send({ status: 'blocked', by: 'guarded-dispatch', text: 'Stale preflight', expectedQueuedUpdatedAt: version }).expect(409);
  expect(response.body.code).toBe('TASK_PREFLIGHT_CHANGED');
  const task = await raw(id);
  expect(task.status).toBe(from);
  expect(task.transitions).toHaveLength(1);
  expect(task.feedback).toEqual([]);
});

test('preflight feedback on the exact queued version is logged with its guard', async () => {
  const id = await create();
  const version = (await read(id)).updatedAt;
  await harness.request.post(`/api/pipeline/tasks/${id}/feedback`)
    .send({ status: 'blocked', by: 'guarded-dispatch', text: 'Workspace busy', expectedQueuedUpdatedAt: version }).expect(200);
  expect((await raw(id)).transitions.at(-1)).toMatchObject({ from: 'queued', to: 'blocked', kind: 'worker_verdict' });
});

test('a status call with an inactive lease is refused and writes no event; the active holder is logged', async () => {
  const id = await create();
  const now = Date.now();
  const lease = { leaseId: '00000000-0000-4000-8000-00000000000a', assignee: 'worker-a', acquiredAt: new Date(now),
    heartbeatAt: new Date(now), expiresAt: new Date(now + 600000), durationMs: 600000, attempt: 1 };
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { status: 'in_progress', assignee: 'worker-a',
    automationLease: lease, automationAttemptCount: 1, automationAttempts: [{ ...lease, finalState: 'active' }] } });

  const stale = await status(id, { status: 'queued', by: 'worker-a', leaseId: '00000000-0000-4000-8000-00000000000b' }).expect(409);
  expect(stale.body.code).toBe('TASK_LEASE_MISMATCH');
  expect((await raw(id))).toMatchObject({ status: 'in_progress', transitions: [expect.objectContaining({ kind: 'created' })] });

  await status(id, { status: 'queued', by: 'worker-a', leaseId: lease.leaseId }).expect(200);
  const requeued = await raw(id);
  expect(requeued.transitions.at(-1)).toMatchObject({ from: 'in_progress', to: 'queued', kind: 'requeued', attempt: 1,
    actor: { declared: 'worker-a', authenticated: null, channel: 'automation_lease' } });

  // The closed lease can no longer move the task, and no event is written.
  const inactive = await status(id, { status: 'blocked', by: 'worker-a', leaseId: lease.leaseId }).expect(409);
  expect(inactive.body.code).toBe('TASK_LEASE_INACTIVE');
  expect((await raw(id)).transitions).toHaveLength(requeued.transitions.length);
});

test.each(['family', 'personal'])('a newly created %s lane task reports complete coverage', async (service) => {
  const id = await create({ service });
  const task = await read(id);
  expect(task.transitions[0]).toMatchObject({ seq: 1, kind: 'created' });
  expect(task.transitionLog).toMatchObject({ coverage: 'complete', reason: null });
});
