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
      ? health.reason === 'fresh_gpu_inventory_empty' ? 'A fresh collector sample reports no GPU.'
        : cpuHost ? 'This CPU host has a model in VRAM: its Ollama instance still sees a GPU.' : 'A configured model is partly or entirely on CPU.'
      : state === 'healthy' ? (cpuHost ? 'Every configured pin runs on CPU, as this host declares.' : 'Every configured pin has full GPU residency in this observation.')
      : state === 'not_applicable' ? 'There is no configured pin set to verify.'
      : health?.reason === 'runtime_owner_active' ? 'A benchmark, session or restoration owns the runtime. Pin health is not qualified during that operation.'
      : 'Fresh, complete residency evidence is unavailable.';
    const next = state === 'degraded' ? 'Inspect the affected pins and runtime evidence before changing the host.'
      : state === 'unknown' ? 'Refresh the observation and inspect the current runtime owner.' : '';
    const entries = Array.isArray(health?.entries) ? health.entries : [];
    const rows = entries.map(entry => {
      const residency = !fresh ? 'Unknown' : entry.loaded !== true ? 'Not observed loaded'
        : ({ full: 'Fully on GPU', partial: 'Partly on CPU', cpu: entry.expected === 'cpu' ? 'On CPU (declared)' : 'On CPU', unknown: 'Unknown' }[entry.status] || 'Unknown');
      return `<li><span>${shared.escapeHtml(entry.model)}</span><strong>${residency}</strong></li>`;
    }).join('');
    return `<section class="nc-gpu-health is-${state}" aria-label="Pinned model GPU residency" data-gpu-health="${state}">
      <strong>${labels[state]}</strong><p>${details}</p>${next ? `<p class="nc-gpu-next">${next}</p>` : ''}
      <details><summary>Residency evidence</summary>${rows ? `<ul>${rows}</ul>` : '<p>No per-model observation available.</p>'}
      <small>${Number.isFinite(observed) ? `Observed ${shared.escapeHtml(new Date(observed).toISOString())}` : 'Observation time unavailable'} · HTTP reachability and GPU residency are separate observations.</small></details>
    </section>`;
  }

  window.NerveCenterGpuHealth = { render };
})();
