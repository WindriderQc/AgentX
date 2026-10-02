const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const PlanningItem = require('../../models/PlanningItem');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const routes = require('../../routes/pipeline');
let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  app.use('/api/pipeline', routes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
async function create(input = {}) {
  const response = await harness.request.post('/api/pipeline/tasks').send({ title: 'A task', spec: '', ...input }).expect(201);
  return response.body.data.task.pipelineId;
}
async function read(id) { return (await harness.request.get(`/api/pipeline/tasks/${id}`).expect(200)).body.data; }

test('a preflight problem returns the exact queued ticket without consuming an attempt', async () => {
  const id = await create();
  const { task } = await read(id);
  await harness.request.post(`/api/pipeline/tasks/${id}/feedback`).send({ status: 'blocked', by: 'guarded-dispatch', text: 'The worker workspace still has a result awaiting review.', expectedQueuedUpdatedAt: task.updatedAt }).expect(200);
  const saved = (await read(id)).task;
  expect(saved).toMatchObject({ status: 'blocked', assignee: null, automationAttemptCount: 0 });
  expect(saved.feedback.at(-1).text).toContain('awaiting review');
});

test('late preflight feedback cannot block a newly claimed task', async () => {
  const id = await create();
  const { task } = await read(id);
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'another-worker' }).expect(200);
  await harness.request.post(`/api/pipeline/tasks/${id}/feedback`).send({ status: 'blocked', by: 'guarded-dispatch', text: 'Stale preflight', expectedQueuedUpdatedAt: task.updatedAt }).expect(409);
  expect((await read(id)).task).toMatchObject({ status: 'in_progress', assignee: 'another-worker', feedback: [] });
});

test('summary timeline uses persisted timestamps and excludes private attempt receipts', async () => {
  const id = await create({ title: 'Timeline contract' });
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { automationAttempts: [{
    attempt: 1, acquiredAt: new Date('2026-09-01'), completedAt: new Date('2026-09-02'),
    reviewedAt: new Date('2026-09-03'), finalState: 'review', reviewOutcome: 'accepted',
    evidence: { workerReceiptFingerprint: 'a'.repeat(64), failureCodes: [] }
  }] } });
  const res = await harness.request.get('/api/pipeline/tasks?view=summary&includeDone=true').expect(200);
  const summary = res.body.data.tasks.find(task => task.pipelineId === id);
  expect(summary.automationAttempts).toBeUndefined();
  expect(summary.timeline.find(event => event.kind === 'reviewed')).toMatchObject({ at: '2026-09-03T00:00:00.000Z', label: 'Human decision: accepted' });
  expect(JSON.stringify(summary)).not.toContain('workerReceiptFingerprint');
});
function patch(id, token, changes) { return harness.request.patch(`/api/pipeline/tasks/${id}`).send({ editToken: token, changes }); }

test('creation stores freeform Markdown, dates and roadmap links, with durable retry identity', async () => {
  const roadmap = await PlanningItem.create({ type: 'outcome', title: 'A usable pipeline' });
  const dependency = await create();
  const input = { title: 'New task', spec: '\n# Old format\r\nKeep [links](https://example.org) and whitespace.\n', source: 'pipeline-ui', sourceKey: 'editor-retry', dependsOn: [dependency], planningItemIds: [String(roadmap._id)], dueAt: '2026-10-02T18:00:00.000Z', priority: 2 };
  const id = await create(input);
  expect(await create(input)).toBe(id);
  expect(await PipelineTask.countDocuments({ source: input.source, sourceKey: input.sourceKey })).toBe(1);
  expect((await read(id)).task).toMatchObject({ title: input.title, spec: input.spec, status: 'queued', dueAt: input.dueAt, dependsOn: [dependency], planningItemIds: input.planningItemIds, priority: 2 });
  expect((await read(dependency)).task.spec).toBe('');
});

