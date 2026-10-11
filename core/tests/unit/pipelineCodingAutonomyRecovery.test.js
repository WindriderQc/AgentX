'use strict';
const express = require('express');
const request = require('supertest');
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Runtime = require('../../models/RuntimeCoordination');
const autonomy = require('../../src/services/pipelineCodingAutonomyService');
const recovery = require('../../src/services/pipelineCodingAutonomyRecovery');
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

test('received campaign attestation closes only the exact selection and retains historical model and native evidence', async () => {
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { workloads: [{ requestId: 'other-request',
    hosts: ['http://other.invalid:11434'], resourceIds: ['other-gpu'], recoveryState: 'UNKNOWN' }] } });
  const before = await task();
  const otherBefore = await Task.findOne({ pipelineId: '0002' }).lean();
  const runtimeBefore = await Runtime.findById('runtime').select('+releaseReceipts').lean();
  const result = await post(); expect(result.status).toBe(200);
  const after = await task(); const closed = after.codingAutonomy.runs[0];
  expect(closed.modelReceipts).toEqual(before.codingAutonomy.runs[0].modelReceipts);
  expect(closed.pendingInferences).toEqual([CALL]);
  expect(closed.currentUsage).toEqual(before.codingAutonomy.runs[0].currentUsage);
  expect(after.automationAttempts).toEqual(before.automationAttempts);
  expect(closed.recovery).toMatchObject({ state: 'confirmed', authority: 'operator-reconciliation',
    campaignId: QUEUE, dispatchId: DISPATCH, nativeVerdictFingerprint: 'b'.repeat(64),
    historicalJournalFingerprint: policy.digest([closed.modelReceipts, closed.pendingInferences]) });
  expect(after.codingAutonomy).toMatchObject({ authorized: false, state: 'stopped',
    reason: 'operator_reconciled_native_completion', spent: { testSeconds: 5, modelSeconds: 3, modelCalls: 2, ciSeconds: 7 } });
  expect(after.codingAutonomy.spent.workSeconds).toBeGreaterThanOrEqual(60);
  expect(result.body.data.runs[0]).toMatchObject({ pendingInferenceCount: 0,
    historicalPendingInferenceCount: 1, unresolvedCallIds: [] });
  expect(after.codingAutonomy.manualInterventions).toHaveLength(1);
  expect((await settings())).toMatchObject({ enabled: false, active: null });
  expect(await Task.findOne({ pipelineId: '0002' }).lean()).toEqual(otherBefore);
  expect(await Runtime.findById('runtime').select('+releaseReceipts').lean()).toEqual(runtimeBefore);
  expect(control.launch).not.toHaveBeenCalled(); expect(control.stop).not.toHaveBeenCalled(); expect(control.reconcile).not.toHaveBeenCalled();
});

test('the identical lost-response retry is idempotent while changed evidence refuses', async () => {
  expect((await post()).status).toBe(200); const before = await task();
  expect((await post()).body.data.alreadyRecovered).toBe(true);
  expect(await task()).toEqual(before);
  expect((await post(body({ receiptSha256: 'f'.repeat(64) }))).status).toBe(409);
  expect((await post(body({ key: 'replacement-recovery' }))).status).toBe(409);
  expect(await task()).toEqual(before);
});
test('an explicitly authorized task can recover through its original issue-linked multi-task campaign', async () => {
  delete job.source.taskId; job.source.issueUrl = 'https://github.com/synthetic/project/issues/42';
  expect((await post()).status).toBe(200); expect((await settings()).active).toBeNull();
});

test.each([
  { confirm: false }, { confirmation: 'SUCCESS' }, { callIds: [] }, { callIds: [CALL, CALL] },
  { callIds: ['invalid'] }, { expectedRevision: -1 }, { key: '' }, { receiptSha256: 'invalid' },
])('invalid or unconfirmed recovery input refuses without mutations: %j', async extra => {
  const before = await task(); const config = await settings();
  expect((await post(body(extra))).status).toBe(400);
  expect(await task()).toEqual(before); expect(await settings()).toEqual(config);
});

