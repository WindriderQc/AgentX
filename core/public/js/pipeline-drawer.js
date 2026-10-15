/* Pipeline task drawer rendering. pipeline.js creates it with its shared
   state and helpers and keeps opening, refresh and actions. */
(function () {
  'use strict';
  let drawerEls, preserveDrawerDraft, state, readStorage, STORAGE_REVIEWER, reviewContext, escapeHtml, renderSupersedePreview, statusBadge, priorityChip, riskChip, latestTeamUpdate, formatDate, metaRow, relativeTime, renderAttemptDossier, restoreDrawerDraft;

  function renderDrawer(task, { preserveDraft = false } = {}) {
    const { title, id, body } = drawerEls();
    if (title) title.textContent = task.title || 'Untitled task';
    if (id) id.textContent = `#${task.pipelineId}`;
    if (!body) return;
    const draft = preserveDraft ? preserveDrawerDraft(body) : null;
    if (draft) {
      const currentKeys = new Set(draft.fields.map(field => field.key));
      draft.fields.push(...(state.drawer.draft?.fields || []).filter(field => !field.contextBound && !currentKeys.has(field.key)));
    }
    state.drawer.draft = draft;

    const feedback = Array.isArray(task.feedback) ? task.feedback.slice().reverse() : [];
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    const reviewer = readStorage(STORAGE_REVIEWER) || '';
    const review = reviewContext(task);
    const report = window.PipelineLaunchController?.currentReport(task);
    const profileContext = escapeHtml(window.PipelineLaunchController?.profileContext(task) || '');
    const deliveryItem = Array.isArray(state.delivery?.items)
      ? state.delivery.items.find((item) => item?.pipelineId === task.pipelineId)
      : null;
    const closedUnmergedDelivery = task.status === 'done'
      && deliveryItem?.stage === 'merge_blocked'
      && String(deliveryItem?.pullRequest?.state || '').toLowerCase() === 'closed';

    const actions = [];
    const secondaryActions = [];
    const reportRun = state.launchController?.control?.run;
    if (reportRun?.pipelineId === task.pipelineId && reportRun.reportName && reportRun.phase === 'unknown') {
      actions.push(`<div class="pipeline-drawer-action"><p>The original report outcome needs reconciliation before another execution.</p>
        <button type="button" class="pipeline-btn compact" data-drawer-action="reconcile-report"${state.launchController.canReconcile?.() ? '' : ' disabled'}>Reconcile saved report</button></div>`);
    }
    const qualification = task.codingAutonomy?.disposition?.kind === 'qualification' ? task.codingAutonomy.disposition : null;
    const codingTask = !/^\s*(personal|family|household|secretary)\s*$/i.test(String(task.service || ''))
      && !/^\s*(idea-drop\s*$|household-)/i.test(String(task.source || ''));
    const outcomeApi = window.PipelineWorkerOutcome;
    const workerControl = state.drawer.workerError ? null : state.drawer.workerControl || (state.launchController?.error ? null : state.launchController?.control);
    const workerOutcome = !qualification && (outcomeApi?.latest(task) || outcomeApi?.native(task, workerControl));
    const stopped = task.status === 'blocked' ? outcomeApi?.describe(workerOutcome) : null;
    const resumeWorker = outcomeApi?.canResume(task, workerControl);
    const managed = Boolean(task.codingAutonomy || task.automation?.mode === 'review_only' || task.automationAttemptCount > 0 || task.automationAttempts?.length);
    const canReply = !managed && !qualification && task.status === 'blocked' && codingTask && (!task.assignee || resumeWorker);
    if (!qualification && managed && ['queued', 'blocked'].includes(task.status)) {
      actions.push('<p class="pipeline-drawer-context">This task uses the existing Coding Team correction loop. Review its authorization and resume through the Coding Team controls.</p>');
    }
    if (!managed && !qualification && task.status === 'queued' && !task.assignee && codingTask) {
      actions.push(`<form class="pipeline-drawer-action" data-drawer-action="give-to-team" data-profile-context="${profileContext}">
        ${window.PipelineLaunchController?.profileFields(task) || ''}
        <button type="submit" class="pipeline-btn primary">Give to the team</button></form>`);
    }
    if (canReply) {
      actions.unshift(`<form class="pipeline-drawer-action" data-drawer-action="reply-resume" data-profile-context="${profileContext}">
        ${window.PipelineLaunchController?.profileFields(task) || ''}
        <label><span>Updated instructions or your answer</span><textarea name="answer" rows="4" maxlength="3000" required placeholder="Describe what the next pass must do and save."></textarea></label>
        <button type="submit" class="pipeline-btn primary">Update instructions and resume</button>
      </form>`);
    }
    if (!qualification && task.status === 'blocked' && codingTask && task.assignee === 'coding-team' && !resumeWorker && workerOutcome) {
      actions.unshift(`<div class="pipeline-drawer-action"><p>Check the original worker status before resuming this task.</p>${state.drawer.workerError ? `<p class="pipeline-error">${escapeHtml(state.drawer.workerError)}</p>` : ''}<button type="button" class="pipeline-btn compact" data-drawer-action="refresh-worker">Check worker status</button></div>`);
    }
    if (!qualification && task.status === 'review') {
      actions.push(`
        <form class="pipeline-drawer-action" data-drawer-action="confirm-done" data-report-context="${escapeHtml(report ? `${report.requestId}:${report.sha256}` : '')}">
          <label>
            <span>Accept result as (must differ from worker <code>${escapeHtml(task.assignee || 'unassigned')}</code>)</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. reviewer" value="${escapeHtml(reviewer)}">
          </label>
          ${report && report.kind !== 'blocked' ? '<label><input type="checkbox" name="reportScopeComplete" required> I reviewed this report and confirm it covers the complete requested scope.</label>' : ''}
          <button type="submit" class="pipeline-btn primary compact"><i class="fas fa-check-double"></i><span>Accept result</span></button>
        </form>
      `);
    }
    if (!qualification && (task.status === 'review' || closedUnmergedDelivery)) {
      const correctionDetail = closedUnmergedDelivery
        ? `PR #${deliveryItem.pullRequest.number} is closed without merge. Record the required replacement, release the accepted result, and return this exact task to the guarded queue.`
        : 'Record a precise reason, release the claim, and return this exact task to the guarded queue.';
      actions.push(`
        <details class="pipeline-drawer-correction"${closedUnmergedDelivery ? ' open' : ''}><summary>Request a correction</summary>
        <form class="pipeline-drawer-action" data-drawer-action="request-correction">
          <p><strong>Request a correction</strong><br>${escapeHtml(correctionDetail)}</p>
          <label>
            <span>Reviewer identity</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. reviewer" value="${escapeHtml(reviewer)}">
          </label>
          <label>
            <span>Correction required</span>
            <textarea name="reason" rows="3" maxlength="5000" required placeholder="What exact evidence or implementation must change?"></textarea>
          </label>
          <button type="submit" class="pipeline-btn compact"><i class="fas fa-rotate-left"></i><span>Request correction</span></button>
        </form></details>
      `);
    }
    if (!qualification && ['in_progress', 'blocked'].includes(task.status)) {
      secondaryActions.push(`
        <details><summary>Release worker claim</summary><div class="pipeline-drawer-action">
          <p>Release the task back to the queue. The worker claim and heartbeat are cleared.</p>
          <button type="button" class="pipeline-btn compact" data-drawer-action="requeue"><i class="fas fa-rotate-left"></i><span>Re-queue task</span></button>
        </div></details>
      `);
    }
    if (!qualification && task.status !== 'done') {
      // Supersede is a two-step human decision: preview the exact transition
      // and its checks first (no mutation), then confirm or cancel.
      secondaryActions.push(`
        <details><summary>Replace this task</summary><form class="pipeline-drawer-action" data-drawer-action="supersede-preview">
          <p><strong>Mark superseded</strong><br>Close this task in favour of its replacement. Nothing is re-queued; the decision is written to both audit trails and the task can only be reopened deliberately.</p>
          <label>
            <span>Replaced by (pipeline id)</span>
            <input type="text" name="supersededBy" required maxlength="16" pattern="[0-9A-Za-z_-]+" placeholder="e.g. 0620" value="${escapeHtml(state.drawer.supersede?.supersededBy || '')}">
          </label>
          <label>
            <span>Reason</span>
            <textarea name="reason" rows="2" maxlength="2000" minlength="8" required placeholder="Why this task no longer applies and what replaces it">${escapeHtml(state.drawer.supersede?.reason || '')}</textarea>
          </label>
          <label>
            <span>Decided by</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. reviewer" value="${escapeHtml(reviewer)}">
          </label>
          <button type="submit" class="pipeline-btn compact"><i class="fas fa-code-branch"></i><span>Preview supersede</span></button>
        </form>
        ${renderSupersedePreview(task)}</details>
      `);
    }
    if (task.status !== 'done') {
      secondaryActions.push(`
        <details><summary>Add a note</summary><form class="pipeline-drawer-action" data-drawer-action="add-note">
          <label>
            <span>Add a note to the audit trail</span>
            <textarea name="text" rows="2" maxlength="5000" required placeholder="What should workers and human reviewers know?"></textarea>
          </label>
          <button type="submit" class="pipeline-btn compact"><i class="fas fa-pen"></i><span>Add note</span></button>
        </form></details>
      `);
    }
    const resolution = task.resolution && task.resolution.kind === 'superseded' ? task.resolution : null;
    const mode = qualification ? 'archive' : ['queued', 'in_progress', 'blocked', 'review', 'done'].includes(task.status) ? task.status : 'unknown';
    const nextStepTitles = {
      observe_progress: 'Nothing to decide right now',
      human_review: 'Your decision',
      inspect_blocker: canReply ? 'Your answer' : 'Your attention is needed',
      inspect_worker: 'Check the worker before intervening',
      inspect_owner: 'Check who owns this task',
      inspect_dependencies: 'Check the dependencies',
      await_claim: 'Launch this task',
      wait_not_before: 'Wait for the planned start',
      wait_coding_capacity: 'Follow the current launch request',
      review_due_date: 'Review the overdue task',
      none: 'Task closed',
      qualification_archived: 'For reference',
    };
    const nextStepCopy = {
      observe_progress: 'The worker owns the next step.',
      human_review: 'Accept the result or request a correction. Merge and deployment remain separate.',
      inspect_blocker: canReply ? 'Read the problem above before sending your answer.' : 'Check the recorded work and execution before retrying.',
      await_claim: 'Check the request before handing it to the team.',
      none: 'Merge and deployment are tracked separately.',
    };
    const messageEntry = mode === 'blocked'
      ? feedback.find(entry => ['coding-team', 'guarded-dispatch', task.assignee].includes(entry.by)) || feedback[0] : feedback[0];
    const resultLink = window.PipelineEvidenceReferences?.resultLink?.(task, state.deliveryError ? undefined : state.delivery?.items) || '';
    const resultChange = resultLink && ['review', 'done'].includes(mode) ? deliveryItem?.summary?.change : '';
    const headings = { queued: 'Requested result', in_progress: 'Latest update', blocked: 'What is blocking this task?',
      review: 'Result to review', done: resolution ? 'Replaced task' : 'Recorded result',
      archive: `Archived qualification · ${qualification?.outcome || ''}`, unknown: 'Task state unavailable' };
    const mainText = mode === 'queued' ? task.spec || 'No requested result is recorded yet. Use Edit task to describe what you need.'
      : mode === 'archive' ? qualification.reason || 'Consult the original qualification receipt.'
      : resolution ? resolution.reason
      : resultChange && ['review', 'done'].includes(mode) ? resultChange
      : mode === 'review' && String(messageEntry?.text || '').startsWith('Dispatcher independent verification: PASS') ? 'The worker submitted the result for review.'
      : stopped ? `${stopped.detail}\n\n${stopped.facts}`
      : messageEntry ? latestTeamUpdate(task)
      : mode === 'blocked' ? 'No blocking reason has been recorded.'
      : mode === 'in_progress' ? 'No progress update has been recorded yet.'
      : mode === 'unknown' ? 'Refresh the task before making a decision.' : 'No work summary has been recorded.';
    const latestAttempt = (Array.isArray(task.automationAttempts) ? task.automationAttempts : [])
      .reduce((latest, attempt) => !latest || Number(attempt.attempt) > Number(latest.attempt) ? attempt : latest, null);
    const verification = latestAttempt?.evidence?.schema && latestAttempt.completedAt ? latestAttempt.evidence.verification : null;
    const attemptDossier = renderAttemptDossier(task);
    body.innerHTML = `
      <div class="pipeline-drawer-overview">
        <div class="pipeline-drawer-status">${statusBadge(task.status)} ${priorityChip(task.priority)} ${riskChip(task.risk)}${resolution ? ` <span class="pipeline-chip pipeline-chip-superseded" title="${escapeHtml(resolution.reason || '')}"><i class="fas fa-code-branch" aria-hidden="true"></i> Superseded by <a href="/pipeline?task=${encodeURIComponent(resolution.supersededBy)}">#${escapeHtml(resolution.supersededBy)}</a></span>` : ''}</div>
        <div class="pipeline-drawer-action-row">
          <button type="button" class="pipeline-btn compact" data-edit-pipeline-task="${escapeHtml(task.pipelineId)}"><i class="fas fa-pen" aria-hidden="true"></i><span>Edit task</span></button>
          <button type="button" class="pipeline-btn compact" data-copy-task-link="${escapeHtml(task.pipelineId)}" title="Copy the direct link to this task dossier"><i class="fas fa-link" aria-hidden="true"></i><span>Copy task link</span></button>
        </div>
      </div>
      <p class="pipeline-drawer-byline">${escapeHtml(task.assignee ? `Assigned to ${task.assignee}` : 'Not assigned')}${task.dueAt ? ` · Due ${escapeHtml(formatDate(task.dueAt))}` : ''}</p>
      <div class="pipeline-drawer-workspace" data-dossier-mode="${mode}">
        <div class="pipeline-drawer-content">
          <section class="pipeline-drawer-document${mode === 'blocked' ? ' needs-answer' : ''}" aria-labelledby="pipelineDrawerContentTitle">
            <h3 id="pipelineDrawerContentTitle">${escapeHtml(stopped ? stopped.title : headings[mode])}</h3>
            ${messageEntry && !['queued', 'archive'].includes(mode) && !resolution && !resultChange ? `<p class="pipeline-drawer-byline">${escapeHtml(messageEntry.by || 'Recorded message')}${messageEntry.at ? ` · ${escapeHtml(formatDate(messageEntry.at))}` : ''}</p>` : ''}
            <div class="pipeline-drawer-copy">${escapeHtml(mainText || '')}</div>
            ${mode === 'in_progress' ? `<p class="pipeline-drawer-signal">${task.heartbeatAt ? `Worker signal ${escapeHtml(relativeTime(task.heartbeatAt) || formatDate(task.heartbeatAt))}.` : 'No worker signal recorded.'} Progress is confirmed by work updates or results.</p>` : ''}
            ${['review', 'done', 'blocked'].includes(mode) && verification ? `<p class="pipeline-drawer-check">Recorded checks: <strong>${escapeHtml(verification.status || 'unknown')}</strong> · ${escapeHtml(formatDate(latestAttempt.completedAt))}</p>` : mode === 'review' ? '<p class="pipeline-drawer-context">No automated verification is recorded.</p>' : ''}
            ${mode === 'archive' ? '<p class="pipeline-drawer-context">Original outcomes and dependency barriers remain in force. This archive does not accept a product delivery or authorize another worker.</p>' : ''}
            ${resultLink && mode !== 'queued' ? `<div class="pipeline-drawer-result-link">${resultLink}</div>` : ''}
          </section>
          ${['in_progress', 'blocked', 'review', 'done'].includes(mode) ? window.PipelineDeliverables?.markup(task, { compact: true }) || '' : ''}
        </div>
        <section class="pipeline-drawer-section pipeline-drawer-next" aria-labelledby="pipelineDrawerNextTitle" data-attention="${review.actor === 'human' ? 'human' : 'follow-up'}">
          <h3 id="pipelineDrawerNextTitle">${escapeHtml(stopped ? stopped.requiresInspection ? 'Check original execution' : resumeWorker ? 'Update instructions and resume' : 'Check worker status' : closedUnmergedDelivery ? 'Correction needed' : nextStepTitles[review.code] || review.label)}</h3>
          <p class="pipeline-drawer-copy">${escapeHtml(stopped ? stopped.suggestion : closedUnmergedDelivery ? 'The PR closed without a merge. Record the correction needed.' : nextStepCopy[review.code] || review.action)}</p>
          ${state.drawer.actionError?.pipelineId === task.pipelineId ? `<p class="pipeline-error" role="alert" data-drawer-action-error>${escapeHtml(state.drawer.actionError.message)}</p>` : ''}
          ${actions.join('')}
        </section>
      </div>
      ${resolution ? `<div class="pipeline-drawer-resolution"><strong>Superseded</strong> by <code>${escapeHtml(resolution.supersededBy)}</code> · ${escapeHtml(resolution.by || 'operator')} · ${escapeHtml(formatDate(resolution.at))}<br>${escapeHtml(resolution.reason || '')}<br><span class="pipeline-muted">Closed without delivery. Reopening requires an explicit decision; it never re-queues by itself.</span></div>` : ''}
      ${mode !== 'queued' && task.spec ? `<details class="pipeline-drawer-original" data-drawer-section="request"><summary>Original request</summary><div class="pipeline-drawer-copy">${escapeHtml(task.spec)}</div></details>` : ''}
      <details class="pipeline-drawer-technical" data-drawer-section="technical"><summary>Technical details and history</summary>
      <div class="pipeline-drawer-section pipeline-drawer-support">
        <details class="pipeline-drawer-help" data-drawer-section="help"><summary>About this status and next step</summary><p><strong>${escapeHtml(review.label)}</strong></p><p>${escapeHtml(review.detail)}</p><p>${escapeHtml(review.action)}</p></details>
        ${window.PipelineEligibility?.markup(task) || ''}${window.PipelineStallDiagnosis?.markup(task) || ''}
      <details class="pipeline-drawer-disclosure"><summary>Task details</summary><dl class="pipeline-drawer-meta">
        ${metaRow('Owner', escapeHtml(task.assignee || 'unassigned'))}
        ${metaRow('Service', escapeHtml(task.service || '--'))}
        ${task.epic ? metaRow('Epic', escapeHtml(task.epic)) : ''}
        ${metaRow('Source', escapeHtml(task.source || '--'))}
        ${deps.length ? metaRow('Depends on', deps.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ')) : ''}
        ${task.dueAt ? metaRow('Due', escapeHtml(formatDate(task.dueAt))) : ''}
        ${task.notBefore ? metaRow('Not before', escapeHtml(formatDate(task.notBefore))) : ''}
        ${task.heartbeatAt ? metaRow('Heartbeat', escapeHtml(`${formatDate(task.heartbeatAt)} (${relativeTime(task.heartbeatAt)})`)) : ''}
        ${metaRow('Created', escapeHtml(formatDate(task.createdAt)))}
        ${metaRow('Updated', escapeHtml(`${formatDate(task.updatedAt)}${relativeTime(task.updatedAt) ? ` (${relativeTime(task.updatedAt)})` : ''}`))}
      </dl></details>
      ${window.PipelinePlan?.markup(task) || ''}${window.PipelineDeliverables?.markup(task) || ''}
      ${attemptDossier ? `<details class="pipeline-drawer-disclosure"><summary>Attempts and verification</summary>${attemptDossier}</details>` : ''}
      ${window.PipelineEvidenceReferences?.markup(task, { launchRun: state.launchController?.control?.run, deliveryItems: state.deliveryError ? undefined : state.delivery?.items }) || ''}
      <details class="pipeline-drawer-disclosure">
        <summary>Audit trail <span class="pipeline-drawer-count">${feedback.length}</span></summary>
        ${feedback.length ? `
          <ol class="pipeline-drawer-feedback">
            ${feedback.map((entry) => `
              <li>
                <header><strong>${escapeHtml(entry.by || 'agent')}</strong><time>${escapeHtml(formatDate(entry.at))}</time></header>
                <p>${escapeHtml(entry.text || '')}</p>
              </li>
            `).join('')}
          </ol>` : '<div class="pipeline-empty">No feedback recorded yet.</div>'}
      </details>
      ${secondaryActions.length ? `<details class="pipeline-drawer-disclosure pipeline-drawer-secondary"><summary>More task actions</summary><p class="pipeline-drawer-context">Optional notes and task management.</p><div class="pipeline-drawer-secondary-actions">${secondaryActions.join('')}</div></details>` : ''}
      </div></details>
    `;
    if (draft) restoreDrawerDraft(body, draft);
    window.PipelineWorkerMonitor?.render({ $: id => document.getElementById(id), controller: state.launchController, task });
    const unsentAnswer = draft?.fields.find(field => field.key === 'reply-resume:answer' && field.value.trim());
    if (unsentAnswer && !body.querySelector('form[data-drawer-action="reply-resume"]')) {
      const saved = document.createElement('section');
      saved.className = 'pipeline-drawer-section';
      saved.innerHTML = '<h3>Unsent answer preserved</h3><p>The task changed while you were writing. Your text is kept here for copying or a later reply.</p><pre class="pipeline-drawer-spec"></pre>';
      saved.querySelector('pre').textContent = unsentAnswer.value;
      body.prepend(saved);
    }
  }

  window.PipelineDrawer = {
    create(deps) {
      ({ drawerEls, preserveDrawerDraft, state, readStorage, STORAGE_REVIEWER, reviewContext, escapeHtml, renderSupersedePreview, statusBadge, priorityChip, riskChip, latestTeamUpdate, formatDate, metaRow, relativeTime, renderAttemptDossier, restoreDrawerDraft } = deps);
      return { renderDrawer };
    }
  };
})();