test('content edits retain assignment, live heartbeat, status, receipts and existing feedback', async () => {
  const id = await create({ spec: 'Existing spec' });
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { status: 'in_progress', assignee: 'other-worker', automationAttemptCount: 4, feedback: [{ by: 'reviewer', text: 'Existing receipt' }] } });
  const snapshot = await read(id);
  const heartbeat = new Date('2026-09-11T15:01:02.333Z');
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { heartbeatAt: heartbeat }, $push: { feedback: { by: 'worker', text: 'Still working' } } });
  const response = await patch(id, snapshot.editToken, { title: 'Clarified task', spec: '' }).expect(200);
  expect(response.body.data.task).toMatchObject({ status: 'in_progress', assignee: 'other-worker', heartbeatAt: heartbeat.toISOString(), automationAttemptCount: 4, spec: '' });
  expect(response.body.data.task.feedback.map(item => item.text)).toEqual(['Existing receipt', 'Still working', 'Edited task: title, spec.']);
  const updated = response.body.data;
  await patch(id, updated.editToken, { title: 'Clarified task' }).expect(200);
  expect((await read(id)).task.feedback).toHaveLength(3);
});

test('editor responses hide live and historical mutation leases', async () => {
  const id = await create();
  const now = new Date();
  const lease = {
    leaseId: 'active-lease-secret', assignee: 'worker-a', attempt: 2,
    acquiredAt: now, heartbeatAt: now, expiresAt: new Date(now.getTime() + 60_000), durationMs: 60_000,
  };
  await PipelineTask.updateOne({ pipelineId: id }, { $set: {
    status: 'in_progress', assignee: 'worker-a', automationLease: lease,
    automationAttempts: [{ ...lease, leaseId: 'past-lease-secret', attempt: 1, finalState: 'review' }],
  } });
  const { editToken } = await read(id);

  const response = await patch(id, editToken, { title: 'Edited task' }).expect(200);

  expect(JSON.stringify(response.body.data.task)).not.toMatch(/active-lease-secret|past-lease-secret/);
  expect(response.body.data.task.automationLease.attempt).toBe(2);
  expect(response.body.data.task.automationAttempts[0].attempt).toBe(1);
  const stored = await PipelineTask.findOne({ pipelineId: id }).lean();
  expect(stored.automationLease.leaseId).toBe('active-lease-secret');
  expect(stored.automationAttempts[0].leaseId).toBe('past-lease-secret');

  const status = await harness.request.post(`/api/pipeline/tasks/${id}/status`).send({ status: 'in_progress', by: 'operator' }).expect(200);
  expect(JSON.stringify(status.body.data.task)).not.toMatch(/active-lease-secret|past-lease-secret/);
});

test('idempotent creation and operator mutations return task documents without historical leases', async () => {
  const source = 'lease-redaction-test';
  const sourceKey = 'repeat-create';
  const id = await create({ source, sourceKey });
  const replacement = await create();
  const now = new Date();
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { automationAttempts: [{
    leaseId: 'historical-lease-secret', assignee: 'worker-a', attempt: 1,
    acquiredAt: now, heartbeatAt: now, expiresAt: now, completedAt: now, finalState: 'review',
    evidence: { schema: 'agentx.pipeline-automation-evidence/v1', verification: { status: 'passed' },
      changes: {}, usage: { durationMs: 100, costNanodollars: null }, failureCodes: [], source: 'clawdx-guarded/v1' },
  }] } });
  const expectRedacted = response => expect(JSON.stringify(response.body.data.task)).not.toContain('historical-lease-secret');

  expectRedacted(await harness.request.post('/api/pipeline/tasks').send({ title: 'A task', spec: '', source, sourceKey }).expect(201));
  expectRedacted(await harness.request.post(`/api/pipeline/tasks/${id}/feedback`).send({ by: 'operator', text: 'Reviewed evidence' }).expect(200));
  const cost = { by: 'operator', costNanodollars: 10, costKind: 'session-estimate',
    costSource: 'openclaw-session-usage/v1', costEvidenceFingerprint: 'c'.repeat(64) };
  expectRedacted(await harness.request.post(`/api/pipeline/tasks/${id}/automation-attempts/1/cost`).send(cost).expect(200));
  expectRedacted(await harness.request.post(`/api/pipeline/tasks/${id}/automation-attempts/1/cost`).send(cost).expect(200));
  expectRedacted(await harness.request.post(`/api/pipeline/tasks/${id}/supersede`).send({
    supersededBy: replacement, reason: 'Replaced after review', by: 'operator', confirm: true,
  }).expect(200));
  expect((await PipelineTask.findOne({ pipelineId: id }).lean()).automationAttempts[0].leaseId).toBe('historical-lease-secret');
});

