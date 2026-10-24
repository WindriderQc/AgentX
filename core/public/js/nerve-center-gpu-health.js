(function () {
  'use strict';
  const shared = window.NerveCenterShared;
  const MAX_AGE_MS = 60000;

  function render(health) {
    const observed = Date.parse(health?.checkedAt);
    const fresh = Number.isFinite(observed) && observed <= Date.now() && Date.now() - observed <= MAX_AGE_MS;
    const state = fresh && ['healthy', 'degraded', 'not_applicable'].includes(health?.status) ? health.status : 'unknown';
    const cpuHost = health?.residency === 'cpu';
    const labels = { healthy: cpuHost ? 'Pins on CPU, as declared' : 'Pins fully on GPU', degraded: 'GPU residency degraded',
      not_applicable: 'No configured pins', unknown: 'GPU residency unknown' };
    const details = state === 'degraded'
      ? health.reason === 'fresh_gpu_inventory_empty' ? 'Fresh sample: no GPU detected.'
        : cpuHost ? 'A model sits in VRAM, yet Ollama still sees a GPU.' : 'A pin runs partly or fully on CPU.'
      : state === 'healthy' ? (cpuHost ? 'Every pin runs on CPU, as declared.' : 'Every pin is fully loaded on GPU.')
      : state === 'not_applicable' ? 'Nothing to verify.'
      : health?.reason === 'runtime_owner_active' ? 'A benchmark, session or restore owns the runtime; checks are paused.'
      : 'No fresh, complete evidence.';
    const next = state === 'degraded' ? 'Inspect the affected pins.'
      : state === 'unknown' ? 'Refresh, then check the runtime owner.' : '';
    const entries = Array.isArray(health?.entries) ? health.entries : [];
    const rows = entries.map(entry => {
      const residency = !fresh ? 'Unknown' : entry.loaded !== true ? 'Not observed loaded'
        : ({ full: 'Fully on GPU', partial: 'Partly on CPU', cpu: entry.expected === 'cpu' ? 'On CPU (declared)' : 'On CPU', unknown: 'Unknown' }[entry.status] || 'Unknown');
      return `<li><span>${shared.escapeHtml(entry.model)}</span><strong>${residency}</strong></li>`;
    }).join('');
    const observedLabel = Number.isFinite(observed) ? shared.escapeHtml(new Date(observed).toISOString()) : 'time unavailable';
    return `<section class="nc-gpu-health is-${state}" aria-label="Pinned model GPU residency" data-gpu-health="${state}">
      <strong>${labels[state]}</strong><p>${details}${next ? ` <span class="nc-gpu-next">${next}</span>` : ''}</p>
      <details><summary>Residency evidence</summary>
        ${rows ? `<ul>${rows}</ul>` : '<p>No per-model observation.</p>'}
        <small>Observed ${observedLabel}. HTTP reachability is checked separately.</small>
      </details>
    </section>`;
  }

  window.NerveCenterGpuHealth = { render };
})();
