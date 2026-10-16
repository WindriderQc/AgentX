'use strict';
const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const routes = require('../../routes/pipeline');
const outcome = require('../../../shared/pipelineWorkerOutcome');
let harness;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/pipeline', routes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
afterEach(() => jest.restoreAllMocks());
async function claimed(input = {}) {
  const created = await harness.request.post('/api/pipeline/tasks').send({ title: 'Review documentation', service: 'core' }).expect(201);
  const id = created.body.data.task.pipelineId;
  await harness.request.post(`/api/pipeline/tasks/${id}/claim`).send({ assignee: 'coding-team' }).expect(200);
  if (Object.keys(input).length) await PipelineTask.updateOne({ pipelineId: id }, { $set: input });
  return id;
}
function body(id) {
  return { by: 'coding-team', status: 'blocked', text: 'Worker stopped without saved progress.', workerOutcome: {
    schema: outcome.SCHEMA, requestId: '11111111-2222-4333-8444-555555555555', pipelineId: id, claimSeq: 2,
    result: 'blocked', reason: 'no_useful_progress', source: 'worker_report',
    startedAt: new Date(Date.now() - 500).toISOString(), finishedAt: new Date().toISOString(), usage: { workSeconds: 2700, modelCalls: 20 } } };
}
const post = (id, value) => harness.request.post(`/api/pipeline/tasks/${id}/feedback`).send(value);
const raw = id => PipelineTask.findOne({ pipelineId: id }).lean();

test('manual stop persists an explanation and can be reconciled after a lost acknowledgment without duplicate notes', async () => {
  const id = await claimed(); const request = body(id);
  await post(id, request).expect(200);
  const before = await raw(id);
  expect(before.status).toBe('blocked'); expect(before.assignee).toBe('coding-team');
  expect(before.feedback.at(-1).workerOutcome).toMatchObject(request.workerOutcome);
  expect(before.automationAttemptCount).toBe(0); expect(before.automationAttempts).toEqual([]);
  expect(before.codingAutonomy).toBeUndefined();
  const attention = await harness.request.get(`/api/pipeline/attention?task=${id}`).expect(200);
  expect(attention.body.data.attention.items[0].label).toBe('Stopped without saved progress');
  expect(JSON.stringify(attention.body)).not.toContain(request.text);
  const summary = await harness.request.get(`/api/pipeline/tasks?scope=engineering&view=summary`).expect(200);
  expect(JSON.stringify(summary.body)).not.toContain(request.text);
  const retry = await post(id, request).expect(200);
  expect(retry.body.data.alreadyRecorded).toBe(true);
  expect(await raw(id)).toEqual(before);
  await post(id, { ...request, text: 'Changed observation' }).expect(409);
});

test('operator observation appends to an already blocked task without changing its original result or transitions', async () => {
  const id = await claimed(); await post(id, { by: 'coding-team', status: 'blocked', text: 'Original raw result.' }).expect(200);
  const before = await raw(id); const request = body(id); delete request.status;
  request.by = 'operator'; request.workerOutcome.source = 'operator_observation';
  await post(id, request).expect(200);
  const after = await raw(id);
  expect(after.transitions).toEqual(before.transitions); expect(after.feedback[0]).toEqual(before.feedback[0]);
  for (const key of ['status', 'assignee', 'automationAttempts', 'automationAttemptCount', 'automationLease', 'codingAutonomy']) expect(after[key]).toEqual(before[key]);
});

test.each([{ service: ' Family ' }, { source: 'household-request' }, { codingAutonomy: { authorized: false } },
  { automationAttemptCount: 1 }, { status: 'review' }, { assignee: 'other-worker' }])('observation cannot cross the existing fence: %j', async fields => {
  const id = await claimed(fields); const before = await raw(id);
  await post(id, body(id)).expect(409); expect(await raw(id)).toEqual(before);
});

test('old observations, forged source labels and stale task versions cannot be recorded', async () => {
  const id = await claimed(); const request = body(id);
  const old = { ...request, workerOutcome: { ...request.workerOutcome, startedAt: '2026-01-01', finishedAt: '2026-01-02' } };
  await post(id, old).expect(400);
  await post(id, { ...request, by: 'other' }).expect(400);
  await post(id, { ...request, workerOutcome: { ...request.workerOutcome, claimSeq: 1 } }).expect(400);
  const operator = { ...request, by: 'operator', workerOutcome: { ...request.workerOutcome, source: 'operator_observation' } };
  await post(id, operator).expect(400);
  const stale = await PipelineTask.findOne({ pipelineId: id });
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { spec: 'Updated instructions' } });
  jest.spyOn(PipelineTask, 'findOne').mockResolvedValueOnce(stale);
  await post(id, request).expect(409);
  expect((await raw(id)).feedback).toEqual([]);
});

test('private-lane drift is refused even if a writer preserves updatedAt', async () => {
  const id = await claimed(); const request = body(id); const stale = await PipelineTask.findOne({ pipelineId: id });
  await PipelineTask.collection.updateOne({ pipelineId: id }, { $set: { source: 'household-request' } });
  jest.spyOn(PipelineTask, 'findOne').mockResolvedValueOnce(stale);
  await post(id, request).expect(409); expect((await raw(id)).feedback).toEqual([]);
});

test('a legacy manual task without a stored automation counter retains that absence', async () => {
  const id = await claimed(); await PipelineTask.collection.updateOne({ pipelineId: id }, { $unset: { automationAttemptCount: '' } });
  await post(id, body(id)).expect(200);
  const task = await raw(id); expect(task.status).toBe('blocked');
  expect(task.automationAttemptCount).toBeUndefined(); expect(task.automationAttempts).toEqual([]);
  expect(task.feedback.at(-1).workerOutcome.reason).toBe('no_useful_progress');
});