test.each(['subset', 'foreign-call', 'foreign-task', 'foreign-request', 'completed-model', 'wrong-revision'])('%s cannot settle this historical execution', async mode => {
  if (mode === 'subset') await Task.updateOne({ pipelineId: '0001' }, { $push: {
    'codingAutonomy.runs.0.pendingInferences': OTHER_CALL, 'codingAutonomy.runs.0.modelReceipts': { callId: OTHER_CALL, state: 'unknown' } } });
  if (mode === 'completed-model') await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.runs.0.modelReceipts.0.state': 'completed' } });
  const input = body(mode === 'foreign-call' ? { callIds: [OTHER_CALL] } : mode === 'wrong-revision' ? { expectedRevision: 9 } : {});
  const before = await task(); const config = await settings();
  const response = await post(input, mode === 'foreign-task' ? '0002' : '0001', mode === 'foreign-request' ? OTHER_CALL : REQUEST);
  expect(response.status).toBe(409); expect(await task()).toEqual(before); expect(await settings()).toEqual(config);
});

test.each(['authorization', 'lease', 'capacity', 'verdict', 'latest-attempt', 'host-busy', 'host-missing', 'host-unrecorded'])('%s remains fenced without recovery', async mode => {
  const update = { authorization: { 'codingAutonomy.authorized': true }, lease: { automationLease: { leaseId: 'held' } },
    capacity: { codingCapacity: { admissionId: 'held' } }, verdict: { 'automationAttempts.0.resultRequestFingerprint': null },
    'latest-attempt': { automationAttemptCount: 2 } }[mode];
  if (update) await Task.updateOne({ pipelineId: '0001' }, { $set: update });
  const host = await control.status();
  if (mode === 'host-busy') host.busy = true;
  if (mode === 'host-missing') host.run.phase = 'unknown';
  if (mode === 'host-unrecorded') host.run.progress.coreRecorded = false;
  control.status.mockResolvedValue(host);
  const before = await task(); const config = await settings();
  expect((await post()).status).toBe(409); expect(await task()).toEqual(before); expect(await settings()).toEqual(config);
});

test.each(['source-task', 'state', 'operation', 'authority', 'confirmation', 'hash', 'reference', 'old-receipt'])('campaign %s mismatch refuses recovery', async mode => {
  if (mode === 'source-task') job.source.taskId = '0002';
  if (mode === 'state') job.state = 'running';
  if (mode === 'operation') job.operation.id = 'other-operation';
  if (mode === 'authority') job.releaseReceipt.authority = 'native';
  if (mode === 'confirmation') job.releaseReceipt.confirmation = null;
  if (mode === 'hash') job.releaseReceipt.receiptSha256 = 'f'.repeat(64);
  if (mode === 'reference') job.releaseReceipt.receiptRef = '/private/other.json';
  if (mode === 'old-receipt') job.finishedAt = new Date(0).toISOString();
  const before = await task(); expect((await post()).status).toBe(409);
  expect(await task()).toEqual(before); expect((await settings()).active.recovery).toBeUndefined();
});

test.each(['maintenance-active', 'maintenance-unknown', 'workload', 'inference-unknown', 'physical-alias', 'same-request', 'missing-runtime'])('%s native authority vetoes recovery without alteration', async mode => {
  if (mode === 'missing-runtime') await Runtime.deleteMany({});
  else {
    const value = mode.startsWith('maintenance') ? { maintenance: { state: mode.endsWith('unknown') ? 'UNKNOWN' : 'ACTIVE' } }
      : mode === 'workload' ? { workloads: [{ hosts: [HOST], resourceIds: [] }] }
        : { inferences: [{ host: mode === 'inference-unknown' ? HOST : 'http://alias.invalid:11434', state: 'UNKNOWN',
          resourceIds: mode === 'physical-alias' ? ['synthetic-gpu'] : [], requestId: mode === 'same-request' ? REQUEST : 'other' }] };
    await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: value });
  }
  const before = await Runtime.findById('runtime').lean(); expect((await post()).status).toBe(409);
  expect(await Runtime.findById('runtime').lean()).toEqual(before); expect((await settings()).active.recovery).toBeUndefined();
});

test('a racing enable wins before the recovery fence and leaves the task untouched', async () => {
  const original = control.status.getMockImplementation();
  control.status.mockImplementation(async input => {
    await autonomy.configure({ enabled: true, confirm: true, expectedRevision: 2 }); return original(input);
  });
  const before = await task(); expect((await post()).status).toBe(409);
  expect(await task()).toEqual(before); expect((await settings()).enabled).toBe(true);
});

