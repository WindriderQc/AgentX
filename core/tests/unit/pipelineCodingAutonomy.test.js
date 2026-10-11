'use strict';
const express = require('express');
const request = require('supertest');
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Slots = require('../../models/PipelineAutomationSlot');
const service = require('../../src/services/pipelineCodingAutonomyService');
const policy = require('../../src/services/pipelineCodingAutonomyPolicy');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const { claimEligibleTask } = require('../../src/services/pipelineTaskService');
jest.mock('../../src/services/heavyWorkQueueService', () => ({ get: jest.fn() }));
const queue = require('../../src/services/heavyWorkQueueService');
const QUEUE = '11111111-2222-4333-8444-555555555555';
const HEAD = 'a'.repeat(40);
const PR = { repository: 'example/project', number: 42, branch: 'agentx/coding-task-0001', base: 'main',
  url: 'https://github.com/example/project/pull/42', head: HEAD };
let control;
let receipts;
let observations;
const app = express().use(express.json()).use('/api/pipeline', require('../../routes/pipeline-feedback'));
function intent() {
  return normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1', mode: 'review_only',
    policyRef: 'reviewed/v1', dataClassification: 'public', operations: ['update'], scope: ['source.js'],
    lockKeys: ['file:source.js'], executionProfile: 'coding-sandbox/v1', verificationProfile: 'agentx-dispatcher-tests/v1',
    budgets: { maxDurationMs: 14400000, maxAttempts: 3, maxCostNanodollars: 0 }, humanGates: ['review', 'merge', 'deploy'] });
}
async function task(id = '0001', extra = {}) {
  return Task.create({ pipelineId: id, title: `Synthetic coding task ${id}`, spec: 'Synthetic fixture only',
    service: 'agentx-coding', status: 'queued', risk: 'low', assignee: null, automation: intent(), ...extra });
}
async function authorize(id = '0001', limits) {
  return service.authorize(id, { authorized: true, confirm: true, expectedRevision: 0, queueRequestId: QUEUE, limits });
}
async function enable() { const state = await service.settings(); return service.configure({ enabled: true, confirm: true, expectedRevision: state.revision }); }
async function selected() { return (await service.status()).active; }
async function launch() { await service.tick(); const active = await selected(); await service.tick(); return active; }
async function complete(active, head = HEAD, usage = { workSeconds: 10, testSeconds: 3, modelSeconds: 4, modelCalls: 1 }) {
  const claimed = await claimEligibleTask(active.pipelineId, 'coding-team', new Date(), { automated: true, dispatchRequestId: active.requestId });
  const leaseId = claimed.automationLease.leaseId;
  const response = await request(app).post(`/api/pipeline/tasks/${active.pipelineId}/feedback`).send({
    by: 'coding-team', assignee: 'coding-team', leaseId, text: 'Synthetic native verdict', status: 'done',
    attemptEvidence: { schema: 'agentx.pipeline-automation-evidence/v1', verification: { status: 'passed' }, changes: {}, usage: {}, failureCodes: [],
      workerReceiptFingerprint: 'b'.repeat(64), routing: { status: 'verified', provider: 'ollama', effectiveModel: 'synthetic-model',
        requestCount: 1, sessionCallCount: 1, evidenceFingerprint: 'c'.repeat(64) } } });
  expect(response.status).toBe(200);
  receipts.set(active.requestId, { pipelineId: active.pipelineId, requestId: active.requestId, phase: 'finished', progress: {
    phase: 'finished', stage: 'publishing', coreRecorded: true, result: 'review', checkpoint: head,
    pr: { ...PR, head }, usage, seenStates: ['d'.repeat(64)], seenTests: ['e'.repeat(64)] } });
  await service.tick();
  await Task.updateOne({ pipelineId: active.pipelineId }, { $set: { 'codingAutonomy.nextObservationAt': new Date(0).toISOString() } });
}
beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Settings.deleteMany({}), Slots.deleteMany({})]);
  receipts = new Map(); observations = new Map();
  queue.get.mockResolvedValue({ state: 'dispatching', executor: { mode: 'operator' }, source: { type: 'coding', ref: 'synthetic-session' },
    hosts: ['http://127.0.0.1:9'], reservation: { start: new Date(Date.now() - 10000).toISOString(), end: new Date(Date.now() + 600000).toISOString() } });
  control = {
    status: jest.fn(async ({ requestId }) => ({ busy: false, run: receipts.get(requestId) || { requestId, phase: 'not_received' } })),
    launch: jest.fn(async input => { receipts.set(input.requestId, { pipelineId: input.pipelineId, requestId: input.requestId, phase: 'running' }); }),
    observe: jest.fn(async input => observations.get(input.requestId) || { ...PR, state: 'open', mergeable: 'unknown', checks: [] }),
    reconcile: jest.fn(), stop: jest.fn(),
  };
  service.configureControl(control);
});
afterEach(() => service.configureControl(null));

