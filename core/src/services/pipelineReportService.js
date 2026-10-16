'use strict';
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const claim = require('./pipelineManualReportClaim');
const files = require('./pipelineTaskDeliverableService');
const routerConfig = require('./modelRouterConfig');
const checkpoints = require('./pipelineReportCheckpoint');
const { isDeepStrictEqual } = require('util');
const { feedbackTransition } = require('./pipelineTaskTransitionPaths');
const content = require('../helpers/fileContentChecks');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WC = { w: 1, j: true };
function acknowledged(result) {
  if (result.acknowledged !== true) throw claim.fail('Report persistence acknowledgement is unverified', 'REPORT_PERSISTENCE_UNVERIFIED', 503);
}
const FIELDS = ['pipelineId', 'taskId', 'claimSeq', 'specSha256', 'sourceCommit', 'reportName', 'model', 'modelCallLimit', 'parentRequestId', 'parentSha256'];
function modelCallLimit(value = 128) {
  if (!Number.isSafeInteger(value) || value < 128 || value > 256)
    throw claim.fail('Report model call limit must be an integer from 128 to 256', 'REPORT_BUDGET_INVALID', 400);
  return value;
}
const sameIntent = (existing, intent) => FIELDS.every(name =>
  (name === 'modelCallLimit' ? modelCallLimit(existing[name]) : name.startsWith('parent') ? existing[name] ?? null : existing[name]) === intent[name]);

