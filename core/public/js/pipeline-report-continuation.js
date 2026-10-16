(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else window.PipelineReportContinuation = factory();
})(function () {
  'use strict';
  // Owner switch for automatic continuation of private reports (#835).
  const base = '/api/pipeline/report-continuation';

  function statusText(state) {
    if (!state) return 'Continuation state unavailable.';
    const switchText = state.enabled ? 'On' : 'Off';
    const runner = state.available ? '' : ' · the coding runner is unavailable, so nothing can start';
    const active = state.active ? ` · continuing task ${state.active.pipelineId} (request ${state.active.requestId})` : ' · nothing in progress';
    return `${switchText}${active}${runner}`;
  }

  function mount(doc = document, fetchImpl = fetch) {
    const $ = id => doc.getElementById(id);
    if (!$('reportContinuation')) return null;
    let state = null;
    const show = text => { $('reportContinuationStatus').textContent = text; };
    async function call(url, body) {
      const response = await fetchImpl(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Refresh the continuation switch and try again.');
      return payload.data;
    }
    async function refresh() {
      try { state = await call(base); show(statusText(state)); }
      catch (error) { show(error.message); }
    }
    doc.querySelectorAll('[data-report-continuation]').forEach(button => button.addEventListener('click', async () => {
      const enabled = button.dataset.reportContinuation === 'true';
      if (enabled && !$('reportContinuationConfirm').checked) { show('Tick the approval box first.'); return; }
      try {
        state = await call(`${base}/config`, { enabled, confirm: true, expectedRevision: state?.revision ?? 0 });
        $('reportContinuationConfirm').checked = false;
        show(statusText({ ...state, available: true }));
      } catch (error) { show(error.message); }
    }));
    return refresh();
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => mount());
  return { statusText, mount };
});
