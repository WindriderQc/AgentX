'use strict';
const Run = require('../../models/PipelineReportRun');
const files = require('./pipelineTaskDeliverableService');
const { specHash } = require('./pipelineManualReportClaim');
const fail = message => Object.assign(new Error(message), { status: 409, code: 'REPORT_REVIEW_REQUIRED' });
const { currentReport } = require('../../../shared/pipelineReportSelection');
async function acceptance(task, body) {
  const result = currentReport(task);
  if (task.status !== 'review' || !result || result.kind === 'blocked') return null;
  const review = body.reportAcceptance;
  if (!String(body.by || '').trim() || !review || review.requestId !== result.requestId
    || review.sha256 !== result.sha256 || review.scopeComplete !== true)
    throw fail('Review this exact report and explicitly confirm that it covers the complete requested scope');
  const native = await Run.findById(result.requestId).lean();
  if (!native || native.state !== 'review' || native.taskId !== String(task._id) || native.claimSeq !== result.claimSeq
    || native.specSha256 !== specHash(task) || native.result?.sha256 !== result.sha256 || native.result?.deliverableId !== result.deliverableId)
    throw fail('The report receipt no longer matches this task and requested scope');
  if (native.inventory && (native.coverage?.declaredComplete !== true || body.by === 'coding-team'
    || !review.evidenceRef || !/^[a-f0-9]{64}$/.test(review.evidenceSha256 || '')))
    throw fail('Complete source coverage and an independent review receipt are required before acceptance');
  let receipt;
  try { receipt = await files.verify(task.pipelineId, result.deliverableId); }
  catch { throw fail('The report file is unavailable; verify it before accepting'); }
  if (receipt.sha256 !== result.sha256 || receipt.availability.status !== 'available')
    throw fail('The exact report bytes must be available and verified before acceptance');
  return { requestId: result.requestId, sha256: result.sha256, scopeComplete: true,
    ...(native.inventory ? { evidenceRef: review.evidenceRef, evidenceSha256: review.evidenceSha256 } : {}) };
}
module.exports = { currentReport, acceptance };
