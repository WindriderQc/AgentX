'use strict';
const crypto = require('crypto');
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const File = require('../../models/PipelineTaskDeliverable');
const authority = require('../../src/services/pipelineReportAuthority');
const preparation = require('../../src/services/pipelineTaskPreparationService');
const reports = require('../../src/services/pipelineReportService');
const inference = require('../../src/services/pipelineReportInference');
const queue = require('../../src/services/heavyWorkQueueService');
const config = require('../../src/services/modelRouterConfig');
const coverage = require('../../src/services/pipelineReportCoverage');
const files = require('../../src/services/pipelineTaskDeliverableService');
const { specHash } = require('../../src/services/pipelineManualReportClaim');
const id = () => crypto.randomUUID();
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const HOST = 'http://model.invalid:11434';
let job, control;
beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Run.deleteMany({}), File.deleteMany({})]);
  job = { id: id(), dispatchId: id(), state: 'running', executor: { mode: 'operator' },
    source: { type: 'coding', ref: 'synthetic-coding-session', taskId: '0001' }, hosts: [HOST],
    reservation: { start: new Date(Date.now() - 60000).toISOString(), end: new Date(Date.now() + 14400000).toISOString() } };
  jest.spyOn(queue, 'get').mockImplementation(async () => job);
  jest.spyOn(config, 'ensureTaskModelOverridesLoaded').mockResolvedValue();
  jest.spyOn(config, 'getModelForTask').mockReturnValue({ model: 'fixture-model', url: HOST });
  control = { status: jest.fn(async () => ({ busy: false })), launch: jest.fn() };
  authority.configureControl(control);
});
afterEach(() => jest.restoreAllMocks());
const profile = { profile: 'report', reportName: 'review.md', modelCallLimit: 128 };
const grant = () => ({ key: id(), confirm: true, queueRequestId: job.id, additionalRuns: 1,
  budget: { modelCalls: 128, workSeconds: 7200 } });
