'use strict';

const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const Slot = require('../../models/PipelineAutomationSlot');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const { repairGuardQuery } = require('../../src/services/pipelineTaskDiagnosis');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

let harness;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/pipeline', require('../../routes/pipeline'));
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness.close(); });
beforeEach(async () => { await PipelineTask.deleteMany({}); await Slot.deleteMany({}); });

function automation(maxDurationMs = 60000) {
  return normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1', mode: 'review_only',
    policyRef: 'low-risk/v1', dataClassification: 'public', operations: ['update'], scope: ['core/src/example.js'],
    lockKeys: ['example'], executionProfile: 'worker/v1', verificationProfile: 'jest/v1',
    budgets: { maxDurationMs, maxAttempts: 2, maxCostNanodollars: 0 }, humanGates: ['review', 'merge', 'deploy'] });
}
async function createTask(input = {}) {
  const response = await harness.request.post('/api/pipeline/tasks').send({ title: 'Diagnosis task', spec: '', ...input }).expect(201);
  return response.body.data.task.pipelineId;
}
const diagnose = async id => (await harness.request.get(`/api/pipeline/tasks/${id}/diagnosis`).expect(200)).body.data.diagnosis;
const raw = id => PipelineTask.findOne({ pipelineId: id }).lean();
async function snapshot() {
  return { tasks: await PipelineTask.find({}).sort({ pipelineId: 1 }).lean(), slots: await Slot.find({}).lean() };
}
async function automatedClaim(id, leaseDurationMs = 60000) {
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { automation: automation(), risk: 'low' } });
  const claim = await harness.request.post(`/api/pipeline/tasks/${id}/claim`)
    .send({ assignee: 'coding-worker', automated: true, leaseDurationMs }).expect(200);
  return claim.body.data.task.automationLease;
}
// Durable time travel: age the lease, the slot and the heartbeat together.
async function ageLease(id, ms) {
  const task = await raw(id);
  const shift = date => new Date(new Date(date).getTime() - ms);
  await PipelineTask.updateOne({ pipelineId: id }, { $set: {
    heartbeatAt: shift(task.heartbeatAt),
    'automationLease.acquiredAt': shift(task.automationLease.acquiredAt),
    'automationLease.heartbeatAt': shift(task.automationLease.heartbeatAt),
    'automationLease.expiresAt': shift(task.automationLease.expiresAt),
  } });
  await Slot.updateOne({}, { $set: { expiresAt: shift(task.automationLease.expiresAt) } });
}

test('dead worker: an expired lease needs recovery, never reads as a stopped worker, and escalates once', async () => {
  const id = await createTask();
  const lease = await automatedClaim(id);
  await ageLease(id, 5 * 60000);
  const before = await snapshot();
  const first = await diagnose(id);
  const second = await diagnose(id);
  expect(first).toMatchObject({ schema: 'agentx.pipeline-task-diagnosis/v1', category: 'recovery_required', code: 'lease_expired',
    owner: 'operator', authorization: 'not_granted', repair: 'none', worker: { state: 'unknown' },
    lease: { state: 'expired', attempt: 1, ref: expect.stringMatching(/^lease-[a-f0-9]{16}$/) },
    runtime: { consulted: false } });
  expect(first.worker.state).not.toBe('stopped');
  expect(first.missingEvidence.map(item => item.code)).toEqual(expect.arrayContaining(['worker_process', 'external_effects', 'runtime_outcome']));
  expect(first.escalation.key).toMatch(/^esc-[a-f0-9]{16}$/);
  expect(second.escalation.key).toBe(first.escalation.key);
  // The raw lease id never leaves Core, and reading changed nothing.
  expect(JSON.stringify(first)).not.toContain(lease.leaseId);
  expect(await snapshot()).toEqual(before);
  // A note (updatedAt changes) is not a new episode.
  await PipelineTask.updateOne({ pipelineId: id }, { $push: { feedback: { by: 'operator', text: 'Looking at the host' } } });
  expect((await diagnose(id)).escalation.key).toBe(first.escalation.key);
});