async function task(id) {
  const value = await Task.findOne({ pipelineId: id }).lean();
  if (!value) throw claim.fail('Task not found', 'NOT_FOUND', 404);
  return value;
}
async function run(id, key) {
  if (!UUID.test(key)) throw claim.fail('Invalid report request identity', 'REPORT_ID_INVALID', 400);
  const value = await Run.findById(key).lean();
  if (!value || value.pipelineId !== id) throw claim.fail('Report request not found', 'REPORT_NOT_FOUND', 404);
  return value;
}
function termination(value) {
  return value.pendingInferences.length === 0 && value.modelReceipts.every(row => ['completed', 'refused'].includes(row.state));
}
function completed(value) { return termination(value) && value.modelReceipts.length > 0 && value.modelReceipts.every(row => row.state === 'completed'); }
async function status(id, key) {
  // Read only this accepted execution's receipts. Later task edits/deletion do
  // not erase custody of an outstanding inference; no task content is exposed.
  const value = await run(id, key);
  return { requestId: key, pipelineId: id, claimSeq: value.claimSeq, state: value.state, model: value.model,
    modelCallLimit: modelCallLimit(value.modelCallLimit), modelCallsRemaining: Math.max(0, modelCallLimit(value.modelCallLimit) - value.modelReceipts.length),
    pendingInferences: value.pendingInferences, modelReceipts: value.modelReceipts, terminationVerified: termination(value),
    allCallsCompleted: completed(value), result: value.result || null,
    reportName: value.reportName, sourceCommit: value.sourceCommit, parentRequestId: value.parentRequestId || null, parentSha256: value.parentSha256 || null,
    cumulativeUsage: await checkpoints.lineage(value) };
}
async function start(id, key, body) {
  const limit = modelCallLimit(body.modelCallLimit);
  const parent = checkpoints.selection(body);
  if (!/^\d{4}$/.test(id) || !UUID.test(key) || !/^[a-f0-9]{40}$/.test(body.sourceCommit || '') || typeof body.reportName !== 'string'
    || body.reportName.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(body.reportName)
    || !Number.isSafeInteger(body.hardRemainingSeconds) || body.hardRemainingSeconds < 1 || body.hardRemainingSeconds > 14400)
    throw claim.fail('Invalid native report request', 'REPORT_REQUEST_INVALID', 400);
  const owner = await task(id);
  const guard = claim.query(owner, body);
  await routerConfig.ensureTaskModelOverridesLoaded();
  const target = routerConfig.getModelForTask('code_generation');
  if (body.model !== target.model || !target.url || String(body.model).startsWith('openrouter/'))
    throw claim.fail('Report must use the qualified local coding route', 'REPORT_MODEL_CHANGED');
  const intent = Object.fromEntries(FIELDS.map(name => [name, name === 'pipelineId' ? id : name === 'taskId' ? String(owner._id)
    : name === 'modelCallLimit' ? limit : name.startsWith('parent') ? parent[name] : body[name]]));
  const existing = await Run.findById(key).lean();
  if (existing) {
    if (!sameIntent(existing, intent)) throw claim.fail('This report request has a different intent', 'REPORT_REQUEST_CONFLICT');
    return status(id, key);
  }
  // Admission must wait for uniqueness, including immediately after deployment.
  await Run.collection.createIndex({ taskId: 1, claimSeq: 1 },
    { unique: true, partialFilterExpression: { executionVersion: 1 } });
  if (await Run.exists({ taskId: intent.taskId, claimSeq: intent.claimSeq, _id: { $ne: key } }))
    throw claim.fail('This task claim already belongs to another report execution', 'REPORT_CLAIM_EXECUTION_CONFLICT');
  if (parent.parentRequestId) {
    const { parent: prior } = await checkpoints.load(intent);
    if ((await checkpoints.lineage(prior)).executions >= 32)
      throw claim.fail('The report continuation chain reached its bounded limit; review the saved work before a fresh execution', 'REPORT_LINEAGE_LIMIT');
  }
  const permit = await Task.updateOne(guard, { $inc: { manualReportPermitSeq: 1 } }, { timestamps: false, writeConcern: WC });
  acknowledged(permit);
  if (permit.modifiedCount !== 1) throw claim.fail('Report claim changed before authorization');
  try { await Run.create([{ _id: key, ...intent, executionVersion: 1, host: target.url, deadlineAt: new Date(Date.now() + body.hardRemainingSeconds * 1000) }], { writeConcern: WC }); }
  catch (error) {
    if (error.code !== 11000) throw error;
    if (!await Run.exists({ _id: key })) throw claim.fail('This task claim already belongs to another report execution', 'REPORT_CLAIM_EXECUTION_CONFLICT');
  }
  const created = await run(id, key);
  if (!sameIntent(created, intent)) throw claim.fail('This report request has a different intent', 'REPORT_REQUEST_CONFLICT');
  return status(id, key);
}
function decodeReport(body) {
  const decoded = typeof body?.dataUrl === 'string' && body.dataUrl.length <= content.maxDataUrlLength(files.MAX_BYTES) && content.parseDataUrl(body.dataUrl);
  if (!decoded || decoded.mimeType !== 'text/markdown' || !decoded.canonical || !decoded.data.length || decoded.data.length > files.MAX_BYTES
    || content.decodeText(decoded.data).error || content.sha256(decoded.data) !== body.sha256)
    throw claim.fail('Report content must be bounded Markdown matching its SHA-256', 'REPORT_BYTES_INVALID', 400);
  return decoded.data;
}
function reportOrigin(value, state) {
  return { requestId: value._id, claimSeq: value.claimSeq, sourceCommit: value.sourceCommit, specSha256: value.specSha256, state };
}
function outcome(value, receipt) {
  return { schema: 'agentx.pipeline-report-result/v1', requestId: value._id, claimSeq: value.claimSeq,
    sourceCommit: value.sourceCommit, specSha256: value.specSha256, reportName: value.reportName, deliverableId: receipt.id, sha256: receipt.sha256 };
}
// Result writes are immutable. Return only the exact durably stored result;
// a failed acknowledgement is reconciled by identity on the next request.
async function record(value, result, state) {
  const saved = await Run.updateOne({ _id: value._id, finalKind: value.finalKind, finalHash: value.finalHash,
    state: 'active', result: { $exists: false } },
  { $set: { state, result }, $inc: { revision: 1 } }, { writeConcern: WC });
  acknowledged(saved);
  const stored = await run(value.pipelineId, value._id);
  if (stored.state !== state || !isDeepStrictEqual(stored.result, result))
    throw claim.fail('Report has a different durable terminal result', 'REPORT_RESULT_CONFLICT');
  return stored.result;
}
async function replay(owner, value, body) {
  const entry = (owner?.feedback || []).find(row => row.reportOutcome?.requestId === value._id);
  if (!entry) return null;
  if (entry.reportOutcome.kind === 'blocked') throw claim.fail('This report request stopped before delivery', 'REPORT_REQUEST_BLOCKED');
  if (entry.reportOutcome.sha256 !== body.sha256) throw claim.fail('A different result is already recorded', 'REPORT_RESULT_CONFLICT');
  const receipt = await files.verify(owner.pipelineId, entry.reportOutcome.deliverableId);
  if (receipt.availability.status !== 'available' || receipt.sha256 !== body.sha256) throw claim.fail('Recorded report bytes are unverified', 'REPORT_BYTES_UNVERIFIED');
  const outcome = await record(value, entry.reportOutcome, 'review');
  return { reportReadyForReview: true, alreadyRecorded: true, receipt, outcome };
}
async function finalize(value, kind, hash) {
  if (!value.finalKind) {
    const saved = await Run.updateOne({ _id: value._id, revision: value.revision, state: 'active', finalKind: { $exists: false }, pendingInferences: { $size: 0 } },
      { $set: { finalKind: kind, finalHash: hash }, $inc: { revision: 1 } }, { writeConcern: WC });
    acknowledged(saved);
  }
  const current = await run(value.pipelineId, value._id);
  if (current.finalKind !== kind || current.finalHash !== hash) throw claim.fail('Report changed before its final intent', 'REPORT_RESULT_CONFLICT');
  return current;
}
async function superseded(value, extra = {}) {
  const result = { schema: 'agentx.pipeline-report-result/v1', requestId: value._id, claimSeq: value.claimSeq,
    sourceCommit: value.sourceCommit, kind: 'superseded', ...extra };
  return { superseded: true, outcome: await record(value, result, 'blocked') };
}
async function ownerOrNull(id) { return Task.findOne({ pipelineId: id }).lean(); }
async function heartbeat(id, key) {
  const value = await run(id, key);
  if (value.state !== 'active' || value.finalKind) throw claim.fail('Report execution is already closing');
  const owner = await task(id), guard = claim.query(owner, value), heartbeatAt = new Date();
  const saved = await Task.updateOne(guard, { $set: { heartbeatAt } }, { writeConcern: WC });
  acknowledged(saved);
  if (saved.matchedCount !== 1) throw claim.fail('The report no longer owns this task heartbeat');
  return { pipelineId: id, requestId: key, heartbeatAt };
}
async function checkpoint(id, key) {
  const value = await run(id, key);
  claim.query(await task(id), value);
  if (value.state !== 'active' || value.finalKind) throw claim.fail('Report execution is already closing');
  return checkpoints.read(value);
}
async function reconcileModels(id, key) {
  const value = await run(id, key);
  for (const row of value.modelReceipts) {
    if (row.state !== 'unknown' || !['completed', 'refused'].includes(row.settlement?.state)
      || row.finishedAt !== row.settlement.finishedAt || !Number.isFinite(Date.parse(row.settlement.finishedAt))) continue;
    const saved = await Run.updateOne({ _id: key, modelReceipts: { $elemMatch: { callId: row.callId, state: 'unknown',
      finishedAt: row.finishedAt, 'settlement.state': row.settlement.state, 'settlement.finishedAt': row.settlement.finishedAt } } }, {
      $set: { 'modelReceipts.$[call].state': row.settlement.state }, $pull: { pendingInferences: row.callId }, $inc: { revision: 1 },
    }, { arrayFilters: [{ 'call.callId': row.callId, 'call.state': 'unknown',
      'call.finishedAt': row.finishedAt, 'call.settlement.state': row.settlement.state, 'call.settlement.finishedAt': row.settlement.finishedAt }], writeConcern: WC });
    acknowledged(saved);
  }
  return status(id, key);
}
async function submit(id, key, body) {
  decodeReport(body);
  let value = await run(id, key);
  if (!completed(value)) throw claim.fail('Native model termination must be proven before report delivery', 'REPORT_MODEL_TERMINATION_UNVERIFIED');
  value = await finalize(value, 'review', body.sha256);
  if (value.result?.kind === 'superseded') return { superseded: true, outcome: value.result };
  let owner = await ownerOrNull(id);
  const previous = await replay(owner, value, body);
  if (previous) return previous;
  if (!owner) return superseded(value, { sha256: body.sha256 });
  let guard;
  try { guard = claim.query(owner, value, ['in_progress', 'blocked']); }
  catch (error) { if (error.code === 'REPORT_CLAIM_CHANGED') return superseded(value, { sha256: body.sha256 }); throw error; }
  const permit = await Task.updateOne(guard, { $inc: { manualReportPermitSeq: 1 } }, { timestamps: false, writeConcern: WC });
  acknowledged(permit);
  if (permit.modifiedCount !== 1) {
    const raced = await replay(await ownerOrNull(id), value, body);
    return raced || superseded(value, { sha256: body.sha256 });
  }
  const name = value.reportName.slice(0, -3) + '-' + key + '.md';
  const { receipt } = await files.register(id, { by: 'coding-team', name, sha256: body.sha256, dataUrl: body.dataUrl }, { reportOrigin: reportOrigin(value, 'candidate') });
  if (receipt.availability.status !== 'available') throw claim.fail('Report bytes are unverified', 'REPORT_BYTES_UNVERIFIED');
  const entry = { by: 'coding-team', at: new Date(), reportOutcome: outcome(value, receipt),
    text: `Report ready for independent review: ${receipt.ref}. Source snapshot ${value.sourceCommit}; coverage requires review.` };
  const update = { $push: { feedback: entry }, $set: { status: 'review' } };
  feedbackTransition(guard, update, owner, { entry, requested: 'done' });
  const changed = await Task.findOneAndUpdate(guard, update, { new: true, writeConcern: WC }).lean();
  if (!changed) {
    const raced = await replay(await ownerOrNull(id), value, body);
    return raced || superseded(value, { sha256: body.sha256 });
  }
  return { reportReadyForReview: true, receipt, outcome: await record(value, entry.reportOutcome, 'review') };
}

