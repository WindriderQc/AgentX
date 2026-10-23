'use strict';
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

// Also consumed by the maintenance CLI in a running Core installation. Keeping
// the receiver here lets operators receive evidence without restarting an owner
// whose original inference is still fenced. No worker or provider is launched.
function createRecovery({ coreRoot, control } = {}) {
  const load = coreRoot ? createRequire(resolve(coreRoot, 'src/services/pipelineReportCloudRecovery.js')) : require;
  const Run = load('../../models/PipelineReportRun');
  const Task = load('../../models/PipelineTask');
  const files = load('./pipelineTaskDeliverableService');
  const claim = load('./pipelineManualReportClaim');
  const { digest } = load('./pipelineReportModelRecovery');
  const fail = () => claim.fail('The original cloud refusal and independent operator mapping are unverified', 'REPORT_CLOUD_REFUSAL_UNVERIFIED');

  async function receive(id, key, body) {
    const value = await Run.findById(key).lean();
    const row = value?.modelReceipts.find(x => x.callId === body.callId && x.prepareId === body.prepareId);
    const intentHash = digest(body);
    if (value?.pipelineId === id && row?.terminationRecovery?.operatorMapping?.intentHash === intentHash)
      return { recovered: true, idempotent: true };
    const failure = value?.escalationFailures?.find(x => x.callId === row?.callId);
    if (!value || value.pipelineId !== id || value.state !== 'active' || value.finalKind || !row
        || row.state !== 'unknown' || row.settlement || body.expectedReceiptSha256 !== digest(row)
        || body.claimSeq !== value.claimSeq || body.specSha256 !== value.specSha256 || body.sourceCommit !== value.sourceCommit
        || body.inventorySha256 !== value.inventorySha256 || !/^[a-f0-9]{64}$/.test(body.inventorySha256 || '')
        || body.confirmation !== 'RECEIVE_ORIGINAL_CLOUD_PAYMENT_REFUSAL'
        || typeof body.by !== 'string' || !body.by.trim() || body.by.length > 160 || body.by === 'coding-team'
        || failure?.executionState !== 'unknown' || failure.attempts?.length !== 1
        || (value.escalationCalls || []).some(x => x.callId === row.callId)) throw fail();
    claim.query(await Task.findById(value.taskId).lean() || {}, value, ['in_progress', 'blocked']);
    const observed = control && await control.status({ requestId: key });
    if (observed?.busy !== false || observed.run?.requestId !== key || observed.run.pipelineId !== id
        || observed.run.phase !== 'unknown' || observed.run.progress?.checkpoint !== value.sourceCommit) throw fail();
    const archived = await files.download(id, body.evidence?.deliverableId);
    if (archived.receipt.sha256 !== body.evidence?.sha256 || archived.receipt.ref !== body.evidence?.receiptRef
        || archived.receipt.mimeType !== 'application/json' || archived.receipt.producer.channel !== 'operator_api'
        || archived.receipt.producer.declared !== body.by || archived.receipt.reportOrigin) throw fail();
    let entries;
    try { entries = JSON.parse(archived.data.toString('utf8')); } catch { throw fail(); }
    // A bounded native journal extract must contain exactly one matching HTTP
    // response in this call's time window. This is operator correlation, not a
    // claim that a provider signed the Core call ID or supplied a success.
    if (!Array.isArray(entries) || entries.length !== 1) throw fail();
    const entry = entries[0];
    const match = /^\S+ \[provider-transport-fetch\] \[model-fetch\] response provider=([a-z0-9-]+) api=([a-z-]+) model=([A-Za-z0-9._:/-]+) status=402 elapsedMs=(\d+) dispatcher=\w+ contentType=application\/json$/.exec(entry.message || '');
    const started = Date.parse(row.startedAt), finished = Date.parse(row.finishedAt), responseAt = Number(entry.timestamp) / 1000;
    if (!match || entry.unit !== 'openclaw-gateway.service' || !/^\d+$/.test(entry.pid || '')
        || `${match[1]}/${match[3]}` !== failure.attempts[0].model || match[2] !== 'openai-completions'
        || ![started, finished, responseAt].every(Number.isFinite) || finished < started
        || responseAt < started || responseAt > finished || responseAt - Number(match[4]) < started) throw fail();
    const recovery = { schema: 'agentx.report-cloud-refusal-recovery/v1', originalUnknownReceipt: row,
      receivedAt: new Date().toISOString(), executionState: 'not-dispatched', httpStatus: 402,
      model: failure.attempts[0].model, step: failure.step, nanodollars: 0,
      costSource: 'provider-payment-refusal', nativeJournal: entry,
      operatorMapping: { authority: 'operator-attestation', intentHash, by: body.by, evidence: body.evidence,
        originalUnknownReceiptSha256: body.expectedReceiptSha256 } };
    const saved = await Run.updateOne({ _id: key, revision: value.revision, state: 'active', finalKind: { $exists: false },
      modelReceipts: { $elemMatch: { callId: row.callId, prepareId: row.prepareId, state: 'unknown', settlement: { $exists: false } } } },
    { $set: { 'modelReceipts.$[call].terminationRecovery': recovery,
      'modelReceipts.$[call].settlement': { state: 'refused', finishedAt: row.finishedAt, recovered: true } }, $inc: { revision: 1 } },
    { arrayFilters: [{ 'call.callId': row.callId, 'call.prepareId': row.prepareId, 'call.state': 'unknown' }], writeConcern: { w: 1, j: true } });
    if (saved.acknowledged !== true || saved.modifiedCount !== 1) throw fail();
    // The existing native reconcile-models path receives this durable refusal.
    // The receiver never pulls pending admissions or rewrites failure history.
    return { recovered: true, executionState: 'not-dispatched', reconcileRequired: true };
  }
  return { receive };
}

function resolved(value, callId) {
  return (value.modelReceipts || []).some(row => row.callId === callId && row.state === 'refused'
    && row.settlement?.state === 'refused' && row.terminationRecovery?.schema === 'agentx.report-cloud-refusal-recovery/v1'
    && row.terminationRecovery.executionState === 'not-dispatched');
}
async function resolutions(taskId) {
  const Run = require('../../models/PipelineReportRun');
  const runs = await Run.find({ taskId: String(taskId), 'modelReceipts.terminationRecovery.schema': 'agentx.report-cloud-refusal-recovery/v1' })
    .select('modelReceipts').lean();
  return runs.flatMap(value => (value.modelReceipts || []).filter(row => resolved(value, row.callId)).map(row => ({
    requestId: value._id, callId: row.callId, step: row.terminationRecovery.step, model: row.terminationRecovery.model,
    evidenceSha256: row.terminationRecovery.operatorMapping.evidence.sha256, executionState: 'not-dispatched'
  })));
}
module.exports = { createRecovery, resolved, resolutions };