test('simultaneous editors cannot silently overwrite each other', async () => {
  const id = await create();
  const { editToken } = await read(id);
  const responses = await Promise.all([patch(id, editToken, { spec: 'Editor A' }), patch(id, editToken, { spec: 'Editor B' })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(responses.find(r => r.status === 409).body.code).toBe('TASK_EDIT_CONFLICT');
  const saved = await read(id);
  expect(saved.task.spec).toBe(responses.find(r => r.status === 200).body.data.task.spec);
  await patch(id, editToken, { title: 'Stale edit' }).expect(409);
  await patch(id, saved.editToken, { title: 'Compared edit' }).expect(200);
});

test.each([{ status: 'done' }, { assignee: 'new-owner' }, { feedback: [] }, { automation: {} }, { title: '' }, { priority: 6 }, { dueAt: 'not a date' }, { dependsOn: ['999999'] }, { planningItemIds: ['bad-id'] }, { spec: 'x'.repeat(100001) }].map(changes => [Object.keys(changes)[0], changes]))('rejects invalid or lifecycle edits: %s', async (_field, changes) => {
  const id = await create();
  const before = await read(id);
  const persistedBefore = await PipelineTask.findOne({ pipelineId: id }).lean();
  await patch(id, before.editToken, changes).expect(400);
  // The derived next-action observation time changes on each read; persistence
  // and the edit token remain the authority for whether a rejected edit wrote.
  expect(await PipelineTask.findOne({ pipelineId: id }).lean()).toEqual(persistedBefore);
  expect((await read(id)).editToken).toBe(before.editToken);
});

test('dependency edits reject unknown tasks, self references and cycles', async () => {
  const a = await create();
  const b = await create({ dependsOn: [a] });
  const snapshot = await read(a);
  for (const dependsOn of [['9999'], [a], [b]]) await patch(a, snapshot.editToken, { dependsOn }).expect(400);
  expect((await read(a)).task.dependsOn).toEqual([]);
});

test('existing archived roadmap links survive edits, but cannot be newly attached', async () => {
  const item = await PlanningItem.create({ type: 'outcome', title: 'Historical outcome' });
  const a = await create({ planningItemIds: [String(item._id)] });
  await PlanningItem.updateOne({ _id: item._id }, { $set: { status: 'archived' } });
  const snapshot = await read(a);
  await patch(a, snapshot.editToken, { title: 'Still editable', planningItemIds: [String(item._id)] }).expect(200);
  await harness.request.post('/api/pipeline/tasks').send({ title: 'Cannot attach archived item', planningItemIds: [String(item._id)] }).expect(400);
});

test('simultaneous dependency edits on different tasks cannot create a cycle', async () => {
  const a = await create(); const b = await create();
  const snapshots = await Promise.all([read(a), read(b)]);
  const responses = await Promise.all([patch(a, snapshots[0].editToken, { dependsOn: [b] }), patch(b, snapshots[1].editToken, { dependsOn: [a] })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
  expect(responses.find(r => r.status === 400).body.code).toBe('TASK_DEPENDENCY_CYCLE');
  expect((await read(a)).task.dependsOn.length + (await read(b)).task.dependsOn.length).toBe(1);
});

test('draft endpoint returns a proposal without persisting a task', async () => {
  const draftService = require('../../src/services/pipelineDraftService');
  const propose = jest.spyOn(draftService, 'proposeDraft').mockResolvedValue({ draft: { title: 'Proposal', spec: 'Draft only', service: 'core', priority: 3 } });
  const count = await PipelineTask.countDocuments();
  try {
    const response = await harness.request.post('/api/pipeline/draft').send({ instruction: 'A useful task' }).expect(200);
    expect(response.body.data.draft.title).toBe('Proposal');
    expect(await PipelineTask.countDocuments()).toBe(count);
    expect(propose.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  } finally { propose.mockRestore(); }
});
