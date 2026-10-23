'use strict';

jest.mock('../../src/services/modelRouterConfig', () => ({
  ensureTaskModelOverridesLoaded: jest.fn(async () => {}),
  getModelForTask: jest.fn(() => ({ model: 'coder:27b-q8_0', url: 'http://10.0.0.5:11434/' }))
}));
jest.mock('../../src/services/pipelineReportEscalation', () => ({ policy: jest.fn(async () => ({ enabled: false, maxCostNanodollars: 1e10 })) }));
jest.mock('../../src/services/pipelineReportService', () => ({ status: jest.fn() }));

const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const Continuation = require('../../models/PipelineReportContinuation');
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const resume = require('../../src/services/pipelineReportResume');

const PARENT = '10d7dc99-f2dc-4bd4-b903-6258c6e1d6a7';
const SHA = 'f'.repeat(64);
const docs = (reviewed, left) => [...Array.from({ length: reviewed }, (_, i) => ({ path: `docs/R${i}.md`, state: 'reviewed' })),
  ...Array.from({ length: left }, (_, i) => ({ path: `docs/L${i}.md`, state: i % 3 ? 'pending' : 'partial' }))];
const stopped = (requestId, reason = 'runner_error', sha = SHA) => ({ by: 'coding-team', at: new Date(),
  reportOutcome: { requestId, kind: 'blocked', reason, reportName: 'DOCUMENTATION_PEER_REVIEW.md', partial: { deliverableId: 'd', sha256: sha } } });

let control;
let preparation;
async function seed(extra = {}) {
  const _id = new (require('mongoose').Types.ObjectId)();
  await Task.collection.insertOne({ _id, pipelineId: '0939', title: 'Documentation peer review', status: 'blocked', service: 'agentx-coding',
    assignee: 'coding-team', updatedAt: new Date('2026-10-16T08:30:00Z'), feedback: [stopped(PARENT)],
    codingResult: { profile: 'report', reportName: 'DOCUMENTATION_PEER_REVIEW.md', modelCallLimit: 128 }, ...extra });
  await Run.collection.insertOne({ _id: PARENT, taskId: String(_id), claimSeq: 26, state: 'blocked', coverage: { documents: docs(62, 14) } });
  return _id;
}
function wire() {
  control = { target: 'host',
    status: jest.fn(async ({ requestId } = {}) => (requestId ? { run: null } : { busy: false, candidates: [{ pipelineId: '0939', expectedAttemptCount: 3 }] })),
    launch: jest.fn(async () => ({ accepted: true })), reconcile: jest.fn(async () => ({ reconciled: true })) };
  preparation = { apply: jest.fn(async input => {
    await Task.updateOne({ pipelineId: input.pipelineId }, { $set: { status: 'queued', codingResult: { ...input.result } } });
    return Task.findOne({ pipelineId: input.pipelineId }).lean();
  }) };
  resume.configure({ control, preparation });
}

beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Run.deleteMany({}), Queue.deleteMany({}), Archive.deleteMany({}), Runtime.deleteMany({}), Continuation.deleteMany({})]);
  wire();
  require('../../src/services/pipelineReportService').status.mockReset();
});

it('receives the original checkpoint after a drain race only when Core proves all calls terminated', async () => {
  const job = { id: 'f2222222-2222-4222-8222-222222222222', executor: { pipelineId: '0939' },
    reservation: { end: new Date(Date.now() + 60000).toISOString() } };
  await seed({ status: 'in_progress', reportResume: { queueRequestId: job.id, launch: { requestId: PARENT, executorId: 'fixture-executor' } } });
  await Run.updateOne({ _id: PARENT }, { $set: { state: 'active' } });
  control.status.mockResolvedValue({ busy: false, run: { requestId: PARENT, phase: 'unknown', canReconcile: true,
    progress: { stage: 'checkpoint' } } });
  const reports = require('../../src/services/pipelineReportService');
  reports.status.mockResolvedValue({ requestId: PARENT, state: 'active', terminationVerified: false, pendingInferences: ['original-call'] });
  expect(await resume.observeCampaign(job)).toMatchObject({ terminal: false, operationId: PARENT });
  expect(control.reconcile).not.toHaveBeenCalled();
  reports.status.mockResolvedValue({ requestId: PARENT, state: 'active', terminationVerified: true, pendingInferences: [] });
  // A lost receive reply keeps the same identity and does not release the campaign.
  control.reconcile.mockRejectedValueOnce(new Error('response lost'));
  expect(await resume.observeCampaign(job)).toMatchObject({ terminal: false, operationId: PARENT });
  expect(control.reconcile).toHaveBeenCalledWith({ pipelineId: '0939', requestId: PARENT, executorId: 'fixture-executor' });
  expect(control.launch).not.toHaveBeenCalled();
  await Run.updateOne({ _id: PARENT }, { $set: { state: 'blocked' } });
  await Task.updateOne({ pipelineId: '0939' }, { $set: { status: 'blocked' }, $push: { feedback: stopped(PARENT, 'runner_error', 'c'.repeat(64)) } });
  const result = await resume.observeCampaign(job);
  expect(result).toMatchObject({ terminal: true, state: 'failed', operationId: PARENT });
  expect(control.reconcile).toHaveBeenCalledTimes(1);
});