test('a prepared journal refuses enable and a restarted tick cannot release it or dispatch work', async () => {
  const write = interceptWrite(Task, confirmedWrite, async () => { throw new Error('simulated outage'); });
  expect((await post()).status).toBe(500);
  const before = await task(); expect((await run()).recovery.state).toBe('prepared');
  await expect(autonomy.configure({ enabled: true, confirm: true, expectedRevision: (await settings()).revision })).rejects.toMatchObject({ statusCode: 409 });
  await autonomy.tick(); expect((await settings()).active.requestId).toBe(REQUEST);
  expect(await task()).toEqual(before); expect(control.launch).not.toHaveBeenCalled();
  write.mockRestore(); expect((await post()).status).toBe(200);
  expect((await settings()).active).toBeNull();
  expect((await task()).codingAutonomy.spent).toEqual(before.codingAutonomy.spent);
  expect((await task()).codingAutonomy.manualInterventions).toHaveLength(1);
});

test('an applied prepared write with lost acknowledgement retains the fence until the same recovery is re-acknowledged', async () => {
  const write = interceptWrite(Task, preparedWrite, async apply => { await apply(); return { acknowledged: false, modifiedCount: 1 }; });
  expect((await post()).status).toBe(503); const before = await task();
  expect((await run()).recovery.state).toBe('prepared'); await autonomy.tick();
  expect((await settings()).active.requestId).toBe(REQUEST);
  write.mockRestore(); expect((await post()).status).toBe(200);
  expect((await task()).codingAutonomy.spent).toEqual(before.codingAutonomy.spent);
  expect((await run()).modelReceipts).toEqual(before.codingAutonomy.runs[0].modelReceipts);
});

test.each(['confirmed-ack', 'release-ack'])('lost %s reconciles after restart without charging or changing another selection', async phase => {
  const model = phase === 'confirmed-ack' ? Task : Settings;
  const predicate = phase === 'confirmed-ack' ? confirmedWrite : update => update.$set?.active === null;
  const write = interceptWrite(model, predicate, async apply => { await apply(); return { acknowledged: false, modifiedCount: 1 }; });
  expect((await post()).status).toBe(503); const before = await task();
  write.mockRestore(); await autonomy.tick(); expect((await settings()).active).toBeNull();
  const reconciled = await task(); expect(reconciled.codingAutonomy.spent).toEqual(before.codingAutonomy.spent);
  const other = { pipelineId: '0002', requestId: OTHER_CALL };
  await Settings.updateOne({ _id: 'coding-autonomy' }, { $set: { active: other } });
  expect((await post()).body.data.alreadyRecovered).toBe(true);
  expect((await settings()).active).toEqual(other); expect(await task()).toEqual(reconciled);
});

test('a lost fence acknowledgement creates no journal and is resumed through the same original identity', async () => {
  const write = interceptWrite(Settings, update => Boolean(update.$set?.['active.recovery']),
    async apply => { await apply(); return { acknowledged: false, modifiedCount: 1 }; });
  const before = await task(); expect((await post()).status).toBe(503);
  expect(await task()).toEqual(before); await autonomy.tick(); expect((await settings()).active.requestId).toBe(REQUEST);
  write.mockRestore(); expect((await post()).status).toBe(200); expect((await settings()).active).toBeNull();
});

test('prepared recovery cannot be released by a stale dispatch completion or an ordinary stop', async () => {
  const write = interceptWrite(Task, confirmedWrite, async () => { throw new Error('simulated outage'); });
  expect((await post()).status).toBe(500); write.mockRestore();
  await autonomy.stop('0001', REQUEST, { confirm: true }); await autonomy.tick();
  expect((await settings()).active.requestId).toBe(REQUEST);
  expect((await run()).recovery.state).toBe('prepared');
  expect((await post()).status).toBe(200);
});

test('native duration of a recovered unknown receipt stops growing after administrative resolution', async () => {
  await Task.updateOne({ pipelineId: '0001' }, { $unset: { 'codingAutonomy.runs.0.modelReceipts.0.finishedAt': 1 } });
  expect((await post()).status).toBe(200); const closed = await run();
  expect(policy.nativeModelMs(closed, Date.now() + 86400000)).toBe(policy.nativeModelMs(closed));
  expect(closed.modelReceipts[0].finishedAt).toBeUndefined();
});

