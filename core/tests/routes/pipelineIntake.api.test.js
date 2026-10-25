'use strict';
const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const Task = require('../../models/PipelineTask');
const ReportRun = require('../../models/PipelineReportRun');
const Slot = require('../../models/PipelineAutomationSlot');
const service = require('../../src/services/pipelineTaskService');
const policy = require('../../src/services/taskIntakePolicy');
const intake = require('../../src/services/taskIntakeService');
const preparation = require('../../src/services/pipelineTaskPreparationService');
const app = express(); app.use(express.json()); app.use('/pipeline', require('../../routes/pipeline'));
const read = async id => (await request(app).get(`/pipeline/tasks/${id}`).expect(200)).body.data;
const create = async (extra = {}) => (await request(app).post('/pipeline/tasks').send({ title: 'Synthetic engineering need',
  spec: 'Inspect a synthetic fixture, then explain the result.', service: 'core', sourceKey: randomUUID(), ...extra }).expect(201)).body.data.task;
function command(task, state = 'accepted', extra = {}) {
  const view = policy.view(task);
  return { state, reason: 'Reviewed synthetic request and scope.', by: 'fixture-operator', requestId: randomUUID(),
    expectedRevision: view.revision, expectedScopeFingerprint: view.scopeFingerprint, confirm: true, ...extra };
}
beforeEach(async () => { await Promise.all([Task, ReportRun, Slot].map(model => model.deleteMany({}))); });
afterEach(() => jest.restoreAllMocks());

test('new engineering requests are proposals across create/read/list, not claimable work', async () => {
  const created = await create();
  const { task } = await read(created.pipelineId);
  expect(task).toMatchObject({ status: 'queued', intake: { state: 'proposed', revision: 1 },
    intakeView: { state: 'proposed', claimGate: 'decision_required', authorization: 'not_granted' }, nextAction: { code: 'intake_review', attention: true } });
  expect(await service.findNextEligibleTask()).toBeNull();
  await request(app).post(`/pipeline/tasks/${task.pipelineId}/claim`).send({ assignee: 'fixture-worker' }).expect(409);
  await request(app).post(`/pipeline/tasks/${task.pipelineId}/status`).send({ status: 'in_progress' }).expect(409);
  await request(app).post(`/pipeline/tasks/${task.pipelineId}/feedback`).send({ status: 'partial', text: 'Synthetic attempted bypass' }).expect(409);
  await request(app).get(`/pipeline/tasks/${task.pipelineId}/worker`).expect(409);
  await expect(preparation.read(task.pipelineId)).rejects.toMatchObject({ code: 'TASK_INTAKE_REQUIRED' });
  const eligibility = await request(app).get(`/pipeline/tasks/${task.pipelineId}/eligibility`).expect(200);
  expect(eligibility.body.data.eligibility).toMatchObject({ observedEligible: false, reasons: [{ code: 'intake_decision_required' }] });
  const rows = await request(app).get('/pipeline/tasks?scope=engineering&view=summary').expect(200);
  expect(rows.body.data.tasks[0].intakeView.state).toBe('proposed');
  expect(rows.body.data.tasks[0]).not.toHaveProperty('spec');
  expect((await Task.findOne({ pipelineId: task.pipelineId })).automationAttemptCount).toBe(0);
});

test('HTTP-supplied acceptance cannot impersonate an existing reviewed domain operation', async () => {
  const created = await create({ intakeAcceptance: { by: 'forged', reason: 'Forged reviewed commitment.', ref: 'forged' }, intake: { state: 'accepted' } });
  expect((await read(created.pipelineId)).task.intakeView.state).toBe('proposed');
  const reviewed = await service.createTaskInMongo({ title: 'Synthetic already reviewed follow-up', service: 'core' }, {
    intakeAcceptance: { by: 'fixture-operator', reason: 'Reviewed through the native source workflow.', ref: 'synthetic-domain:approved' } });
  const task = (await read(reviewed.pipelineId)).task;
  expect(task.intake).toMatchObject({ state: 'accepted', history: [{ actor: { channel: 'domain_review', authenticated: null }, evidenceRef: 'synthetic-domain:approved' }] });
  expect(task.automationAttemptCount).toBe(0); expect(task.automation).toBeUndefined();
});

