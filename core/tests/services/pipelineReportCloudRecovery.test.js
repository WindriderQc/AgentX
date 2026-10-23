'use strict';
const crypto = require('node:crypto');
const Run = require('../../models/PipelineReportRun');
const Task = require('../../models/PipelineTask');
const File = require('../../models/PipelineTaskDeliverable');
const files = require('../../src/services/pipelineTaskDeliverableService');
const { createRecovery, resolved, resolutions } = require('../../src/services/pipelineReportCloudRecovery');
const { digest } = require('../../src/services/pipelineReportModelRecovery');
const reports = require('../../src/services/pipelineReportService');
const { specHash } = require('../../src/services/pipelineManualReportClaim');
let task, run, row, log, body, control, receiver;
beforeEach(async () => {
  await Promise.all([Run.deleteMany({}), Task.deleteMany({}), File.deleteMany({})]);
  task = await Task.create({ pipelineId: '0001', service: 'agentx-coding', title: 'Synthetic report', spec: 'Review frozen source.',
    status: 'in_progress', assignee: 'coding-team', transitionSeq: 2 });
  await Task.updateOne({ _id: task._id }, { $set: { transitions: [{ kind: 'claimed', seq: 2 }] } });
  row = { callId: crypto.randomUUID(), prepareId: crypto.randomUUID(), state: 'unknown',
    startedAt: new Date(Date.now() - 10000).toISOString(), finishedAt: new Date(Date.now() - 5000).toISOString() };
  run = await Run.create({ _id: crypto.randomUUID(), pipelineId: '0001', taskId: String(task._id), claimSeq: 2, specSha256: specHash(task),
    sourceCommit: 'a'.repeat(40), inventorySha256: 'b'.repeat(64), reportName: 'review.md', model: 'synthetic-local', host: 'http://model.invalid:11434',
    deadlineAt: new Date(Date.now() + 10000), modelReceipts: [row], pendingInferences: [row.callId],
    escalation: { models: ['fixture/model'], maxCostNanodollars: 2e9 },
    escalationFailures: [{ callId: row.callId, step: 1, executionState: 'unknown',
      attempts: [{ model: 'fixture/model', code: 'OPENCLAW_NATIVE_MODEL_FAILED', executionState: 'unknown' }] }] });
  log = [{ timestamp: String((Date.parse(row.finishedAt) - 20) * 1000), pid: '1234', unit: 'openclaw-gateway.service',
    message: '2026-10-23T12:00:00.000Z [provider-transport-fetch] [model-fetch] response provider=fixture api=openai-completions model=model status=402 elapsedMs=469 dispatcher=new contentType=application/json' }];
  control = { status: jest.fn(async () => ({ busy: false, run: { requestId: run._id, pipelineId: '0001', phase: 'unknown', progress: { checkpoint: run.sourceCommit } } })) };
  receiver = createRecovery({ control });
  body = { by: 'synthetic-operator', callId: row.callId, prepareId: row.prepareId, expectedReceiptSha256: digest(row),
    claimSeq: 2, sourceCommit: run.sourceCommit, specSha256: run.specSha256, inventorySha256: run.inventorySha256,
    confirmation: 'RECEIVE_ORIGINAL_CLOUD_PAYMENT_REFUSAL' };
});

