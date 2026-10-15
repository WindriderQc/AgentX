/* Pipeline delivery inbox and dispatch control: GitHub links, delivery gates
   and cards, merge, and the one-task launch control. pipeline.js creates it
   with its shared state and helpers. */
(function () {
  'use strict';
  let escapeHtml, $, state, formatDate, DELIVERY_STAGE_META, readProjection, fetchJson, toast, loadTasks, formatStatus, inferenceSummary;

  function safeGitHubUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : '';
    } catch {
      return '';
    }
  }

  function deliveryLink(value, label, icon) {
    const url = safeGitHubUrl(value);
    return url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><i class="fas ${escapeHtml(icon)}" aria-hidden="true"></i>${escapeHtml(label)}</a>`
      : '';
  }

  function deliveryGate(label, passed) {
    return `<span class="pipeline-delivery-gate ${passed ? 'pass' : 'fail'}"><i class="fas ${passed ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i>${escapeHtml(label)}</span>`;
  }

  const DELIVERY_PAGE_SIZE = 5;
  const DELIVERY_VIEWS = { all: 'All active', decisions: 'Needs a decision', progress: 'Follow progress' };
  const rendered = new WeakMap();
  function markup(element, html) {
    if (element && rendered.get(element) !== html) { element.innerHTML = html; rendered.set(element, html); }
  }
  function countValue(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

  function renderDeliveryInbox() {
    const statusEl = $('pipelineDeliveryState'), list = $('pipelineDeliveryList');
    const count = $('pipelineDeliveryHumanCount'), views = $('pipelineDeliveryViews'), pager = $('pipelineDeliveryPager');
    if (!statusEl || !list) return;
    const observation = state.delivery;
    if (!observation) {
      statusEl.dataset.tone = state.deliveryError ? 'unavailable' : 'loading';
      markup(statusEl, state.deliveryError
        ? `<i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>Delivery evidence unavailable: ${escapeHtml(state.deliveryError)}</span>`
        : '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Reading delivery decisions independently of the task queue…</span>');
      if (count) count.textContent = 'Unknown';
      markup(list, state.deliveryError ? '<div class="pipeline-empty">The task queue remains available. Refresh deliveries to read their current state.</div>'
        : '<div class="pipeline-empty">Reading review, CI and delivery evidence…</div>');
      markup(views, ''); markup(pager, ''); if (pager) pager.hidden = true;
      if (state.deliveryError) {
        $('pipelineDeliveryHistoryMeta').textContent = 'Delivery history unavailable';
        markup($('pipelineDeliveryHistoryList'), '<div class="pipeline-empty">No production conclusion can be drawn from this failed request.</div>');
      }
      return;
    }

    const items = Array.isArray(observation.items) ? observation.items : [];
    const active = items.filter(item => item.stage !== 'deployed');
    const completed = items.filter(item => item.stage === 'deployed');
    const humanActions = countValue(observation.counts?.humanActionRequired);
    const readyToMerge = countValue(observation.counts?.readyToMerge);
    if (count) count.textContent = state.deliveryError ? 'Unknown' : `${humanActions ?? 'Unknown'} decision${humanActions === 1 ? '' : 's'}`;
    statusEl.dataset.tone = state.deliveryError ? 'unavailable' : state.deliveryLoading ? 'loading' : humanActions == null || humanActions > 0 ? 'attention' : 'ready';
    markup(statusEl, state.deliveryError
      ? `<i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>${escapeHtml(state.deliveryError)} · Last observation retained from ${escapeHtml(formatDate(observation.observedAt))}. Merge controls are disabled.</span>`
      : state.deliveryLoading
        ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Refreshing deliveries · previous observation retained; merge controls are disabled.</span>'
        : `<i class="fas ${humanActions ? 'fa-user-check' : 'fa-circle-info'}" aria-hidden="true"></i><span>${humanActions == null ? 'Decision total unknown' : humanActions ? `${humanActions} delivery decision${humanActions === 1 ? '' : 's'} in this snapshot` : 'No delivery decision is waiting in this snapshot'} · ${readyToMerge == null ? 'merge readiness unknown' : `${readyToMerge} PR${readyToMerge === 1 ? '' : 's'} ready to merge`}. Review and merge are separate steps.</span>`);
    const meta = $('pipelineDeliveryMeta');
    const unclassified = active.filter(item => ![true, false].includes(item.humanActionRequired)).length;
    if (meta) meta.textContent = `${state.deliveryError ? 'Stale observation' : 'Observed'} ${formatDate(observation.observedAt)} · Recent-task snapshot, independent of overview filters; not an all-time total. These counts can overlap Needs attention.`
      + (unclassified ? ` ${unclassified} record${unclassified === 1 ? ' has' : 's have'} unknown action ownership and remain${unclassified === 1 ? 's' : ''} in All active.` : '');

    // Keep expanded evidence across refreshes, filters and page changes.
    state.deliveryExpanded ||= new Set();
    for (const el of document.querySelectorAll('[data-delivery-evidence]')) {
      if (el.open) state.deliveryExpanded.add(el.dataset.deliveryEvidence);
      else state.deliveryExpanded.delete(el.dataset.deliveryEvidence);
    }
    const expandedHistory = [...document.querySelectorAll('[data-delivery-record][open]')].map(el => el.dataset.deliveryRecord);
    const focused = document.activeElement?.dataset;
    const focusedView = focused?.deliveryView, focusedPage = focused?.deliveryPage;
    const view = DELIVERY_VIEWS[state.deliveryView] ? state.deliveryView : 'all';
    const subsets = { all: active, decisions: active.filter(item => item.humanActionRequired === true),
      progress: active.filter(item => item.humanActionRequired === false) };
    const filtered = subsets[view];
    const last = Math.max(0, Math.ceil(filtered.length / DELIVERY_PAGE_SIZE) - 1);
    const page = Math.min(Math.max(0, state.deliveryPage || 0), last); state.deliveryPage = page;
    const start = page * DELIVERY_PAGE_SIZE, shown = filtered.slice(start, start + DELIVERY_PAGE_SIZE);
    markup(views, Object.entries(DELIVERY_VIEWS).map(([key, label]) => `<button type="button" class="pipeline-btn compact${view === key ? ' active' : ''}" data-delivery-view="${key}" aria-pressed="${view === key}">${label} <span>${subsets[key].length}</span></button>`).join(''));
    markup(list, shown.length ? shown.map(item => renderDeliveryCard(item)).join('')
      : `<div class="pipeline-empty">${view === 'decisions' ? 'No delivery decision is waiting in this observation.' : view === 'progress' ? 'No delivery is awaiting automated follow-up in this observation.' : 'No active delivery. Completed deliveries are in History.'}</div>`);
    markup(pager, filtered.length ? `<span class="pipeline-delivery-pageinfo">${start + 1}–${start + shown.length} of ${filtered.length} · ${DELIVERY_VIEWS[view]}</span>${last ? `<div><button type="button" class="pipeline-btn compact" data-delivery-page="prev"${page === 0 ? ' disabled' : ''}>Previous</button><button type="button" class="pipeline-btn compact" data-delivery-page="next"${page === last ? ' disabled' : ''}>Next</button></div>` : ''}` : '');
    if (pager) pager.hidden = !filtered.length;
    $('pipelineDeliveryHistoryMeta').textContent = `${state.deliveryError ? 'Stale observation · ' : ''}${completed.length} completed deliveries · observed ${formatDate(observation.observedAt)} · independent of the attempt window and board filters`;
    markup($('pipelineDeliveryHistoryList'), completed.length ? completed.map(item => `
      <details class="pipeline-delivery-record" data-delivery-record="${escapeHtml(item.pipelineId)}">
        <summary><span>${escapeHtml(item.pipelineId)} · ${escapeHtml(item.title)}</span><span class="pipeline-status pipeline-status-done">Production proven <i class="fas fa-chevron-down" aria-hidden="true"></i></span></summary>
        ${renderDeliveryCard(item)}
      </details>`).join('') : '<div class="pipeline-empty">No completed production delivery in this observation.</div>');
    document.querySelectorAll('[data-delivery-record]').forEach(el => { el.open = expandedHistory.includes(el.dataset.deliveryRecord); });
    document.querySelectorAll('[data-delivery-evidence]').forEach(el => { el.open = state.deliveryExpanded.has(el.dataset.deliveryEvidence); });
    if (focusedView) views?.querySelector(`[data-delivery-view="${focusedView}"]`)?.focus();
    if (focusedPage) (pager?.querySelector(`[data-delivery-page="${focusedPage}"]:not([disabled])`)
      || pager?.querySelector('[data-delivery-page]:not([disabled])'))?.focus();
  }

  function renderDeliveryCard(item) {
    const stage = DELIVERY_STAGE_META[item.stage] || { label: 'Delivery state unknown', icon: 'fa-circle-question', tone: 'failed' };
    const summary = item.summary || {}, pr = item.pullRequest, ci = item.ci, deployment = item.deployment, gate = item.gate;
    const headSha = String(pr?.headSha || '');
    const merging = state.deliveryMerging === item.pipelineId;
    const mergeReady = !state.deliveryError && !state.deliveryLoading && item.stage === 'pr_ready_to_merge' && gate?.ready === true && /^[a-f0-9]{40}$/.test(headSha);
    const gates = gate ? [deliveryGate('Accepted task', gate.taskAccepted === true), deliveryGate('Exact PR', gate.exactPullRequest === true),
      deliveryGate('Exact SHA', gate.exactHead === true), deliveryGate('Sealed receipt', gate.sealedReceipt === true),
      deliveryGate('Required CI green', gate.ciGreen === true), deliveryGate('GitHub mergeable', gate.mergeable === true)].join('') : '';
    const productionGate = deployment?.production?.available ? deliveryGate('Live production parity', deployment.status === 'succeeded') : '';
    const links = [deliveryLink(pr?.url, pr?.number ? `PR #${pr.number}` : 'Pull request', 'fa-code-pull-request'),
      deliveryLink(ci?.url, 'Exact CI run', 'fa-list-check'), deliveryLink(deployment?.url, 'Deployment run', 'fa-rocket')].filter(Boolean).join('');
    const action = item.stage === 'review_ready' ? 'Review result' : ['ci_failed', 'receipt_mismatch', 'merge_blocked', 'delivery_unavailable'].includes(item.stage)
      ? 'Inspect blocker' : 'Open dossier';
    const recommendation = item.stage === 'review_ready' ? 'Human review required before acceptance or merge.'
      : mergeReady ? 'Eligible for an explicit merge decision after revalidation.'
        : item.stage === 'deployed' ? 'Production delivery receipt available.'
          : summary.recommendation === 'CORRECT' ? 'Inspect the recorded issue before continuing.' : 'Follow the next step; merge is not available here.';
    return `<article class="pipeline-delivery-card tone-${escapeHtml(stage.tone)}" data-delivery-item="${escapeHtml(item.pipelineId)}">
      <div class="pipeline-delivery-card-head"><div class="pipeline-delivery-identity">
        <strong>#${escapeHtml(item.pipelineId)} · ${escapeHtml(item.title || 'Untitled task')}</strong>
        <span>Attempt ${escapeHtml(item.attempt || '--')}${pr?.number ? ` · PR #${escapeHtml(pr.number)}` : ''}</span>
      </div><span class="pipeline-delivery-stage"><i class="fas ${escapeHtml(stage.icon)}" aria-hidden="true"></i>${escapeHtml(stage.label)}</span></div>
      <p class="pipeline-delivery-next"><span>Next step</span>${escapeHtml(summary.nextAction || 'Refresh the delivery evidence before deciding.')}</p>
      <div class="pipeline-delivery-actions"><button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(item.pipelineId)}"><i class="fas fa-folder-open" aria-hidden="true"></i><span>${action}</span></button>
        ${mergeReady ? `<button type="button" class="pipeline-btn primary compact" data-delivery-merge data-pipeline-id="${escapeHtml(item.pipelineId)}" data-pr-number="${escapeHtml(pr.number)}" data-head-sha="${escapeHtml(headSha)}" ${merging ? 'disabled' : ''} title="Merge exact PR #${escapeHtml(pr.number)} at ${escapeHtml(headSha)} after revalidating every gate"><i class="fas ${merging ? 'fa-spinner fa-spin' : 'fa-code-merge'}" aria-hidden="true"></i><span>${merging ? 'Revalidating exact gate' : `Merge PR #${escapeHtml(pr.number)} · ${escapeHtml(headSha.slice(0, 8))}`}</span></button>` : ''}
      </div>
      <details class="pipeline-delivery-evidence" data-delivery-evidence="${escapeHtml(item.pipelineId)}:${escapeHtml(item.attempt || 'unknown')}"><summary>Change, tests and delivery evidence</summary>
        <dl class="pipeline-delivery-summary"><div><dt>What changes</dt><dd>${escapeHtml(summary.change || 'Unknown')}</dd></div>
          <div><dt>Tests &amp; proof</dt><dd>${escapeHtml(summary.tests || 'Unknown')}</dd></div><div><dt>Risks</dt><dd>${escapeHtml(summary.risks || 'Unknown')}</dd></div>
          <div><dt>Recommendation</dt><dd>${recommendation}</dd></div><div><dt>Exact next action</dt><dd>${escapeHtml(summary.nextAction || 'Refresh exact evidence.')}</dd></div>
        </dl>
        ${gates || productionGate ? `<div class="pipeline-delivery-gates" aria-label="Protected delivery gates">${gates}${productionGate}</div>` : ''}
        ${headSha ? `<p class="pipeline-delivery-commit">Commit <code>${escapeHtml(headSha)}</code></p>` : ''}
        ${links ? `<div class="pipeline-delivery-links">${links}</div>` : ''}
      </details>
    </article>`;
  }

  function bindDeliveryNavigation() {
    $('pipelineDeliveryViews')?.addEventListener('click', event => {
      const view = event.target.closest('[data-delivery-view]')?.dataset.deliveryView;
      if (!DELIVERY_VIEWS[view]) return;
      state.deliveryView = view; state.deliveryPage = 0; renderDeliveryInbox();
    });
    $('pipelineDeliveryPager')?.addEventListener('click', event => {
      const button = event.target.closest('[data-delivery-page]');
      if (!button || button.disabled) return;
      state.deliveryPage = Math.max(0, (state.deliveryPage || 0) + (button.dataset.deliveryPage === 'next' ? 1 : -1));
      renderDeliveryInbox();
      $('pipelineDeliveryTitle')?.scrollIntoView?.({ block: 'start' });
      $('pipelineDeliveryTitle')?.focus?.({ preventScroll: true });
    });
  }

  async function loadDeliveryStatus() {
    state.deliveryError = null;
    state.deliveryLoading = true;
    renderDeliveryInbox();
    try {
      const payload = await readProjection('delivery', '/api/runtime-bridges/coding-delivery/status', 45000);
      if (!payload) return;
      if (!Array.isArray(payload.data?.items)) throw new Error('Delivery records are unavailable or in an unknown format.');
      state.delivery = payload.data;
    } catch (error) {
      state.deliveryError = String(error.message || error);
    }
    state.deliveryLoading = false;
    renderDeliveryInbox();
  }

  async function mergeDeliveryItem(button) {
    const pipelineId = String(button?.dataset?.pipelineId || '');
    const pullRequestNumber = Number(button?.dataset?.prNumber);
    const expectedHeadSha = String(button?.dataset?.headSha || '').toLowerCase();
    const item = state.delivery?.items?.find((candidate) => candidate.pipelineId === pipelineId);
    if (!/^\d{4}$/.test(pipelineId) || !Number.isInteger(pullRequestNumber) || !/^[a-f0-9]{40}$/.test(expectedHeadSha)) return;
    if (state.deliveryError || state.deliveryLoading || state.deliveryMerging) return;
    if (item?.stage !== 'pr_ready_to_merge' || item?.gate?.ready !== true) return;
    const confirmed = window.confirm(
      `Merge exact PR #${pullRequestNumber} at ${expectedHeadSha}?\n\n` +
      'Pipeline will revalidate the accepted task, exact PR and SHA, sealed receipt, required green CI jobs, and GitHub mergeability. After GitHub confirms the merge, the separate protected deployment workflow starts automatically.'
    );
    if (!confirmed) return;

    state.deliveryMerging = pipelineId;
    renderDeliveryInbox();
    try {
      const payload = await fetchJson('/api/runtime-bridges/coding-delivery/merge', {
        method: 'POST',
        body: JSON.stringify({
          pipelineId,
          pullRequestNumber,
          expectedHeadSha,
          confirmation: `MERGE PR #${pullRequestNumber} @ ${expectedHeadSha}`
        })
      });
      const mergeSha = payload?.data?.mergeCommitSha;
      toast('success', `PR #${pullRequestNumber} merged${mergeSha ? ` at ${String(mergeSha).slice(0, 12)}` : ''}; protected deployment dispatched.`);
    } catch (error) {
      toast('error', error.message || String(error));
    } finally {
      state.deliveryMerging = null;
      await loadTasks({ silent: true });
    }
  }

  function renderDispatchControl() {
    window.PipelineWorkerMonitor?.render({ $, controller: state.launchController, task: state.drawer?.task });
    const detail = $('pipelineTeamLaunchDetail');
    const select = $('pipelineTeamLaunchTask');
    const confirm = $('pipelineTeamLaunchConfirm');
    const button = $('pipelineTeamLaunchButton');
    const controller = state.launchController;
    if (!detail || !select || !confirm || !button) return;
    const control = controller?.control;
    const candidates = control?.candidates || [];
    const pending = controller?.pending;
    const selected = pending ? '' : select.value;
    const options = '<option value="">' + (candidates.length ? 'Choose a task…' : 'No task is currently eligible') + '</option>'
      + candidates.map(task => `<option value="${escapeHtml(task.pipelineId)}">${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title)}</option>`).join('');
    if (select.dataset.options !== options) { select.innerHTML = options; select.dataset.options = options; }
    const candidate = candidates.find(task => task.pipelineId === selected);
    select.value = candidate ? selected : '';
    const identity = candidate ? JSON.stringify([candidate.pipelineId, candidate.expectedAttemptCount, candidate.title]) : '';
    if (select.dataset.candidate !== identity) confirm.checked = false;
    select.dataset.candidate = identity;
    const ready = control?.available === true && !control.busy && !pending && !controller?.submitting && !controller?.checking && !controller?.error;
    select.disabled = !ready || !candidates.length;
    $('pipelineTeamLaunchForm')?.querySelectorAll('[name=reportName], [name=modelCallLimit]').forEach(field => { field.disabled = !ready; });
    confirm.disabled = !ready || !select.value;
    // A status read temporarily disables launch, but does not erase consent for
    // the same selection. A busy host, changed candidate or error clears it.
    if (!select.value || control?.busy || pending || controller?.submitting || controller?.error || !control?.available) confirm.checked = false;
    button.disabled = !ready || !select.value || !confirm.checked;
    const availability = $('pipelineTeamLaunchAvailability');
    if (availability) {
      availability.dataset.tone = controller?.error || control?.available === false ? 'unavailable' : ready ? 'ready' : 'loading';
      availability.textContent = controller?.error ? 'Availability could not be verified. Check the execution monitor.'
        : !control ? 'Checking launch availability…'
          : !control.available ? 'The launch host is unavailable.'
            : pending || control.busy ? 'A run is already active. Follow it in the execution monitor.'
              : candidates.length ? `${candidates.length} eligible task${candidates.length === 1 ? '' : 's'} · choose one to run`
                : 'No eligible task. Check task scope and admission conditions below.';
    }
    const selection = $('pipelineTeamLaunchSelection');
    if (selection) { selection.hidden = !select.value; selection.dataset.pipelineTask = select.value; }
    button.innerHTML = controller?.submitting
      ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Submitting request</span>'
      : '<i class="fas fa-play" aria-hidden="true"></i><span>Run one task</span>';
    const run = pending && (control?.run?.requestId !== pending.requestId || (control?.run?.pipelineId && control.run.pipelineId !== pending.pipelineId)) ? null : control?.run;
    const summary = control?.summary;
    const admission = $('pipelineTeamAdmissionDetail');
    const admissionText = summary
      ? `${summary.eligibleTasks} of ${summary.queuedTasks} queued tasks eligible for this worker · ${summary.privateQueuedTasks} personal/household tasks outside its scope. Only unassigned, non-private agentx-coding tasks can start. Board filters do not change this list.`
      : 'The host checks task status, ownership, coding service and private lane before launch.';
    if (admission) admission.textContent = admissionText;
    detail.textContent = admissionText;
    const result = $('pipelineTeamLaunchResult');
    if (result) {
      result.hidden = !run && !pending;
      result.innerHTML = run
        ? `<strong>${escapeHtml(run.message || formatStatus(run.phase))}</strong>${window.PipelineEvidenceReferences?.launchMarkup(run) || ''}${run.task ? `<span>Task ${escapeHtml(run.task.pipelineId)}: ${escapeHtml(formatStatus(run.task.status))} · ${escapeHtml(run.task.automationAttemptCount || 0)} recorded attempt(s).</span>` : ''}${run.pipelineId ? `<button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(run.pipelineId)}">Open task dossier</button>` : ''}`
        : pending ? `<strong>Checking request for task ${escapeHtml(pending.pipelineId)}. Acknowledgement does not prove that the task has been claimed.</strong>` : '';
    }
    const retry = $('pipelineTeamLaunchRetry');
    if (retry) {
      retry.hidden = !pending || !(run?.phase === 'not_received' || run?.canRetry === true);
      retry.disabled = !controller?.canRetry();
    }
    let cancel = $('pipelineTeamLaunchCancel');
    if (!cancel && retry) {
      cancel = document.createElement('button');
      cancel.id = 'pipelineTeamLaunchCancel'; cancel.type = 'button'; cancel.className = 'pipeline-btn compact';
      cancel.textContent = 'Cancel capacity wait';
      cancel.addEventListener('click', () => state.launchController?.cancel());
      retry.after(cancel);
    }
    if (cancel) { cancel.hidden = run?.phase !== 'waiting'; cancel.disabled = !controller?.canCancel(); }
    const reasons = $('pipelineTeamEligibilityReasons');
    if (reasons) reasons.innerHTML = !control || controller?.error
      ? '<p>Admission conditions are unavailable. Refresh execution to check again.</p>'
      : (control.excluded || []).map(task => `<div class="pipeline-launch-exclusion"><button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(task.pipelineId)}">${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title)}</button><p>${(task.reasons || []).map(reason => escapeHtml(reason.detail || reason.code)).join(' · ')}</p></div>`).join('') || '<p>No additional non-private queue exclusions in the current observation.</p>';
  }

  async function loadDispatchControlStatus() {
    return state.launchController?.refresh();
  }

  async function launchOneTask() {
    const pipelineId = String($('pipelineTeamLaunchTask')?.value || '');
    if ($('pipelineTeamLaunchConfirm')?.checked !== true || !state.launchController?.canLaunch(pipelineId)) return;
    let profile;
    try { profile = window.PipelineLaunchController.fromForm($('pipelineTeamLaunchForm')); }
    catch (error) { toast('error', error.message); return; }
    const launch = state.launchController.launch(pipelineId, profile);
    const monitor = $('pipelineExecution');
    monitor?.scrollIntoView({ block: 'start', behavior: 'auto' });
    monitor?.focus({ preventScroll: true });
    await launch;
  }

  // ---------------------------------------------------------------------------
  // Global state strip + counts
  // ---------------------------------------------------------------------------

  window.PipelineDelivery = {
    create(deps) {
      ({ escapeHtml, $, state, formatDate, DELIVERY_STAGE_META, readProjection, fetchJson, toast, loadTasks, formatStatus, inferenceSummary } = deps);
      return { loadDeliveryStatus, mergeDeliveryItem, renderDispatchControl, loadDispatchControlStatus, launchOneTask, bindDeliveryNavigation };
    }
  };
})();
