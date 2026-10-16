// A recorded observation explains a worker stop. It never grants a retry,
// proves runtime release, or replaces an automation attempt receipt.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const api = factory();
    api.mountBrowser = app => app.get('/js/pipeline-worker-outcome.js', (_req, res) => res.sendFile(__filename));
    module.exports = api;
  } else root.PipelineWorkerOutcome = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const SCHEMA = 'agentx.pipeline-worker-outcome/v1';
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const REASONS = {
    no_useful_progress: ['Stopped without saved progress', 'The worker reached its time limit without recent saved changes or completed tests.', 'Ask the team to save a first deliverable early, then improve it as the review continues.'],
    no_changes: ['No changes delivered', 'The worker finished without a saved change.', 'Clarify the expected deliverable and where it should be saved.'],
    model_output_limit: ['Model response limit reached', 'The worker could not finish within the response limit.', 'Ask for smaller steps and an early saved draft.'],
    model_call_limit: ['Model call limit reached', 'The worker used its allowed model calls.', 'Review any saved work and clarify what remains.'],
    soft_budget_no_progress: ['Work budget reached', 'The worker could not extend its work budget with saved progress.', 'Review the scope and ask for an early saved deliverable.'],
    hard_budget: ['Work budget reached', 'The worker reached its execution budget.', 'Review any saved work and clarify what remains.'],
    worker_exit: ['Worker stopped before finishing', 'The worker reported an unsuccessful exit.', 'Read the last update and correct the reported problem.'],
    model_termination_unverified: ['Worker termination needs checking', 'The original model operation has not been verified as stopped.', 'Inspect the original execution before considering another run.'],
    runner_error: ['Worker result needs checking', 'The worker could not complete its result recording.', 'Inspect the original execution and its receipts.'],
    operator_stop: ['Worker stopped by request', 'A stop was requested for this execution.', 'Review its saved work before deciding the next step.'],
    dependencies_failed: ['Dependency preparation failed', 'The worker could not prepare the project dependencies.', 'Read the last update and correct the dependency problem.'],
    dependencies_changed: ['Dependency changes need review', 'The worker saved package changes that need installation.', 'Review those changes before handing the task back.'],
    runtime_unavailable: ['Coding runtime unavailable', 'The configured coding runtime could not be validated.', 'Check the configured runtime before another pass.'],
    runtime_changed: ['Coding runtime changed', 'The configured coding runtime changed during preparation.', 'Check the configured runtime before another pass.'],
    tests_failed: ['Tests need correction', 'The last observed test did not pass. The checkpoint remains local.', 'Ask the team to correct the failure and rerun the relevant tests.'],
    generated_artifacts: ['Checkpoint needs inspection', 'The branch contains generated runtime files that cannot be published.', 'Preserve the checkpoint privately and inspect the source changes.'],
  };
  function normalize(value, pipelineId) {
    if (!value || value.schema !== SCHEMA || !UUID.test(value.requestId || '')
      || value.pipelineId !== pipelineId || value.result !== 'blocked' || typeof value.reason !== 'string' || !Object.hasOwn(REASONS, value.reason)
      || !Number.isSafeInteger(value.claimSeq) || value.claimSeq < 1
      || !['worker_report', 'operator_observation'].includes(value.source)) throw new Error('Invalid worker outcome observation.');
    const started = Date.parse(value.startedAt), finished = Date.parse(value.finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) throw new Error('Invalid worker outcome dates.');
    const usage = {};
    for (const [key, maximum] of [['workSeconds', 86400], ['modelCalls', 10000]]) {
      const count = value.usage?.[key];
      if (!Number.isSafeInteger(count) || count < 0 || count > maximum) throw new Error('Invalid worker outcome usage.');
      usage[key] = count;
    }
    return { schema: SCHEMA, requestId: value.requestId, pipelineId, claimSeq: value.claimSeq, result: 'blocked', reason: value.reason,
      source: value.source, startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), usage };
  }
  function latest(task) {
    const entry = (task?.feedback || []).slice().reverse().find(item => item.workerOutcome);
    if (!entry) return null;
    try {
      const result = normalize(entry.workerOutcome, task.pipelineId);
      const claim = (task.transitions || []).slice().reverse().find(item => item.kind === 'claimed');
      if (!claim || claim.seq !== result.claimSeq || Date.parse(claim.at) > Date.parse(result.startedAt) + 120000 || Date.parse(claim.at) > Date.parse(result.finishedAt)) return null;
      return result;
    } catch { return null; }
  }
  function native(task, control, now = Date.now()) {
    const run = control?.run, progress = run?.progress;
    const observed = Date.parse(control?.observedAt);
    if (control?.available !== true || !Number.isFinite(observed) || now - observed > 120000 || observed > now + 5000
      || run?.phase !== 'finished' || run.pipelineId !== task.pipelineId || progress?.phase !== 'finished'
      || progress.pipelineId !== task.pipelineId || progress.requestId !== run.requestId) return null;
    try { return normalize({ schema: SCHEMA, requestId: run.requestId, pipelineId: task.pipelineId,
      claimSeq: progress.claimSeq ?? latest(task)?.claimSeq, result: progress.result, reason: progress.stopReason, source: 'worker_report',
      startedAt: progress.startedAt, finishedAt: progress.activityAt, usage: progress.usage }, task.pipelineId); }
    catch { return null; }
  }
  function describe(outcome) {
    if (!outcome) return null;
    const [title, detail, suggestion] = REASONS[outcome.reason];
    return { title, detail, suggestion, facts: `${Math.round(outcome.usage.workSeconds / 60)} min · ${outcome.usage.modelCalls} model calls`,
      requiresInspection: ['model_termination_unverified', 'runner_error'].includes(outcome.reason) };
  }
  function canResume(task, control, now = Date.now()) {
    const outcome = native(task, control, now);
    const recorded = latest(task);
    const report = (task.feedback || []).slice().reverse().find(row => row.workerOutcome)?.reportOutcome;
    const saved = report?.partial;
    // Core only registers a stopped report after its native calls terminate.
    // A reconciled private checkpoint can retain runner_error as its original
    // diagnostic; that label must not permanently hide its continuation form.
    const recoveredReport = recorded?.reason === 'runner_error' && report?.schema === 'agentx.pipeline-report-result/v1'
      && report.kind === 'blocked' && report.reason === 'runner_error' && report.requestId === recorded.requestId
      && report.claimSeq === recorded.claimSeq && /^[a-f0-9]{40}$/.test(report.sourceCommit || '')
      && /^[a-f0-9]{24}$/.test(saved?.deliverableId || '') && /^[a-f0-9]{64}$/.test(saved?.sha256 || '')
      && Number.isSafeInteger(saved?.size) && saved.size > 0
      && task.reportBudget?.latest?.requestId === report.requestId && task.reportBudget.latest.state === 'blocked'
      && task.reportBudget.latest.sourceCommit === report.sourceCommit
      && typeof report.reportName === 'string' && control?.run?.reportName === report.reportName
      && control.run.progress?.checkpoint === report.sourceCommit && control.run.progress?.coreRecorded === true;
    return Boolean(task.status === 'blocked' && task.assignee === 'coding-team' && !task.automationLease?.leaseId
      && !task.codingAutonomy && !(Number(task.automationAttemptCount) > 0) && control?.busy === false && outcome
      && (!describe(outcome).requiresInspection || recoveredReport)
      && recorded && (!describe(recorded).requiresInspection || recoveredReport) && recorded.reason === outcome.reason
      && recorded.requestId === outcome.requestId && recorded.claimSeq === outcome.claimSeq);
  }
  return { SCHEMA, normalize, latest, native, describe, canResume };
});
