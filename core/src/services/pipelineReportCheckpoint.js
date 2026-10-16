'use strict';
const Run = require('../../models/PipelineReportRun');
const files = require('./pipelineTaskDeliverableService');
const claim = require('./pipelineManualReportClaim');
function selection(body) {
  return { parentRequestId: null, parentSha256: null, ...require('../../../shared/pipelineReportSelection').parent(body) };
}
async function load(value) {
  const parent = await Run.findById(value.parentRequestId).lean();
  if (!parent || parent.pipelineId !== value.pipelineId || parent.taskId !== value.taskId
    || parent.specSha256 !== value.specSha256 || parent.sourceCommit !== value.sourceCommit || parent.claimSeq >= value.claimSeq
    || !['blocked', 'review'].includes(parent.state) || !parent.result || parent.pendingInferences.length
    || parent.modelReceipts.some(row => !['completed', 'refused'].includes(row.state)))
    throw claim.fail('The prior report scope, source or native termination is unverified', 'REPORT_CHECKPOINT_CONFLICT');
  const checkpoint = parent.result.partial || parent.result;
  if (!checkpoint.deliverableId || checkpoint.sha256 !== value.parentSha256)
    throw claim.fail('The original report checkpoint changed', 'REPORT_CHECKPOINT_CONFLICT');
  const file = await files.download(value.pipelineId, checkpoint.deliverableId);
  if (file.receipt.sha256 !== value.parentSha256)
    throw claim.fail('The report checkpoint bytes changed', 'REPORT_BYTES_UNVERIFIED');
  return { parent, ...file };
}
async function read(value) {
  if (!value.parentRequestId) throw claim.fail('This execution has no prior report checkpoint', 'REPORT_CHECKPOINT_NOT_FOUND', 404);
  const { parent, receipt, data } = await load(value);
  return { requestId: value._id, parentRequestId: parent._id, sha256: receipt.sha256, sourceCommit: parent.sourceCommit,
    dataUrl: 'data:text/markdown;base64,' + data.toString('base64') };
}
async function lineage(value) {
  let current = value, executions = 0, modelCalls = 0;
  const visited = new Set();
  while (current) {
    if (visited.has(current._id) || executions >= 32) throw claim.fail('Report lineage is inconsistent', 'REPORT_LINEAGE_INVALID');
    visited.add(current._id); executions++; modelCalls += current.modelReceipts.length;
    if (!current.parentRequestId) break;
    const next = await Run.findById(current.parentRequestId).lean();
    if (!next || next.pipelineId !== value.pipelineId || next.taskId !== value.taskId || next.claimSeq >= current.claimSeq)
      throw claim.fail('The linked report execution is unavailable', 'REPORT_LINEAGE_INVALID');
    current = next;
  }
  return { executions, modelCalls, budgetScope: 'current_execution_only' };
}
module.exports = { selection, load, read, lineage };