test('slow worker: a lease still being renewed is observed execution, even beyond its budget', async () => {
  const id = await createTask();
  const lease = await automatedClaim(id, 30000);
  // Three renewals 25 s apart: 75 s of observed activity, beyond the 60 s budget.
  for (let step = 0; step < 3; step += 1) {
    await ageLease(id, 25000);
    await harness.request.post(`/api/pipeline/tasks/${id}/heartbeat`).send({ assignee: 'coding-worker', leaseId: lease.leaseId }).expect(200);
  }
  const diagnosis = await diagnose(id);
  expect(diagnosis).toMatchObject({ category: 'execution_observed', code: 'lease_active_over_budget', owner: 'worker',
    worker: { state: 'lease_renewed', heartbeat: 'recent' }, lease: { state: 'active' }, escalation: null, budgetMs: 60000 });
  expect(diagnosis.elapsedMs).toBeGreaterThan(60000);
});

test('absent observation: a claim without any heartbeat is unknown, not dead', async () => {
  const id = await createTask();
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'interactive-worker' }).expect(200);
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { heartbeatAt: null } });
  const diagnosis = await diagnose(id);
  expect(diagnosis).toMatchObject({ category: 'unknown', code: 'heartbeat_absent', owner: 'operator',
    worker: { heartbeat: 'absent', state: 'unknown' } });
  expect(diagnosis.escalation.key).toMatch(/^esc-/);
  expect(diagnosis.missingEvidence.map(item => item.code)).toContain('heartbeat');
});

test('concurrent renewal: a heartbeat after the diagnosis invalidates both the escalation and any guarded repair', async () => {
  const id = await createTask();
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'interactive-worker' }).expect(200);
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { heartbeatAt: new Date(Date.now() - 2 * 3600000) } });
  const stale = await diagnose(id);
  expect(stale).toMatchObject({ category: 'unknown', code: 'heartbeat_stale' });
  expect(await PipelineTask.countDocuments(repairGuardQuery(id, stale.observedVersion))).toBe(1);

  await harness.request.post(`/api/pipeline/tasks/${id}/heartbeat`).send({ assignee: 'interactive-worker' }).expect(200);
  // A repair decided on the stale diagnosis would now match nothing.
  expect(await PipelineTask.countDocuments(repairGuardQuery(id, stale.observedVersion))).toBe(0);
  const fresh = await diagnose(id);
  expect(fresh).toMatchObject({ category: 'execution_observed', code: 'heartbeat_recent', escalation: null });

  // Automated lease: renewal changes the recorded expiry, so the guard fails too.
  const other = await createTask();
  const lease = await automatedClaim(other);
  const observed = await diagnose(other);
  expect(observed).toMatchObject({ code: 'lease_active', escalation: null });
  await ageLease(other, 1000);
  await harness.request.post(`/api/pipeline/tasks/${other}/heartbeat`).send({ assignee: 'coding-worker', leaseId: lease.leaseId }).expect(200);
  expect(await PipelineTask.countDocuments(repairGuardQuery(other, observed.observedVersion))).toBe(0);
  expect((await diagnose(other)).code).toBe('lease_active');
});

test('an operator can requeue against the current diagnosis but not a stale heartbeat', async () => {
  const id = await createTask();
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'interactive-worker' }).expect(200);
  const stale = await diagnose(id);
  await harness.request.post(`/api/pipeline/tasks/${id}/heartbeat`).send({ assignee: 'interactive-worker' }).expect(200);
  const refused = await harness.request.post(`/api/pipeline/tasks/${id}/status`)
    .send({ status: 'queued', by: 'operator', expected: stale.observedVersion }).expect(409);
  expect(refused.body.code).toBe('TASK_EXPECTED_VERSION_CONFLICT');
  expect((await raw(id)).status).toBe('in_progress');

  const fresh = await diagnose(id);
  const requeued = await harness.request.post(`/api/pipeline/tasks/${id}/status`)
    .send({ status: 'queued', by: 'operator', expected: fresh.observedVersion }).expect(200);
  expect(requeued.body.data.task).toMatchObject({ status: 'queued', assignee: null });
  expect((await harness.request.post(`/api/pipeline/tasks/${id}/status`)
    .send({ status: 'blocked', expected: {} }).expect(400)).body.code).toBe('INVALID_EXPECTED_VERSION');
});