async function fixture(extra = {}) {
  const owner = await Task.create({ pipelineId: '0001', title: 'Review fixture', spec: 'Review README against source.',
    status: 'queued', service: 'agentx-coding', ...extra });
  const credits = grant();
  const task = await preparation.apply({ pipelineId: owner.pipelineId, expectedUpdatedAt: owner.updatedAt.toISOString(),
    handoff: true, result: profile, reportGrant: credits });
  return { task, credits };
}
async function claim(task, seq = 2) {
  await Task.updateOne({ _id: task._id }, { $set: { status: 'in_progress', assignee: 'coding-team', transitionSeq: seq,
    transitions: [{ kind: 'claimed', seq }] } });
  return { claimSeq: seq, specSha256: specHash(task), sourceCommit: 'a'.repeat(40), reportName: 'review.md', model: 'fixture-model',
    hardRemainingSeconds: 14400, inventory: { sourceCommit: 'a'.repeat(40), documents: [{ path: 'README.md', sha256: digest('fixture markdown') }] } };
}
test('Core saves the exact result and one explicit grant; replays preserve credit and never launch a worker', async () => {
  const { task, credits } = await fixture();
  expect(task.codingResult).toEqual(profile);
  const replay = await preparation.apply({ pipelineId: task.pipelineId, expectedUpdatedAt: task.updatedAt.toISOString(),
    handoff: true, result: profile, reportGrant: credits });
  expect(replay.codingReportAuthority).toEqual(task.codingReportAuthority);
  await expect(authority.prepare(replay, profile, { ...credits, budget: { modelCalls: 256, workSeconds: 7200 } }))
    .rejects.toMatchObject({ code: 'REPORT_GRANT_CONFLICT' });
  await expect(authority.prepare(replay, profile, { ...credits, key: id() })).rejects.toMatchObject({ code: 'REPORT_GRANT_CONFLICT' });
  expect(control.launch).not.toHaveBeenCalled();
});
test('all historic UUIDs remain charged, including earlier code executions and larger native call counts', async () => {
  const historic = Array.from({ length: 5 }, (_, n) => ({ by: 'coding-team', workerOutcome: {
    requestId: id(), claimSeq: n + 1, result: 'blocked', reason: 'model_call_limit', usage: { modelCalls: 100, workSeconds: 1000 } } }));
  const task = await Task.create({ pipelineId: '0001', title: 'History fixture', spec: 'Preserve history', service: 'agentx-coding', feedback: historic });
  await Run.create({ _id: historic[0].workerOutcome.requestId, pipelineId: '0001', taskId: String(task._id), claimSeq: 1,
    specSha256: specHash(task), sourceCommit: 'a'.repeat(40), reportName: 'old.md', model: 'fixture-model', host: HOST,
    deadlineAt: new Date(), state: 'blocked', modelReceipts: Array.from({ length: 110 }, () => ({ state: 'completed' })) });
  control.status.mockResolvedValue({ busy: false, run: { pipelineId: '0001', requestId: historic.at(-1).workerOutcome.requestId,
    phase: 'finished', progress: { phase: 'finished' } } });
  const saved = await authority.prepare(task.toObject(), profile, grant());
  expect(saved.baseline).toMatchObject({ executions: 5, modelCalls: 510, workSeconds: 5000 });
  expect(authority.limits(saved)).toEqual({ executions: 6, modelCalls: 638, workSeconds: 12200 });
  expect(saved.grants[0].spentBefore.receipts).toHaveLength(5);
});
test('a missing or uncertain earlier report fences a new identity even when its parent is omitted', async () => {
  const { task } = await fixture(), intent = await claim(task), key = id();
  await reports.start('0001', key, intent);
  const call = await inference.prepare({ 'x-agentx-report-task': '0001', 'x-agentx-report-request': key, 'x-agentx-coding-call': id() }, 'fixture-model');
  await call.finish('unknown');
  await Task.updateOne({ _id: task._id }, { $set: { transitionSeq: 4, transitions: [{ kind: 'claimed', seq: 4 }] } });
  await expect(reports.start('0001', id(), { ...intent, claimSeq: 4 })).rejects.toMatchObject({ code: 'REPORT_MODEL_TERMINATION_UNVERIFIED' });
  expect(await Run.countDocuments({})).toBe(1);
  expect((await Run.findById(key).lean()).pendingInferences).toHaveLength(1);
});
test('an allocation whose acknowledgement was lost is reconciled by its original UUID after a restart', async () => {
  const { task } = await fixture(), intent = await claim(task), key = id();
  const original = Task.updateOne.bind(Task);
  jest.spyOn(Task, 'updateOne').mockImplementationOnce(original).mockImplementationOnce(async (...args) => {
    await original(...args); throw new Error('Synthetic acknowledgement lost');
  });
  await expect(reports.start('0001', key, intent)).rejects.toThrow('acknowledgement lost');
  jest.restoreAllMocks();
  jest.spyOn(config, 'ensureTaskModelOverridesLoaded').mockResolvedValue();
  jest.spyOn(config, 'getModelForTask').mockReturnValue({ model: 'fixture-model', url: HOST });
  jest.spyOn(queue, 'get').mockResolvedValue(job);
  await expect(reports.start('0001', id(), intent)).rejects.toMatchObject({ code: 'REPORT_AUTHORITY_UNVERIFIED' });
  const replay = await reports.start('0001', key, intent);
  expect(replay.requestId).toBe(key);
  expect((await Task.findById(task._id).lean()).codingReportAuthority.bindings).toHaveLength(1);
});
test.each(['expired', 'host', 'task', 'dispatch'])('the native report rejects a changed campaign %s before model admission', async change => {
  const { task } = await fixture(), intent = await claim(task), key = id();
  await reports.start('0001', key, intent);
  if (change === 'expired') job.reservation.end = new Date(Date.now() - 1).toISOString();
  if (change === 'host') job.hosts = ['http://other.invalid:11434'];
  if (change === 'task') job.source.taskId = '0002';
  if (change === 'dispatch') job.dispatchId = id();
  await expect(inference.prepare({ 'x-agentx-report-task': '0001', 'x-agentx-report-request': key, 'x-agentx-coding-call': id() }, 'fixture-model'))
    .rejects.toMatchObject({ code: 'REPORT_CAMPAIGN_UNVERIFIED' });
  expect((await Run.findById(key).lean()).modelReceipts).toHaveLength(0);
});
test('the campaign bounds the native deadline and a changed snapshot cannot replay a request', async () => {
  job.reservation.end = new Date(Date.now() + 60000).toISOString();
  const { task } = await fixture(), intent = await claim(task), key = id();
  await reports.start('0001', key, intent);
  expect((await Run.findById(key).lean()).deadlineAt.toISOString()).toBe(job.reservation.end);
  const altered = { ...intent, inventory: { ...intent.inventory, documents: [{ path: 'README.md', sha256: digest('changed') }] } };
  await expect(reports.start('0001', key, altered)).rejects.toMatchObject({ code: 'REPORT_REQUEST_CONFLICT' });
});
test('Core refuses a missing durable report selection instead of granting code privileges', async () => {
  const { task } = await fixture(), intent = await claim(task);
  await Task.updateOne({ _id: task._id }, { $set: { codingResult: { profile: 'code' } } });
  await expect(reports.start('0001', id(), intent)).rejects.toMatchObject({ code: 'REPORT_PROFILE_CONFLICT' });
  expect(await Run.countDocuments({})).toBe(0);
});
test('source coverage retains pending scope and refuses reviewed rows without concrete evidence', () => {
  const snapshot = coverage.inventory({ sourceCommit: 'a'.repeat(40), documents: [{ path: 'README.md', sha256: digest('doc') }] }, 'a'.repeat(40));
  expect(coverage.coverage(null, snapshot).documents[0].state).toBe('pending');
  expect(() => coverage.coverage({ inventorySha256: snapshot.sha256, documents: [{ ...snapshot.documents[0], state: 'reviewed', evidence: [] }] }, snapshot))
    .toThrow('concrete source references');
  expect(() => coverage.inventory({ sourceCommit: 'a'.repeat(40), documents: [{ path: '../private.md', sha256: digest('doc') }] }, 'a'.repeat(40)))
    .toThrow('exact Markdown inventory');
});
function stopped(key, partial) {
  return { workerOutcome: { schema: 'agentx.pipeline-worker-outcome/v1', requestId: key, pipelineId: '0001', claimSeq: 2,
    result: 'blocked', reason: 'worker_exit', source: 'worker_report', startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date().toISOString(), usage: { workSeconds: 1, modelCalls: 0 } }, ...(partial ? { partial } : {}) };
}
function upload(text, name = 'fixture.md') {
  return { by: 'operator-fixture', name, sha256: digest(text), dataUrl: 'data:text/markdown;base64,' + Buffer.from(text).toString('base64') };
}
test('Core derives stop progress from accepted coverage and ignores a caller claim about report bytes', async () => {
  const { task } = await fixture(), intent = await claim(task), key = id();
  await reports.start('0001', key, intent);
  const body = stopped(key, upload('# Administrative changes only\n'));
  body.progress = { verified: true, advanced: true, addedUnits: 999 };
  const result = await reports.stop('0001', key, body);
  expect(result.outcome.progress).toMatchObject({ verified: true, advanced: false, addedUnits: 0 });
  expect((await Run.findById(key).lean()).result.progress).toEqual(result.outcome.progress);
  body.progress.advanced = false;
  const replay = await reports.stop('0001', key, body);
  expect(replay).toMatchObject({ alreadyRecorded: true, outcome: result.outcome });
  expect(control.launch).not.toHaveBeenCalled();
});
async function nextGrant(task, key, selected) {
  control.status.mockResolvedValue({ busy: false, run: { pipelineId: '0001', requestId: key, phase: 'finished',
    progress: { phase: 'finished', coreRecorded: true } } });
  const current = await Task.findById(task._id).lean();
  return preparation.apply({ pipelineId: '0001', expectedUpdatedAt: current.updatedAt.toISOString(),
    result: selected, reportGrant: grant(), handoff: true });
}
test('a terminal run that never produced a checkpoint can receive explicit new work on the same task', async () => {
  const { task } = await fixture(), first = await claim(task), key = id();
  await reports.start('0001', key, first); await reports.stop('0001', key, stopped(key));
  const selected = { ...profile, parentRequestId: key, parentSha256: null };
  const prepared = await nextGrant(task, key, selected), intent = await claim(prepared, 4), next = id();
  await reports.start('0001', next, { ...intent, parentRequestId: key, parentSha256: null });
  expect(await reports.checkpoint('0001', next)).toMatchObject({ parentRequestId: key, checkpointAvailable: false, dataUrl: null });
  expect((await reports.status('0001', next)).cumulativeUsage.spent).toMatchObject({ executions: 2, workSeconds: expect.any(Number) });
  expect(await Task.countDocuments({})).toBe(1);
});
test('a rejected review candidate becomes the next grant parent and keeps its cumulative costs', async () => {
  const { task } = await fixture(), intent = await claim(task), key = id();
  await reports.start('0001', key, intent);
  await (await inference.prepare({ 'x-agentx-report-task': '0001', 'x-agentx-report-request': key, 'x-agentx-coding-call': id() }, 'fixture-model')).finish('completed');
  const delivered = await reports.submit('0001', key, upload('# Candidate\n'));
  await Task.updateOne({ _id: task._id }, { $set: { status: 'blocked' } });
  const selected = { ...profile, parentRequestId: key, parentSha256: delivered.receipt.sha256 };
  const prepared = await nextGrant(task, key, selected);
  expect(prepared.codingReportAuthority.grants.at(-1)).toMatchObject({ parentRequestId: key, spentBefore: { modelCalls: 1 } });
  const next = id(); await reports.start('0001', next, { ...await claim(prepared, 4), ...selected });
  expect((await reports.checkpoint('0001', next)).sha256).toBe(delivered.receipt.sha256);
});
test('ordinary uploads honor a report checkpoint reservation even at the shared file limit', async () => {
  const { task } = await fixture();
  for (let n = 0; n < files.MAX_PER_TASK - 1; n++) await files.register('0001', upload('# Existing ' + n, `existing-${n}.md`));
  const key = id(); await reports.start('0001', key, await claim(task));
  const results = await Promise.allSettled([
    files.register('0001', upload('# Competing operator file', 'extra.md')),
    reports.stop('0001', key, stopped(key, upload('# Saved model partial\n'))),
  ]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'DELIVERABLE_LIMIT' } });
  expect(results[1].status).toBe('fulfilled'); expect(await File.countDocuments({})).toBe(files.MAX_PER_TASK);
  expect((await files.verify('0001', results[1].value.outcome.partial.deliverableId)).availability.hashVerified).toBe(true);
});
test('successful report accounting includes the native runner start and freezes it at final intent', async () => {
  const { task } = await fixture(), intent = await claim(task), key = id(), now = Date.now();
  const runnerStartedAt = new Date(now - 90000).toISOString();
  await Task.updateOne({ _id: task._id }, { $set: { transitions: [{ kind: 'claimed', seq: 2, at: new Date(now - 89900) }] } });
  await reports.start('0001', key, { ...intent, runnerStartedAt });
  await (await inference.prepare({ 'x-agentx-report-task': '0001', 'x-agentx-report-request': key, 'x-agentx-coding-call': id() }, 'fixture-model')).finish('completed');
  await reports.submit('0001', key, upload('# Saved report\n'));
  const stored = await Run.findById(key).lean();
  expect(stored.startedAt.toISOString()).toBe(runnerStartedAt);
  const usage = (await reports.status('0001', key)).cumulativeUsage.spent.workSeconds;
  expect(usage).toBeGreaterThanOrEqual(90);
  await Run.updateOne({ _id: key }, { $set: { finishedAt: new Date(Date.now() + 3600000) } });
  expect((await reports.status('0001', key)).cumulativeUsage.spent.workSeconds).toBe(usage);
});

