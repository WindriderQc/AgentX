'use strict';
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const reports = require('./pipelineReportService');
const claim = require('./pipelineManualReportClaim');
const WC = { w: 1, j: true };
async function prepare(headers, model, signal) {
  const key = headers['x-agentx-report-request'], id = headers['x-agentx-report-task'], callId = headers['x-agentx-coding-call'];
  if (headers['x-agentx-coding-request'] || !reports.UUID.test(key || '') || !reports.UUID.test(callId || '') || !/^\d{4}$/.test(id || ''))
    throw claim.fail('Invalid report inference identity', 'REPORT_INFERENCE_INVALID', 400);
  const value = await reports.run(id, key), owner = await reports.task(id);
  const guard = claim.query(owner, value);
  if (value.model !== model || value.state !== 'active' || value.finalKind || value.deadlineAt.getTime() <= Date.now())
    throw claim.fail('Report model or execution window changed', 'REPORT_INFERENCE_CONFLICT');
  if (value.pendingInferences.length || value.modelReceipts.length >= 128 || value.modelReceipts.some(row => row.callId === callId))
    throw claim.fail('Reconcile the prior receipt; model requests cannot be replayed', 'REPORT_INFERENCE_PENDING');
  const permitted = await Task.updateOne(guard, { $inc: { manualReportPermitSeq: 1 } }, { timestamps: false, writeConcern: WC });
  reports.acknowledged(permitted);
  if (permitted.modifiedCount !== 1) throw claim.fail('Report claim changed before inference');
  const prepareId = require('crypto').randomUUID();
  let timer;
  try {
    const saved = await Run.updateOne({ _id: key, revision: value.revision, state: 'active', finalKind: { $exists: false }, pendingInferences: { $size: 0 } }, {
      $push: { modelReceipts: { callId, prepareId, state: 'pending', startedAt: new Date().toISOString() }, pendingInferences: callId }, $inc: { revision: 1 },
    }, { writeConcern: WC });
    reports.acknowledged(saved);
    if (saved.modifiedCount !== 1) throw claim.fail('Report inference changed before dispatch');
  } catch (error) {
    // This invocation has not returned to the dispatcher. Only its own durable
    // preparation nonce may attest refusal; a concurrent call stays untouched.
    try { await finish('refused'); } catch (_) { /* Unknown persistence retains the original fence. */ }
    throw error;
  }
  const abort = new AbortController();
  timer = setTimeout(() => abort.abort(claim.fail('Report hard budget exhausted', 'REPORT_HARD_BUDGET')), Math.max(1, value.deadlineAt.getTime() - Date.now()));
  timer.unref?.();
  async function finish(state) {
    clearTimeout(timer);
    const finishedAt = new Date().toISOString(), prefix = 'modelReceipts.$[call]';
    const update = { $set: { [`${prefix}.state`]: 'unknown', [`${prefix}.finishedAt`]: finishedAt }, $inc: { revision: 1 } };
    if (state !== 'unknown') update.$set[`${prefix}.settlement`] = { state, finishedAt };
    const settled = await Run.updateOne({ _id: key, modelReceipts: { $elemMatch: { callId, prepareId, state: 'pending' } } }, update,
      { arrayFilters: [{ 'call.callId': callId, 'call.prepareId': prepareId, 'call.state': 'pending' }], writeConcern: WC });
    if (!settled.acknowledged || settled.modifiedCount !== 1) throw claim.fail('Report inference settlement is unverified', 'REPORT_SETTLEMENT_UNVERIFIED', 503);
    if (state === 'unknown') return;
    try { await Run.updateOne({ _id: key, modelReceipts: { $elemMatch: { callId, prepareId, state: 'unknown', 'settlement.state': state, 'settlement.finishedAt': finishedAt } } }, {
      $set: { [`${prefix}.state`]: state }, $pull: { pendingInferences: callId }, $inc: { revision: 1 },
    }, { arrayFilters: [{ 'call.callId': callId, 'call.prepareId': prepareId, 'call.state': 'unknown', 'call.settlement.state': state, 'call.settlement.finishedAt': finishedAt }], writeConcern: WC }); }
    catch (_) { /* Keep pending if cleanup fails; never clear an unverified receipt. */ }
  }
  return { options: { signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
    reportDeadlineAt: value.deadlineAt.getTime(), hostUrl: value.host,
    attribution: { workItemId: id, correlationId: key, runtime: 'agentx' } }, finish };
}
module.exports = { prepare };