test('a human idea promotion preserves its existing commitment without a duplicate approval', async () => {
  const ideas = require('../../src/services/ideaInboxService');
  const idea = await ideas.captureIdea({ text: 'Synthetic reviewed engineering idea', origin: 'nestor' });
  const promoted = await ideas.promoteToExecution(idea.idea.id, { targetType: 'task', by: 'fixture-operator', service: 'core' });
  const task = await Task.findOne({ pipelineId: promoted.task.pipelineId }).lean();
  expect(task.intake).toMatchObject({ state: 'accepted', history: [{ evidenceRef: `planning-idea:${idea.idea.id}`, actor: { channel: 'domain_review' } }] });
  expect(task.status).toBe('queued'); expect(task.automationAttemptCount).toBe(0);
});

test('an explicit decision accepts only the current request and grants no execution authority', async () => {
  const created = await create(); const { task } = await read(created.pipelineId);
  const response = await request(app).post(`/pipeline/tasks/${task.pipelineId}/intake`).send(command(task)).expect(200);
  expect(response.body.data).toMatchObject({ replayed: false, receipt: { from: 'proposed', to: 'accepted',
    actor: { declared: 'fixture-operator', authenticated: null, channel: 'operator_api' } },
  task: { status: 'queued', assignee: null, automationAttemptCount: 0 }, intakeView: { claimGate: 'accepted_scope', authorization: 'not_granted' } });
  expect((await read(task.pipelineId)).task.nextAction.code).toBe('await_claim');
  expect((await service.findNextEligibleTask()).pipelineId).toBe(task.pipelineId);
  expect(await service.findNextEligibleTask({ automation: 'true' })).toBeNull();
  expect(await Slot.countDocuments()).toBe(0);
});

test('decision replay retains the exact receipt and never turns changed arguments into a new intent', async () => {
  const created = await create(); const { task } = await read(created.pipelineId);
  const input = command(task);
  const [one, two] = await Promise.all([intake.decide(task.pipelineId, input), intake.decide(task.pipelineId, input)]);
  expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
  expect((await Task.findOne({ pipelineId: task.pipelineId })).intake.history).toHaveLength(2);
  expect((await intake.decide(task.pipelineId, Object.fromEntries(Object.entries(input).reverse()))).replayed).toBe(true);
  await expect(intake.decide(task.pipelineId, { ...input, state: 'declined' })).rejects.toMatchObject({ code: 'TASK_INTAKE_KEY_CONFLICT' });
});

test('concurrent decisions require a fresh revision and do not erase their predecessor', async () => {
  const created = await create(); const { task } = await read(created.pipelineId);
  const results = await Promise.allSettled([intake.decide(task.pipelineId, command(task)), intake.decide(task.pipelineId, command(task, 'declined'))]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason.code).toBe('TASK_INTAKE_CONFLICT');
  const current = (await read(task.pipelineId)).task;
  await expect(intake.decide(task.pipelineId, command(task))).rejects.toMatchObject({ code: 'TASK_INTAKE_CONFLICT' });
  expect(current.intake.history).toHaveLength(2);
});

test.each(['deferred', 'declined', 'needs_clarification'])('%s keeps the task, provenance and rationale without scheduling work', async state => {
  const created = await create(); const { task } = await read(created.pipelineId);
  await intake.decide(task.pipelineId, command(task, state));
  const current = (await read(task.pipelineId)).task;
  expect(current.status).toBe('queued'); expect(current.sourceKey).toBe(task.sourceKey);
  expect(current.intake.history.at(-1).reason).toBe('Reviewed synthetic request and scope.');
  expect(current.nextAction.code).toBe(state === 'needs_clarification' ? 'intake_review' : 'intake_not_pursued');
  expect(current.nextAction.attention).toBe(state === 'needs_clarification');
  expect(await service.findNextEligibleTask()).toBeNull();
  await intake.decide(task.pipelineId, command(current));
  expect((await read(task.pipelineId)).task.intakeView.state).toBe('accepted');
});

