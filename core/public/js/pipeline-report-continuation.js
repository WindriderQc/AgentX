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
      try { state = await call(base); show(statusText(state)); showEscalation(state.escalation); }
      catch (error) { show(error.message); }
    }
    async function escalate(enabled) {
      const confirm = $('reportEscalationConfirm');
      if (enabled && !confirm?.checked) { $('reportEscalationStatus').textContent = 'Tick the approval box first.'; return; }
      const models = String($('reportEscalationModels')?.value || '').split('\n').map(line => line.trim()).filter(Boolean);
      const cap = Number($('reportEscalationCap')?.value);
      try {
        const policy = await call(`${base}/escalation`, { enabled, confirm: true, expectedRevision: state?.escalation?.revision ?? 0,
          ...(enabled ? { models, maxCostUsdPerTask: cap } : {}) });
        state = { ...state, escalation: policy };
        if (confirm) confirm.checked = false;
        showEscalation(policy);
      } catch (error) { $('reportEscalationStatus').textContent = error.message; }
    }
    function showEscalation(policy) {
      if (!$('reportEscalationStatus') || !policy) return;
      $('reportEscalationStatus').textContent = escalationText(policy);
      if ($('reportEscalationModels') && doc.activeElement !== $('reportEscalationModels')) $('reportEscalationModels').value = policy.models.join('\n');
      if ($('reportEscalationCap') && doc.activeElement !== $('reportEscalationCap')) $('reportEscalationCap').value = policy.maxCostUsdPerTask;
    }
    $('reportEscalationForm')?.addEventListener('submit', event => { event.preventDefault(); escalate(true); });
    doc.querySelector('[data-report-escalation="false"]')?.addEventListener('click', () => escalate(false));
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

  function escalationText(policy) {
    if (!policy) return 'Escalation policy unavailable.';
    return policy.enabled
      ? `On · ${policy.models.join(' → ')} · cap $${Number(policy.maxCostUsdPerTask).toFixed(2)} per task · only tasks whose grant allows it`
      : 'Off · failed steps stay on the local model and are blocked after a second failure';
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => mount());
  return { statusText, escalationText, mount };
});
