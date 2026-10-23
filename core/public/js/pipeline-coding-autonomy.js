(function () {
  'use strict';
  const base = '/api/pipeline/coding-autonomy';
  let snapshot;
  let busy = false;
  let timer;
  let showArchived = false;
  const $ = id => document.getElementById(id);
  const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  async function request(url, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, { ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Refresh the original request to reconcile its result.');
      return payload.data;
    } finally { clearTimeout(timeout); }
  }
  function remaining(seconds) {
    if (seconds < 60) return seconds > 0 ? `${seconds} sec` : '0 min';
    const minutes = Math.floor(seconds / 60); const extra = seconds - minutes * 60;
    return extra ? `${minutes} min ${extra} sec` : `${minutes} min`;
  }
  function confirmed() {
    const confirmation = $('codingAutonomyConfirm');
    if (!confirmation.checked) {
      confirmation.scrollIntoView?.({ block: 'center' });
      confirmation.focus?.({ preventScroll: true });
      throw new Error('Confirm the reviewed task scope and campaign first.');
    }
  }
  function protectDraft(form) {
    const initial = [...form.querySelectorAll('input, textarea')].map(field => ({ field, value: field.value, checked: field.checked }));
    const update = () => { form.dataset.dirty = initial.some(item => item.field.value !== item.value || item.field.checked !== item.checked) ? 'true' : 'false'; };
    form.addEventListener('input', update); form.addEventListener('change', update);
  }
  function appendActionForm(article, form, title) {
    const details = element('details', '');
    details.append(element('summary', title), form); article.append(details);
  }
  function appendCodeStepGraph(article, value) {
    if (!value) return;
    const presenter = window.PipelineCodeStepGraph;
    const summary = presenter?.summaryText?.(value);
    if (!summary) {
      article.append(element('p', 'Code-step graph unavailable; malformed evidence was not displayed.'));
      return;
    }
    article.append(element('p', `Multi-host graph · ${summary}`));
    const details = element('details', '');
    const body = element('div', '');
    body.innerHTML = presenter.render(value, { compact: true });
    details.append(element('summary', 'Code-step graph and final assembly evidence'), body);
    article.append(details);
  }
  function renderStatus(suffix = '') {
    const current = snapshot.tasks.filter(t => !t.disposition && t.taskStatus !== 'done');
    const queued = current.filter(t => t.authorized && ['queued', 'correction'].includes(t.state)).length;
    $('codingAutonomyStatus').textContent = `${snapshot.enabled ? 'Enabled' : 'Paused'} · ${queued} authorized tasks waiting · ${current.filter(t => t.taskStatus === 'blocked').length} blocked · ${current.filter(t => t.taskStatus === 'review').length} awaiting review · ${snapshot.active ? `active task ${snapshot.active.pipelineId}, request ${snapshot.active.requestId}` : 'no active execution'}${suffix}`;
  }
  function continuationForm(task, run) {
    const form = element('form', '');
    form.append(element('p', `Reviewed continuation · ${task.nativeAttemptCount}/${task.nativeAttemptLimit} native attempts consumed. Original failures and spent budgets remain recorded.`));
    const fields = {};
    const input = (key, title, value, type = 'number') => {
      const label = element('label', title), field = document.createElement('input');
      field.type = type; field.value = value; field.required = true;
      if (type === 'number') { field.min = 1; field.step = 1; }
      label.append(field); form.append(label); fields[key] = field;
    };
    input('queueRequestId', 'New approved coding campaign', '', 'text');
    input('key', 'Reviewed continuation identity', `coding-continuation:${run.requestId}${task.continuationAborts?.length ? `:review-${task.continuationAborts.length + 1}` : ''}`, 'text');
    input('nativeAttemptLimit', 'Reviewed total native attempt limit (maximum 10)', Math.max(task.nativeAttemptLimit, task.nativeAttemptCount + 1));
    fields.nativeAttemptLimit.max = 10;
    input('additionalRuns', 'Additional workers (maximum 3)', 1); fields.additionalRuns.max = 3;
    for (const [key, label, value] of [['workSeconds', 'Additional work minutes', 60], ['testSeconds', 'Additional test minutes', 15],
      ['modelSeconds', 'Additional model minutes', 30], ['modelCalls', 'Additional model calls', 32], ['ciSeconds', 'Additional CI minutes', 15]]) input(key, label, value);
    const label = element('label', 'Correction based on the preserved checkpoint and test evidence');
    const text = document.createElement('textarea'); text.required = true; text.maxLength = 4000; label.append(text); form.append(label);
    const send = element('button', 'Record reviewed continuation'); send.type = 'submit'; send.className = 'pipeline-btn'; form.append(send);
    form.addEventListener('submit', event => { event.preventDefault(); act(() => request(`${base}/tasks/${task.pipelineId}/runs/${run.requestId}/continuation`, {
      confirm: true, confirmation: 'CONTINUE_TERMINAL_CHECKPOINT_WITH_REVIEWED_ATTEMPT_LIMIT',
      key: fields.key.value, expectedRevision: task.authorizationRevision,
      expectedAutomationFingerprint: task.automationFingerprint, expectedNativeAttemptLimit: task.nativeAttemptLimit,
      nativeAttemptLimit: Number(fields.nativeAttemptLimit.value), additionalRuns: Number(fields.additionalRuns.value),
      head: run.head, queueRequestId: fields.queueRequestId.value, verificationProfile: task.verificationProfile,
      text: text.value, budget: Object.fromEntries(['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls', 'ciSeconds']
        .map(key => [key, Number(fields[key].value) * (key === 'modelCalls' ? 1 : 60)])) })); });
    return form;
  }
  function render() {
    renderStatus();
    const list = $('codingAutonomyTasks');
    const archiveList = $('codingAutonomyArchiveTasks');
    list.replaceChildren();
    archiveList.replaceChildren();
    archiveList.hidden = !showArchived;
    const archived = snapshot.tasks.filter(t => t.disposition || t.taskStatus === 'done').length;
    const toggle = element('button', `${showArchived ? 'Hide' : 'Show'} archived qualifications and closed tasks (${archived})`);
    toggle.type = 'button'; toggle.className = 'pipeline-btn compact';
    toggle.setAttribute('aria-expanded', String(showArchived));
    toggle.setAttribute('aria-controls', 'codingAutonomyArchiveTasks');
    toggle.addEventListener('click', () => {
      if (editing()) { renderStatus(' · send or clear your task edit before changing the archive view'); return; }
      showArchived = !showArchived; render();
    });
    $('codingAutonomyArchiveControls').replaceChildren(toggle);
    if (!snapshot.tasks.some(t => !t.disposition && t.taskStatus !== 'done')) {
      const empty = element('p', 'No current Coding Team tasks. Set up a campaign above to authorize work.');
      empty.className = 'pipeline-autonomy-empty'; list.append(empty);
    }
    for (const task of snapshot.tasks) {
      if (!showArchived && (task.disposition || task.taskStatus === 'done')) continue;
      const article = element('article', '');
      article.append(element('h3', `${task.pipelineId} · ${task.title}`), element('p', `${task.state} · task ${task.taskStatus} · ${task.resumes} corrections · ${task.nextAction}`),
        element('p', `Remaining: ${remaining(task.remaining.workSeconds)} work, ${remaining(task.remaining.testSeconds)} tests, ${remaining(task.remaining.modelSeconds)} model, ${task.remaining.modelCalls} calls, ${remaining(task.remaining.ciSeconds)} CI`),
        element('p', `Last useful progress: ${task.lastUsefulProgressAt || 'none recorded'} · manual interventions: ${task.manualInterventions.length}`));
      article.append(element('p', `Authorized files: ${task.scope.join(', ')} · campaign ${task.queueRequestId}`));
      if (task.readiness && !task.readiness.canAuthorize)
        for (const issue of task.readiness.issues) article.append(element('p', `${issue.message} ${issue.nextAction}`));
      appendCodeStepGraph(article, task.codeStepGraph);
      if (task.nativeAttemptLimit) article.append(element('p', `Native attempts: ${task.nativeAttemptCount}/${task.nativeAttemptLimit} · remaining worker corrections: ${task.remaining.maxResumes}`));
      const exhausted = [['workSeconds', 'work'], ['testSeconds', 'tests'], ['modelSeconds', 'model time'],
        ['modelCalls', 'model calls'], ['ciSeconds', 'CI']].filter(([key]) => task.remaining[key] === 0).map(([, title]) => title);
      if (exhausted.length) article.append(element('p', `Exhausted budgets: ${exhausted.join(', ')}. Review prior usage and the recorded outcome before approving further work; spent costs are retained.`));
      if (task.ciObservationActive) article.append(element('p', 'Core continues watching CI for the exact published commit, including while coding is paused or worker resumes are exhausted. No coding worker starts merely to wait.'));
      const run = task.runs.at(-1);
      if (task.disposition) article.append(element('p', `Archived qualification: ${task.disposition.outcome} · ${task.disposition.reason}. Original execution outcomes and dependency barriers remain in force.`));
      if (task.continuationAborts?.length) article.append(element('p', 'A reviewed continuation was abandoned before its grant. No worker or credit was created; review the changed checkpoint or campaign proof before submitting a new intent.'));
      if (task.failureCodes?.length) article.append(element('p', `Recorded stop: ${task.failureCodes.join(', ')} · ${task.authorized ? 'execution authorized' : 'execution authorization removed; this card is not queued'}`));
      if (!snapshot.enabled && !snapshot.active && !task.authorized && task.state === 'stopped' && task.taskStatus === 'blocked'
        && !task.pr && !task.disposition && run?.finishedAt && !run.pendingInferenceCount && run.head
        && task.nativeAttemptLimit && task.verificationProfile) appendActionForm(article, continuationForm(task, run), 'Review a continuation from the saved checkpoint');
      const activeRecovery = snapshot.active?.pipelineId === task.pipelineId && snapshot.active.requestId === run?.requestId
        ? snapshot.active.recovery : null;
      if (run) article.append(element('p', `Execution ${run.requestId} · worker ${run.finishedAt ? 'finished' : 'termination not yet confirmed'} · unresolved model requests ${run.pendingInferenceCount}`));
      if (task.runs.some(item => item.pendingInferenceCount || item.historicalPendingInferenceCount
        || item.modelReceipts?.some(call => ['unknown', 'pending'].includes(call.state)))) article.append(element('p', 'An unknown or pending model receipt is an uncertain outcome. An absent worker or administrative recovery does not make it successful or authorize another worker. Original outcomes remain recorded.'));
      const recoveryHeld = run?.recovery && snapshot.active?.pipelineId === task.pipelineId && snapshot.active.requestId === run.requestId;
      if (run?.recovery) article.append(element('p', `Recovery ${run.recovery.state} · ${run.recovery.authority}${recoveryHeld ? ' · selection slot still held' : ''} · historical unresolved receipts retained: ${run.historicalPendingInferenceCount}. Original model outcomes are unchanged.`));
      if ((run?.pendingInferenceCount || recoveryHeld) && !snapshot.enabled && !task.authorized
        && ['blocked', 'stopping', 'stop_requested', 'stopped'].includes(task.state)) {
        const form = element('form', '');
        form.append(element('p', 'Reconcile the original execution after verifying worker termination and native resource release. Core checks the received campaign receipt and keeps the original model outcomes.'));
        const label = element('label', 'I verified termination of the original worker and release through the native resource owner.');
        const verified = document.createElement('input'); verified.type = 'checkbox'; verified.required = true; label.append(verified);
        const send = element('button', recoveryHeld ? 'Finish this original recovery' : 'Reconcile this original execution'); send.type = 'submit'; send.className = 'pipeline-btn';
        form.append(label, send);
        form.addEventListener('submit', event => {
          event.preventDefault();
          act(async () => {
            if (!verified.checked) throw new Error('Verify original worker termination and native release before reconciliation.');
            const received = run.recovery || (await request(`/api/cluster/schedule/work-queue/${task.queueRequestId}`)).releaseReceipt;
            await request(`${base}/tasks/${task.pipelineId}/runs/${run.requestId}/recover`, {
              confirm: true, confirmation: 'ORIGINAL_WORKER_TERMINATED_AND_NATIVE_AUTHORITY_RELEASED',
              key: run.recovery?.key || activeRecovery?.key || `coding-recovery:${run.requestId}`, expectedRevision: task.authorizationRevision,
              callIds: run.recovery?.callIds || run.unresolvedCallIds, receiptRef: received?.receiptRef,
              receiptSha256: received?.receiptSha256 });
          });
        });
        appendActionForm(article, form, 'Reconcile the original execution');
      }
      if (task.pr) {
        const delivery = task.delivery;
        const link = element('a', `PR #${task.pr.number}${delivery?.merged ? ' · merged' : delivery?.state === 'closed' ? ' · closed' : ''} · ${task.pr.head.slice(0, 12)}`);
        link.href = task.pr.url; link.rel = 'noopener'; article.append(link);
        const last = delivery || task.observations.at(-1);
        article.append(element('p', `PR published. CI ${last ? last.checks.map(c => `${c.name}: ${c.state} (${c.coverage || "execution coverage unverified"})`).join(' · ') : 'not yet observed'}. Installation and product acceptance have no receipt from this loop.`));
        if (delivery) article.append(element('p', `Observed ${delivery.observedAt} · CI ${delivery.ci}${delivery.headMatches ? ' on the published commit' : ` on a different remote commit ${delivery.head.slice(0, 12)}; original worker head retained`}. Human acceptance remains a separate decision.`));
      }
      if (task.authorized && (!run || run.finishedAt)) {
        const withdraw = element('button', 'Remove task authorization'); withdraw.type = 'button'; withdraw.className = 'pipeline-btn';
        withdraw.addEventListener('click', () => act(() => request(`${base}/tasks/${task.pipelineId}/authorization`,
          { authorized: false, confirm: true, expectedRevision: task.authorizationRevision }))); article.append(withdraw);
      }
      if (run && !['stopped', 'closed'].includes(task.state)) {
        const stop = element('button', ['waiting_ci', 'correction', 'ready_for_review'].includes(task.state) ? 'Cancel waiting and future corrections' : 'Stop this exact worker');
        stop.type = 'button'; stop.className = 'pipeline-btn';
        stop.addEventListener('click', () => act(() => request(`${base}/tasks/${task.pipelineId}/runs/${run.requestId}/stop`, { confirm: true }))); article.append(stop);
      }
      if (task.pr && !task.delivery?.merged && task.delivery?.state !== 'closed' && ['waiting_ci', 'ready_for_review'].includes(task.state)) {
        const form = element('form', '');
        const label = element('label', 'Review correction for this exact commit');
        const text = document.createElement('textarea'); text.maxLength = 4000; text.required = true; label.append(text);
        const send = element('button', 'Send correction to the Coding Team'); send.type = 'submit'; send.className = 'pipeline-btn';
        form.append(label, send);
        form.addEventListener('submit', event => { event.preventDefault(); act(() => request(`${base}/tasks/${task.pipelineId}/review`, { confirm: true, head: task.pr.head, text: text.value })); });
        appendActionForm(article, form, 'Request a correction for this commit');
      }
      if (run?.finishedAt && !task.authorized && !task.disposition && ['stopped', 'closed'].includes(task.state)
        && snapshot.active?.pipelineId !== task.pipelineId) {
        const form = element('form', '');
        form.append(element('p', 'Archive a qualification with a separate operator receipt. Its task status, dependency barriers and original model outcomes remain in force.'));
        const fields = {};
        for (const [key, title] of [['outcome', 'Qualification outcome: passed, abandoned or superseded'],
          ['reason', 'Qualification reason'], ['receiptRef', 'Private qualification receipt reference'], ['receiptSha256', 'Receipt SHA-256']]) {
          const label = element('label', title), field = document.createElement('input'); field.required = true;
          label.append(field); form.append(label); fields[key] = field;
        }
        const send = element('button', 'Archive qualification'); send.type = 'submit'; send.className = 'pipeline-btn'; form.append(send);
        form.addEventListener('submit', event => { event.preventDefault(); act(() => request(`${base}/tasks/${task.pipelineId}/disposition`, {
          confirm: true, confirmation: 'ARCHIVE_QUALIFICATION_WITH_ORIGINAL_RECEIPTS', expectedRevision: task.authorizationRevision,
          requestId: run.requestId, ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])) })); });
        appendActionForm(article, form, 'Archive this qualification');
      }
      const history = element('details', ''); history.append(element('summary', 'Execution history and intervention evidence'));
      for (const item of task.runs) {
        history.append(element('p', `${item.requestId} · previous ${item.parentRequestId || 'none'} · ${item.result || 'pending'} · ${item.head || 'no checkpoint'} · ${item.usage ? JSON.stringify(item.usage) : 'usage unconfirmed'}`));
        if (item.codeStepGraph) appendCodeStepGraph(history, item.codeStepGraph);
      }
      for (const item of task.manualInterventions) history.append(element('p', `${item.kind} · ${item.head || item.requestId || ''} · ${item.at}`));
      for (const form of article.querySelectorAll('form')) protectDraft(form);
      article.append(history);
      (task.disposition || task.taskStatus === 'done' ? archiveList : list).append(article);
    }
  }
  // Something typed or ticked in a task card that a rebuild would erase.
  function editing() {
    return [$('codingAutonomyTasks'), $('codingAutonomyArchiveTasks')].some(list => list.contains(document.activeElement)
      || [...list.querySelectorAll('form')].some(form => form.dataset.dirty === 'true')
      || [...list.querySelectorAll('textarea')].some(field => field.value)
      || [...list.querySelectorAll('input[type="checkbox"]')].some(box => box.checked));
  }
  async function refresh({ background = false } = {}) {
    if (busy || (background && document.hidden)) return;
    busy = true;
    try {
      snapshot = await request(base);
      if (background && editing()) renderStatus(' · task cards update once your edit is sent or cleared');
      else render();
    }
    catch (error) { $('codingAutonomyStatus').textContent = error.message; }
    finally { busy = false; }
  }
  async function act(fn) {
    if (busy) return;
    busy = true;
    try { confirmed(); await fn(); }
    catch (error) { $('codingAutonomyStatus').textContent = error.message; return; }
    finally { busy = false; }
    await refresh();
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (!$('pipelineCodingAutonomy')) return;
    document.querySelectorAll('[data-autonomy-switch]').forEach(button => button.addEventListener('click', () => act(() => request(`${base}/config`,
      { enabled: button.dataset.autonomySwitch === 'true', confirm: true, expectedRevision: snapshot.revision }))));
    $('codingAutonomyRefresh').addEventListener('click', () => refresh());
    $('codingAutonomyCampaign').addEventListener('submit', event => {
      event.preventDefault(); const id = new FormData(event.target).get('queueRequestId');
      act(async () => {
        const root = '/api/cluster/schedule/work-queue'; const job = await request(`${root}/${id}`);
        if (job.source?.type !== 'coding' || job.executor?.mode !== 'operator') throw new Error('Select a reviewed coding operator campaign.');
        if (['dispatching', 'running'].includes(job.state)) return;
        await request(`${root}/${id}/begin`, { expectedRevision: job.revision });
      });
    });
    $('codingAutonomyAuthorize').addEventListener('submit', event => {
      event.preventDefault(); const data = new FormData(event.target);
      act(() => request(`${base}/tasks/${data.get('pipelineId')}/authorization`, { authorized: true, confirm: true,
        expectedRevision: snapshot.tasks.find(t => t.pipelineId === data.get('pipelineId'))?.authorizationRevision || 0,
        queueRequestId: data.get('queueRequestId'), lowRisk: true,
        scope: String(data.get('scope')).split('\n').map(p => p.trim()).filter(Boolean),
        verificationProfile: data.get('verificationProfile'),
        qualification: {
          acceptanceCriteria: String(data.get('acceptanceCriteria') || '').split('\n').map(text => text.trim()).filter(Boolean),
          requiredCapabilities: String(data.get('requiredCapabilities') || '').split('\n').map(text => text.trim()).filter(Boolean),
          estimate: { workSeconds: Number(data.get('estimatedWorkMinutes')) * 60, modelCalls: Number(data.get('estimatedModelCalls')) }
        },
        limits: { maxResumes: Number(data.get('maxResumes')), workSeconds: Number(data.get('workMinutes')) * 60,
          testSeconds: Number(data.get('testMinutes')) * 60, modelSeconds: Number(data.get('modelMinutes')) * 60,
          modelCalls: Number(data.get('modelCalls')), ciSeconds: Number(data.get('ciMinutes')) * 60,
          noProgressSeconds: Number(data.get('noProgressMinutes')) * 60 } }));
    });
    refresh(); timer = setInterval(() => refresh({ background: true }), 15000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  });
})();
