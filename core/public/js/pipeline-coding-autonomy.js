(function () {
  'use strict';
  const base = '/api/pipeline/coding-autonomy';
  let snapshot;
  let busy = false;
  let timer;
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
  function confirmed() {
    if (!$('codingAutonomyConfirm').checked) throw new Error('Confirm the reviewed task scope and campaign first.');
  }
  function render() {
    $('codingAutonomyStatus').textContent = `${snapshot.enabled ? 'Enabled' : 'Paused'} · ${snapshot.tasks.filter(t => t.authorized).length} explicitly authorized tasks · ${snapshot.active ? `active task ${snapshot.active.pipelineId}, request ${snapshot.active.requestId}` : 'no active execution'}`;
    const list = $('codingAutonomyTasks');
    list.replaceChildren();
    for (const task of snapshot.tasks) {
      const article = element('article', '');
      article.append(element('h3', `${task.pipelineId} · ${task.title}`), element('p', `${task.state} · task ${task.taskStatus} · ${task.resumes} corrections · ${task.nextAction}`),
        element('p', `Remaining: ${Math.floor(task.remaining.workSeconds / 60)} min work, ${Math.floor(task.remaining.testSeconds / 60)} min tests, ${Math.floor(task.remaining.modelSeconds / 60)} min model, ${task.remaining.modelCalls} calls, ${Math.floor(task.remaining.ciSeconds / 60)} min CI`),
        element('p', `Last useful progress: ${task.lastUsefulProgressAt || 'none recorded'} · manual interventions: ${task.manualInterventions.length}`));
      article.append(element('p', `Authorized files: ${task.scope.join(', ')} · campaign ${task.queueRequestId}`));
      const run = task.runs.at(-1);
      const activeRecovery = snapshot.active?.pipelineId === task.pipelineId && snapshot.active.requestId === run?.requestId
        ? snapshot.active.recovery : null;
      if (run) article.append(element('p', `Execution ${run.requestId} · worker ${run.finishedAt ? 'finished' : 'termination not yet confirmed'} · unresolved model requests ${run.pendingInferenceCount}`));
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
        article.append(form);
      }
      if (task.pr) {
        const link = element('a', `Draft PR #${task.pr.number} · ${task.pr.head.slice(0, 12)}`);
        link.href = task.pr.url; link.rel = 'noopener'; article.append(link);
        const last = task.observations.at(-1);
        article.append(element('p', `PR published. CI ${last ? last.checks.map(c => `${c.name}: ${c.state} (${c.coverage || "execution coverage unverified"})`).join(' · ') : 'not yet observed'}. Human review, merge, installation and product acceptance have no receipt from this loop.`));
      }
      if (task.authorized && !run) {
        const withdraw = element('button', 'Remove task authorization'); withdraw.type = 'button'; withdraw.className = 'pipeline-btn';
        withdraw.addEventListener('click', () => act(() => request(`${base}/tasks/${task.pipelineId}/authorization`,
          { authorized: false, confirm: true, expectedRevision: task.authorizationRevision }))); article.append(withdraw);
      }
      if (run && !['stopped', 'closed'].includes(task.state)) {
        const stop = element('button', ['waiting_ci', 'correction', 'ready_for_review'].includes(task.state) ? 'Cancel waiting and future corrections' : 'Stop this exact worker');
        stop.type = 'button'; stop.className = 'pipeline-btn';
        stop.addEventListener('click', () => act(() => request(`${base}/tasks/${task.pipelineId}/runs/${run.requestId}/stop`, { confirm: true }))); article.append(stop);
      }
      if (task.pr && ['waiting_ci', 'ready_for_review'].includes(task.state)) {
        const form = element('form', '');
        const label = element('label', 'Review correction for this exact commit');
        const text = document.createElement('textarea'); text.maxLength = 4000; text.required = true; label.append(text);
        const send = element('button', 'Send correction to the Coding Team'); send.type = 'submit'; send.className = 'pipeline-btn';
        form.append(label, send);
        form.addEventListener('submit', event => { event.preventDefault(); act(() => request(`${base}/tasks/${task.pipelineId}/review`, { confirm: true, head: task.pr.head, text: text.value })); });
        article.append(form);
      }
      const history = element('details', ''); history.append(element('summary', 'Execution history and intervention evidence'));
      for (const item of task.runs) history.append(element('p', `${item.requestId} · previous ${item.parentRequestId || 'none'} · ${item.result || 'pending'} · ${item.head || 'no checkpoint'} · ${item.usage ? JSON.stringify(item.usage) : 'usage unconfirmed'}`));
      for (const item of task.manualInterventions) history.append(element('p', `${item.kind} · ${item.head || item.requestId || ''} · ${item.at}`));
      article.append(history); list.append(article);
    }
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try { snapshot = await request(base); render(); }
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
    $('codingAutonomyRefresh').addEventListener('click', refresh);
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
        limits: { maxResumes: Number(data.get('maxResumes')), workSeconds: Number(data.get('workMinutes')) * 60,
          ciSeconds: Number(data.get('ciMinutes')) * 60 } }));
    });
    refresh(); timer = setInterval(refresh, 15000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  });
})();