it('previews the remaining work and a safety budget instead of asking for numbers', async () => {
  await seed();
  const view = await resume.preview('0939');
  expect(view.checkpoint).toEqual({ parentRequestId: PARENT, parentSha256: SHA });
  expect(view.work).toMatchObject({ total: 76, remaining: 14, reviewed: 62, source: 'coverage' });
  // 14 documents x 6 calls + writer, with margin, never below the 128-call floor.
  expect(view.budget).toMatchObject({ modelCalls: 135, executions: 2, basis: 'remaining_documents' });
  expect(view.budget.workSeconds).toBe(Math.ceil((14 * 240 + 900) * 1.5));
  expect(view.route).toEqual({ model: 'coder:27b-q8_0', host: 'http://10.0.0.5:11434' });
});

it('plans a Core-owned campaign as soon as possible, once per checkpoint, starting automatically', async () => {
  await seed();
  await expect(resume.resume('0939', { when: 'asap' })).rejects.toMatchObject({ code: 'REPORT_RESUME_INVALID' });
  const view = await resume.resume('0939', { confirm: true, when: 'asap', autoContinue: true });
  expect(view.campaign).toMatchObject({ state: 'reserved', reservation: { when: 'asap', autoStart: true } });
  const job = await queue.get(view.campaign.id);
  expect(job).toMatchObject({ kind: 'other', hosts: ['http://10.0.0.5:11434'], executor: { mode: 'pipeline-report', pipelineId: '0939' },
    source: { type: 'coding', taskId: '0939' }, estimatedMinutes: view.budget.minutes });
  expect(view.resume).toMatchObject({ basis: PARENT, autoContinue: true, allowCloudEscalation: false, state: 'planned' });
  const again = await resume.resume('0939', { confirm: true, when: 'tonight' }).catch(error => error);
  // Same checkpoint: the same campaign is replanned, never duplicated.
  if (!(again instanceof Error)) expect(again.campaign.id).toBe(view.campaign.id);
  expect((await queue.list()).jobs).toHaveLength(1);
});

it('at the slot, grants the campaign and launches the worker from the checkpoint once, then settles on no progress', async () => {
  await seed();
  const view = await resume.resume('0939', { confirm: true, when: 'asap', allowCloudEscalation: true });
  // Bring the slot to now.
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': view.campaign.id },
    { $set: { 'jobs.$.reservation.start': new Date(Date.now() - 1000).toISOString() } });
  const launched = await launcher.dispatchDue();
  expect(launched).toHaveLength(1);
  const grant = preparation.apply.mock.calls[0][0].reportGrant;
  expect(grant).toMatchObject({ confirm: true, queueRequestId: view.campaign.id, additionalRuns: 2,
    budget: { modelCalls: 135 }, allowCloudEscalation: true });
  expect(preparation.apply.mock.calls[0][0].result).toMatchObject({ profile: 'report', parentRequestId: PARENT, parentSha256: SHA });
  expect(control.launch).toHaveBeenCalledTimes(1);
  const requestId = control.launch.mock.calls[0][0].requestId;
  expect(control.launch.mock.calls[0][0]).toMatchObject({ pipelineId: '0939', expectedAttemptCount: 3, parentRequestId: PARENT, confirm: true });
  expect(await queue.get(view.campaign.id)).toMatchObject({ state: 'running', operation: { id: requestId } });
  await launcher.dispatchDue();
  expect(control.launch).toHaveBeenCalledTimes(1);

  // Still running: the campaign stays open.
  expect((await evidence.reconcile(view.campaign.id, 'test')).state).toBe('running');
  // The worker stopped with the same saved bytes as its parent: no progress.
  await Task.updateOne({ pipelineId: '0939' }, { $set: { status: 'blocked' }, $push: { feedback: stopped(requestId, 'model_call_limit') } });
  const settled = await evidence.reconcile(view.campaign.id, 'test');
  expect(settled).toMatchObject({ state: 'failed', releaseReceipt: { authority: 'core.pipeline-report', outcome: { requestId, reason: 'model_call_limit' } } });
  expect((await Task.findOne({ pipelineId: '0939' }).lean()).reportResume).toMatchObject({ state: 'stopped', result: { decision: 'no_progress' } });
});

