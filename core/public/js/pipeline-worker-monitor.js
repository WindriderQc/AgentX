(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PipelineWorkerMonitor = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  // Presentation of the existing launch controller only. The native owner keeps
  // request reconciliation, stop execution and resource-release receipts.
  const REQUEST = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const TASK = /^\d{4}$/;
  const TERMINAL = new Set(['finished', 'rejected', 'stopped']);
  const PHASE = { submitting: 'Submitting the original request', uncertain: 'Launch outcome unknown',
    accepted: 'Launch accepted; claim not yet proven', running: 'Worker running', stopping: 'Stop requested; checkpoint pending',
    unknown: 'Host outcome unknown', waiting: 'Waiting for capacity', not_received: 'Original request receipt not found',
    finished: 'Last worker receipt', rejected: 'Last launch rejected', stopped: 'Last request stopped' };
  const STAGE = { preparing: 'Preparing workspace', dependencies: 'Installing dependencies', model_wait: 'Waiting for model capacity or response',
    model_generation: 'Model generating', tool: 'Worker tool running', test: 'Tests running', checkpoint: 'Saving checkpoint', publishing: 'Publishing draft PR' };
  const RESULT = { blocked: 'Blocked', review: 'Draft PR ready for review', local_only: 'Local work awaits publication' };
  const TEST = { pytest: 'pytest', unittest: 'unittest', jest: 'Jest', npm_test: 'npm test', node_test: 'Node tests' };
  const OUTCOME = { passed: 'passed', failed: 'failed', unknown: 'unknown' };
  const INFERENCE = { waiting: 'Waiting to retry inference', streaming: 'Receiving model response', completed: 'Model call completed',
    exhausted: 'Inference retry limit reached', failed: 'Inference failed', cancelled: 'Inference cancelled', recovery_required: 'Explicit recovery required' };
  const REASONS = new Set(['model_budget_reserve', 'hard_budget', 'soft_budget_no_progress', 'no_useful_progress', 'model_call_limit',
    'operator_stop', 'worker_exit', 'model_output_limit', 'no_changes', 'dependencies_failed', 'dependencies_changed', 'runner_error',
    'tests_failed', 'generated_artifacts', 'ineligible_task', 'runtime_unavailable', 'runtime_changed', 'model_wait_inactive',
    'model_generation_inactive', 'tool_inactive', 'test_inactive', 'continuation_checkpoint_changed', 'github_token_missing',
    'git_reconciliation', 'git_conflict_remaining', 'verification_profile_unknown', 'progress_history_limit', 'model_termination_unverified',
    'authorization_removed', 'queue_window_closed']);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 86400;
  const own = (map, key) => Object.hasOwn(map, key) ? map[key] : null;
  const row = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

  function age(value, now) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return 'Unknown';
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return 'Unknown';
    const seconds = Math.floor((now - time) / 1000);
    if (seconds < -5) return `${value} · age unknown (clock ahead)`;
    const elapsed = Math.max(0, seconds);
    const label = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.floor(elapsed / 60)} min` : `${Math.floor(elapsed / 3600)} h`;
    return `${value} · ${label} ago (browser clock)`;
  }

  function boundAttempt(task, run) {
    const refs = task?.evidenceReferences;
    if (task?.pipelineId !== run?.pipelineId || refs?.schema !== 'agentx.pipeline-evidence-references/v1'
      || refs.pipelineId !== run.pipelineId || !Array.isArray(refs.attempts)) return null;
    const matches = refs.attempts.filter(item => item.request?.status === 'recorded' && item.request.requestId === run.requestId);
    const item = matches[0];
    return matches.length === 1 && Number.isSafeInteger(item.attempt) && item.attempt > 0 ? item : null;
  }

  function observation(controller, task, now = Date.now()) {
    const control = controller?.control;
    const pending = controller?.pending;
    const candidate = control?.run;
    const matches = !pending || (candidate?.requestId === pending.requestId && candidate?.pipelineId === pending.pipelineId);
    const run = matches && REQUEST.test(candidate?.requestId || '') && TASK.test(candidate?.pipelineId || '') ? candidate : null;
    const identity = run || pending;
    const taskId = TASK.test(identity?.pipelineId || '') ? identity.pipelineId : null;
    const requestId = REQUEST.test(identity?.requestId || '') ? identity.requestId : null;
    const progress = run?.progress && run.progress.requestId === run.requestId && run.progress.pipelineId === run.pipelineId ? run.progress : null;
    const attempt = boundAttempt(task, run);
    const historical = Boolean(run && TERMINAL.has(run.phase) && !pending);
    let title = run ? own(PHASE, run.phase) || 'Request state unknown' : pending ? 'Checking the original request' : control?.busy ? 'Worker busy; request identity unknown' : 'No active coding worker observed';
    let tone = historical ? 'ready' : run?.phase === 'unknown' || run?.phase === 'uncertain' || (pending && !run) ? 'attention' : control?.busy || pending ? 'loading' : 'ready';
    if (!control || control.available !== true) { title = 'Worker host unavailable'; tone = 'unavailable'; }
    if (controller?.error) { title = 'Host read unavailable; last observation retained'; tone = 'unavailable'; }
    let details = row('Host observation', esc(age(control?.observedAt, now)));
    if (identity) {
      details += row('Task', taskId ? `#${taskId}${historical ? ' · historical receipt' : ''}` : 'Unknown')
        + row('Launch request', requestId ? `<code>${requestId}</code>` : 'Unknown')
        + row('Recorded attempt', attempt ? `${attempt.attempt}${attempt.current ? ' · current in dossier' : ' · historical in dossier'}` : 'Unknown · open the dossier for the request binding');
    }
    const inference = control?.inference;
    if (inference && identity) {
      const bound = run && attempt?.current === true && inference.pipelineId === run.pipelineId && inference.attempt === attempt.attempt;
      details += row('Native model observation', bound
        ? esc(`${own(INFERENCE, inference.state) || 'State unknown'} · ${integer(inference.requestCount) ? inference.requestCount : 'Unknown'} observed call(s)`
          + (Number.isSafeInteger(inference.attempts) && inference.attempts >= 1 && inference.attempts <= 6 ? ` · call try ${inference.attempts}/6` : ''))
        : 'Unknown · no current dossier binding for this launch request');
    }
    if (progress) {
      const budget = value => integer(value) ? `${Math.ceil(value / 60)} min remaining` : 'Unknown';
      const runningTest = own(TEST, progress.currentTest);
      const lastTest = own(TEST, progress.lastTest?.name);
      const checkpoint = typeof progress.checkpoint === 'string' && /^[a-f0-9]{40}$/.test(progress.checkpoint) ? progress.checkpoint : null;
      details += row(historical ? 'Recorded result / stage' : 'Worker stage', esc(own(RESULT, progress.result) || own(STAGE, progress.stage) || 'Unknown'))
        + row('Host heartbeat', esc(age(progress.heartbeatAt, now)))
        + row('Last useful progress', esc(age(progress.progressAt, now)))
        + row('Soft budget', budget(progress.softRemainingSeconds))
        + row('Hard budget', budget(progress.hardRemainingSeconds))
        + row('Tests', esc(`${runningTest ? `Running: ${runningTest}` : 'No running test recorded'} · ${lastTest ? `Last: ${lastTest} ${own(OUTCOME, progress.lastTest.outcome) || 'unknown'}` : 'Last result unknown'}`))
        + row('Model calls', integer(progress.modelCalls) ? String(progress.modelCalls)
          + (integer(progress.modelCallLimit) && progress.modelCallLimit >= 128 && progress.modelCallLimit <= 256
            ? ` / ${progress.modelCallLimit} · ${Math.max(0, progress.modelCallLimit - progress.modelCalls)} remaining` : '') : 'Unknown')
        + row('Local checkpoint', checkpoint ? `<code title="${checkpoint}">${checkpoint.slice(0, 12)}</code> · source saved locally` : 'Unknown')
        + (REASONS.has(progress.stopReason) ? row('Recorded stop reason', esc(progress.stopReason.replaceAll('_', ' '))) : '');
    } else if (identity) details += row('Worker progress', 'Unknown · no matching progress receipt');
    const lifecycle = run?.phase === 'stopping'
      ? 'The native owner recorded a stop request. Worker termination and native model/resource release remain unproven here.'
      : run?.phase === 'unknown' || run?.phase === 'uncertain' || (pending && !run)
        ? 'Outcome unknown. Reconcile this original request; another worker is not authorized by this observation.'
        : historical ? 'This is the last request receipt, not an active worker. Request completion does not prove native model/resource release, acceptance, merge or deployment.'
          : 'Heartbeat records host liveness. Useful progress records source or test activity. Stop acknowledgement and native model/resource release are separate evidence.';
    return { title, tone, details, lifecycle, taskId, attempt, historical, run,
      canStop: Boolean(run && controller?.canStop?.()),
      showStop: Boolean(run && (run.canStop === true || run.phase === 'stopping')) };
  }

  function render({ $, controller, task, now }) {
    const root = $('pipelineWorkerMonitor');
    if (!root) return;
    const view = observation(controller, task, now);
    const status = $('pipelineTeamLaunchState');
    if (status.textContent !== view.title) status.textContent = view.title;
    status.dataset.tone = view.tone;
    const evidence = $('pipelineWorkerMonitorEvidence');
    const markup = `<dl>${view.details}</dl>`;
    if (evidence.innerHTML !== markup) evidence.innerHTML = markup;
    const note = $('pipelineWorkerMonitorNote');
    if (note.textContent !== view.lifecycle) note.textContent = view.lifecycle;
    const dossier = $('pipelineWorkerMonitorDossier');
    dossier.hidden = !view.taskId;
    if (view.taskId) {
      dossier.href = `/pipeline?task=${view.taskId}${view.attempt ? `&attempt=${view.attempt.attempt}` : ''}`;
      dossier.textContent = view.attempt ? `Open task #${view.taskId} · attempt ${view.attempt.attempt} dossier` : `Open task #${view.taskId} dossier`;
    } else dossier.removeAttribute('href');
    const stop = $('pipelineTeamLaunchStop');
    stop.hidden = !view.showStop; stop.disabled = !view.canStop;
    stop.textContent = view.run?.phase === 'stopping' ? 'Stop requested · awaiting checkpoint' : `Stop worker #${view.taskId || ''}`;
    stop.onclick = () => controller?.stop();
    const refresh = $('pipelineTeamLaunchRefresh');
    if (refresh) refresh.disabled = Boolean(controller?.checking);
  }

  return { observation, render };
});