test('content changes invalidate the accepted scope while old decisions and budgets remain', async () => {
  const created = await create(); let current = await read(created.pipelineId);
  await intake.decide(created.pipelineId, command(current.task)); current = await read(created.pipelineId);
  const original = JSON.stringify(current.task.intake);
  await request(app).patch(`/pipeline/tasks/${created.pipelineId}`).send({ editToken: current.editToken,
    changes: { spec: 'A materially different requested outcome.' }, by: 'fixture-operator' }).expect(200);
  current = await read(created.pipelineId);
  expect(JSON.stringify(current.task.intake)).toBe(original);
  expect(current.task.intakeView).toMatchObject({ state: 'needs_clarification', recordedState: 'accepted', claimGate: 'decision_required' });
  await expect(service.claimEligibleTask(created.pipelineId, 'fixture-worker')).rejects.toMatchObject({ code: 'TASK_INTAKE_REQUIRED' });
  await intake.decide(created.pipelineId, command(current.task));
  expect((await read(created.pipelineId)).task.intakeView.state).toBe('accepted');
});

test('a decision racing a claim cannot be overwritten by the stale claim', async () => {
  const created = await create(); const accepted = await intake.decide(created.pipelineId, command((await read(created.pipelineId)).task));
  const original = Task.findOneAndUpdate.bind(Task);
  jest.spyOn(Task, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await intake.decide(created.pipelineId, command(accepted.task, 'deferred'));
    return original(...args);
  });
  await expect(service.claimEligibleTask(created.pipelineId, 'fixture-worker')).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' });
  expect((await read(created.pipelineId)).task).toMatchObject({ status: 'queued', assignee: null, intake: { state: 'deferred' } });
});

test('a native authorization racing a decision fences it even without a timestamp change', async () => {
  const created = await create(); const { task } = await read(created.pipelineId);
  const original = Task.findOneAndUpdate.bind(Task);
  jest.spyOn(Task, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
    await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { codingAutonomy: { revision: 1, authorized: true } } }, { timestamps: false });
    return original(...args).lean();
  } }));
  await expect(intake.decide(task.pipelineId, command(task, 'declined'))).rejects.toMatchObject({ code: 'TASK_INTAKE_CONFLICT' });
  expect((await Task.findOne({ pipelineId: task.pipelineId })).intake.state).toBe('proposed');
});

test('summary and detail honor native profile ownership without publishing its identity in summaries', async () => {
  const created = await create();
  await Task.updateOne({ pipelineId: created.pipelineId }, { $set: { profileId: 'synthetic-private-owner' } });
  expect((await read(created.pipelineId)).task.intakeView.state).toBe('native_domain');
  const rows = await request(app).get('/pipeline/tasks?view=summary').expect(200);
  expect(rows.body.data.tasks[0].intakeView.state).toBe('native_domain');
  expect(rows.body.data.tasks[0]).not.toHaveProperty('profileId');
});

test.each([
  { status: 'in_progress', assignee: 'fixture-worker' },
  { codingCapacity: { requestId: 'synthetic-unknown-capacity' } },
  { automationLease: { leaseId: 'synthetic-expired', expiresAt: new Date(0) } },
  { codingAutonomy: { authorized: true, runs: [] } },
  { codingReportAuthority: { bindings: [{ requestId: 'synthetic-missing-report' }] } },
])('intake changes refuse native ownership or unresolved effects %#', async fields => {
  const created = await create(); let { task } = await read(created.pipelineId);
  await Task.updateOne({ pipelineId: task.pipelineId }, { $set: fields });
  task = await Task.findOne({ pipelineId: task.pipelineId }).lean();
  await expect(intake.decide(task.pipelineId, command(task, 'declined'))).rejects.toMatchObject({ code: 'TASK_INTAKE_FENCED' });
  expect((await Task.findOne({ pipelineId: task.pipelineId })).intake.revision).toBe(1);
});