test('expected status rejects a heartbeat that wins after the route reads the task', async () => {
  const id = await createTask();
  const expected = (await diagnose(id)).observedVersion;
  const original = PipelineTask.findOneAndUpdate.bind(PipelineTask);
  const spy = jest.spyOn(PipelineTask, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await PipelineTask.updateOne({ pipelineId: id }, { $set: { heartbeatAt: new Date() } });
    return original(...args);
  });
  try {
    const refused = await harness.request.post(`/api/pipeline/tasks/${id}/status`)
      .send({ status: 'blocked', by: 'operator', expected }).expect(409);
    expect(refused.body.code).toBe('TASK_EXPECTED_VERSION_CONFLICT');
  } finally {
    spy.mockRestore();
  }
  expect((await raw(id)).status).toBe('queued');
});

test('expected status pins an expired automated lease when requeuing after inspection', async () => {
  const id = await createTask();
  const lease = await automatedClaim(id);
  await ageLease(id, 5 * 60000);
  const diagnosis = await diagnose(id);
  expect(diagnosis.code).toBe('lease_expired');
  expect(JSON.stringify(diagnosis.observedVersion)).not.toContain(lease.leaseId);
  const response = await harness.request.post(`/api/pipeline/tasks/${id}/status`)
    .send({ status: 'queued', by: 'operator', expected: diagnosis.observedVersion }).expect(200);
  expect(response.body.data.task).toMatchObject({ status: 'queued', assignee: null });
  expect((await raw(id)).automationLease).toBeUndefined();
});

test('worker status with expected rejects a lease expiry changed after the route read', async () => {
  const id = await createTask();
  const lease = await automatedClaim(id);
  const expected = (await diagnose(id)).observedVersion;
  const original = PipelineTask.findOneAndUpdate.bind(PipelineTask);
  const spy = jest.spyOn(PipelineTask, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await PipelineTask.updateOne({ pipelineId: id }, {
      $set: { 'automationLease.expiresAt': new Date(Date.now() + 120000) },
    });
    return original(...args);
  });
  try {
    const refused = await harness.request.post(`/api/pipeline/tasks/${id}/status`)
      .send({ status: 'review', by: 'coding-worker', leaseId: lease.leaseId, expected }).expect(409);
    expect(refused.body.code).toBe('TASK_EXPECTED_VERSION_CONFLICT');
  } finally {
    spy.mockRestore();
  }
  const task = await raw(id);
  expect(task.status).toBe('in_progress');
  expect(task.automationAttempts[0].finalState).toBe('active');
  expect((await diagnose(id)).observedVersion).not.toEqual(expected);
});

test('human task and blocked dependency name their owner; only the blocked root would escalate', async () => {
  const human = await createTask({ service: 'family' });
  const root = await createTask();
  const dependent = await createTask({ dependsOn: [root] });
  await harness.request.post(`/api/pipeline/tasks/${root}/status`).send({ status: 'blocked', by: 'operator' }).expect(200);

  expect(await diagnose(human)).toMatchObject({ category: 'human_decision', code: 'human_lane', owner: 'human', escalation: null });
  expect(await diagnose(root)).toMatchObject({ category: 'human_decision', code: 'blocked', owner: 'human', escalation: null });
  expect(await diagnose(dependent)).toMatchObject({ category: 'dependency', code: 'dependency_blocked', owner: 'human',
    rootRefs: [`task-${root}`], escalation: null });

  await harness.request.post(`/api/pipeline/tasks/${root}/status`).send({ status: 'queued', by: 'operator' }).expect(200);
  expect(await diagnose(dependent)).toMatchObject({ category: 'dependency', code: 'dependency_pending', owner: 'dependency_owner' });
});