test('known pre-model refusal receives the original claim and preparation cost once, then allows a linked grant', async () => {
  const { task } = await fixture(), intent = await claim(task), key = id(), startedAt = new Date(Date.now() - 5000);
  await Task.updateOne({ _id: task._id }, { $set: { transitions: [{ kind: 'claimed', seq: 2, at: startedAt }] } });
  const body = { ...intent, runnerStartedAt: startedAt.toISOString() };
  const preflight = require('../../src/services/pipelineReportPreflight');
  const receipt = await preflight.receive('0001', key, body, { code: 'REPORT_CAMPAIGN_UNVERIFIED' });
  expect(receipt.usage).toMatchObject({ modelCalls: 0, workSeconds: expect.any(Number) });
  expect(receipt.usage.workSeconds).toBeGreaterThanOrEqual(5);
  expect(await preflight.receive('0001', key, body, { code: 'REPORT_CAMPAIGN_UNVERIFIED' })).toEqual(receipt);
  expect((await reports.status('0001', key)).cumulativeUsage.spent).toMatchObject({ executions: 1, modelCalls: 0 });
  const selected = { ...profile, parentRequestId: key, parentSha256: null };
  const prepared = await nextGrant(task, key, selected), next = id();
  await reports.start('0001', next, { ...await claim(prepared, 4), ...selected });
  expect((await reports.status('0001', next)).cumulativeUsage.spent.executions).toBe(2);
  expect((await Task.findById(task._id).lean()).reportPreflightReceipts).toHaveLength(1);
});
test('a stopped continuation with no new file retains the effective earlier checkpoint and coverage', async () => {
  const { task } = await fixture(), a = id();
  await reports.start('0001', a, await claim(task));
  const saved = await reports.stop('0001', a, stopped(a, upload('# Original model findings')));
  let prepared = await nextGrant(task, a, { ...profile, parentRequestId: a, parentSha256: saved.outcome.partial.sha256 });
  const b = id(); await reports.start('0001', b, { ...await claim(prepared, 4), parentRequestId: a, parentSha256: saved.outcome.partial.sha256 });
  await reports.stop('0001', b, { workerOutcome: { ...stopped(b).workerOutcome, claimSeq: 4 } });
  prepared = await nextGrant(task, b, { ...profile, parentRequestId: b, parentSha256: null });
  const c = id(); await reports.start('0001', c, { ...await claim(prepared, 6), parentRequestId: b, parentSha256: null });
  const restored = await reports.checkpoint('0001', c);
  expect(restored).toMatchObject({ parentRequestId: b, contentRequestId: a, inherited: true, sha256: saved.outcome.partial.sha256 });
  expect(Buffer.from(restored.dataUrl.split(',')[1], 'base64').toString()).toBe('# Original model findings');
  expect(restored.coverage.documents[0].state).toBe('pending');
});

