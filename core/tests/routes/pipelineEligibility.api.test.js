'use strict';

const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const Slot = require('../../models/PipelineAutomationSlot');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const { AUTOMATION_SLOT_ID } = require('../../src/services/pipelineTaskService');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

let harness;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/pipeline', require('../../routes/pipeline'));
  app.use('/api/planning', require('../../routes/planning'));
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness.close(); });
beforeEach(async () => { await PipelineTask.deleteMany({}); await Slot.deleteMany({}); });

const create = overrides => PipelineTask.create({ pipelineId: '0950', title: 'Eligibility fixture',
  service: 'core', status: 'queued', ...overrides });
const read = () => harness.request.get('/api/pipeline/tasks/0950/eligibility');

test('Pipeline list, task dossier and Planning references share next action without writes', async () => {
  const task = await create({ status: 'in_progress', assignee: 'worker', heartbeatAt: new Date('2026-01-01'),
    spec: 'Synthetic full specification that must not enter summaries' });
  const before = await PipelineTask.findById(task._id).lean();
  const list = await harness.request.get('/api/pipeline/tasks?view=summary').expect(200);
  const detail = await harness.request.get('/api/pipeline/tasks/0950').expect(200);
  const planning = await harness.request.get('/api/planning/dashboard').expect(200);
  const projections = [list.body.data.tasks[0], detail.body.data.task, planning.body.data.tasks[0]].map(row => row.nextAction);
  for (const projection of projections) {
    expect(projection).toMatchObject({ code: 'inspect_worker', heartbeatFreshness: 'stale',
      authorization: 'not_granted', reference: '/pipeline?task=0950' });
    const { observedAt, ...fields } = projection;
    const { observedAt: otherTime, ...expected } = projections[0];
    expect(fields).toEqual(expected);
  }
  expect(list.body.data.tasks[0].spec).toBeUndefined();
  expect(planning.body.data.tasks[0].spec).toBeUndefined();
  expect(await PipelineTask.findById(task._id).lean()).toEqual(before);
  expect(await Slot.countDocuments()).toBe(0);
});
function automation() {
  return normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1', mode: 'review_only',
    policyRef: 'low-risk/v1', dataClassification: 'public', operations: ['update'], scope: ['core/src/example.js'],
    lockKeys: ['example'], executionProfile: 'worker/v1', verificationProfile: 'jest/v1',
    budgets: { maxDurationMs: 60000, maxAttempts: 1, maxCostNanodollars: 0 },
    humanGates: ['review', 'merge', 'deploy'] });
}

test('eligibility is read-only and does not claim a task, slot or attempt', async () => {
  const task = await create({});
  const before = await PipelineTask.findById(task._id).lean();
  const response = await read().expect(200);
  expect(response.body.data.eligibility).toMatchObject({ observedEligible: true,
    authorization: 'not_granted', mode: 'manual', reasons: [], observedAt: expect.any(String) });
  expect(await PipelineTask.findById(task._id).lean()).toEqual(before);
  expect(await Slot.countDocuments()).toBe(0);
});

test.each([
  [{ notBefore: new Date(Date.now() + 3600000) }, 'not_before', 'TASK_NOT_READY'],
  [{ status: 'review' }, 'task_unavailable', 'TASK_UNAVAILABLE'],
  [{ dependsOn: ['0951'] }, 'dependencies_incomplete', 'TASK_DEPENDENCIES_BLOCKED'],
])('observation and claim share the refusal for %j', async (overrides, reason, claimCode) => {
  await create(overrides);
  const response = await read().expect(200);
  expect(response.body.data.eligibility).toMatchObject({ observedEligible: false, reasons: [expect.objectContaining({ code: reason })] });
  const claim = await harness.request.post('/api/pipeline/tasks/0950/claim').send({ assignee: 'worker' }).expect(409);
  expect(claim.body.code).toBe(claimCode);
});

test('private lanes cannot be widened by query parameters and dependency content is never exposed', async () => {
  await create({ dependsOn: ['0951'] });
  await PipelineTask.create({ pipelineId: '0951', title: 'Synthetic private dependency title',
    service: 'family', status: 'queued' });
  const response = await read().expect(200);
  expect(JSON.stringify(response.body)).not.toContain('Synthetic private');
  expect(JSON.stringify(response.body)).not.toContain('0951');
  await harness.request.get('/api/pipeline/tasks/0951/eligibility?service=family&includePrivate=true').expect(404);
});

test('attempt budget and live slot are observed without exposing reservation identities', async () => {
  await create({ risk: 'low', automation: automation(), automationAttemptCount: 1 });
  await Slot.create({ _id: AUTOMATION_SLOT_ID, leaseId: 'synthetic-private-lease', pipelineId: '0952',
    assignee: 'other-worker', expiresAt: new Date(Date.now() + 60000) });
  const response = await harness.request.get('/api/pipeline/tasks/0950/eligibility?automation=true').expect(200);
  expect(response.body.data.eligibility.reasons.map(item => item.code))
    .toEqual(expect.arrayContaining(['attempt_budget_exhausted', 'automation_slot_occupied']));
  expect(JSON.stringify(response.body)).not.toContain('synthetic-private-lease');
  expect(JSON.stringify(response.body)).not.toContain('other-worker');
});

test('a task changed after a positive observation is revalidated by the atomic claim', async () => {
  await create({});
  expect((await read()).body.data.eligibility.observedEligible).toBe(true);
  await PipelineTask.updateOne({ pipelineId: '0950' }, { $set: { service: 'family' } });
  await harness.request.post('/api/pipeline/tasks/0950/claim').send({ assignee: 'worker' }).expect(404);
  expect(await PipelineTask.findOne({ pipelineId: '0950' }).lean()).toMatchObject({ assignee: null, status: 'queued' });
});
