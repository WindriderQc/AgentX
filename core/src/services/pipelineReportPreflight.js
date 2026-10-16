'use strict';
// A known admission refusal has no model effects. Receive it on the same task
// atomically with its cost and claim verdict; timeouts never use this path.
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const claim = require('./pipelineManualReportClaim');
const { feedbackTransition } = require('./pipelineTaskTransitionPaths');
const { createHash } = require('crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SAFE = new Set(['REPORT_CAMPAIGN_UNVERIFIED', 'REPORT_TASK_BUDGET_EXHAUSTED', 'REPORT_PROFILE_CONFLICT',
  'REPORT_MODEL_CHANGED', 'REPORT_INVENTORY_INVALID', 'REPORT_INVENTORY_CHANGED', 'REPORT_SOURCE_CHANGED', 'REPORT_CHECKPOINT_CONFLICT',
  'REPORT_BYTES_UNVERIFIED', 'REPORT_PARENT_REQUIRED', 'REPORT_OPERATOR_STOP', 'REPORT_START_TIME_INVALID']);
SAFE.add('REPORT_PREFLIGHT_FAILED');
async function lookup(id, key) {
  const task = await Task.findOne({ pipelineId: id, 'reportPreflightReceipts.requestId': key }).lean();
  return task?.reportPreflightReceipts.find(row => row.requestId === key) || null;
}
async function receive(id, key, body, error) {
  if (!SAFE.has(error.code) || !/^[a-f0-9-]{36}$/.test(key) || (body.sourceCommit != null && !/^[a-f0-9]{40}$/.test(body.sourceCommit))
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(body.reportName || '')) return null;
  const task = await Task.findOne({ pipelineId: id }).lean();
  if (!task) return null;
  const prior = task.reportPreflightReceipts?.find(row => row.requestId === key);
  if (prior) {
    if (prior.intentHash !== hash(body)) throw claim.fail('The received refusal has a different start intent', 'REPORT_REQUEST_CONFLICT');
    return prior;
  }
  const guard = claim.query(task, body);
  if (task.codingReportAuthority?.bindings?.some(row => row.claimSeq === body.claimSeq)
    || await Run.exists({ taskId: String(task._id), claimSeq: body.claimSeq })) return null;
  if ((task.reportPreflightReceipts || []).length >= 32) throw claim.fail('Preserve the finite preflight receipt journal', 'REPORT_HISTORY_UNVERIFIED');
  const started = Date.parse(body.runnerStartedAt), finished = Date.now();
  const claimed = new Date((task.transitions || []).find(row => row.kind === 'claimed' && row.seq === body.claimSeq)?.at).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(claimed) || started > claimed || started < claimed - 60000) return null;
  const usage = { modelCalls: 0, workSeconds: Math.ceil(Math.max(0, finished - started) / 1000), modelSeconds: 0, testSeconds: 0 };
  const workerOutcome = { schema: 'agentx.pipeline-worker-outcome/v1', requestId: key, pipelineId: id, claimSeq: body.claimSeq,
    source: 'worker_report', result: 'blocked', reason: 'runner_error', startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
    usage: { modelCalls: 0, workSeconds: usage.workSeconds } };
  const result = { requestId: key, claimSeq: body.claimSeq, kind: 'blocked', preflight: true, reason: 'runner_error', refusalCode: error.code };
  const receipt = { requestId: key, pipelineId: id, taskId: String(task._id), claimSeq: body.claimSeq, specSha256: body.specSha256,
    sourceCommit: body.sourceCommit || null, reportName: body.reportName, parentRequestId: body.parentRequestId || null, parentSha256: body.parentSha256 || null,
    intentHash: hash(body), state: 'blocked', preflight: true, result, usage };
  const entry = { by: 'coding-team', at: new Date(), workerOutcome, reportOutcome: { ...result, reportName: body.reportName,
    sourceCommit: body.sourceCommit, specSha256: body.specSha256 }, text: `Report admission refused before any model dispatch (${error.code}). Its native start and costs are retained.` };
  const update = { $push: { feedback: entry, reportPreflightReceipts: receipt }, $set: { status: 'blocked' } };
  guard['codingReportAuthority.revision'] = task.codingReportAuthority?.revision ?? null;
  feedbackTransition(guard, update, task, { entry, requested: 'blocked' });
  const saved = await Task.updateOne(guard, update, { writeConcern: { w: 1, j: true } });
  if (saved.acknowledged !== true) throw claim.fail('Reconcile this original admission refusal', 'REPORT_PERSISTENCE_UNVERIFIED', 503);
  if (saved.modifiedCount !== 1) return lookup(id, key);
  return receipt;
}
async function parent(id, key) {
  const value = await lookup(id, key);
  return value ? { ...value, _id: key, pendingInferences: [], modelReceipts: [] } : null;
}
module.exports = { lookup, receive, parent, hash };
