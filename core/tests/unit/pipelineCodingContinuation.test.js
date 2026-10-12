'use strict';
const express = require('express');
const request = require('supertest');
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Runtime = require('../../models/RuntimeCoordination');
const autonomy = require('../../src/services/pipelineCodingAutonomyService');
const recovery = require('../../src/services/pipelineCodingAutonomyRecovery');
const continuation = require('../../src/services/pipelineCodingContinuation');
const policy = require('../../src/services/pipelineCodingAutonomyPolicy');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
jest.mock('../../src/services/heavyWorkQueueService', () => ({
  get: jest.fn(), runtimeOverlaps: jest.requireActual('../../src/services/heavyWorkQueueService').runtimeOverlaps,
}));
const queue = require('../../src/services/heavyWorkQueueService');
const REQUEST = '10000000-0000-4000-8000-000000000001';
const CALL = '20000000-0000-4000-8000-000000000001';
const OTHER_CALL = '20000000-0000-4000-8000-000000000002';
const QUEUE = '30000000-0000-4000-8000-000000000001';
const DISPATCH = '40000000-0000-4000-8000-000000000001';
const HOST = 'http://coding.invalid:11434';
const REF = '/private/synthetic-terminal.json';
const SHA = 'a'.repeat(64);
const app = express().use(express.json()).use('/api/pipeline', require('../../routes/pipeline-coding-autonomy'));
let control;
let job;

const body = (extra = {}) => ({ confirm: true, confirmation: recovery.CONFIRMATION,
  expectedRevision: 10, key: `coding-recovery:${REQUEST}`, callIds: [CALL], receiptRef: REF, receiptSha256: SHA, ...extra });
const post = (input = body(), id = '0001', requestId = REQUEST) =>
  request(app).post(`/api/pipeline/coding-autonomy/tasks/${id}/runs/${requestId}/recover`).send(input);
const task = () => Task.findOne({ pipelineId: '0001' }).lean();
const settings = () => Settings.findById('coding-autonomy').lean();
const run = async () => (await task()).codingAutonomy.runs.at(-1);
function interceptWrite(model, predicate, replacement) {
  const original = model.updateOne;
  return jest.spyOn(model, 'updateOne').mockImplementation(function (...args) {
    return predicate(args[1]) ? replacement(() => original.apply(this, args), args) : original.apply(this, args);
  });
}
const preparedWrite = update => update.$set?.codingAutonomy?.runs.at(-1)?.recovery?.state === 'prepared';
const confirmedWrite = update => update.$set?.['codingAutonomy.runs.$[run].recovery.state'] === 'confirmed';

beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Settings.deleteMany({}), Runtime.deleteMany({})]);
  const start = new Date(Date.now() - 95000).toISOString();
  const end = new Date(Date.now() - 40000).toISOString();
  const automation = normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1', mode: 'review_only',
    policyRef: 'synthetic/v1', dataClassification: 'public', operations: ['update'], scope: ['synthetic.py'],
    lockKeys: ['file:synthetic.py'], executionProfile: 'coding-sandbox/v1', verificationProfile: 'agentx-dispatcher-tests/v1',
    budgets: { maxDurationMs: 7200000, maxAttempts: 2, maxCostNanodollars: 0 }, humanGates: ['review', 'merge', 'deploy'] });
  await Task.create({ pipelineId: '0001', title: 'Synthetic stopped coding task', spec: 'Disposable CPU fixture',
    service: 'agentx-coding', status: 'blocked', assignee: 'coding-team', risk: 'low', automation,
    automationAttemptCount: 1, automationAttempts: [{ leaseId: 'synthetic-lease', dispatchRequestId: REQUEST,
      assignee: 'coding-team', attempt: 1, acquiredAt: start, heartbeatAt: end, expiresAt: end, completedAt: end, finalState: 'blocked',
      resultRequestFingerprint: 'b'.repeat(64), evidence: { schema: 'agentx.pipeline-automation-evidence/v1',
        verification: { status: 'unknown' }, usage: { durationMs: 37000 } } }],
    codingAutonomy: { schema: 'agentx.pipeline-coding-autonomy/v1', revision: 10, authorized: false,
      state: 'blocked', reason: 'native_completion_unverified', basis: 'c'.repeat(64), queueRequestId: QUEUE,
      limits: policy.limits(), spent: { workSeconds: 5, testSeconds: 2, modelSeconds: 1, modelCalls: 1, ciSeconds: 7 },
      observations: [], seenDiagnostics: [], manualInterventions: [], runs: [{ requestId: REQUEST,
        parentRequestId: null, startedAt: start, expectedAttemptCount: 0, pendingInferences: [CALL],
        currentUsage: { workSeconds: 27, testSeconds: 0, modelCalls: 0, modelSeconds: 0 },
        modelReceipts: [{ callId: CALL, state: 'unknown', startedAt: start, finishedAt: start }] }] } });
  await Task.create({ pipelineId: '0002', title: 'Other owner task', spec: 'Preserve this task',
    service: 'agentx-coding', status: 'in_progress', assignee: 'other-owner' });
  await Settings.create({ _id: 'coding-autonomy', enabled: false, revision: 2,
    active: { pipelineId: '0001', requestId: REQUEST, selectedAt: start } });
  await Runtime.collection.insertOne({ _id: 'runtime', maintenance: null, workloads: [], inferences: [], releaseReceipts: [] });
  job = { id: QUEUE, state: 'failed', source: { type: 'coding', ref: 'synthetic-session', taskId: '0001' },
    hosts: [HOST], resourceIds: ['synthetic-gpu'], executor: { mode: 'operator', receiptRef: REF },
    dispatchId: DISPATCH, operation: { id: DISPATCH, authority: 'operator-attestation' },
    finishedAt: new Date(Date.now() - 30000).toISOString(), releaseReceipt: { authority: 'operator-attestation',
      operationId: DISPATCH, confirmation: 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED',
      receiptRef: REF, receiptSha256: SHA, actor: 'synthetic-operator' } };
  queue.get.mockImplementation(async () => structuredClone(job));
  control = { status: jest.fn(async () => ({ busy: false, run: { pipelineId: '0001', requestId: REQUEST,
    phase: 'finished', progress: { pipelineId: '0001', requestId: REQUEST, phase: 'finished',
      result: 'blocked', coreRecorded: true, usage: { workSeconds: 37, testSeconds: 3, modelSeconds: 2, modelCalls: 1 } } } })),
    launch: jest.fn(), stop: jest.fn(), reconcile: jest.fn() };
  autonomy.configureControl(control);
});
afterEach(() => { jest.restoreAllMocks(); autonomy.configureControl(null); });


const NEXT_QUEUE = '30000000-0000-4000-8000-000000000002';
const HEAD = 'f'.repeat(40);
const grantBody = extra => ({ confirm: true, confirmation: continuation.CONFIRMATION,
  key: 'synthetic-budget-grant', expectedRevision: 10, head: HEAD, queueRequestId: NEXT_QUEUE,
  additionalRuns: 1, verificationProfile: 'agentx-dispatcher-tests/v1', text: 'Correct the reviewed defects.',
  budget: { workSeconds: 3600, testSeconds: 300, modelSeconds: 1800, modelCalls: 20, ciSeconds: 600 }, ...extra });
