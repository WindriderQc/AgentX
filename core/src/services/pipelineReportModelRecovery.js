'use strict';
const Run = require('../../models/PipelineReportRun');
const Task = require('../../models/PipelineTask');
const Binding = require('../../models/PipelineReportAdmission');
const Runtime = require('../../models/RuntimeCoordination');
const claim = require('./pipelineManualReportClaim');
const crypto = require('crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WC = { w: 1, j: true };
const fail = message => claim.fail(message, 'REPORT_NATIVE_TERMINATION_UNVERIFIED');
const timestamp = value => value instanceof Date ? value.getTime() : Date.parse(value);
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
let control;
function configureControl(value) { control = value; }
const scope = (value, row) => ({ requestId: value._id, pipelineId: value.pipelineId, taskId: value.taskId,
  claimSeq: value.claimSeq, specSha256: value.specSha256, sourceCommit: value.sourceCommit, callId: row.callId, prepareId: row.prepareId });
function acknowledged(result) {
  if (result.acknowledged !== true || result.matchedCount !== 1) throw fail('Reconcile the original native admission binding acknowledgement');
}
async function saveBinding(value, row, native, mapping, releaseReceipt) {
  if (!UUID.test(native?.admissionId || '') || !UUID.test(native?.generation || '') || native.principal !== 'core-trusted-runtime')
    throw fail('The exact Core-owned native admission is required');
  const key = native.admissionId + ':' + native.generation;
  const intent = { ...scope(value, row), native: { admissionId: native.admissionId, generation: native.generation,
    principal: native.principal, host: value.host, model: value.model }, ...(mapping ? { mapping } : {}),
    ...(releaseReceipt ? { releaseReceipt } : {}) };
  try { await Binding.create([{ _id: key, ...intent }], { writeConcern: WC }); }
  catch (error) { if (error.code !== 11000) throw error; }
  const stored = await Binding.findById(key).lean();
  if (!stored || Object.keys(intent).some(key => digest(stored[key]) !== digest(intent[key])))
    throw fail('This admission already belongs to another report call or mapping');
  return stored;
}
async function bind(identity, admission) {
  if (!identity) return;
  const value = await Run.findById(identity.requestId).lean();
  const row = value?.modelReceipts.find(row => row.callId === identity.callId && row.prepareId === identity.prepareId);
  if (!row || value.pipelineId !== identity.pipelineId || row.state !== 'pending' || value.state !== 'active' || value.finalKind)
    throw fail('The original report call no longer owns admission');
  const existing = await Binding.find(scope(value, row)).lean();
  if (existing.length >= 32 && !existing.some(x => x.native.admissionId === admission?.admissionId && x.native.generation === admission?.generation))
    throw fail('The bounded native attempt inventory needs reconciliation');
  await saveBinding(value, row, admission);
  // A lost acknowledgement prevents provider dispatch. The durable binding can
  // still reconcile that same admission's subsequent pre-dispatch release.
  acknowledged(await Run.updateOne({ _id: value._id, revision: value.revision, state: 'active',
    modelReceipts: { $elemMatch: { callId: row.callId, prepareId: row.prepareId, state: 'pending' } } },
  { $inc: { revision: 1 } }, { writeConcern: WC }));
}
function nativeRelease(value, binding, runtime) {
    const proof = binding.native;
    if (runtime?.inferences?.some(x => x.admissionId === proof.admissionId && x.generation === proof.generation))
      throw fail('The native admission is still held or quarantined');
    const receipt = binding.releaseReceipt || runtime?.releaseReceipts?.find(x => x.admissionId === proof.admissionId && x.generation === proof.generation);
    if (!receipt || receipt.released !== true || !['agentx.runtime-inference-completion/v1', 'agentx.caller-abort-recovery/v1'].includes(receipt.contract)
      || receipt.principal !== proof.principal || receipt.host !== value.host || receipt.model !== value.model
      || !Number.isFinite(timestamp(receipt.releasedAt)) || !Number.isFinite(timestamp(receipt.acquiredAt))
      || timestamp(receipt.releasedAt) < timestamp(receipt.acquiredAt) || timestamp(receipt.releasedAt) > Date.now() + 1000
      || (receipt.contract === 'agentx.caller-abort-recovery/v1' && (!Number.isFinite(timestamp(receipt.unknownAt))
        || timestamp(receipt.unknownAt) < timestamp(receipt.acquiredAt) || timestamp(receipt.unknownAt) > timestamp(receipt.releasedAt))))
      throw fail('The native owner has not provided the exact terminal release receipt');
    return receipt;
}
async function preserveRelease(binding, receipt) {
  if (binding.releaseReceipt) return;
  const saved = await Binding.updateOne({ _id: binding._id, releaseReceipt: { $exists: false } },
    { $set: { releaseReceipt: receipt } }, { writeConcern: WC });
  if (saved.acknowledged !== true) throw fail('Native receipt custody acknowledgement is unverified');
  const stored = await Binding.findById(binding._id).lean();
  if (digest(stored?.releaseReceipt) !== digest(receipt)) throw fail('The original native release receipt differs');
}
async function releases(value, bindings) {
  const runtime = await Runtime.findById('runtime').select('+releaseReceipts').lean();
  const results = [];
  for (const binding of bindings) {
    const receipt = nativeRelease(value, binding, runtime);
    await preserveRelease(binding, receipt);
    results.push(receipt);
  }
  return results;
}
async function receive(value, row, bindings) {
  if (!bindings.length) return false;
  for (const binding of bindings) if (Object.entries(scope(value, row)).some(([key, expected]) => binding[key] !== expected))
    throw fail('Native admission scope differs from the original report call');
  const nativeReceipts = await releases(value, bindings);
  const recovery = { terminationOnly: true, originalUnknownReceipt: row,
    receivedAt: new Date().toISOString(), terminationAt: new Date(Math.max(...nativeReceipts.map(x => timestamp(x.releasedAt)))).toISOString(),
    nativeReceipts, ...(bindings[0].mapping ? { operatorMapping: bindings[0].mapping } : {}) };
  const saved = await Run.updateOne({ _id: value._id, revision: value.revision,
    taskId: value.taskId, claimSeq: value.claimSeq, specSha256: value.specSha256, sourceCommit: value.sourceCommit,
    modelReceipts: { $elemMatch: { callId: row.callId, prepareId: row.prepareId, state: 'unknown', finishedAt: row.finishedAt } } }, {
    $set: { 'modelReceipts.$[call].state': 'completed', 'modelReceipts.$[call].terminationRecovery': recovery,
      'modelReceipts.$[call].settlement': { state: 'completed', finishedAt: row.finishedAt, terminationOnly: true, recovered: true } },
    $pull: { pendingInferences: row.callId }, $inc: { revision: 1 },
  }, { arrayFilters: [{ 'call.callId': row.callId, 'call.prepareId': row.prepareId, 'call.state': 'unknown', 'call.finishedAt': row.finishedAt }], writeConcern: WC });
  acknowledged(saved);
  return true; // Only termination was recovered; no model success is asserted.
}
async function reconcile(value) {
  for (const row of value.modelReceipts) {
    if (row.state !== 'unknown' || row.settlement) continue;
    const bindings = await Binding.find(scope(value, row)).lean();
    if (!bindings.length) continue; // Legacy calls require explicit operator mapping.
    const current = await Run.findById(value._id).lean();
    const actual = current.modelReceipts.find(x => x.callId === row.callId && x.prepareId === row.prepareId);
    if (actual?.state !== 'unknown' || actual.settlement) continue;
    try { await receive(current, actual, bindings); }
    catch (error) { if (error.code !== 'REPORT_NATIVE_TERMINATION_UNVERIFIED') throw error; }
  }
}
let observing = false;
async function observe() {
  if (observing) return;
  observing = true;
  try {
    // Preserve each released attempt while its call may still be pending or
    // retrying. Query the bounded native journal by admission ID, not old runs.
    const runtime = await Runtime.findById('runtime').select('+releaseReceipts').lean();
    const keys = (runtime?.releaseReceipts || []).map(x => x.admissionId + ':' + x.generation);
    const bindings = await Binding.find({ _id: { $in: keys }, releaseReceipt: { $exists: false } }).lean();
    for (const binding of bindings) {
      try { await preserveRelease(binding, nativeRelease(binding.native, binding, runtime)); }
      catch (error) { if (error.code !== 'REPORT_NATIVE_TERMINATION_UNVERIFIED') throw error; }
    }
    // Capture native owner recovery before its bounded recent-receipt journal
    // rotates. This settles custody only; it never launches a worker or model.
    const values = await Run.find({ state: 'active', modelReceipts: { $elemMatch: { state: 'unknown' } } })
      .select('pipelineId taskId claimSeq specSha256 sourceCommit host model revision modelReceipts').limit(32).lean();
    for (const value of values) await reconcile(value);
  } finally { observing = false; }
}
async function mapLegacy(id, key, body) {
  const value = await Run.findById(key).lean();
  if (!value || value.pipelineId !== id) throw fail('The original report identity is required');
  const row = value.modelReceipts.find(row => row.callId === body.callId && row.prepareId === body.prepareId);
  const intent = { ...body }, intentHash = digest(intent);
  if (row?.terminationRecovery?.operatorMapping?.intentHash === intentHash) return { recovered: true, idempotent: true };
  if (!row || row.state !== 'unknown' || row.settlement || value.state !== 'active' || value.finalKind
    || body.claimSeq !== value.claimSeq || body.specSha256 !== value.specSha256 || body.sourceCommit !== value.sourceCommit
    || body.expectedReceiptSha256 !== digest(row) || body.confirmation !== 'MAP_ORIGINAL_REPORT_CALL_TO_RELEASED_NATIVE_ADMISSION'
    || typeof body.by !== 'string' || !body.by.trim() || body.by.length > 160 || body.by === 'coding-team'
    || typeof body.evidence?.receiptRef !== 'string' || !body.evidence.receiptRef.trim() || body.evidence.receiptRef.length > 500
    || !/^[a-f0-9]{64}$/.test(body.evidence?.sha256 || ''))
    throw fail('Explicit operator scope, original UNKNOWN hash and independent mapping evidence are required');
  const owner = await Task.findById(value.taskId).lean();
  claim.query(owner || {}, value, ['in_progress', 'blocked']);
  const observed = control && await control.status({ requestId: key });
  if (observed?.busy !== false || observed.run?.requestId !== key || observed.run.pipelineId !== id
    || observed.run.phase !== 'unknown' || observed.run.progress?.checkpoint !== value.sourceCommit)
    throw fail('The exact original native worker must be inactive and awaiting reconciliation');
  const existing = await Binding.find(scope(value, row)).lean();
  if (existing.length) {
    if (existing.length !== 1 || existing[0].mapping?.intentHash !== intentHash)
      throw fail('Reconcile every existing native attempt instead of replacing its binding');
    await receive(value, row, existing);
    return { recovered: true, terminationOnly: true, idempotent: true };
  }
  const native = { ...body.nativeAdmission, principal: 'core-trusted-runtime' };
  const runtime = await Runtime.findById('runtime').select('+releaseReceipts').lean();
  let archived;
  if (!runtime?.releaseReceipts?.some(x => x.admissionId === native.admissionId && x.generation === native.generation)) {
    if (!body.evidence.deliverableId) throw fail('Archive the original native owner receipt in this task before its recent journal rotates');
    const file = await require('./pipelineTaskDeliverableService').download(id, body.evidence.deliverableId);
    if (file.receipt.sha256 !== body.evidence.sha256 || file.receipt.ref !== body.evidence.receiptRef
      || file.receipt.mimeType !== 'application/json' || file.receipt.producer.channel !== 'operator_api'
      || file.receipt.producer.declared === 'coding-team' || file.receipt.reportOrigin)
      throw fail('The operator archive must retain the exact native owner evidence in this task');
    try { archived = JSON.parse(file.data.toString('utf8')).nativeReceipt; }
    catch { throw fail('The archived native owner receipt is invalid'); }
    if (archived?.admissionId !== native.admissionId || archived?.generation !== native.generation)
      throw fail('The archived native admission identity differs');
  }
  const receipt = nativeRelease(value, { native, ...(archived ? { releaseReceipt: archived } : {}) }, runtime);
  const started = timestamp(row.startedAt), finished = timestamp(row.finishedAt);
  const stopped = timestamp(receipt.contract === 'agentx.caller-abort-recovery/v1' ? receipt.unknownAt : receipt.releasedAt);
  if (![started, finished, stopped].every(Number.isFinite) || finished < started
    || Math.abs(timestamp(receipt.acquiredAt) - started) > 5000 || Math.abs(stopped - finished) > 5000)
    throw fail('Native admission timing contradicts the operator mapping');
  const mapping = { authority: 'operator-attestation', intentHash, by: body.by, evidence: body.evidence,
    nativeReceiptSource: archived ? 'operator-task-archive' : 'native-owner-journal',
    originalUnknownReceiptSha256: body.expectedReceiptSha256 };
  const binding = await saveBinding(value, row, native, mapping, receipt);
  // Scope is immutable in the same Run CAS. This closes custody only; later
  // report publication/continuation independently revalidates the live Task.
  await receive(value, row, [binding]);
  return { recovered: true, terminationOnly: true };
}
module.exports = { configureControl, bind, reconcile, observe, mapLegacy, digest, nativeStatus: input => control?.status(input) };