test('planned waits are not escalated and a queued task still naming an owner needs recovery', async () => {
  const deferred = await createTask({ notBefore: new Date(Date.now() + 3600000).toISOString() });
  expect(await diagnose(deferred)).toMatchObject({ category: 'planned_wait', code: 'not_before', escalation: null });
  const zombie = await createTask();
  await PipelineTask.updateOne({ pipelineId: zombie }, { $set: { assignee: 'gone-worker' } });
  expect(await diagnose(zombie)).toMatchObject({ category: 'recovery_required', code: 'queued_with_owner', owner: 'operator' });
});

test('bounded list: counts every active task, lists ambiguous ones first, and writes nothing', async () => {
  const expired = await createTask();
  await automatedClaim(expired);
  await ageLease(expired, 5 * 60000);
  await createTask();
  const review = await createTask();
  await harness.request.post(`/api/pipeline/tasks/${review}/status`).send({ status: 'review', by: 'operator' }).expect(200);
  const before = await snapshot();
  const response = await harness.request.get('/api/pipeline/diagnosis?limit=1').expect(200);
  const list = response.body.data.diagnoses;
  expect(list).toMatchObject({ schema: 'agentx.pipeline-task-diagnoses/v1', authorization: 'not_granted', repair: 'none',
    scope: { scanned: 3, scanTruncated: false }, escalations: 1, truncated: true });
  expect(list.counts).toMatchObject({ recovery_required: 1, planned_wait: 1, human_decision: 1 });
  expect(list.items.map(item => [item.pipelineId, item.code])).toEqual([[expired, 'lease_expired']]);
  expect(await snapshot()).toEqual(before);
  await harness.request.get('/api/pipeline/diagnosis?limit=0').expect(400);
  await harness.request.get('/api/pipeline/tasks/abc/diagnosis').expect(400);
  await harness.request.get('/api/pipeline/tasks/9999/diagnosis').expect(404);
});

test('a slot naming another lease is reported as unknown instead of being trusted', async () => {
  const id = await createTask();
  await automatedClaim(id);
  await Slot.updateOne({}, { $set: { leaseId: 'another-lease' } });
  expect(await diagnose(id)).toMatchObject({ category: 'unknown', code: 'slot_mismatch', owner: 'operator' });
});

test('a queued family routine is a private lane: no recovery, no escalation, never in the engineering list', async () => {
  // familyTaskService.createTask shape: queued with the lane as assignee.
  await PipelineTask.create({ pipelineId: '0960', title: 'Synthetic routine', service: 'family', status: 'queued',
    assignee: 'household-family', epic: 'Family Routine', source: 'household-parent' });
  await PipelineTask.create({ pipelineId: '0961', title: 'Synthetic personal errand', service: 'personal', status: 'in_progress',
    assignee: 'someone', heartbeatAt: null });
  await PipelineTask.create({ pipelineId: '0962', title: 'Synthetic idea', service: 'core', source: 'idea-drop', status: 'blocked' });
  for (const id of ['0960', '0961', '0962']) {
    expect(await diagnose(id)).toMatchObject({ category: 'human_decision', code: 'human_lane', scope: 'private', escalation: null });
  }
  await createTask();
  const list = (await harness.request.get('/api/pipeline/diagnosis').expect(200)).body.data.diagnoses;
  expect(list.scope).toMatchObject({ lane: 'engineering', privateLanes: 'excluded', scanned: 1 });
  expect(list.escalations).toBe(0);
  expect(list.items).toEqual([]);
  expect(list.counts).toMatchObject({ planned_wait: 1, human_decision: 0, recovery_required: 0, unknown: 0 });
  expect(JSON.stringify(list)).not.toMatch(/096[012]|Synthetic/);
});