test('legacy work retains native rules; personal/family decisions remain outside engineering intake', async () => {
  const legacy = await Task.create({ pipelineId: '8990', title: 'Synthetic legacy work', service: 'core', spec: 'Existing scope' });
  expect(policy.view(legacy)).toMatchObject({ state: 'legacy_unrecorded', claimGate: 'existing_policy' });
  expect((await service.claimEligibleTask(legacy.pipelineId, 'fixture-worker')).status).toBe('in_progress');
  for (const service of ['personal', 'family', 'household', 'secretary']) {
    const privateTask = await create({ service });
    const { task } = await read(privateTask.pipelineId);
    expect(task.intake).toBeUndefined();
    await expect(intake.decide(task.pipelineId, command(task))).rejects.toMatchObject({ code: 'TASK_INTAKE_PRIVATE' });
  }
});

test('creation replay preserves its current decision instead of recreating a proposal', async () => {
  const sourceKey = randomUUID(); const created = await create({ sourceKey });
  await intake.decide(created.pipelineId, command((await read(created.pipelineId)).task, 'declined'));
  const replay = await create({ sourceKey });
  expect(replay).toMatchObject({ alreadyExisting: true, pipelineId: created.pipelineId, intakeView: { state: 'declined' } });
});

test('moving a private record into engineering creates a proposal instead of a legacy exemption', async () => {
  const created = await create({ service: 'personal' }); const current = await read(created.pipelineId);
  await request(app).patch(`/pipeline/tasks/${created.pipelineId}`).send({ editToken: current.editToken,
    changes: { service: 'core' } }).expect(200);
  expect((await read(created.pipelineId)).task.intakeView).toMatchObject({ state: 'proposed', claimGate: 'decision_required' });
  expect(await service.findNextEligibleTask()).toBeNull();
});

test('exact scope, a reason and explicit confirmation are required; content editor cannot alter intake', async () => {
  const created = await create(); const current = await read(created.pipelineId);
  for (const extra of [{ confirm: false }, { reason: 'short' }, { by: '' }, { expectedScopeFingerprint: 'wrong' }]) {
    await request(app).post(`/pipeline/tasks/${created.pipelineId}/intake`).send(command(current.task, 'accepted', extra)).expect(400);
  }
  await request(app).patch(`/pipeline/tasks/${created.pipelineId}`).send({ editToken: current.editToken,
    changes: { intake: { state: 'accepted' } } }).expect(400);
  expect((await read(created.pipelineId)).task.intake.state).toBe('proposed');
});

test('a pending native report fences decisions even after its task was incorrectly returned to the queue', async () => {
  const created = await create(); const { task } = await read(created.pipelineId);
  await ReportRun.collection.insertOne({ _id: randomUUID(), taskId: task._id, state: 'active', modelReceipts: [], pendingInferences: [] });
  await expect(intake.decide(task.pipelineId, command(task, 'declined'))).rejects.toMatchObject({ code: 'TASK_INTAKE_FENCED' });
  expect(await ReportRun.countDocuments()).toBe(1);
});

test('full histories refuse new decisions without dropping evidence; exact replays remain readable', async () => {
  const created = await create(); const { task } = await read(created.pipelineId);
  const input = command(task); await intake.decide(task.pipelineId, input);
  const current = await Task.findOne({ pipelineId: task.pipelineId }).lean();
  const history = current.intake.history;
  await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { 'intake.history': [...history,
    ...Array.from({ length: 62 }, (_, index) => ({ ...history[0], revision: index + 3 }))] } });
  await expect(intake.decide(task.pipelineId, command(current, 'deferred'))).rejects.toMatchObject({ code: 'TASK_INTAKE_HISTORY_FULL' });
  expect((await intake.decide(task.pipelineId, input)).replayed).toBe(true);
  expect((await Task.findOne({ pipelineId: task.pipelineId })).intake.history).toHaveLength(64);
});