test('routing and idea intake grant no autonomous execution; switch defaults off', async () => {
  await task(); await enable(); await service.tick(); expect(control.launch).not.toHaveBeenCalled(); expect(await selected()).toBeNull();
  await Settings.deleteMany({}); expect((await service.status()).enabled).toBe(false);
});
test('budgets below the native minimum lease refuse authorization before dispatch', async () => {
  await task();
  await expect(authorize('0001', { workSeconds: 9 })).rejects.toMatchObject({ code: 'CODING_AUTONOMY_INVALID' });
  const tiny = intent(); tiny.budgets.maxDurationMs = 9999; delete tiny.fingerprint;
  await task('0002', { automation: normalizePipelineAutomationIntent(tiny) });
  await expect(authorize('0002')).rejects.toMatchObject({ code: 'CODING_AUTONOMY_SCOPE' });
  expect(policy.limits({ workSeconds: 10 }).workSeconds).toBe(10);
  expect(await selected()).toBeNull(); expect(control.launch).not.toHaveBeenCalled();
});
test.each([{ service: 'personal' }, { service: 'Family' }, { service: 'Household' }, { source: 'idea-drop' }, { source: 'household-tasks' }, { profileId: 'child' }])('private workflows refuse authorization: %j', async extra => {
  await task('0001', extra); await expect(authorize()).rejects.toThrow(); expect(await selected()).toBeNull();
});
test('double selection and launch retain one durable request', async () => {
  await task(); await authorize(); await enable(); await Promise.all([service.tick(), service.tick()]);
  const first = await selected(); await Promise.all([service.tick(), service.tick()]);
  expect(control.launch).toHaveBeenCalledTimes(1); expect((await selected()).requestId).toBe(first.requestId);
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).codingAutonomy.runs).toHaveLength(1);
});
test('lost launch response reconciles the original identity without another launch or attempt', async () => {
  await task(); await authorize(); await enable(); await service.tick(); const first = await selected();
  control.launch.mockImplementationOnce(async input => {
    receipts.set(input.requestId, { pipelineId: input.pipelineId, requestId: input.requestId, phase: 'running' });
    throw new Error('Synthetic lost HTTP/SSH reply');
  });
  await expect(service.tick()).rejects.toThrow('lost'); await service.tick();
  expect(control.launch).toHaveBeenCalledTimes(1); expect((await selected()).requestId).toBe(first.requestId);
});
test('Core restart after selection resumes only durable dispatch identity', async () => {
  await task(); await authorize(); await enable(); await service.tick(); const first = await selected();
  service.configureControl(null); await service.tick(); service.configureControl(control); await service.tick();
  expect(control.launch.mock.calls[0][0].requestId).toBe(first.requestId);
});
test('missing runner after crash is unknown and prevents selecting another job', async () => {
  await task(); await task('0002'); await authorize(); await authorize('0002'); await enable(); const active = await launch();
  receipts.set(active.requestId, { ...active, phase: 'unknown' }); await service.tick(); await service.tick();
  expect((await selected()).requestId).toBe(active.requestId); expect(control.launch).toHaveBeenCalledTimes(1);
  expect((await service.status()).tasks[0].reason).toBe('runner_outcome_unknown');
});
test('dependencies, availability and ownership are retained', async () => {
  await task('0001', { dependsOn: ['0099'] }); await task('0002', { notBefore: new Date(Date.now() + 3600000) });
  await task('0003'); await authorize(); await authorize('0002'); await authorize('0003');
  await Task.updateOne({ pipelineId: '0003' }, { $set: { assignee: 'other-job' } }); await enable(); await service.tick();
  expect(await selected()).toBeNull(); expect(control.launch).not.toHaveBeenCalled();
});
test('expired or unstarted heavy-work campaign prevents launch', async () => {
  await task(); await authorize(); await enable(); queue.get.mockResolvedValue({ state: 'reserved' });
  await service.tick(); expect(await selected()).toBeNull();
});
test('runner preflight completion after window closes clears only the autonomous slot without a native attempt', async () => {
  await task(); await task('0002'); await authorize(); await authorize('0002'); await enable(); const active = await launch();
  receipts.set(active.requestId, { ...active, phase: 'finished', progress: { phase: 'finished', coreRecorded: true,
    preflight: true, result: 'blocked', stopReason: 'queue_window_closed', usage: { workSeconds: 2 } } });
  queue.get.mockResolvedValue({ state: 'completed' }); await service.tick();
  expect(await selected()).toBeNull(); const closed = await Task.findOne({ pipelineId: active.pipelineId }).lean();
  expect(closed.codingAutonomy.state).toBe('blocked'); expect(closed.codingAutonomy.reason).toBe('queue_window_closed');
  expect(closed.automationAttemptCount).toBe(0); expect(closed.codingAutonomy.runs[0].finishedAt).toBeTruthy();
  expect((await Task.findOne({ pipelineId: '0002' }).lean()).codingAutonomy.runs).toHaveLength(0);
});
test('aging prevents starvation and selection uses a stable tie break', () => {
  const old = { priority: 5, pipelineId: '0001', codingAutonomy: { authorizedAt: '2026-01-01T00:00:00Z' } };
  const fresh = { priority: 1, pipelineId: '0002', codingAutonomy: { authorizedAt: '2026-01-10T00:00:00Z' } };
  expect(policy.compare(old, fresh, Date.parse('2026-01-10T00:00:00Z'))).toBeLessThan(0);
});
test('CI from an old commit cannot finish or start a correction', async () => {
  await task(); await authorize(); await enable(); const active = await launch(); await complete(active);
  observations.set(active.requestId, { ...PR, state: 'open', mergeable: 'clean', checks: policy.CHECKS.map(name => ({ name, head: 'f'.repeat(40), state: 'success' })) });
  await service.tick(); expect((await service.status()).tasks[0].state).toBe('waiting_ci'); expect(control.launch).toHaveBeenCalledTimes(1);
});
test('green exact-head CI ends at human review without merge, deploy or task completion', async () => {
  await task(); await authorize(); await enable(); const active = await launch(); await complete(active);
  observations.set(active.requestId, { ...PR, state: 'open', mergeable: 'clean', checks: policy.CHECKS.map(name => ({ name, head: HEAD, state: 'success' })) });
  await service.tick(); const state = (await service.status()).tasks[0];
  expect(state.state).toBe('ready_for_review'); expect(state.taskStatus).toBe('review'); expect(await selected()).toBeNull();
});
test('review correction keeps the same card and PR with a new linked request and cumulative budgets', async () => {
  await task(); await authorize(); await enable(); const first = await launch(); await complete(first);
  await service.recordReview('0001', { confirm: true, head: HEAD, text: 'Synthetic correction request' });
  await service.tick(); const next = await selected(); expect(next.requestId).not.toBe(first.requestId);
  const manifest = await service.workerManifest('0001', next.requestId);
  expect(manifest.parentRequestId).toBe(first.requestId); expect(manifest.pr.number).toBe(42);
  expect(manifest.remaining.workSeconds).toBe(14390); expect(manifest.remaining.modelCalls).toBe(127);
  expect(manifest.seenStates).toEqual(['d'.repeat(64)]);
  const durable = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(durable.automationAttempts).toHaveLength(1); expect(durable.automationAttempts[0].finalState).toBe('review');
  expect(durable.codingAutonomy.manualInterventions[0].kind).toBe('review_feedback');
});
test('native model receipts charge cumulative budgets even when runner usage undercounts and stored totals are stale', async () => {
  await task(); await authorize('0001', { modelCalls: 3, modelSeconds: 60 }); await enable(); const first = await launch();
  const native = [
    { callId: '10000000-0000-4000-8000-000000000001', state: 'completed', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z' },
    { callId: '10000000-0000-4000-8000-000000000002', state: 'completed', startedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:03Z' },
  ];
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.runs.0.modelReceipts': native } });
  expect((await service.status()).tasks[0].remaining).toMatchObject({ modelCalls: 1, modelSeconds: 57 });
  await complete(first, HEAD, { workSeconds: 10, testSeconds: 3, modelCalls: 0, modelSeconds: 0 });
  let durable = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(durable.codingAutonomy.runs[0].usage).toMatchObject({ modelCalls: 2, modelSeconds: 3 });
  expect(durable.codingAutonomy.spent).toMatchObject({ modelCalls: 2, modelSeconds: 3 });
  // Simulate durable state written before native usage was enforced, then restart/resume.
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.spent.modelCalls': 0,
    'codingAutonomy.spent.modelSeconds': 0, 'codingAutonomy.runs.0.usage.modelCalls': 0, 'codingAutonomy.runs.0.usage.modelSeconds': 0 } });
  await service.recordReview('0001', { confirm: true, head: HEAD, text: 'Synthetic correction after stale counters' });
  await service.tick(); const next = await selected(); const manifest = await service.workerManifest('0001', next.requestId);
  expect(manifest.remaining).toMatchObject({ modelCalls: 1, modelSeconds: 57 });
  const claimed = await claimEligibleTask('0001', 'coding-team', new Date(), { automated: true, dispatchRequestId: next.requestId });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { codingCapacity: { model: 'synthetic-model', admissionId: 'fixture', host: 'http://127.0.0.1:9' } } });
  const inference = require('../../src/services/pipelineCodingInferenceService');
  const headers = { 'x-agentx-coding-task': '0001', 'x-agentx-coding-request': next.requestId,
    'x-agentx-coding-lease': claimed.automationLease.leaseId, 'x-agentx-coding-call': '10000000-0000-4000-8000-000000000003' };
  const last = await inference.prepare(headers, 'synthetic-model'); await last.finish('completed');
  await expect(inference.prepare({ ...headers, 'x-agentx-coding-call': '10000000-0000-4000-8000-000000000004' }, 'synthetic-model'))
    .rejects.toMatchObject({ code: 'CODING_MODEL_BUDGET' });
});

