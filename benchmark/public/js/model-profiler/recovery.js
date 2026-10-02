(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function render(payload) {
    const panel = document.getElementById('profiler-recovery');
    if (!panel) return { unknown: true };
    const stamp = Date.parse(payload?.observedAt);
    const valid = payload?.schema === 'agentx.profiler-recovery-view/v1' && Array.isArray(payload.operations)
      && Number.isFinite(stamp) && stamp <= Date.now() && Date.now() - stamp <= 60000;
    if (!valid) {
      panel.hidden = false;
      panel.innerHTML = '<h2>Runtime recovery status unknown</h2><p>Recovery evidence could not be read. Refresh preparation before starting another profile.</p>';
      return { unknown: true };
    }
    const pending = payload.operations.filter(item => item.unresolved);
    const attention = pending.filter(item => item.attention);
    const opened = new Set([...panel.querySelectorAll('details[open][data-recovery-evidence]')].map(node => node.dataset.recoveryEvidence));
    const focused = panel.contains(document.activeElement) ? document.activeElement.closest('[data-recovery-evidence]')?.dataset.recoveryEvidence : null;
    panel.hidden = payload.operations.length === 0 && !payload.truncated;
    panel.innerHTML = `<header><div><span class="profiler-experience-eyebrow">Runtime continuity</span><h2>${attention.length || payload.truncated ? 'Runtime recovery needs attention' : pending.length ? 'Runtime operation in progress' : 'Recent runtime recovery'}</h2></div><span class="profiler-recovery-count">${pending.length}${payload.truncated ? '+' : ''} pending</span></header>
      ${payload.truncated ? '<p>Some pending operations are outside this bounded view. Inspect the host records before declaring recovery complete.</p>' : ''}
      <div class="profiler-recovery-grid">${payload.operations.map(item => `<article class="profiler-recovery-card ${item.attention ? 'is-attention' : ''}">
        <strong>${esc(item.hostLabel)}</strong><p class="profiler-recovery-label">${esc(item.label)}</p><p>${esc(item.action)}</p>
        <details data-recovery-evidence="${esc(item.hostId)}"><summary>Operation evidence</summary><dl><dt>Operation</dt><dd>${esc(item.operationId || 'Unavailable')}</dd><dt>Terminal request receipt</dt><dd>${item.serverTerminalObserved ? 'Recorded' : 'Not recorded; runtime activity remains unknown'}</dd><dt>Requests recorded pending</dt><dd>${esc(item.recordedRequestsPending ?? 'Unknown')}</dd><dt>Last evidence</dt><dd>${esc(item.lastEvidenceAt || 'Unavailable')}</dd></dl></details>
      </article>`).join('')}</div>
      <details class="profiler-recovery-guide" data-recovery-evidence="guide"><summary>How to handle an interrupted operation</summary><ol><li>Inspect the exact operation, current writer and Core runtime claim.</li><li>A saved profile does not prove the runtime was restored. Wait for restoration and release receipts.</li><li>If a dispatched request has no terminal receipt, verify its termination before recovery. A timeout, an old heartbeat or a quiet GPU cannot prove termination.</li><li>If controlled runtime restart is required, follow the operator procedure and record its exact receipt. This screen refreshes evidence; it does not restart or replay work.</li></ol></details>
      <small>Observed ${esc(new Date(stamp).toLocaleString())} · Live host acceptance is a separate check.</small>`;
    panel.querySelectorAll('[data-recovery-evidence]').forEach(node => {
      node.open = opened.has(node.dataset.recoveryEvidence);
      if (focused === node.dataset.recoveryEvidence) node.querySelector('summary').focus({ preventScroll: true });
    });
    return { pending: pending.length, attention: attention.length, unknown: payload.truncated === true };
  }
  window.ProfilerRecovery = { render };
})();
