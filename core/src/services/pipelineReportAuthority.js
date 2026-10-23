'use strict';
// Report execution authority belongs to the original Pipeline task. Grants and
// bindings are append-only; an acknowledgement loss never creates fresh credit.
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const queue = require('./heavyWorkQueueService');
const { fail, specHash } = require('./pipelineManualReportClaim');
const crypto = require('crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WC = { w: 1, j: true };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const latestOutcome = task => (task.feedback || []).slice().reverse().map(row => row.workerOutcome || row.reportOutcome).find(Boolean);
let control;
function configureControl(value) {
  control = value; require('./pipelineReportCheckpointArchive').configureControl(value);
  require('./pipelineReportModelRecovery').configureControl(value);
}
function received(result) {
  if (result.acknowledged !== true) throw fail('Reconcile the original report authority write', 'REPORT_AUTHORITY_UNVERIFIED', 503);
}
async function campaign(id, host, taskId) {
  const job = await queue.get(id), now = new Date().toISOString();
  const owned = job.executor?.mode === 'pipeline-report' && job.executor.pipelineId === taskId;
  if (!['dispatching', 'running'].includes(job.state) || (job.executor?.mode !== 'operator' && !owned)
    || job.source?.type !== 'coding' || job.source.taskId !== taskId || !job.source.ref
    || !job.dispatchId || !job.reservation || now < job.reservation.start || now >= job.reservation.end
    || (job.startBefore && now >= job.startBefore) || (host && !job.hosts.includes(host.replace(/\/+$/, ''))))
    throw fail('The report needs its active task campaign, host and permitted window', 'REPORT_CAMPAIGN_UNVERIFIED');
  return job;
}
function history(task, runs) {
  const entries = new Map();
  for (const entry of task.feedback || []) {
    const row = entry.workerOutcome;
    if (!row) continue;
    if (!UUID.test(row.requestId || '') || !Number.isSafeInteger(row.usage?.modelCalls)
      || !Number.isSafeInteger(row.usage?.workSeconds)) throw fail('Historical report usage needs reconciliation', 'REPORT_HISTORY_UNVERIFIED');
    const prior = entries.get(row.requestId);
    if (prior && digest(prior) !== digest(row)) throw fail('Conflicting historical usage receipts', 'REPORT_HISTORY_UNVERIFIED');
    entries.set(row.requestId, row);
  }
  const costs = new Map([...entries].map(([key, row]) => [key, { ...row.usage }]));
  for (const receipt of task.reportHistoryReceipts || []) {
    const previous = costs.get(receipt.requestId) || {};
    if (!UUID.test(receipt.requestId || '') || !/^[a-f0-9]{64}$/.test(receipt.nativeReceiptFingerprint || '')
      || ['workSeconds', 'modelCalls', 'modelSeconds', 'testSeconds'].some(key => !Number.isSafeInteger(receipt.usage?.[key]) || receipt.usage[key] < 0))
      throw fail('Reconcile the original native historical cost receipt', 'REPORT_HISTORY_UNVERIFIED');
    costs.set(receipt.requestId, Object.fromEntries(['workSeconds', 'modelCalls', 'modelSeconds', 'testSeconds']
      .map(key => [key, Math.max(previous[key] || 0, receipt.usage[key])])));
  }
  for (const run of runs) {
    const old = costs.get(run._id) || { modelCalls: 0, workSeconds: 0 };
    let seconds = 0;
    for (const call of run.modelReceipts) {
      const start = Date.parse(call.startedAt), end = Date.parse(call.finishedAt);
      if (Number.isFinite(start) && Number.isFinite(end)) seconds += Math.max(0, end - start) / 1000;
    }
    const elapsed = run.startedAt ? Math.ceil(Math.max(0, (new Date(run.terminalAt || run.finishedAt || Date.now()) - new Date(run.startedAt)) / 1000)) : 0;
    costs.set(run._id, { modelSeconds: Math.max(old.modelSeconds || 0, Math.ceil(seconds)), testSeconds: old.testSeconds || 0,
      modelCalls: Math.max(old.modelCalls, run.modelReceipts.length),
      workSeconds: Math.max(old.workSeconds, Math.ceil(seconds), run.workSeconds || 0, elapsed) });
  }
  return { executions: costs.size, modelCalls: [...costs.values()].reduce((n, row) => n + row.modelCalls, 0),
    workSeconds: [...costs.values()].reduce((n, row) => n + row.workSeconds, 0),
    modelSeconds: [...costs.values()].reduce((n, row) => n + (row.modelSeconds || 0), 0),
    testSeconds: [...costs.values()].reduce((n, row) => n + (row.testSeconds || 0), 0),
    receipts: [...entries.values()].map(row => ({ requestId: row.requestId, claimSeq: row.claimSeq,
      result: row.result, reason: row.reason, usage: row.usage, fingerprint: digest(row) })) };
}
async function settled(task, runs, requestId) {
  if (runs.some(run => run._id !== requestId && (run.state === 'active' || run.pendingInferences.length
    || run.modelReceipts.some(row => !['completed', 'refused'].includes(row.state)))))
    throw fail('An earlier report still owns unresolved native work', 'REPORT_MODEL_TERMINATION_UNVERIFIED');
  if ((task.codingReportAuthority?.bindings || []).some(binding => binding.requestId !== requestId
    && !runs.some(run => run._id === binding.requestId)))
    throw fail('Reconcile the original allocated report request', 'REPORT_AUTHORITY_UNVERIFIED');
}
async function prepare(task, profile, grant) {
  require('./taskIntakePolicy').assertAccepted(task);
  const runs = await Run.find({ taskId: String(task._id) }).lean();
  await settled(task, runs);
  const state = task.codingReportAuthority || { revision: 0, grants: [], bindings: [] };
  if (state.specSha256 && (state.specSha256 !== specHash(task) || state.reportName !== profile.reportName
    || digest(state.documentPaths || null) !== digest(profile.documentPaths || null)))
    throw fail('Review the changed report specification instead of replacing its authority', 'REPORT_SCOPE_CHANGED');
  if (!grant) {
    if (!state.grants.length) throw fail('Record an explicit report campaign and finite budget', 'REPORT_GRANT_REQUIRED');
    return state;
  }
  if (!UUID.test(grant.key || '') || !UUID.test(grant.queueRequestId || '') || grant.confirm !== true
    || !Number.isSafeInteger(grant.additionalRuns) || grant.additionalRuns < 1 || grant.additionalRuns > 4
    || !Number.isSafeInteger(grant.budget?.modelCalls) || grant.budget.modelCalls < 128 || grant.budget.modelCalls > 1024
    || !Number.isSafeInteger(grant.budget?.workSeconds) || grant.budget.workSeconds < 60 || grant.budget.workSeconds > 57600
    || (grant.allowCloudEscalation !== undefined && typeof grant.allowCloudEscalation !== 'boolean'))
    throw fail('Confirm the report campaign, added calls, work seconds and worker count', 'REPORT_GRANT_INVALID', 400);
  const latest = latestOutcome(task);
  const intent = { key: grant.key, queueRequestId: grant.queueRequestId, additionalRuns: grant.additionalRuns,
    budget: { modelCalls: grant.budget.modelCalls, workSeconds: grant.budget.workSeconds },
    parentRequestId: latest?.requestId || null, checkpoint: profile.parentRequestId ? {
      requestId: profile.parentRequestId, sha256: profile.parentSha256 } : null,
    specSha256: specHash(task), reportName: profile.reportName, modelCallLimit: profile.modelCallLimit,
    documentPaths: profile.documentPaths || null,
    // Explicit owner consent to send this task's step context to a cloud model.
    ...(grant.allowCloudEscalation === true && { allowCloudEscalation: true }) };
  const fingerprint = digest(intent), previous = state.grants.find(row => row.key === grant.key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw fail('This report grant key has another intent', 'REPORT_GRANT_CONFLICT');
    return state;
  }
  if (state.grants.length >= 32 || state.grants.some(row => row.parentRequestId === intent.parentRequestId))
    throw fail('Reconcile the existing grant for this terminal execution', 'REPORT_GRANT_CONFLICT');
  if (control) {
    const native = await control.status(latest ? { requestId: latest.requestId } : {});
    if (native.busy !== false || (latest && (native.run?.requestId !== latest.requestId
      || native.run.pipelineId !== task.pipelineId || native.run.phase !== 'finished'
      || native.run.progress?.phase !== 'finished')))
      throw fail('The original worker must have its native terminal receipt', 'REPORT_NATIVE_RELEASE_UNVERIFIED');
  } else throw fail('The native report authority observer is unavailable', 'REPORT_NATIVE_RELEASE_UNVERIFIED');
  await campaign(intent.queueRequestId, null, task.pipelineId);
  const spent = history(task, runs);
  const capacity = await require('./pipelineDeliverableCapacity').occupancy(task);
  // A new grant replaces the old grant's unused worker allowance. Active or
  // uncertain bindings and all immutable files retain their reservations.
  const last = state.grants.at(-1);
  const unused = last ? Math.max(0, last.additionalRuns - state.bindings.filter(row => row.grantKey === last.key).length) : 0;
  if (capacity.occupied + capacity.reserved - unused + grant.additionalRuns > require('./pipelineTaskDeliverableService').MAX_PER_TASK)
    throw fail('Preserve all saved files; remaining report storage cannot cover these workers', 'REPORT_CHECKPOINT_CAPACITY');
  return { ...state, revision: state.revision + 1, specSha256: specHash(task), reportName: profile.reportName, documentPaths: profile.documentPaths || null,
    grants: [...state.grants, { ...intent, fingerprint, at: new Date().toISOString(), spentBefore: spent }],
    baseline: state.baseline || spent };
}
function limits(state) {
  return { modelCalls: state.baseline.modelCalls + state.grants.reduce((n, row) => n + row.budget.modelCalls, 0),
    workSeconds: state.baseline.workSeconds + state.grants.reduce((n, row) => n + row.budget.workSeconds, 0),
    executions: state.baseline.executions + state.grants.reduce((n, row) => n + row.additionalRuns, 0) };
}
async function bind(task, key, intent, host, hardRemainingSeconds) {
  const runs = await Run.find({ taskId: String(task._id) }).lean();
  await settled(task, runs, key);
  const state = task.codingReportAuthority, selection = task.codingResult;
  if (!state || selection?.profile !== 'report' || selection.reportName !== intent.reportName
    || state.specSha256 !== intent.specSha256 || state.reportName !== intent.reportName
    || selection.modelCallLimit !== intent.modelCallLimit || (selection.parentRequestId || null) !== intent.parentRequestId
    || (selection.parentSha256 || null) !== intent.parentSha256)
    throw fail('The report differs from Core’s durable result selection', 'REPORT_PROFILE_CONFLICT');
  const prior = state.bindings.find(row => row.requestId === key);
  if (prior) {
    if (prior.intentFingerprint !== digest(intent)) throw fail('Reconcile the original report allocation', 'REPORT_REQUEST_CONFLICT');
    return prior;
  }
  const grant = state.grants.at(-1), used = state.bindings.filter(row => row.grantKey === grant.key).length;
  const previous = latestOutcome(task);
  if (previous && (runs.some(row => row._id !== key) || task.reportCheckpointArchive || task.reportPreflightReceipts?.length) && previous.requestId !== intent.parentRequestId)
    throw fail('Continue the latest saved report instead of dropping its work', 'REPORT_PARENT_REQUIRED');
  const spent = history(task, runs), total = limits(state);
  if (used >= grant.additionalRuns || spent.executions >= total.executions || spent.modelCalls + intent.modelCallLimit > total.modelCalls
    || spent.workSeconds >= total.workSeconds) throw fail('The cumulative report authorization is exhausted', 'REPORT_TASK_BUDGET_EXHAUSTED');
  const latest = latestOutcome(task);
  if (latest?.reason === 'operator_stop' && grant.parentRequestId !== latest.requestId)
    throw fail('An operator stop requires a new explicit grant', 'REPORT_OPERATOR_STOP');
  if (state.sourceCommit && state.sourceCommit !== intent.sourceCommit)
    throw fail('The frozen report source revision changed', 'REPORT_SOURCE_CHANGED');
  if (state.inventorySha256 && state.inventorySha256 !== intent.inventorySha256)
    throw fail('The frozen report document inventory changed', 'REPORT_INVENTORY_CHANGED');
  const job = await campaign(grant.queueRequestId, host, task.pipelineId);
  const startedAt = intent.runnerStartedAt || (task.transitions || []).find(row => row.kind === 'claimed' && row.seq === intent.claimSeq)?.at || new Date().toISOString();
  const workSeconds = Math.min(14400, total.workSeconds - spent.workSeconds);
  const deadlineAt = Math.min(Date.now() + hardRemainingSeconds * 1000, new Date(startedAt).getTime() + workSeconds * 1000, Date.parse(job.reservation.end));
  if (deadlineAt <= Date.now()) throw fail('The report preparation consumed its finite work budget', 'REPORT_TASK_BUDGET_EXHAUSTED');
  const binding = { requestId: key, grantKey: grant.key, intentFingerprint: digest(intent), queueRequestId: job.id,
    claimSeq: intent.claimSeq,
    dispatchId: job.dispatchId, queueEndAt: job.reservation.end, sourceCommit: intent.sourceCommit,
    host, startedAt, deadlineAt: new Date(deadlineAt).toISOString(),
    modelCallLimit: Math.min(intent.modelCallLimit, total.modelCalls - spent.modelCalls),
    workSeconds: Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000)), spentBefore: spent };
  const saved = await Task.updateOne({ _id: task._id, 'codingReportAuthority.revision': state.revision,
    transitionSeq: task.transitionSeq, spec: task.spec, status: 'in_progress' }, {
    $push: { 'codingReportAuthority.bindings': binding }, $inc: { 'codingReportAuthority.revision': 1 },
    $set: { 'codingReportAuthority.sourceCommit': intent.sourceCommit, 'codingReportAuthority.inventorySha256': intent.inventorySha256 },
  }, { timestamps: false, writeConcern: WC });
  received(saved);
  if (saved.modifiedCount !== 1) throw fail('Reconcile this report allocation before dispatch', 'REPORT_AUTHORITY_UNVERIFIED');
  return binding;
}
async function inference(task, run) {
  const state = task.codingReportAuthority, binding = state?.bindings.find(row => row.requestId === run._id);
  if (!binding || state.specSha256 !== run.specSha256) throw fail('Report execution has no task authority', 'REPORT_AUTHORITY_UNVERIFIED');
  const job = await campaign(binding.queueRequestId, run.host, task.pipelineId);
  if (job.dispatchId !== binding.dispatchId || job.reservation.end !== binding.queueEndAt)
    throw fail('The original report campaign changed', 'REPORT_CAMPAIGN_UNVERIFIED');
  const spent = history(task, await Run.find({ taskId: String(task._id) }).lean()), total = limits(state);
  if (spent.modelCalls >= total.modelCalls || spent.workSeconds >= total.workSeconds)
    throw fail('The cumulative task budget is exhausted', 'REPORT_TASK_BUDGET_EXHAUSTED');
}
async function projection(task) {
  const state = task.codingReportAuthority;
  const runs = await Run.find({ taskId: String(task._id) }).sort({ claimSeq: 1 }).lean(), latest = runs.at(-1);
  return { budgetScope: 'whole_task', spent: history(task, runs),
    latest: latest ? { requestId: latest._id, state: latest.state, sourceCommit: latest.sourceCommit,
      inventory: latest.inventory || null, coverage: latest.coverage || null } : null,
    limits: state ? limits(state) : null, grants: state?.grants || [], bindings: state?.bindings || [] };
}
module.exports = { configureControl, prepare, bind, inference, projection, history, campaign, limits, digest };