describe('cloud escalation authority (#835)', () => {
  const Settings = require('../../models/PipelineReportContinuation');
  const SOL = 'openai/gpt-5.6-sol';
  const NEMO = 'openrouter/nvidia/nemotron-3-super-120b-a12b:free';
  async function started(allow, enabled = true) {
    await Settings.deleteMany({});
    await Settings.create({ _id: 'report-continuation', escalation: { enabled, models: [SOL, NEMO], maxCostUsdPerTask: 10 } });
    const owner = await Task.create({ pipelineId: '0001', title: 'Review fixture', spec: 'Review README against source.',
      status: 'queued', service: 'agentx-coding' });
    const task = await preparation.apply({ pipelineId: owner.pipelineId, expectedUpdatedAt: owner.updatedAt.toISOString(),
      handoff: true, result: profile, reportGrant: { ...grant(), ...(allow && { allowCloudEscalation: true }) } });
    const intent = await claim(task), key = id();
    await reports.start('0001', key, intent);
    return key;
  }
  const headers = (key, step) => ({ 'x-agentx-report-task': '0001', 'x-agentx-report-request': key, 'x-agentx-coding-call': id(),
    ...(step !== undefined && { 'x-agentx-report-escalation': step }) });

  test('a run records escalation only when the owner policy and its grant both allow it', async () => {
    const key = await started(true);
    expect((await Run.findById(key).lean()).escalation).toEqual({ models: [SOL, NEMO], maxCostNanodollars: 10e9, policyRevision: 0 });
    expect((await reports.status('0001', key)).escalation).toEqual({ models: [SOL, NEMO], maxCostNanodollars: 10e9,
      calls: 0, failures: [], taskSpentNanodollars: 0, costUncertain: false });
    await Run.updateOne({ _id: key }, { $push: { escalationCalls: { nanodollars: 1234 },
      escalationFailures: { callId: 'original-cloud-call', executionState: 'unknown' } } });
    expect((await reports.status('0001', key)).escalation).toMatchObject({ taskSpentNanodollars: 1234, costUncertain: true,
      failures: [{ callId: 'original-cloud-call', executionState: 'unknown' }] });
    await Promise.all([Task.deleteMany({}), Run.deleteMany({})]);
    const refused = await started(false);
    expect((await Run.findById(refused).lean()).escalation).toBeUndefined();
    await Promise.all([Task.deleteMany({}), Run.deleteMany({})]);
    const off = await started(true, false);
    expect((await Run.findById(off).lean()).escalation).toBeUndefined();
  });

  test('an escalated call must name its step and a recorded model, and never gets the local host', async () => {
    const key = await started(true);
    const prepared = await inference.prepare(headers(key, '3'), NEMO);
    expect(prepared.options.hostUrl).toBeUndefined();
    expect(prepared.options.reportAuthority).toBeUndefined();
    expect(prepared.options.reportEscalation).toMatchObject({ requestId: key, pipelineId: '0001', step: 3, model: NEMO, remainingNanodollars: 10e9 });
    await prepared.finish('completed');
    await expect(inference.prepare(headers(key, '4'), 'openai/other')).rejects.toMatchObject({ code: 'REPORT_ESCALATION_REFUSED' });
    await expect(inference.prepare(headers(key), SOL)).rejects.toMatchObject({ code: 'REPORT_INFERENCE_CONFLICT' });
    await expect(inference.prepare(headers(key, 'x'), SOL)).rejects.toMatchObject({ code: 'REPORT_INFERENCE_INVALID' });
    expect((await Run.findById(key).lean()).modelReceipts.map(row => row.state)).toEqual(['completed']);
  });

  test('a run without escalation refuses every escalated call', async () => {
    const key = await started(false);
    await expect(inference.prepare(headers(key, '1'), NEMO)).rejects.toMatchObject({ code: 'REPORT_ESCALATION_REFUSED' });
  });
});

