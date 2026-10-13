'use strict';
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const policy = require('./pipelineCodingAutonomyPolicy');
const CONFIRMATION = 'ARCHIVE_QUALIFICATION_WITH_ORIGINAL_RECEIPTS';
async function archive(id, input) {
  if (input.confirm !== true || input.confirmation !== CONFIRMATION || !Number.isSafeInteger(input.expectedRevision)
    || !['passed', 'abandoned', 'superseded'].includes(input.outcome)
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 2000
    || typeof input.receiptRef !== 'string' || !input.receiptRef.startsWith('/') || input.receiptRef.length > 1000
    || !/^[a-f0-9]{64}$/.test(input.receiptSha256 || ''))
    throw policy.fail('Review the qualification outcome and its separate operator receipt', 'CODING_DISPOSITION_INVALID', 400);
  const task = await Task.findOne({ pipelineId: id }).lean();
  if (!task) throw policy.fail('Task not found', 'NOT_FOUND', 404);
  const state = task.codingAutonomy, last = state?.runs?.at(-1);
  policy.assertTask(task);
  if (state?.disposition) {
    const prior = state.disposition;
    if (prior.requestId === input.requestId && prior.outcome === input.outcome && prior.reason === input.reason
      && prior.receiptRef === input.receiptRef && prior.receiptSha256 === input.receiptSha256) return task;
    throw policy.fail('This qualification already has its operator disposition; preserve that receipt');
  }
  const config = await Settings.findById('coding-autonomy').lean();
  if (task.service !== 'agentx-coding' || !state || state.revision !== input.expectedRevision || state.authorized !== false
    || !['stopped', 'closed'].includes(state.state) || task.automationLease || task.codingCapacity
    || config?.active?.pipelineId === id || !last?.finishedAt || last.requestId !== input.requestId)
    throw policy.fail('Archive only the exact finished qualification with execution authorization removed');
  // This annotation cannot settle a model call, override an attempt outcome,
  // set task.status to done, or release dependencies or runtime ownership.
  const disposition = { kind: 'qualification', outcome: input.outcome, reason: input.reason,
    requestId: last.requestId, receiptRef: input.receiptRef, receiptSha256: input.receiptSha256,
    by: 'operator', at: new Date().toISOString() };
  const result = await Task.findOneAndUpdate({ pipelineId: id, updatedAt: task.updatedAt,
    'codingAutonomy.revision': state.revision, 'codingAutonomy.authorized': false,
    automationLease: null, codingCapacity: null },
  { $set: { 'codingAutonomy.disposition': disposition }, $inc: { 'codingAutonomy.revision': 1 } },
  { new: true, writeConcern: { w: 1, j: true } }).lean();
  if (!result) throw policy.fail('Qualification changed; inspect its original evidence');
  return result;
}
module.exports = { archive, CONFIRMATION };