async function stop(id, key, body) {
  let value = await run(id, key);
  if (!termination(value)) throw claim.fail('Native termination remains unverified', 'REPORT_MODEL_TERMINATION_UNVERIFIED');
  let workerOutcome;
  try { workerOutcome = require('../../../shared/pipelineWorkerOutcome').normalize(body.workerOutcome, id); }
  catch (_) { throw claim.fail('Invalid report stop observation', 'REPORT_STOP_INVALID', 400); }
  if (workerOutcome.requestId !== key || workerOutcome.claimSeq !== value.claimSeq || workerOutcome.source !== 'worker_report')
    throw claim.fail('Stop does not match its native report claim', 'REPORT_CLAIM_INVALID', 400);
  const partial = body.partial == null ? null : { sha256: body.partial.sha256, size: decodeReport(body.partial).length };
  const finalIntent = partial ? { workerOutcome, partialSha256: partial.sha256 } : workerOutcome;
  value = await finalize(value, 'blocked', require('crypto').createHash('sha256').update(JSON.stringify(finalIntent)).digest('hex'));
  if (value.result?.kind === 'superseded') return { blocked: true, superseded: true, outcome: value.result };
  async function replayStop(owner) {
    const old = (owner?.feedback || []).find(row => row.reportOutcome?.requestId === key);
    if (!old) return null;
    if (old.reportOutcome.kind !== 'blocked' || !isDeepStrictEqual(old.workerOutcome, workerOutcome))
      throw claim.fail('Report already has a different terminal result', 'REPORT_RESULT_CONFLICT');
    if (partial) {
      const receipt = await files.verify(id, old.reportOutcome.partial?.deliverableId);
      if (receipt.sha256 !== partial.sha256 || receipt.availability.status !== 'available')
        throw claim.fail('Stored partial report bytes are unverified', 'REPORT_BYTES_UNVERIFIED');
    }
    return { blocked: true, alreadyRecorded: true, outcome: await record(value, old.reportOutcome, 'blocked') };
  }
  const owner = await ownerOrNull(id), old = await replayStop(owner);
  if (old) return old;
  const supersede = async () => ({ blocked: true, ...await superseded(value, { reason: workerOutcome.reason }) });
  if (!owner) return supersede();
  let guard;
  try { guard = claim.query(owner, value, ['in_progress', 'blocked']); }
  catch (error) { if (error.code === 'REPORT_CLAIM_CHANGED') return supersede(); throw error; }
  let archived = null;
  if (partial) {
    const permit = await Task.updateOne(guard, { $inc: { manualReportPermitSeq: 1 } }, { timestamps: false, writeConcern: WC });
    acknowledged(permit);
    if (permit.modifiedCount !== 1) return await replayStop(await ownerOrNull(id)) || supersede();
    const name = value.reportName.slice(0, -3).slice(0, 112) + '-partial-' + key + '.md';
    const { receipt } = await files.register(id, { by: 'coding-team', name, sha256: body.partial.sha256, dataUrl: body.partial.dataUrl }, { reportOrigin: reportOrigin(value, 'partial') });
    if (receipt.availability.status !== 'available' || receipt.sha256 !== partial.sha256)
      throw claim.fail('Partial report bytes are unverified', 'REPORT_BYTES_UNVERIFIED');
    archived = { deliverableId: receipt.id, sha256: receipt.sha256, size: receipt.size };
  }
  const summary = { schema: 'agentx.pipeline-report-result/v1', requestId: key, claimSeq: value.claimSeq, kind: 'blocked', reason: workerOutcome.reason,
    reportName: value.reportName, sourceCommit: value.sourceCommit, specSha256: value.specSha256, ...(archived ? { partial: archived } : {}) };
  const entry = { by: 'coding-team', at: new Date(), reportOutcome: summary, workerOutcome,
    text: archived ? 'Report worker stopped. Its partial draft is saved in task files; requested scope remains incomplete.'
      : 'Report worker stopped without a registered partial draft; requested scope remains incomplete.' };
  const update = { $push: { feedback: entry }, $set: { status: 'blocked' } };
  feedbackTransition(guard, update, owner, { entry, requested: 'blocked' });
  const changed = await Task.findOneAndUpdate(guard, update, { new: true, writeConcern: WC }).lean();
  if (!changed) return await replayStop(await ownerOrNull(id)) || supersede();
  return { blocked: true, outcome: await record(value, summary, 'blocked') };
}
module.exports = { start, status, checkpoint, submit, stop, reconcileModels, heartbeat, run, task, termination, UUID, acknowledged, modelCallLimit };
