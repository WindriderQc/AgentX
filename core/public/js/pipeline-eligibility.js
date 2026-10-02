(function () {
  'use strict';
  const reasons = {
    task_unavailable: 'The task is already owned or is outside the queue.',
    not_before: 'The earliest start time has not arrived.',
    dependencies_incomplete: 'Dependencies are incomplete or unavailable in this task lane.',
    automation_invalid: 'The automation policy cannot be verified.',
    automation_missing: 'No structured automation policy is recorded.',
    automation_manual: 'This task uses the manual workflow.',
    risk_not_low: 'Coding automation requires an explicitly low-risk task.',
    attempt_budget_exhausted: 'The automation attempt budget is exhausted.',
    resource_lock_conflict: 'Another operation holds a required resource.',
    protected_scope: 'The requested change includes a protected path.',
    automation_slot_occupied: 'Another automation attempt occupies the shared slot.'
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const requests = new WeakMap();
  function markup(task) {
    if (!/^\d{3,4}$/.test(task.pipelineId) || ['personal', 'family', 'household', 'secretary'].includes(String(task.service).toLowerCase())
      || task.source === 'idea-drop' || String(task.source || '').startsWith('household-')) return '';
    return `<details class="pipeline-task-eligibility" data-task-eligibility="${esc(task.pipelineId)}"><summary>Why can this task start, or why is it waiting?</summary>
      <p>Inspect the current queue and Coding Team conditions.</p><div data-eligibility-result role="status" aria-live="polite"></div>
      <button type="button" class="pipeline-btn compact" data-refresh-eligibility>Refresh conditions</button>
      <p class="pipeline-muted">This observation starts no work. The launch path checks current conditions again.</p></details>`;
  }
  async function read(id, automated, signal) {
    const response = await fetch(`/api/pipeline/tasks/${encodeURIComponent(id)}/eligibility?automation=${automated}`, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 404 ? 'This task has no coding eligibility view.' : 'Conditions could not be read. Refresh to try again.');
    const value = (await response.json())?.data?.eligibility;
    if (value?.schema !== 'agentx.pipeline-eligibility/v1' || value.pipelineId !== id || !Array.isArray(value.reasons)
      || typeof value.observedEligible !== 'boolean' || value.mode !== (automated ? 'review_only' : 'manual')) throw new Error('The eligibility observation is incomplete.');
    return value;
  }
  function renderMode(value, label) {
    const stamp = Date.parse(value.observedAt);
    const fresh = Number.isFinite(stamp) && stamp <= Date.now() && Date.now() - stamp < 60000;
    const eligible = fresh && value.observedEligible && value.reasons.length === 0;
    return `<section class="pipeline-eligibility-mode"><strong>${label}</strong><p>${!fresh ? 'Current conditions unknown — refresh the observation.' : eligible ? 'Queue conditions observed; launch remains a separate action.' : 'Waiting for these conditions:'}</p>
      ${fresh && !eligible ? `<ul>${value.reasons.map(item => `<li>${esc(reasons[item.code] || 'An unrecognised condition needs inspection.')}${item.code === 'not_before' && item.notBefore ? ` <time>${esc(item.notBefore)}</time>` : ''}</li>`).join('')}</ul>` : ''}
      <small>${fresh ? `Observed ${esc(new Date(stamp).toLocaleString())}` : 'Fresh observation unavailable'}</small></section>`;
  }
  async function refresh(panel) {
    requests.get(panel)?.abort();
    const controller = new AbortController(); requests.set(panel, controller);
    const result = panel.querySelector('[data-eligibility-result]'), button = panel.querySelector('[data-refresh-eligibility]');
    result.textContent = 'Checking current conditions…'; result.setAttribute('aria-busy', 'true'); button.disabled = true;
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const values = await Promise.allSettled([read(panel.dataset.taskEligibility, false, controller.signal), read(panel.dataset.taskEligibility, true, controller.signal)]);
      if (!panel.isConnected || requests.get(panel) !== controller) return;
      result.innerHTML = values.map((value, index) => value.status === 'fulfilled' ? renderMode(value.value, index ? 'Coding Team' : 'Manual worker queue')
        : `<section class="pipeline-eligibility-mode"><strong>${index ? 'Coding Team' : 'Manual worker queue'}</strong><p>${esc(controller.signal.aborted ? 'The observation timed out. Refresh to try again.' : value.reason.message)}</p></section>`).join('');
    } finally {
      clearTimeout(timer);
      if (requests.get(panel) === controller) { result.removeAttribute('aria-busy'); button.disabled = false; }
    }
  }
  document.addEventListener('toggle', event => { if (event.target.matches?.('[data-task-eligibility]') && event.target.open) refresh(event.target); }, true);
  document.addEventListener('click', event => { const button = event.target.closest?.('[data-refresh-eligibility]'); if (button) refresh(button.closest('[data-task-eligibility]')); });
  document.addEventListener('keydown', event => {
    const shell = document.getElementById('pipelineDrawerShell');
    if (event.key !== 'Tab' || !shell || shell.hidden || document.getElementById('pipelineTaskEditor')?.open) return;
    const focusable = [...shell.querySelector('.pipeline-drawer').querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex="0"]')]
      .filter(node => !node.disabled && node.getClientRects().length > 0);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (first && (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  });
  window.PipelineEligibility = { markup };
})();
