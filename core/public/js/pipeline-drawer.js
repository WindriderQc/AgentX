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
      draft.fields.push(...(state.drawer.draft?.fields || []).filter(field => !currentKeys.has(field.key)));
    }
    state.drawer.draft = draft;

    const feedback = Array.isArray(task.feedback) ? task.feedback.slice().reverse() : [];
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    const reviewer = readStorage(STORAGE_REVIEWER) || '';
    const review = reviewContext(task);
    const deliveryItem = Array.isArray(state.delivery?.items)
      ? state.delivery.items.find((item) => item?.pipelineId === task.pipelineId)
      : null;
    const closedUnmergedDelivery = task.status === 'done'
      && deliveryItem?.stage === 'merge_blocked'
      && String(deliveryItem?.pullRequest?.state || '').toLowerCase() === 'closed';

    const actions = [];
    const codingTask = !['personal', 'family', 'household', 'secretary'].includes(String(task.service).toLowerCase());
    if (task.status === 'queued' && !task.assignee && codingTask) {
      actions.push(`<form class="pipeline-drawer-action" data-drawer-action="give-to-team">
        <p>Describe the result in this ticket. The team prepares the work and returns any question here.</p>
        <button type="submit" class="pipeline-btn primary">Give to the team</button></form>`);
    }
    if (task.status === 'blocked' && codingTask && (!task.assignee || task.automation?.mode === 'review_only')) {
      actions.unshift(`<form class="pipeline-drawer-action" data-drawer-action="reply-resume">
        <label><span>Your answer or correction</span><textarea name="answer" rows="4" maxlength="3000" required placeholder="Answer the question or explain what should change."></textarea></label>
        <button type="submit" class="pipeline-btn primary">Reply and resume</button>
      </form>`);
    }
    if (task.status === 'review') {
      actions.push(`
        <form class="pipeline-drawer-action" data-drawer-action="confirm-done">
          <label>
            <span>Accept result as (must differ from worker <code>${escapeHtml(task.assignee || 'unassigned')}</code>)</span>
            <input type="text" name="by" required maxlength="80" placeholder="your identity, e.g. reviewer" value="${escapeHtml(reviewer)}">
          </label>
          <button type="submit" class="pipeline-btn primary compact"><i class="fas fa-check-double"></i><span>Accept result</span></button>
        </form>
      `);
    }
    if (task.status === 'review' || closedUnmergedDelivery) {
      const correctionDetail = closedUnmergedDelivery
        ? `PR #${deliveryItem.pullRequest.number} is closed without merge. Record the required replacement, release the accepted result, and return this exact task to the guarded queue.`
        : 'Record a precise reason, release the claim, and return this exact task to the guarded queue.';
      actions.push(`
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
        </form>
      `);
    }
    if (['in_progress', 'blocked'].includes(task.status)) {
      actions.push(`
        <details><summary>Release worker claim</summary><div class="pipeline-drawer-action">
          <p>Release the task back to the queue. The worker claim and heartbeat are cleared.</p>
          <button type="button" class="pipeline-btn compact" data-drawer-action="requeue"><i class="fas fa-rotate-left"></i><span>Re-queue task</span></button>
        </div></details>
      `);
    }
    if (task.status !== 'done') {
      // Supersede is a two-step human decision: preview the exact transition
      // and its checks first (no mutation), then confirm or cancel.
      actions.push(`
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
      actions.push(`
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
    body.innerHTML = `
      <div class="pipeline-drawer-status">${statusBadge(task.status)} ${priorityChip(task.priority)} ${riskChip(task.risk)}${resolution ? ` <span class="pipeline-chip pipeline-chip-superseded" title="${escapeHtml(resolution.reason || '')}"><i class="fas fa-code-branch" aria-hidden="true"></i> Superseded by <a href="/pipeline?task=${encodeURIComponent(resolution.supersededBy)}">#${escapeHtml(resolution.supersededBy)}</a></span>` : ''}</div>
      ${feedback.length ? `<section class="pipeline-drawer-section"><h3>${task.status === 'blocked' ? 'Your team needs an answer' : 'Latest update'}</h3><p class="pipeline-drawer-spec">${escapeHtml(latestTeamUpdate(task))}</p></section>` : ''}
      ${task.spec ? `<section class="pipeline-drawer-section">${task.status === 'blocked' ? '<details><summary>Requested result</summary>' : '<h3>Requested result</h3>'}<pre class="pipeline-drawer-spec">${escapeHtml(task.spec)}</pre>${task.status === 'blocked' ? '</details>' : ''}</section>` : ''}
      <section class="pipeline-drawer-section"><h3>Next action</h3>
        <p class="pipeline-drawer-spec"><strong>${escapeHtml(review.label)}</strong><br>${escapeHtml(review.detail)}<br>${escapeHtml(review.action)}</p>
      ${actions.join('')}</section>${window.PipelineEligibility?.markup(task) || ''}${window.PipelineStallDiagnosis?.markup(task) || ''}
      <div class="pipeline-drawer-action-row">
        <button type="button" class="pipeline-btn compact" data-copy-task-link="${escapeHtml(task.pipelineId)}" title="Copy the direct link to this task dossier"><i class="fas fa-link" aria-hidden="true"></i><span>Copy task link</span></button>
        <button type="button" class="pipeline-btn compact" data-edit-pipeline-task="${escapeHtml(task.pipelineId)}" title="Edit this task"><i class="fas fa-pen" aria-hidden="true"></i><span>Edit task</span></button>
      </div>
      ${resolution ? `<div class="pipeline-drawer-resolution"><strong>Superseded</strong> by <code>${escapeHtml(resolution.supersededBy)}</code> · ${escapeHtml(resolution.by || 'operator')} · ${escapeHtml(formatDate(resolution.at))}<br>${escapeHtml(resolution.reason || '')}<br><span class="pipeline-muted">Closed without delivery. Reopening requires an explicit decision; it never re-queues by itself.</span></div>` : ''}
      <details><summary>Task details</summary><dl class="pipeline-drawer-meta">
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
      ${window.PipelinePlan?.markup(task) || ''}${renderAttemptDossier(task)}${window.PipelineEvidenceReferences?.markup(task, { launchRun: state.launchController?.control?.run, deliveryItems: state.deliveryError ? undefined : state.delivery?.items }) || ''}${window.PipelineDeliverables?.markup(task) || ''}
      <section class="pipeline-drawer-section">
        <h3><i class="fas fa-timeline" aria-hidden="true"></i> Audit trail <span class="pipeline-drawer-count">${feedback.length}</span></h3>
        ${feedback.length ? `
          <ol class="pipeline-drawer-feedback">
            ${feedback.map((entry) => `
              <li>
                <header><strong>${escapeHtml(entry.by || 'agent')}</strong><time>${escapeHtml(formatDate(entry.at))}</time></header>
                <p>${escapeHtml(entry.text || '')}</p>
              </li>
            `).join('')}
          </ol>` : '<div class="pipeline-empty">No feedback recorded yet.</div>'}
      </section>
    `;
    if (draft) restoreDrawerDraft(body, draft);
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