it('releases the campaign with Core\'s own receipt when the worker could not be started', async () => {
  await seed();
  const view = await resume.resume('0939', { confirm: true, when: 'asap' });
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': view.campaign.id },
    { $set: { 'jobs.$.reservation.start': new Date(Date.now() - 1000).toISOString() } });
  preparation.apply.mockRejectedValueOnce(Object.assign(new Error('The original worker must have its native terminal receipt'), { code: 'REPORT_NATIVE_RELEASE_UNVERIFIED' }));
  await launcher.dispatchDue();
  const job = await queue.get(view.campaign.id);
  expect(job.state).toBe('failed');
  expect(job.releaseReceipt.receiptRef).toMatch(/^core:not-started: .*native terminal receipt/);
  expect(control.launch).not.toHaveBeenCalled();
});

it('refuses a delivered report, a running task and a changed checkpoint at the slot', async () => {
  await seed({ feedback: [{ by: 'coding-team', reportOutcome: { requestId: PARENT, deliverableId: 'd', sha256: SHA } }] });
  await expect(resume.resume('0939', { confirm: true, when: 'asap' })).rejects.toMatchObject({ code: 'REPORT_RESUME_DELIVERED' });
  await Task.updateOne({ pipelineId: '0939' }, { $set: { feedback: [stopped(PARENT)], status: 'running' } });
  await expect(resume.resume('0939', { confirm: true, when: 'asap' })).rejects.toMatchObject({ code: 'REPORT_RESUME_BUSY' });
  await Task.updateOne({ pipelineId: '0939' }, { $set: { status: 'blocked' } });
  const view = await resume.resume('0939', { confirm: true, when: 'asap' });
  await Task.updateOne({ pipelineId: '0939' }, { $push: { feedback: stopped('11111111-1111-4111-8111-111111111111') } });
  await expect(resume.preDispatch(await queue.get(view.campaign.id))).rejects.toMatchObject({ code: 'REPORT_RESUME_CHANGED' });
});

it('retries an unstarted failure under an explicit new campaign and replays that identity', async () => {
  await seed();
  const original = await resume.resume('0939', { confirm: true, when: 'asap' });
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': original.campaign.id },
    { $set: { 'jobs.$.reservation.start': new Date(Date.now() - 1000).toISOString() } });
  preparation.apply.mockRejectedValueOnce(Object.assign(new Error('Checkpoint storage is full'), { code: 'REPORT_CHECKPOINT_CAPACITY' }));
  await launcher.dispatchDue();
  const failed = await resume.preview('0939');
  expect(failed.retryCampaignId).toBe(original.campaign.id);
  const input = { confirm: true, when: 'asap', retryCampaignId: original.campaign.id };
  const renewed = await resume.resume('0939', input);
  expect(renewed.campaign.id).not.toBe(original.campaign.id);
  expect(renewed.resume.grantKey).not.toBe(original.resume.grantKey);
  expect(renewed.resume).toMatchObject({ retryOfCampaignId: original.campaign.id, checkpoint: original.checkpoint });
  const replay = await resume.resume('0939', input);
  expect(replay.campaign.id).toBe(renewed.campaign.id);
  expect((await queue.get(original.campaign.id)).state).toBe('failed');
  expect((await queue.list()).jobs).toHaveLength(2);
  expect(control.launch).not.toHaveBeenCalled();
});

it('does not retry an unknown launch or discard a committed grant', async () => {
  await seed();
  const original = await resume.resume('0939', { confirm: true, when: 'asap' });
  const input = { confirm: true, when: 'asap', retryCampaignId: original.campaign.id };
  await expect(resume.resume('0939', input)).rejects.toMatchObject({ code: 'REPORT_RESUME_CHANGED' });
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': original.campaign.id },
    { $set: { 'jobs.$.state': 'failed', 'jobs.$.releaseReceipt': { receiptRef: 'core:not-started: fixture' } } });
  await Task.updateOne({ pipelineId: '0939' }, { $set: { codingReportAuthority: {
    revision: 1, grants: [{ key: original.resume.grantKey }], bindings: [] } } });
  expect((await resume.preview('0939')).retryCampaignId).toBeNull();
  await expect(resume.resume('0939', input)).rejects.toMatchObject({ code: 'REPORT_RESUME_CHANGED' });
  expect((await queue.list()).jobs).toHaveLength(1);
});

it('reports the selected native ceiling without increasing additional credit or changing the planned grant', async () => {
  await seed({ codingResult: { profile: 'report', reportName: 'DOCUMENTATION_PEER_REVIEW.md', modelCallLimit: 256 } });
  const view = await resume.resume('0939', { confirm: true, when: 'asap' });
  expect(view.perExecutionModelCalls).toBe(256);
  expect(view.budget).toMatchObject({ modelCalls: 135, executions: 1 });
  expect(view.resume.budget.modelCalls).toBe(135);
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': view.campaign.id },
    { $set: { 'jobs.$.reservation.start': new Date(Date.now() - 1000).toISOString() } });
  await launcher.dispatchDue();
  expect(preparation.apply.mock.calls[0][0].reportGrant.budget.modelCalls).toBe(135);
  expect(control.launch.mock.calls[0][0].modelCallLimit).toBe(256);
});
