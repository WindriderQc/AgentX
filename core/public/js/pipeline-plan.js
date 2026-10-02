(function () {
  'use strict';
  // Task plan revisions (agentx.pipeline-task-plan/v1) in the task dossier.
  // A task without a plan shows nothing: small tasks keep their short path.
  const SCHEMA = 'agentx.pipeline-task-plan/v1';
  const STORAGE_REVIEWER = 'agentx.pipeline.reviewer';
  const STATES = {
    undecided: 'Awaiting an optional review',
    approved: 'Approved',
    changes_requested: 'Changes requested',
    stale: 'Decision no longer current',
  };
  const DRIFT = { scope_changed: 'the automation scope changed', task_changed: 'the task request was edited' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const when = value => { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toLocaleString() : 'unknown time'; };
  function readReviewer() { try { return window.localStorage.getItem(STORAGE_REVIEWER) || ''; } catch { return ''; } }
  function saveReviewer(value) { try { window.localStorage.setItem(STORAGE_REVIEWER, value); } catch { /* optional */ } }

  function decisionForm(task, current) {
    return `<form class="pipeline-plan-decision" data-plan-decision="${esc(task.pipelineId)}" data-revision="${esc(current.revision)}" data-fingerprint="${esc(current.fingerprint)}">
      <p class="pipeline-muted">Optional. A decision applies to revision ${esc(current.revision)} only; approving it starts no work.</p>
      <label>Reviewer <input name="by" maxlength="120" autocomplete="name" required value="${esc(readReviewer())}"></label>
      <label>Reason (optional) <input name="reason" maxlength="500"></label>
      <div class="pipeline-plan-actions">
        <button type="submit" class="pipeline-btn compact" data-outcome="approved">Approve revision ${esc(current.revision)}</button>
        <button type="submit" class="pipeline-btn compact" data-outcome="changes_requested">Request changes</button>
      </div>
      <p class="pipeline-plan-message" data-plan-message role="alert" aria-live="assertive"></p>
    </form>`;
  }

  function markup(task) {
    const plan = task?.plan;
    if (!plan || plan.state === 'none') return '';
    if (plan.schema !== SCHEMA || !plan.current || !(plan.state in STATES)) {
      return '<section class="pipeline-plan"><p class="pipeline-plan-unknown">Plan state unknown. Refresh the task before relying on it.</p></section>';
    }
    const current = plan.current;
    const decision = current.decision;
    const drift = (current.changedSince || []).map(code => DRIFT[code] || 'an unrecognised change');
    const stale = (decision?.staleBecause || []).map(code => DRIFT[code] || 'an unrecognised change');
    return `<details class="pipeline-plan" data-task-plan="${esc(task.pipelineId)}" open>
      <summary>Plan revision ${esc(current.revision)} · <span data-plan-state="${esc(plan.state)}">${esc(STATES[plan.state])}</span></summary>
      <p class="pipeline-muted">${current.mode === 'research' ? 'Research plan' : 'Implementation plan'} by ${esc(current.actor?.declared || 'unknown author')} (${esc(current.actor?.channel || 'unknown path')}) · ${esc(when(current.at))}.
        A plan or its approval never starts work; launching stays a separate action.</p>
      ${plan.priorDecision ? `<p class="pipeline-plan-notice">Revision ${esc(plan.priorDecision.revision)} was ${esc(STATES[plan.priorDecision.outcome] || plan.priorDecision.outcome).toLowerCase()}. That decision does not carry over to revision ${esc(current.revision)}.</p>` : ''}
      ${drift.length ? `<p class="pipeline-plan-notice">Since this revision, ${esc(drift.join(' and '))}.</p>` : ''}
      <div class="pipeline-plan-text">${esc(current.text)}</div>
      ${current.truncated ? `<p class="pipeline-plan-notice">Stored text is shortened to ${esc(current.text.length)} of ${esc(current.originalLength)} characters; the fingerprint covers the stored text.</p>` : ''}
      ${current.steps?.length ? `<ol class="pipeline-plan-steps">${current.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}
      ${current.scope?.length ? `<p class="pipeline-plan-scope">Scope: ${current.scope.map(path => `<code>${esc(path)}</code>`).join(' ')}</p>` : '<p class="pipeline-muted">No automation scope is bound to this revision.</p>'}
      <p class="pipeline-muted">Reference <code>${esc(current.planRef || `plan-${current.revision}`)}</code> · fingerprint <code title="${esc(current.fingerprint)}">${esc(String(current.fingerprint).slice(0, 12))}</code></p>
      ${decision ? `<p class="pipeline-plan-decided">${esc(STATES[decision.outcome] || decision.outcome)} by ${esc(decision.actor?.declared || 'unknown')} · ${esc(when(decision.at))}${decision.reason ? ` — ${esc(decision.reason)}` : ''}${stale.length ? `. No longer current: ${esc(stale.join(' and '))}.` : ''}</p>` : ''}
      ${!decision && !drift.length ? decisionForm(task, current) : ''}
    </details>`;
  }

  async function decide(form, outcome) {
    const message = form.querySelector('[data-plan-message]');
    const data = new FormData(form);
    const by = String(data.get('by') || '').trim();
    if (!by) { message.textContent = 'Enter the reviewer name.'; form.querySelector('[name="by"]').focus(); return; }
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    message.textContent = 'Recording the decision…';
    try {
      const response = await fetch(`/api/pipeline/tasks/${encodeURIComponent(form.dataset.planDecision)}/plan/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ revision: Number(form.dataset.revision), planFingerprint: form.dataset.fingerprint, outcome, by,
          ...(String(data.get('reason') || '').trim() && { reason: String(data.get('reason')).trim() }) })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'The decision could not be recorded. Refresh the task and try again.');
      saveReviewer(by);
      document.dispatchEvent(new CustomEvent('pipeline-task-saved', { detail: { pipelineId: form.dataset.planDecision } }));
    } catch (error) {
      if (!form.isConnected) return;
      message.textContent = error.message || 'The decision outcome is unknown. Refresh the task before deciding again.';
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  document.addEventListener('submit', event => {
    const form = event.target.closest?.('[data-plan-decision]');
    if (!form) return;
    event.preventDefault();
    const outcome = event.submitter?.dataset.outcome;
    if (outcome === 'approved' || outcome === 'changes_requested') decide(form, outcome);
  });
  window.PipelinePlan = { markup };
})();
