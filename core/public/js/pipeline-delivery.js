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

  function renderDeliveryInbox() {
    const statusEl = $('pipelineDeliveryState');
    const list = $('pipelineDeliveryList');
    const count = $('pipelineDeliveryHumanCount');
    const meta = $('pipelineDeliveryMeta');
    if (!statusEl || !list) return;

    if (state.deliveryError) {
      statusEl.dataset.tone = 'unavailable';
      statusEl.innerHTML = `<i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>Delivery inbox unavailable: ${escapeHtml(state.deliveryError)}</span>`;
      if (count) count.textContent = '--';
      if (!state.delivery) {
        list.innerHTML = '<div class="pipeline-empty">The task queue remains available. Delivery evidence is unavailable. <button type="button" class="pipeline-btn compact" data-retry-delivery>Retry evidence</button></div>';
        $('pipelineDeliveryHistoryMeta').textContent = 'Delivery history unavailable';
        $('pipelineDeliveryHistoryList').innerHTML = '<div class="pipeline-empty">No production conclusion can be drawn from this failed request.</div>';
        return;
      }
      statusEl.innerHTML += `<span>Last observation retained from ${escapeHtml(formatDate(state.delivery.observedAt))}; merge controls disabled.</span>`;
    }
    if (!state.delivery) {
      if (state.deliveryLoading) {
        statusEl.dataset.tone = 'loading';
        statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Loading delivery evidence independently…</span>';
      }
      return;
    }

    const items = Array.isArray(state.delivery.items) ? state.delivery.items : [];
    const humanActions = Number(state.delivery.counts?.humanActionRequired) || 0;
    const readyToMerge = Number(state.delivery.counts?.readyToMerge) || 0;
    if (!state.deliveryError) {
      statusEl.dataset.tone = humanActions ? 'attention' : 'ready';
      statusEl.innerHTML = humanActions
        ? `<i class="fas fa-bell" aria-hidden="true"></i><span><strong>${humanActions}</strong> human action${humanActions === 1 ? '' : 's'} pending · ${readyToMerge} exact PR${readyToMerge === 1 ? '' : 's'} ready to merge</span>`
        : '<i class="fas fa-circle-check" aria-hidden="true"></i><span>No human delivery decision is waiting. Active PR, CI, and deployment states remain visible below.</span>';
      if (count) count.textContent = state.deliveryLoading ? '…' : String(humanActions);
      if (state.deliveryLoading) statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>Refreshing delivery evidence · previous observation retained.</span>';
    }
    if (meta) {
      const observed = state.delivery.observedAt ? formatDate(state.delivery.observedAt) : 'unknown';
      meta.textContent = `Observed ${observed} · Merge always requires one explicit operator click. Deployment and live production proof remain separate.`;
    }


    const active = items.filter((item) => item.stage !== 'deployed');
    const completed = items.filter((item) => item.stage === 'deployed');
    list.innerHTML = active.length ? active.map(renderDeliveryCard).join('')
      : '<div class="pipeline-empty"><i class="fas fa-circle-check" aria-hidden="true"></i> No active delivery or human decision. Completed deliveries remain in History.</div>';
    const expanded = [...document.querySelectorAll('[data-delivery-record][open]')].map((el) => el.dataset.deliveryRecord);
    $('pipelineDeliveryHistoryMeta').textContent = `${state.deliveryError ? 'Stale observation · ' : ''}${completed.length} completed deliveries · observed ${formatDate(state.delivery.observedAt)} · independent of the attempt window and board filters`;
    $('pipelineDeliveryHistoryList').innerHTML = completed.length ? completed.map((item) => `
      <details class="pipeline-delivery-record" data-delivery-record="${escapeHtml(item.pipelineId)}">
        <summary><span>${escapeHtml(item.pipelineId)} · ${escapeHtml(item.title)}</span><span class="pipeline-status pipeline-status-done">Production proven <i class="fas fa-chevron-down"></i></span></summary>
        ${renderDeliveryCard(item)}
      </details>`).join('') : '<div class="pipeline-empty">No completed production delivery in this observation.</div>';
    document.querySelectorAll('[data-delivery-record]').forEach((el) => { el.open = expanded.includes(el.dataset.deliveryRecord); });
  }

  function renderDeliveryCard(item) {
    const stage = DELIVERY_STAGE_META[item.stage] || { label: String(item.stage || 'Unknown delivery state'), icon: 'fa-circle-question', tone: 'failed' };
    const summary = item.summary || {};
    const pr = item.pullRequest || null;
    const ci = item.ci || null;
    const deployment = item.deployment || null;
    const gate = item.gate || null;
    const headSha = String(pr?.headSha || '');
    const merging = state.deliveryMerging === item.pipelineId;
    const mergeReady = !state.deliveryError && !state.deliveryLoading && item.stage === 'pr_ready_to_merge' && gate?.ready === true && /^[a-f0-9]{40}$/.test(headSha);
    const gates = gate ? [
      deliveryGate('Accepted task', gate.taskAccepted === true),
      deliveryGate('Exact PR', gate.exactPullRequest === true),
      deliveryGate('Exact SHA', gate.exactHead === true),
      deliveryGate('Sealed receipt', gate.sealedReceipt === true),
      deliveryGate('Required CI green', gate.ciGreen === true),
      deliveryGate('GitHub mergeable', gate.mergeable === true)
    ].join('') : '';
    const productionGate = deployment?.production?.available
      ? deliveryGate('Live production parity', deployment.status === 'succeeded')
      : '';
    const links = [
      deliveryLink(pr?.url, pr?.number ? `PR #${pr.number}` : 'Pull request', 'fa-code-pull-request'),
      deliveryLink(ci?.url, 'Exact CI run', 'fa-list-check'),
      deliveryLink(deployment?.url, 'Deployment run', 'fa-rocket')
    ].filter(Boolean).join('');
    return `
      <article class="pipeline-delivery-card tone-${escapeHtml(stage.tone)}">
        <div class="pipeline-delivery-card-head">
          <div class="pipeline-delivery-identity">
            <strong>${escapeHtml(item.pipelineId)} · ${escapeHtml(item.title || 'Untitled task')}</strong>
            <span>Attempt ${escapeHtml(item.attempt || '--')}${pr?.number ? ` · PR #${escapeHtml(pr.number)}` : ''}${headSha ? ` · <code>${escapeHtml(headSha.slice(0, 12))}</code>` : ''}</span>
          </div>
          <span class="pipeline-delivery-stage"><i class="fas ${escapeHtml(stage.icon)}" aria-hidden="true"></i>${escapeHtml(stage.label)}</span>
        </div>
        <dl class="pipeline-delivery-summary">
          <div><dt>What changes</dt><dd>${escapeHtml(summary.change || 'Unknown')}</dd></div>
          <div><dt>Tests &amp; proof</dt><dd>${escapeHtml(summary.tests || 'Unknown')}</dd></div>
          <div><dt>Risks</dt><dd>${escapeHtml(summary.risks || 'Unknown')}</dd></div>
          <div class="${summary.recommendation === 'CORRECT' ? 'recommend-correct' : 'recommend-merge'}"><dt>Recommendation</dt><dd>${escapeHtml(summary.recommendation || 'CORRECT')}</dd></div>
          <div><dt>Exact next action</dt><dd>${escapeHtml(summary.nextAction || 'Refresh exact evidence.')}</dd></div>
        </dl>
        ${gates || productionGate ? `<div class="pipeline-delivery-gates" aria-label="Protected delivery gates">${gates}${productionGate}</div>` : ''}
        <div class="pipeline-delivery-actions">
          <div class="pipeline-delivery-links">
            <button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(item.pipelineId)}"><i class="fas fa-folder-open" aria-hidden="true"></i><span>Open dossier</span></button>
            ${links}
          </div>
          ${mergeReady ? `<button type="button" class="pipeline-btn primary compact" data-delivery-merge data-pipeline-id="${escapeHtml(item.pipelineId)}" data-pr-number="${escapeHtml(pr.number)}" data-head-sha="${escapeHtml(headSha)}" ${merging ? 'disabled' : ''} title="Merge exact PR #${escapeHtml(pr.number)} at ${escapeHtml(headSha)} after revalidating every gate"><i class="fas ${merging ? 'fa-spinner fa-spin' : 'fa-code-merge'}" aria-hidden="true"></i><span>${merging ? 'Revalidating exact gate' : `Merge PR #${escapeHtml(pr.number)} · ${escapeHtml(headSha.slice(0, 8))}`}</span></button>` : ''}
        </div>
      </article>`;

  }


  async function loadDeliveryStatus() {
    state.deliveryError = null;
    state.deliveryLoading = true;
    renderDeliveryInbox();
    try {
      const payload = await readProjection('delivery', '/api/runtime-bridges/coding-delivery/status', 45000);
      if (!payload) return;
      if (!payload.data) throw new Error('status response is missing data');
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
    const stateEl = $('pipelineTeamLaunchState');
    const detail = $('pipelineTeamLaunchDetail');
    const select = $('pipelineTeamLaunchTask');
    const confirm = $('pipelineTeamLaunchConfirm');
    const button = $('pipelineTeamLaunchButton');
    const controller = state.launchController;
    if (!stateEl || !detail || !select || !confirm || !button) return;
    const control = controller?.control;
    const candidates = control?.candidates || [];
    const pending = controller?.pending;
    const selected = pending ? '' : select.value;
    select.innerHTML = '<option value="">' + (candidates.length ? 'Choose a task…' : 'No task is currently eligible') + '</option>'
      + candidates.map(task => `<option value="${escapeHtml(task.pipelineId)}">${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title)}</option>`).join('');
    if (candidates.some(task => task.pipelineId === selected)) select.value = selected;
    const ready = control?.available === true && !control.busy && !pending && !controller?.submitting && !controller?.checking && !controller?.error;
    select.disabled = !ready || !candidates.length;
    confirm.disabled = !ready || !select.value;
    if (confirm.disabled) confirm.checked = false;
    button.disabled = !ready || !select.value || !confirm.checked;
    button.innerHTML = controller?.submitting
      ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Submitting request</span>'
      : '<i class="fas fa-play" aria-hidden="true"></i><span>Run one task</span>';
    const run = pending && control?.run?.requestId !== pending.requestId ? null : control?.run;
    if (controller?.error) {
      stateEl.dataset.tone = 'unavailable';
      stateEl.textContent = controller.error;
    } else if (!control || controller.checking) {
      stateEl.dataset.tone = 'loading';
      stateEl.textContent = 'Checking current host admission and request status…';
    } else if (!control.available) {
      stateEl.dataset.tone = 'unavailable';
      stateEl.textContent = 'The one-shot host is unavailable.';
    } else if (pending || control.busy) {
      stateEl.dataset.tone = 'loading';
      stateEl.textContent = run ? `Request ${run.pipelineId || pending?.pipelineId || ''} · ${formatStatus(run.phase)}` : `Submitting request for ${pending?.pipelineId || 'one task'}…`;
    } else {
      stateEl.dataset.tone = 'ready';
      stateEl.textContent = 'Host observed · one local coding worker';
    }
    const summary = control?.summary;
    detail.textContent = summary
      ? `${summary.eligibleTasks} of ${summary.queuedTasks} queued tasks eligible for this worker · ${summary.privateQueuedTasks} personal/household tasks outside its scope. Only unassigned, non-private agentx-coding tasks can start. Board filters do not change this list.`
      : 'The host checks task status, ownership, coding service and private lane before launch.';
    if (control?.inference && !controller?.error && !controller?.checking && control.available) {
      stateEl.textContent = `Task ${control.inference.pipelineId} · ${inferenceSummary(control.inference)}`;
      detail.textContent = `Task attempt ${control.inference.attempt} · ${control.inference.requestCount} model call(s). Inference retries keep this attempt and never replay worker tools.`;
    }
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
    if (reasons) reasons.innerHTML = (control?.excluded || []).map(task => `<div class="pipeline-launch-exclusion"><button type="button" class="pipeline-btn compact" data-pipeline-task="${escapeHtml(task.pipelineId)}">${escapeHtml(task.pipelineId)} · ${escapeHtml(task.title)}</button><p>${(task.reasons || []).map(reason => escapeHtml(reason.detail || reason.code)).join(' · ')}</p></div>`).join('') || '<p>No additional non-private queue exclusions in the current observation.</p>';
  }

  async function loadDispatchControlStatus() {
    return state.launchController?.refresh();
  }

  async function launchOneTask() {
    const pipelineId = String($('pipelineTeamLaunchTask')?.value || '');
    if ($('pipelineTeamLaunchConfirm')?.checked !== true || !state.launchController?.canLaunch(pipelineId)) return;
    await state.launchController.launch(pipelineId);
  }

  // ---------------------------------------------------------------------------
  // Global state strip + counts
  // ---------------------------------------------------------------------------

  window.PipelineDelivery = {
    create(deps) {
      ({ escapeHtml, $, state, formatDate, DELIVERY_STAGE_META, readProjection, fetchJson, toast, loadTasks, formatStatus, inferenceSummary } = deps);
      return { loadDeliveryStatus, mergeDeliveryItem, renderDispatchControl, loadDispatchControlStatus, launchOneTask };
    }
  };
})();
