(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else window.PipelineReportResume = factory();
})(function () {
  'use strict';
  // One-click resume of a private report (#878): the owner chooses when; Core
  // finds the slot, sizes a safety budget from the remaining documents and
  // launches the worker from the saved report. Nothing to type.
  const base = id => `/api/pipeline/tasks/${encodeURIComponent(id)}/report-resume`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const when = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  };
  const duration = minutes => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`);

  /** Whether the drawer should offer the one-click resume for this task. */
  function eligible(task) {
    if (task?.intakeView?.claimGate === 'decision_required') return false;
    const latest = (task?.feedback || []).map(row => row.reportOutcome).filter(Boolean).at(-1);
    const report = task?.codingResult?.profile === 'report' || Boolean(latest);
    const managed = Boolean(task?.codingAutonomy || task?.automation?.mode === 'review_only');
    return Boolean(report && !managed && ['queued', 'blocked'].includes(task.status) && task.codingResult?.reportName
      && (!latest || latest.kind === 'blocked'));
  }

  function workText(work, checkpoint) {
    const from = checkpoint?.parentSha256 ? ` Continues from the saved report <code>${esc(checkpoint.parentSha256.slice(0, 8))}</code>.`
      : checkpoint ? ' Continues after the last execution (no report was saved).' : ' Starts the report.';
    if (work?.remaining == null) return `Remaining documents unknown.${from}`;
    const detail = [work.partial ? `${work.partial} partial` : '', work.blocked ? `${work.blocked} blocked` : ''].filter(Boolean).join(', ');
    return `<strong>${esc(work.reviewed)} of ${esc(work.total)}</strong> documents reviewed · <strong>${esc(work.remaining)}</strong> left${detail ? ` (${esc(detail)})` : ''}.${from}`;
  }

  /** Where the last resume stands. */
  function stateText(view) {
    const resume = view?.resume;
    const campaign = view?.campaign;
    if (!resume || !campaign) return '';
    const slot = campaign.reservation ? `${when(campaign.reservation.start)} → ${when(campaign.reservation.end)}` : '';
    const lines = {
      requested: 'Recorded; waiting for a slot.',
      reserved: `Planned ${slot}; starts automatically.`,
      dispatching: 'Starting now.',
      running: 'Running now. Progress shows in the worker panel.',
      uncertain: 'Launch outcome unknown; it is not retried. Check it in Automations.',
      completed: 'Finished: the report was delivered. Review it below.',
      failed: `Stopped${resume.result?.decision === 'no_progress' ? ': the last pass saved nothing new' : resume.result?.reason ? ` (${resume.result.reason})` : ''}. ${campaign.releaseReceipt?.receiptRef?.startsWith('core:not-started') ? `The worker never started. ${campaign.releaseReceipt.receiptRef.slice('core:not-started:'.length).trim()}. ` : ''}Resume again when ready.`,
      cancelled: 'The planned resume was cancelled.'
    };
    const tone = ['failed', 'uncertain'].includes(campaign.state) ? 'warn' : ['reserved', 'running', 'dispatching'].includes(campaign.state) ? 'live' : '';
    return `<p class="pipeline-resume-state${tone ? ` is-${tone}` : ''}" role="status">${esc(lines[campaign.state] || campaign.state)} <a href="/automations?view=calendar">Calendar</a></p>`;
  }

  function render(view) {
    if (!view) return '';
    const budget = view.budget || {};
    const maximumCalls = view.perExecutionModelCalls ? view.perExecutionModelCalls * budget.executions : budget.modelCalls;
    const cap = view.escalation?.maxCostNanodollars ? `${(view.escalation.maxCostNanodollars / 1e9).toFixed(2).replace(/\.00$/, '')} $` : null;
    const open = !view.campaign || ['completed', 'failed', 'cancelled'].includes(view.campaign.state) || view.campaign.state === 'reserved';
    const route = view.route ? ` on <code>${esc(view.route.model)}</code>` : '';
    return `<form class="pipeline-drawer-action pipeline-resume" data-report-resume-form="${esc(view.pipelineId)}"${view.retryCampaignId ? ` data-retry-campaign-id="${esc(view.retryCampaignId)}"` : ''}>
      <h3>Resume the report</h3>
      <p>${workText(view.work, view.checkpoint)}</p>
      ${stateText(view)}
      ${open ? `<fieldset class="pipeline-resume-when"><legend>When</legend>
        <label><input type="radio" name="when" value="asap" checked> As soon as possible</label>
        <label><input type="radio" name="when" value="tonight"> Tonight</label>
        <label><input type="radio" name="when" value="at"> At a time</label>
        <label class="pipeline-resume-at" hidden><span>Start</span><input type="datetime-local" name="at"></label>
      </fieldset>
      <p class="pipeline-resume-budget">Up to <strong>${esc(maximumCalls)}</strong> model calls in <strong>${esc(budget.executions)}</strong> ${budget.executions === 1 ? 'execution' : 'executions'}, about <strong>${esc(duration(budget.minutes || 0))}</strong> of work${route}.
        This is a safety net: it ends sooner when the report is done, and stops with an alert when a pass saves nothing new. The remaining task budget also applies.</p>
      <label class="pipeline-resume-check"><input type="checkbox" name="autoContinue"${view.campaign?.state === 'reserved' && view.resume?.autoContinue === true ? ' checked' : ''}> Allow another execution only while verified source coverage advances</label>
      <label class="pipeline-resume-check"><input type="checkbox" name="allowCloudEscalation"> Send failed steps to the cloud${cap ? ` (cap ${esc(cap)} per task)` : ''}${view.escalation && !view.escalation.enabled ? ' · cloud escalation is off globally, so this applies once it is on' : ''}</label>
      <div class="pipeline-resume-actions"><button type="submit" class="pipeline-btn primary">${view.campaign?.state === 'reserved' ? 'Replan' : 'Resume'}</button>
        <span class="pipeline-resume-error" role="alert"></span></div>` : ''}
    </form>`;
  }

  function placeholder(task) {
    return eligible(task) ? `<div class="pipeline-resume-slot" data-report-resume="${esc(task.pipelineId)}"><p class="pipeline-muted">Reading the saved report…</p></div>` : '';
  }

  function mount(doc = document, fetchImpl = fetch, onChange = () => {}) {
    const cache = new Map();
    async function call(id, body) {
      const response = await fetchImpl(base(id), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Resume is unavailable; refresh the task.');
      return payload.data;
    }
    async function hydrate(slot) {
      const id = slot.dataset.reportResume;
      try {
        // Drawer re-renders reuse a fresh answer; older ones are read again.
        const held = cache.get(id);
        const view = held && Date.now() - held.at < 10000 ? held.view : await call(id);
        cache.set(id, { view, at: held?.view === view ? held.at : Date.now() });
        slot.innerHTML = render(view);
      } catch (error) { slot.innerHTML = `<p class="pipeline-error">${esc(error.message)}</p>`; }
    }
    function scan() { doc.querySelectorAll('[data-report-resume]').forEach(slot => { if (!slot.dataset.hydrated) { slot.dataset.hydrated = '1'; hydrate(slot); } }); }
    doc.addEventListener('change', event => {
      const form = event.target.closest?.('[data-report-resume-form]');
      if (!form || event.target.name !== 'when') return;
      const at = form.querySelector('.pipeline-resume-at');
      at.hidden = event.target.value !== 'at';
      form.elements.at.required = event.target.value === 'at';
    });
    doc.addEventListener('submit', async event => {
      const form = event.target.closest?.('[data-report-resume-form]');
      if (!form) return;
      event.preventDefault();
      const id = form.dataset.reportResumeForm;
      const button = form.querySelector('button[type="submit"]');
      const error = form.querySelector('.pipeline-resume-error');
      const choice = form.elements.when.value;
      const body = { confirm: true, when: choice, autoContinue: form.elements.autoContinue.checked, allowCloudEscalation: form.elements.allowCloudEscalation.checked };
      if (form.dataset.retryCampaignId) body.retryCampaignId = form.dataset.retryCampaignId;
      if (choice === 'at') {
        const start = new Date(form.elements.at.value);
        if (!Number.isFinite(start.getTime())) { error.textContent = 'Choose a start time.'; return; }
        body.at = start.toISOString();
      }
      button.disabled = true; error.textContent = '';
      try {
        const view = await call(id, body);
        cache.set(id, { view, at: Date.now() });
        form.outerHTML = render(view);
        onChange(id, view);
      } catch (failure) { error.textContent = failure.message; button.disabled = false; }
    });
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(scan) : null;
    observer?.observe(doc.body, { childList: true, subtree: true });
    scan();
    return { scan, forget: id => cache.delete(id) };
  }

  const api = { eligible, render, placeholder, stateText, workText, mount };
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const start = () => mount(document, fetch, id => window.dispatchEvent(new CustomEvent('pipeline:task-changed', { detail: { pipelineId: id } })));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
  return api;
});
