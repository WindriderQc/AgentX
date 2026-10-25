'use strict';
const Run = require('../../models/PipelineReportRun');
const files = require('./pipelineTaskDeliverableService');
const claim = require('./pipelineManualReportClaim');
function selection(body) {
  return { parentRequestId: null, parentSha256: null, ...require('../../../shared/pipelineReportSelection').parent(body) };
}
async function find(id, key) {
  return await Run.findById(key).lean() || await require('./pipelineReportCheckpointArchive').parent(key)
    || await require('./pipelineReportPreflight').parent(id, key);
}
async function load(value, visited = new Set()) {
  if (visited.has(value.parentRequestId) || visited.size >= 32) throw claim.fail('Report lineage is inconsistent', 'REPORT_LINEAGE_INVALID');
  visited.add(value.parentRequestId);
  const parent = await find(value.pipelineId, value.parentRequestId);
  if (!parent || parent.pipelineId !== value.pipelineId || parent.taskId !== value.taskId
    || parent.specSha256 !== value.specSha256 || (parent.sourceCommit !== value.sourceCommit && !(parent.preflight && parent.sourceCommit === null)) || parent.claimSeq >= value.claimSeq
    || !['blocked', 'review'].includes(parent.state) || !parent.result || parent.pendingInferences.length
    || parent.modelReceipts.some(row => !['completed', 'refused'].includes(row.state)))
    throw claim.fail('The prior report scope, source or native termination is unverified', 'REPORT_CHECKPOINT_CONFLICT');
  const checkpoint = parent.result.partial || parent.result;
  if (value.parentSha256 === null && !checkpoint.deliverableId && !checkpoint.sha256 && parent.result.kind === 'blocked') {
    if (parent.parentRequestId) {
      const inherited = await load({ ...parent, sourceCommit: value.sourceCommit }, visited);
      return { ...inherited, parent, contentRequestId: inherited.contentRequestId || inherited.parent._id, inherited: true };
    }
    return { parent, receipt: null, data: null };
  }
  if (!checkpoint.deliverableId || checkpoint.sha256 !== value.parentSha256)
    throw claim.fail('The original report checkpoint changed', 'REPORT_CHECKPOINT_CONFLICT');
  const file = await files.download(value.pipelineId, checkpoint.deliverableId);
  if (file.receipt.sha256 !== value.parentSha256)
    throw claim.fail('The report checkpoint bytes changed', 'REPORT_BYTES_UNVERIFIED');
  return { parent, ...file };
}
async function read(value) {
  if (!value.parentRequestId) throw claim.fail('This execution has no prior report checkpoint', 'REPORT_CHECKPOINT_NOT_FOUND', 404);
  const { parent, receipt, data, contentRequestId, inherited } = await load(value);
  if (!receipt) return { requestId: value._id, parentRequestId: parent._id, sha256: null, sourceCommit: value.sourceCommit,
    checkpointAvailable: false, dataUrl: null, coverage: parent.coverage || null };
  return { requestId: value._id, parentRequestId: parent._id, sha256: receipt.sha256, sourceCommit: value.sourceCommit,
    coverage: (inherited ? (await find(value.pipelineId, contentRequestId))?.coverage : parent.coverage) || null,
    inherited: Boolean(inherited), contentRequestId: contentRequestId || parent._id,
    dataUrl: 'data:text/markdown;base64,' + data.toString('base64') };
}
async function lineage(value) {
  let current = value, executions = 0, modelCalls = 0;
  const visited = new Set();
  while (current) {
    if (visited.has(current._id) || executions >= 32) throw claim.fail('Report lineage is inconsistent', 'REPORT_LINEAGE_INVALID');
    visited.add(current._id); executions++; modelCalls += current.modelReceipts.length;
    if (!current.parentRequestId) break;
    const next = await find(value.pipelineId, current.parentRequestId);
    if (!next || next.pipelineId !== value.pipelineId || next.taskId !== value.taskId || next.claimSeq >= current.claimSeq)
      throw claim.fail('The linked report execution is unavailable', 'REPORT_LINEAGE_INVALID');
    current = next;
  }
  return { executions, modelCalls, budgetScope: 'current_execution_only' };
}
module.exports = { selection, load, read, lineage, find };