test('retains twenty historical files while granting and saving another report checkpoint', async () => {
  const { task } = await fixture();
  // Ordinary uploads must leave the already promised checkpoint slot available.
  for (let n = 0; n < 20; n++) {
    const data = Buffer.from(`Historical report ${n}`);
    await files.register('0001', { by: 'operator', name: `historical-${n}.md`, sha256: digest(data),
      dataUrl: `data:text/markdown;base64,${data.toString('base64')}` });
  }
  const intent = await claim(task), key = id();
  await reports.start('0001', key, intent);
  await (await inference.prepare({ 'x-agentx-report-task': '0001', 'x-agentx-report-request': key, 'x-agentx-coding-call': id() }, 'fixture-model')).finish('completed');
  const data = Buffer.from('# Complete fixture report');
  const result = await reports.submit('0001', key, { sha256: digest(data),
    dataUrl: `data:text/markdown;base64,${data.toString('base64')}`,
    coverage: { inventorySha256: (await Run.findById(key).lean()).inventory.sha256,
      documents: [{ path: 'README.md', sha256: digest('fixture markdown'), state: 'reviewed',
        evidence: [{ path: 'source.js', sha256: 'f'.repeat(64), line: 1, check: 'Fixture source checked' }] }] } });
  expect(result.reportReadyForReview).toBe(true);
  expect(await File.countDocuments({ pipelineId: '0001' })).toBe(21);
  expect((await files.verify('0001', result.receipt.id)).availability.hashVerified).toBe(true);
});
