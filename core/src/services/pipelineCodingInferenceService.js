'use strict';
const Task = require('../../models/PipelineTask');
const autonomy = require('./pipelineCodingAutonomyService');
const { fail, remaining, nativeModelMs } = require('./pipelineCodingAutonomyPolicy');
const { assertLeaseMutationAllowed } = require('./pipelineTaskService');

// The runner adds these headers outside the network-free worker. The existing
// claim lease is the capability; request/call IDs are only replay identities.
async function prepare(headers, model, signal) {
  const requestId = headers['x-agentx-coding-request'];
  if (!requestId) return null;
  const pipelineId = headers['x-agentx-coding-task'];
  const callId = headers['x-agentx-coding-call'];
  const leaseId = headers['x-agentx-coding-lease'];
  if (!autonomy.UUID.test(requestId) || !autonomy.UUID.test(callId) || !/^\d{4}$/.test(pipelineId || ''))
    throw fail('Invalid coding inference identity', 'CODING_INFERENCE_INVALID', 400);
  const task = await autonomy.readTask(pipelineId);
  await autonomy.workerManifest(pipelineId, requestId);
  assertLeaseMutationAllowed(task, { assignee: 'coding-team', leaseId });
  const run = task.codingAutonomy.runs.at(-1);
  if (task.codingCapacity?.model !== model || !task.codingCapacity?.admissionId)
    throw fail('The model must match the native coding capacity', 'CODING_CAPACITY_PROOF_INVALID');
  if ((run.modelReceipts || []).some(item => item.callId === callId))
    throw fail('A model request is already journalled; reconcile it without inference replay', 'CODING_INFERENCE_ALREADY_RECEIVED');
  if ((run.modelReceipts || []).length >= remaining(task).modelCalls)
    throw fail('Cumulative model request budget exhausted', 'CODING_MODEL_BUDGET');
  const startedAt = new Date();
  const modelMs = remaining(task).modelSeconds * 1000 - Math.max(nativeModelMs(run, startedAt.getTime()), (run.currentUsage?.modelSeconds || 0) * 1000);
  if (modelMs <= 0) throw fail('Cumulative model duration exhausted', 'CODING_MODEL_BUDGET');
  const deadlineAt = startedAt.getTime() + modelMs;
  const saved = await Task.updateOne({ pipelineId, 'automationLease.leaseId': leaseId,
    'codingAutonomy.revision': task.codingAutonomy.revision }, {
    $push: { 'codingAutonomy.runs.$[run].modelReceipts': { callId, state: 'pending', startedAt: startedAt.toISOString() },
      'codingAutonomy.runs.$[run].pendingInferences': callId },
    $inc: { 'codingAutonomy.revision': 1 },
  }, { arrayFilters: [{ 'run.requestId': requestId }], writeConcern: { w: 1, j: true } });
  if (!saved.modifiedCount) throw fail('Coding execution changed before inference');
  const deadline = new AbortController();
  const expire = () => deadline.abort(fail('Coding model duration exhausted', 'CODING_MODEL_BUDGET'));
  const timer = deadlineAt > Date.now() ? setTimeout(expire, deadlineAt - Date.now()) : null;
  if (timer) timer.unref?.(); else expire();
  async function finish(state) {
    clearTimeout(timer);
    const update = { $set: { 'codingAutonomy.runs.$[run].modelReceipts.$[call].state': state,
      'codingAutonomy.runs.$[run].modelReceipts.$[call].finishedAt': new Date().toISOString() },
      $inc: { 'codingAutonomy.revision': 1 } };
    if (state !== 'unknown') update.$pull = { 'codingAutonomy.runs.$[run].pendingInferences': callId };
    await Task.updateOne({ pipelineId }, update, { arrayFilters: [{ 'run.requestId': requestId }, { 'call.callId': callId }], writeConcern: { w: 1, j: true } });
  }
  return { options: { signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    codingDeadlineAt: deadlineAt, codingCapacity: { pipelineId, leaseId }, hostUrl: task.codingCapacity.host,
    attribution: { workItemId: pipelineId, attempt: task.automationLease.attempt, correlationId: requestId,
      source: 'pipeline-coding-autonomy', assignee: 'coding-team' } }, finish };
}
module.exports = { prepare };