test('concurrent recovery requests charge one execution and publish one recovery identity', async () => {
  const responses = await Promise.all([post(), post()]);
  expect(responses.map(item => item.status).sort()).toContain(200);
  expect(responses.every(item => [200, 409].includes(item.status))).toBe(true);
  const durable = await task(); expect(durable.codingAutonomy.manualInterventions).toHaveLength(1);
  expect(durable.codingAutonomy.spent.modelCalls).toBe(2); expect(durable.codingAutonomy.spent.testSeconds).toBe(5);
  expect((await settings()).active).toBeNull();
});

test.each(['model-journal', 'native-attempt', 'campaign-proof', 'new-authority'])('prepared recovery refuses changed %s after an outage', async changed => {
  const write = interceptWrite(Task, confirmedWrite, async () => { throw new Error('simulated outage'); });
  expect((await post()).status).toBe(500); write.mockRestore();
  if (changed === 'model-journal') await Task.updateOne({ pipelineId: '0001' },
    { $set: { 'codingAutonomy.runs.0.modelReceipts.0.finishedAt': new Date().toISOString() } });
  if (changed === 'native-attempt') await Task.updateOne({ pipelineId: '0001' },
    { $set: { 'automationAttempts.0.evidence.usage.durationMs': 999999 } });
  if (changed === 'campaign-proof') job.releaseReceipt.actor = 'different-actor';
  if (changed === 'new-authority') await Runtime.collection.updateOne({ _id: 'runtime' },
    { $set: { inferences: [{ host: HOST, state: 'UNKNOWN' }] } });
  const before = await task(); expect((await post()).status).toBe(409);
  expect(await task()).toEqual(before); expect((await settings()).active.requestId).toBe(REQUEST);
  expect((await run()).recovery.state).toBe('prepared');
});

test.each(['host-busy', 'inference-unknown', 'capacity', 'maintenance'])('confirmed recovery retains its slot when %s appears before release or restart', async held => {
  const write = interceptWrite(Settings, update => update.$set?.active === null, async () => { throw new Error('simulated outage'); });
  expect((await post()).status).toBe(500); write.mockRestore();
  expect((await run()).recovery.state).toBe('confirmed');
  const originalHost = await control.status();
  if (held === 'host-busy') control.status.mockResolvedValue({ ...originalHost, busy: true });
  if (held === 'capacity') await Task.updateOne({ pipelineId: '0001' }, { $set: { codingCapacity: { admissionId: 'held' } } });
  if (held === 'inference-unknown') await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { inferences: [{ host: HOST, state: 'UNKNOWN' }] } });
  if (held === 'maintenance') await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { maintenance: { state: 'UNKNOWN' } } });
  const before = await task(); await autonomy.tick().catch(error => expect(error.statusCode).toBe(409));
  expect((await settings()).active.requestId).toBe(REQUEST); expect((await post()).status).toBe(409);
  expect(await task()).toEqual(before);
  control.status.mockResolvedValue(originalHost);
  await Task.updateOne({ pipelineId: '0001' }, { $unset: { codingCapacity: 1 } });
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { maintenance: null, inferences: [] } });
  expect((await post()).status).toBe(200); expect((await settings()).active).toBeNull();
});

test('an old inference without resource IDs on a physical alias still vetoes recovery', async () => {
  const original = process.env.AGENTX_RUNTIME_RESOURCES_JSON;
  try {
    const alias = 'http://alias.invalid:11434';
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'synthetic-gpu', endpoints: [HOST, alias] }]);
    const topology = require('../../src/services/runtimePhysicalResources').resourceTopology();
    await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { resourceTopologyHash: topology.hash,
      inferences: [{ host: alias, resourceIds: [], state: 'UNKNOWN' }] } });
    expect((await post()).status).toBe(409); expect((await settings()).active.recovery).toBeUndefined();
    expect((await Runtime.findById('runtime').lean()).inferences).toHaveLength(1);
  } finally {
    if (original === undefined) delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    else process.env.AGENTX_RUNTIME_RESOURCES_JSON = original;
  }
});

test('generic waiting-stop cleanup cannot release an acquired recovery fence', async () => {
  const write = interceptWrite(Task, confirmedWrite, async () => { throw new Error('simulated outage'); });
  expect((await post()).status).toBe(500); write.mockRestore();
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.state': 'waiting_ci',
    'codingAutonomy.ciStartedAt': new Date().toISOString() } });
  await autonomy.stop('0001', REQUEST, { confirm: true });
  expect((await settings()).active.requestId).toBe(REQUEST);
  expect((await settings()).active.recovery.key).toBe(body().key);
  expect((await run()).recovery.state).toBe('prepared');
});
