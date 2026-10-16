'use strict';
const Archive = require('../../models/PipelineReportCheckpointArchive');
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const Runtime = require('../../models/RuntimeCoordination');
const claim = require('./pipelineManualReportClaim');
const files = require('./pipelineTaskDeliverableService');
const { contains } = require('../helpers/workerTaskScope');
const crypto = require('crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WC = { w: 1, j: true };
let control;
function configureControl(value) { control = value; }
async function attach(task, stored) {
  const saved = await Task.updateOne({ _id: task._id, transitionSeq: task.transitionSeq, spec: task.spec,
    status: task.status, 'codingReportAuthority.revision': task.codingReportAuthority?.revision ?? null }, {
    $set: { reportHistoryReceipts: stored.nativeCosts, reportCheckpointArchive: { parentRequestId: stored._id,
      parentSha256: stored.sha256, claimSeq: stored.claimSeq, sourceCommit: stored.sourceCommit, reportName: stored.reportName, deliverableId: stored.deliverableId } },
  }, { timestamps: false, writeConcern: WC });
  if (saved.acknowledged !== true || saved.matchedCount !== 1)
    throw claim.fail('Archive stored; reconcile its original task attachment', 'REPORT_ARCHIVE_ATTACH_UNVERIFIED');
}
async function archive(id, key, body) {
  if (body.confirmation !== 'ARCHIVE_MODEL_CHECKPOINT_WITH_NATIVE_TERMINATION_EVIDENCE' || !UUID.test(key || '')
    || !/^[a-f0-9]{64}$/.test(body.originalSpecSha256 || '')
    || typeof body.scopeEvidence?.receiptRef !== 'string' || !body.scopeEvidence.receiptRef.trim() || body.scopeEvidence.receiptRef.length > 500
    || !/^[a-f0-9]{64}$/.test(body.scopeEvidence?.sha256 || '')
    || !/^[a-f0-9]{40}$/.test(body.sourceCommit || '') || !/^[a-f0-9]{64}$/.test(body.sha256 || '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,116}\.md$/.test(body.reportName || '')
    || typeof body.by !== 'string' || !body.by.trim() || body.by.length > 160
    || typeof body.path !== 'string' || !/^\.review-work\/[A-Za-z0-9_./-]+\.md$/.test(body.path) || body.path.split('/').includes('..')
    || typeof body.termination?.receiptRef !== 'string' || !body.termination.receiptRef.trim() || body.termination.receiptRef.length > 500
    || !/^[a-f0-9]{64}$/.test(body.termination?.sha256 || ''))
    throw claim.fail('Archive the exact original worker checkpoint with its independent native termination evidence', 'REPORT_ARCHIVE_INVALID', 400);
  const task = await Task.findOne({ pipelineId: id }).lean();
  if (!task || !contains(task) || task.automationLease || task.codingAutonomy || task.automationAttemptCount
    || !['blocked', 'queued'].includes(task.status) || (task.assignee && task.assignee !== 'coding-team'))
    throw claim.fail('The original manual task must be stopped and unleased', 'REPORT_ARCHIVE_CONFLICT');
  const original = (task.feedback || []).slice().reverse().find(row => row.workerOutcome)?.workerOutcome;
  if (body.originalSpecSha256 !== claim.specHash(task))
    throw claim.fail('The archived worker scope differs from the current specification', 'REPORT_SCOPE_CHANGED');
  if (original?.requestId !== key || original.result !== 'blocked' || task.transitionSeq !== body.expectedTransitionSeq)
    throw claim.fail('Archive only the exact current terminal worker result', 'REPORT_ARCHIVE_CONFLICT');
  if (await Run.exists({ taskId: String(task._id), $or: [{ state: 'active' }, { 'pendingInferences.0': { $exists: true } },
    { modelReceipts: { $elemMatch: { state: { $nin: ['completed', 'refused'] } } } }] }))
    throw claim.fail('Reconcile outstanding report models before archival', 'REPORT_MODEL_TERMINATION_UNVERIFIED');
  const intent = { requestId: key, pipelineId: id, taskId: String(task._id), claimSeq: original.claimSeq,
    specSha256: body.originalSpecSha256, scopeEvidence: { authority: 'operator-attestation', receiptRef: body.scopeEvidence.receiptRef, sha256: body.scopeEvidence.sha256 }, sourceCommit: body.sourceCommit, reportName: body.reportName,
    sha256: body.sha256, path: body.path, archiveActor: body.by, termination: { authority: 'operator-attestation', receiptRef: body.termination.receiptRef, sha256: body.termination.sha256 } };
  const intentHash = digest(intent), prior = await Archive.findById(key).lean();
  if (prior) {
    if (prior.intentHash !== intentHash) throw claim.fail('Reconcile the original checkpoint archive identity', 'REPORT_ARCHIVE_CONFLICT');
    const verified = await files.verify(id, prior.deliverableId);
    if (verified.availability.status !== 'available' || verified.sha256 !== prior.sha256)
      throw claim.fail('The original archive bytes are unavailable', 'REPORT_BYTES_UNVERIFIED');
    await attach(task, prior);
    return prior;
  }
  if (!control) throw claim.fail('Native worker observation is unavailable', 'REPORT_NATIVE_RELEASE_UNVERIFIED');
  const nativeCosts = [];
  const observations = [...new Map((task.feedback || []).filter(row => row.workerOutcome)
    .map(row => [row.workerOutcome.requestId, row.workerOutcome])).values()];
  if (observations.length > 32) throw claim.fail('Review the bounded native execution inventory', 'REPORT_HISTORY_UNVERIFIED');
  for (const row of observations) {
    const observed = await control.status({ requestId: row.requestId }), native = observed.run, progress = native?.progress;
    if (observed.busy !== false || native?.requestId !== row.requestId || native.pipelineId !== id || native.phase !== 'finished'
      || progress?.phase !== 'finished' || progress.result !== row.result || progress.stopReason !== row.reason
      || progress.usage?.modelCalls !== row.usage?.modelCalls || progress.usage?.workSeconds !== row.usage?.workSeconds
      || (row.requestId === key && progress.checkpoint !== body.sourceCommit))
      throw claim.fail('The original native result, costs or source checkpoint differ', 'REPORT_NATIVE_RELEASE_UNVERIFIED');
    nativeCosts.push({ requestId: row.requestId, usage: progress.usage, nativeReceiptFingerprint: digest({ requestId: native.requestId,
      pipelineId: id, checkpoint: progress.checkpoint, result: progress.result, reason: progress.stopReason, usage: progress.usage }) });
  }
  const runtime = await Runtime.findById('runtime').lean();
  if (runtime?.maintenance || runtime?.inferences?.length || runtime?.workloads?.length)
    throw claim.fail('Native runtime owners must be released before checkpoint archival', 'REPORT_NATIVE_RELEASE_UNVERIFIED');
  const originalFile = await control.checkpoint({ pipelineId: id, requestId: key, path: body.path });
  if (originalFile.requestId !== key || originalFile.pipelineId !== id || originalFile.sourceCommit !== body.sourceCommit
    || originalFile.path !== body.path || originalFile.sha256 !== body.sha256)
    throw claim.fail('The original native checkpoint bytes changed', 'REPORT_BYTES_UNVERIFIED');
  const origin = { requestId: key, claimSeq: original.claimSeq, specSha256: intent.specSha256, sourceCommit: body.sourceCommit,
    state: 'partial', contentAuthor: 'coding-team', archiveActor: body.by, depositChannel: 'operator_archive' };
  const { receipt } = await files.register(id, { by: body.by, name: body.reportName.slice(0, -3) + '-archive-' + key + '.md',
    dataUrl: originalFile.dataUrl, sha256: body.sha256 }, { reportOrigin: origin });
  try { await Archive.create([{ _id: key, ...intent, intentHash, deliverableId: receipt.id, originalOutcome: original, nativeCosts }], { writeConcern: WC }); }
  catch (error) { if (error.code !== 11000) throw error; }
  const stored = await Archive.findById(key).lean();
  if (!stored || stored.intentHash !== intentHash) throw claim.fail('Reconcile the exact checkpoint archive write', 'REPORT_ARCHIVE_CONFLICT');
  await attach(task, stored);
  return stored;
}
async function parent(key) {
  const value = await Archive.findById(key).lean();
  return value ? { ...value, state: 'blocked', parentRequestId: null, pendingInferences: [], modelReceipts: [],
    result: { kind: 'blocked', partial: { deliverableId: value.deliverableId, sha256: value.sha256 } } } : null;
}
module.exports = { configureControl, archive, parent };