const grant = input => continuation.continueRecovered('0001', REQUEST, input || grantBody(), control);
beforeEach(async () => {
  const original = await task(); const state = original.codingAutonomy; const last = state.runs[0];
  last.finishedAt = new Date().toISOString(); last.result = 'blocked';
  last.usage = { workSeconds: 100, testSeconds: 3, modelSeconds: 2, modelCalls: 1 };
  last.recovery = { state: 'confirmed', authority: 'operator-reconciliation', releaseVerifiedAt: new Date().toISOString(),
    historicalJournalFingerprint: policy.digest([last.modelReceipts, last.pendingInferences]),
    nativeAttemptFingerprint: policy.digest(original.automationAttempts[0]) };
  state.state = 'stopped'; state.basis = policy.basis(original);
  await Task.updateOne({ pipelineId: '0001' }, { $set: { codingAutonomy: state } });
  await Settings.updateOne({ _id: 'coding-autonomy' }, { $set: { active: null } });
  job = { id: NEXT_QUEUE, state: 'dispatching', source: { type: 'coding', ref: 'synthetic-session', taskId: '0001' },
    hosts: [HOST], executor: { mode: 'operator' }, reservation: {
      start: new Date(Date.now() - 10000).toISOString(), end: new Date(Date.now() + 3600000).toISOString() } };
  control.status.mockResolvedValue({ busy: false, run: { pipelineId: '0001', requestId: REQUEST, phase: 'finished',
    progress: { pipelineId: '0001', requestId: REQUEST, phase: 'finished', coreRecorded: true, result: 'blocked', checkpoint: HEAD } } });
});
test('credits and one additional worker preserve all original runs, costs, scope and UNKNOWN', async () => {
  const before = await task(), other = await Task.findOne({ pipelineId: '0002' }).lean();
  const after = await grant();
  expect(after.codingAutonomy.runs).toEqual(before.codingAutonomy.runs);
  expect(after.codingAutonomy.spent).toEqual(before.codingAutonomy.spent);
  expect(after.automation).toEqual(before.automation); expect(after.automationAttempts).toEqual(before.automationAttempts);
  expect(after.codingAutonomy.budgetGrants).toHaveLength(1);
  expect(policy.remaining(after).modelSeconds).toBe(policy.remaining(before).modelSeconds + 1800);
  expect(policy.remaining(after).maxResumes).toBe(1);
  expect(after.codingAutonomy).toMatchObject({ authorized: true, state: 'correction', verificationProfile: 'agentx-dispatcher-tests/v1' });
  expect((await settings()).active).toBeNull(); expect(control.launch).not.toHaveBeenCalled();
  expect(await Task.findOne({ pipelineId: '0002' }).lean()).toEqual(other);
});
test('same grant retry adds no credit or intervention and changed evidence refuses', async () => {
  const first = await grant(); const retry = await grant();
  expect(retry.codingAutonomy.budgetGrants).toHaveLength(1);
  expect(policy.remaining(retry)).toEqual(policy.remaining(first));
  expect(retry.codingAutonomy.manualInterventions).toEqual(first.codingAutonomy.manualInterventions);
  await expect(grant(grantBody({ head: 'a'.repeat(40) }))).rejects.toThrow('different');
});
test('lost first acknowledgement retains activation fence until identical retry durably receives journal', async () => {
  const spy = interceptWrite(Task, update => update.$set?.codingAutonomy?.budgetGrants?.length,
    async commit => { await commit(); throw new Error('Synthetic lost acknowledgement'); });
  await expect(grant()).rejects.toThrow('lost acknowledgement'); spy.mockRestore();
  expect((await settings()).active.recovery.kind).toBe('coding-continuation');
  await expect(autonomy.configure({ enabled: true, confirm: true, expectedRevision: (await settings()).revision })).rejects.toThrow('recovery');
  await grant(); expect((await settings()).active).toBeNull();
  expect((await task()).codingAutonomy.budgetGrants).toHaveLength(1);
});
test.each(['unrecovered', 'active-worker', 'checkpoint', 'campaign', 'scope', 'unknown-child'])('refuses %s before additional credit or inference', async kind => {
  if (kind === 'unrecovered') await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.runs.0.recovery.state': 'prepared' } });
  if (kind === 'active-worker') control.status.mockResolvedValue({ busy: true });
  if (kind === 'checkpoint') control.status.mockResolvedValue({ busy: false, run: { phase: 'finished', progress: { checkpoint: 'a'.repeat(40) } } });
  if (kind === 'campaign') job.source.taskId = '0002';
  if (kind === 'scope') await Task.updateOne({ pipelineId: '0001' }, { $set: { spec: 'Changed task' } });
  if (kind === 'unknown-child') await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { inferences: [{ requestId: REQUEST, host: HOST, state: 'UNKNOWN' }] } });
  await expect(grant()).rejects.toThrow(); expect((await task()).codingAutonomy.budgetGrants).toBeUndefined();
  expect(control.launch).not.toHaveBeenCalled();
});
test('new dispatch is a linked second run on the same card and consumes its own grant', async () => {
  const oldRun = await run(); await grant();
  await autonomy.configure({ enabled: true, confirm: true, expectedRevision: (await settings()).revision });
  await autonomy.tick(); const fresh = await task();
  expect(fresh.codingAutonomy.runs).toHaveLength(2);
  expect(fresh.codingAutonomy.runs[0]).toEqual(oldRun);
  expect(fresh.codingAutonomy.runs[1].parentRequestId).toBe(REQUEST);
  const manifest = await autonomy.workerManifest('0001', fresh.codingAutonomy.runs[1].requestId);
  expect(manifest.continuationCheckpoint).toBe(HEAD);
  expect(manifest.verificationProfile).toBe('agentx-dispatcher-tests/v1');
});
test('a second key cannot double-credit the same recovered execution', async () => {
  await grant();
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.authorized': false, 'codingAutonomy.state': 'stopped' } });
  await expect(grant(grantBody({ key: 'second', expectedRevision: (await task()).codingAutonomy.revision }))).rejects.toThrow('already received');
});