test('exports a charged completed answer only after its original execution settles', async () => {
  const completedRow = { ...row, state: 'completed', settlement: { state: 'completed', finishedAt: row.finishedAt } };
  const call = { callId: row.callId, step: 1, model: 'fixture/model', nanodollars: 123000, costSource: 'runtime-estimate', billing: 'paid' };
  await Run.updateOne({ _id: run._id }, { $set: { modelReceipts: [completedRow], pendingInferences: [], escalationCalls: [call] } });
  expect(await resolutions(task._id)).toEqual([]);
  await Run.updateOne({ _id: run._id }, { $set: { state: 'blocked' } });
  expect(await resolutions(task._id)).toEqual([expect.objectContaining({ requestId: run._id, callId: row.callId,
    step: 1, model: 'fixture/model', executionState: 'completed', evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect((await Run.findById(run._id).lean()).escalationCalls).toHaveLength(1);
  expect((await Run.findById(run._id).lean()).escalationCalls[0].nanodollars).toBe(123000);
  await Run.updateOne({ _id: run._id }, { $set: { pendingInferences: ['unresolved-original'] } });
  expect(await resolutions(task._id)).toEqual([]);
  await Run.updateOne({ _id: run._id }, { $set: { pendingInferences: [], 'modelReceipts.0.state': 'unknown' } });
  expect(await resolutions(task._id)).toEqual([]);
  await Run.updateOne({ _id: run._id }, { $set: { 'modelReceipts.0.state': 'completed', 'escalationCalls.0.nanodollars': null } });
  expect(await resolutions(task._id)).toEqual([]);
});
async function archive() {
  const data = Buffer.from(JSON.stringify(log));
  const { receipt } = await files.register('0001', { by: 'synthetic-operator', name: 'synthetic-provider-refusal.json',
    dataUrl: 'data:application/json;base64,' + data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') });
  body.evidence = { deliverableId: receipt.id, receiptRef: receipt.ref, sha256: receipt.sha256 };
}
test('receives exact native payment refusal without clearing pending; native reconciliation retains the original unknown', async () => {
  await archive();
  expect(await receiver.receive('0001', run._id, body)).toMatchObject({ recovered: true, reconcileRequired: true });
  const received = await Run.findById(run._id).lean();
  expect(received.pendingInferences).toEqual([row.callId]);
  expect(received.modelReceipts[0]).toMatchObject({ state: 'unknown', settlement: { state: 'refused', finishedAt: row.finishedAt },
    terminationRecovery: { originalUnknownReceipt: row, nanodollars: 0, nativeJournal: log[0], operatorMapping: { authority: 'operator-attestation' } } });
  expect(received.escalationFailures).toEqual(run.toObject().escalationFailures);
  expect(await resolutions(task._id)).toEqual([]);
  expect(await receiver.receive('0001', run._id, body)).toMatchObject({ idempotent: true });
  const terminal = await reports.reconcileModels('0001', run._id);
  expect(terminal).toMatchObject({ pendingInferences: [], terminationVerified: true, allCallsCompleted: false, escalation: { costUncertain: false } });
  const settled = await Run.findById(run._id).lean();
  expect(resolved(settled, row.callId)).toBe(true);
  expect(await resolutions(task._id)).toEqual([expect.objectContaining({ requestId: run._id, callId: row.callId, step: 1, model: 'fixture/model' })]);
  expect(await receiver.receive('0001', run._id, body)).toMatchObject({ idempotent: true });
  const Settings = require('../../models/PipelineReportContinuation');
  await Settings.deleteMany({});
  await Settings.create({ _id: 'report-continuation', escalation: { enabled: true, models: ['other/model'], maxCostUsdPerTask: 2 } });
  const escalation = require('../../src/services/pipelineReportEscalation');
  const granted = { _id: task._id, codingReportAuthority: { grants: [{ allowCloudEscalation: true }] } };
  expect(await escalation.forRun(granted)).toMatchObject({ maxCostNanodollars: 2e9, models: ['other/model'],
    refusalResolutions: [{ requestId: run._id, callId: row.callId, step: 1, model: 'fixture/model' }] });
  expect(await escalation.forRun({ _id: task._id })).toBeUndefined();
});
test.each(['sourceCommit', 'inventorySha256', 'specSha256', 'expectedReceiptSha256', 'prepareId', 'claimSeq', 'confirmation', 'by'])('refuses changed %s', async field => {
  await archive(); body[field] = 'different';
  await expect(receiver.receive('0001', run._id, body)).rejects.toMatchObject({ code: 'REPORT_CLOUD_REFUSAL_UNVERIFIED' });
  expect((await Run.findById(run._id).lean()).modelReceipts[0]).toEqual(row);
});
test.each(['status', 'model', 'pid', 'unit', 'time', 'elapsed', 'multiple'])('refuses contradictory native %s evidence', async kind => {
  if (kind === 'status') log[0].message = log[0].message.replace('status=402', 'status=503');
  if (kind === 'model') log[0].message = log[0].message.replace('model=model', 'model=other');
  if (kind === 'pid') log[0].pid = '';
  if (kind === 'unit') log[0].unit = 'other.service';
  if (kind === 'time') log[0].timestamp = String(Date.now() * 1000);
  if (kind === 'elapsed') log[0].message = log[0].message.replace('elapsedMs=469', 'elapsedMs=999999');
  if (kind === 'multiple') log.push(log[0]);
  await archive();
  await expect(receiver.receive('0001', run._id, body)).rejects.toMatchObject({ code: 'REPORT_CLOUD_REFUSAL_UNVERIFIED' });
  expect((await Run.findById(run._id).lean()).pendingInferences).toEqual([row.callId]);
});
test.each(['busy', 'scope', 'multiple-attempts', 'cost', 'lost-ack'])('retains fencing on %s', async kind => {
  await archive();
  if (kind === 'busy') control.status.mockResolvedValue({ busy: true });
  if (kind === 'scope') await Task.updateOne({ _id: task._id }, { $set: { spec: 'Changed scope' } });
  if (kind === 'multiple-attempts') await Run.updateOne({ _id: run._id }, { $push: { 'escalationFailures.0.attempts': { model: 'fixture/other' } } });
  if (kind === 'cost') await Run.updateOne({ _id: run._id }, { $push: { escalationCalls: { callId: row.callId, nanodollars: 100 } } });
  if (kind === 'lost-ack') jest.spyOn(Run, 'updateOne').mockResolvedValueOnce({ acknowledged: false });
  try { await expect(receiver.receive('0001', run._id, body)).rejects.toThrow(); }
  finally { jest.restoreAllMocks(); }
  expect((await Run.findById(run._id).lean()).pendingInferences).toEqual([row.callId]);
});

test('receives a native Responses bad-request refusal under explicit generic confirmation', async () => {
  log[0].message = log[0].message.replace('api=openai-completions', 'api=openai-responses').replace('status=402', 'status=400');
  body.confirmation = 'RECEIVE_ORIGINAL_CLOUD_PROVIDER_REFUSAL';
  await archive();
  expect(await receiver.receive('0001', run._id, body)).toMatchObject({ recovered: true });
  expect((await Run.findById(run._id).lean()).modelReceipts[0].terminationRecovery).toMatchObject({ httpStatus: 400, nanodollars: 0 });
});

test('a payment-only confirmation cannot receive a different native refusal', async () => {
  log[0].message = log[0].message.replace('status=402', 'status=400');
  await archive();
  await expect(receiver.receive('0001', run._id, body)).rejects.toThrow();
});

test('known refused attempts do not disqualify later completed work, but a refusal alone cannot deliver', async () => {
  await archive(); await receiver.receive('0001', run._id, body);
  expect((await reports.reconcileModels('0001', run._id)).allCallsCompleted).toBe(false);
  await Run.updateOne({ _id: run._id }, { $push: { modelReceipts: { callId: crypto.randomUUID(), prepareId: crypto.randomUUID(),
    state: 'completed', startedAt: row.startedAt, finishedAt: row.finishedAt } } });
  expect((await reports.status('0001', run._id)).allCallsCompleted).toBe(true);
  await Run.updateOne({ _id: run._id }, { $push: { modelReceipts: { callId: 'uncertain', state: 'unknown' } } });
  expect((await reports.status('0001', run._id)).allCallsCompleted).toBe(false);
});