test('Core model deadline aborts an uncompleted call without claiming termination or releasing another owner', async () => {
  await task(); await authorize('0001', { modelSeconds: 1 }); await enable(); const active = await launch();
  const claimed = await claimEligibleTask('0001', 'coding-team', new Date(), { automated: true, dispatchRequestId: active.requestId });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { codingCapacity: { model: 'synthetic-model', admissionId: 'fixture', host: 'http://127.0.0.1:9' } } });
  const headers = { 'x-agentx-coding-task': '0001', 'x-agentx-coding-request': active.requestId,
    'x-agentx-coding-lease': claimed.automationLease.leaseId, 'x-agentx-coding-call': '10000000-0000-4000-8000-000000000001' };
  const inference = require('../../src/services/pipelineCodingInferenceService');
  const call = await inference.prepare(headers, 'synthetic-model', new AbortController().signal);
  await new Promise(resolve => call.options.signal.addEventListener('abort', resolve, { once: true }));
  expect(call.options.signal.reason.code).toBe('CODING_MODEL_BUDGET');
  await call.finish('unknown'); const durable = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(durable.codingAutonomy.runs[0].pendingInferences).toHaveLength(1);
  expect(durable.codingAutonomy.runs[0].modelReceipts[0].state).toBe('unknown');
  expect(durable.automationLease.leaseId).toBe(claimed.automationLease.leaseId); expect(durable.codingCapacity.admissionId).toBe('fixture');
  await expect(inference.prepare({ ...headers, 'x-agentx-coding-call': '10000000-0000-4000-8000-000000000002' }, 'synthetic-model'))
    .rejects.toMatchObject({ code: 'CODING_MODEL_BUDGET' });
});
test('changed remote head becomes an explicit manual intervention and worker correction', async () => {
  await task(); await authorize(); await enable(); const first = await launch(); await complete(first);
  observations.set(first.requestId, { ...PR, head: 'f'.repeat(40), state: 'open', mergeable: 'clean', checks: [] });
  await service.tick(); const state = (await service.status()).tasks[0];
  expect(state.manualInterventions[0].kind).toBe('remote_branch_update');
  expect((await service.workerManifest('0001', (await selected()).requestId)).correction.kind).toBe('remote_head_changed');
});
test('resume limit and cumulative work exhaustion do not reset on requeue', async () => {
  await task(); await authorize('0001', { maxResumes: 0 }); await enable(); const first = await launch(); await complete(first);
  await service.recordReview('0001', { confirm: true, head: HEAD, text: 'Synthetic correction' }); await service.tick();
  expect((await service.status()).tasks[0].reason).toBe('resume_limit'); expect(await selected()).toBeNull();
});
test('cancel waiting is durable, does not signal another worker and prevents relaunch', async () => {
  await task(); await authorize(); await enable(); const first = await launch(); await complete(first);
  await service.stop('0001', first.requestId, { confirm: true }); await service.tick();
  expect(control.stop).not.toHaveBeenCalled(); expect(control.launch).toHaveBeenCalledTimes(1);
  expect((await service.status()).tasks[0].state).toBe('stopped');
});
test('active stop uses exact task/request and a lost stop reply fences all retries', async () => {
  await task(); await authorize(); await enable(); const first = await launch();
  control.stop.mockRejectedValue(Object.assign(new Error('Lost reply'), { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN' }));
  await service.stop('0001', first.requestId, { confirm: true }); await service.tick();
  expect(control.stop).toHaveBeenCalledWith({ pipelineId: '0001', requestId: first.requestId, confirm: true });
  expect(control.launch).toHaveBeenCalledTimes(1); expect((await service.status()).tasks[0].authorized).toBe(false);
});
test('pause allows observation but prevents a new worker or correction', async () => {
  await task(); await authorize(); await enable(); const first = await launch(); await complete(first);
  await service.recordReview('0001', { confirm: true, head: HEAD, text: 'Synthetic correction' });
  const config = await service.settings(); await service.configure({ enabled: false, confirm: true, expectedRevision: config.revision });
  await service.tick(); expect(await selected()).toBeNull(); expect(control.launch).toHaveBeenCalledTimes(1);
});
test('lost native feedback response replays only saved verdict; no new worker', async () => {
  await task(); await authorize(); await enable(); const first = await launch();
  receipts.set(first.requestId, { ...first, phase: 'finished', progress: { phase: 'finished', result: 'review', coreRecorded: false } });
  await service.tick(); expect(control.reconcile).toHaveBeenCalledWith({ pipelineId: '0001', requestId: first.requestId });
  expect(control.launch).toHaveBeenCalledTimes(1); expect((await selected()).requestId).toBe(first.requestId);
});

test('lost publication outcome is reconciled without a replacement worker', async () => {
  await task(); await authorize(); await enable(); const first = await launch();
  receipts.set(first.requestId, { ...first, phase: 'unknown', progress: { phase: 'delivering', stage: 'publishing', coreRecorded: false } });
  await service.tick(); expect(control.reconcile).toHaveBeenCalledWith({ pipelineId: '0001', requestId: first.requestId });
  expect(control.launch).toHaveBeenCalledTimes(1); expect((await selected()).requestId).toBe(first.requestId);
});
test('late stop preserves actual published PR and records its refusal; no correction relaunch', async () => {
  await task(); await authorize(); await enable(); const first = await launch();
  control.stop.mockRejectedValue(Object.assign(new Error('Publication already started'), { code: 'CODING_DISPATCH_STOP_TOO_LATE' }));
  await expect(service.stop('0001', first.requestId, { confirm: true })).rejects.toThrow('already started');
  await complete(first); await service.tick(); const current = (await service.status()).tasks[0];
  expect(current.state).toBe('stopped'); expect(current.reason).toBe('stop_too_late_publication');
  expect(current.pr.number).toBe(42); expect(current.manualInterventions[0].kind).toBe('stop_refused_publication');
  expect(control.launch).toHaveBeenCalledTimes(1);
});
test('a second upstream conflict resumes only after the native lease is conclusively released', async () => {
  await task(); await authorize(); await enable(); const first = await launch();
  await Task.updateOne({ pipelineId: '0001' }, { $set: { status: 'blocked', automationAttemptCount: 1 } });
  receipts.set(first.requestId, { ...first, phase: 'finished', progress: { phase: 'finished', coreRecorded: true,
    result: 'blocked', stopReason: 'git_conflict_remaining', checkpoint: HEAD, usage: { workSeconds: 7 } } });
  await service.tick(); const second = await selected();
  expect(second.requestId).not.toBe(first.requestId);
  const manifest = await service.workerManifest('0001', second.requestId);
  expect(manifest.parentRequestId).toBe(first.requestId); expect(manifest.remaining.workSeconds).toBe(14393);
  expect(manifest.correction.kind).toBe('git_conflict_remaining');
});


test('review feedback after cumulative CI exhaustion cannot spend another model turn', async () => {
  await task(); await authorize('0001', { ciSeconds: 10 }); await enable(); const first = await launch(); await complete(first);
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.ciStartedAt': new Date(Date.now() - 20000).toISOString() } });
  await service.recordReview('0001', { confirm: true, head: HEAD, text: 'Synthetic review after deadline' });
  await service.tick(); expect((await service.status()).tasks[0].reason).toBe('cumulative_ciSeconds');
  expect(control.launch).toHaveBeenCalledTimes(1); expect(await selected()).toBeNull();
});
test('stop of an unreceived selection retains its identity and releases the slot after host cancellation proof', async () => {
  await task(); await task('0002'); await authorize(); await authorize('0002'); await enable(); await service.tick();
  const first = await selected();
  control.stop.mockImplementationOnce(async input => receipts.set(input.requestId, { ...first, phase: 'finished', progress: {
    phase: 'finished', coreRecorded: true, preflight: true, result: 'blocked', stopReason: 'operator_stop', usage: {} } }));
  await service.stop('0001', first.requestId, { confirm: true }); await service.tick();
  expect(control.launch).not.toHaveBeenCalled(); expect((await selected()).pipelineId).toBe('0002');
  expect((await service.status()).tasks[0].state).toBe('stopped');
});

test('a task taken by another worker after selection cancels only the unreceived identity', async () => {
  await task(); await task('0002'); await authorize(); await authorize('0002'); await enable(); await service.tick();
  const first = await selected(); await Task.updateOne({ pipelineId: '0001' }, { $set: { status: 'in_progress', assignee: 'other-worker' } });
  control.stop.mockImplementationOnce(async () => receipts.set(first.requestId, { ...first, phase: 'finished', cancelledBeforeLaunch: true,
    progress: { phase: 'finished', coreRecorded: true, preflight: true, result: 'blocked', usage: {} } }));
  await service.tick(); await service.tick();
  expect(control.launch).not.toHaveBeenCalled(); expect((await selected()).pipelineId).toBe('0002');
  const original = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(original.assignee).toBe('other-worker'); expect(original.codingAutonomy.reason).toBe('task_owned_elsewhere');
});
