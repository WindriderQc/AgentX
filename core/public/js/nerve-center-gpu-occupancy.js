(function () {
  'use strict';

  // GPU occupancy over a window, per physical GPU (#365), under the host cards.
  // Every figure is a share of the time samples cover; uncovered time is shown
  // as missing, never as idle.
  const shared = window.NerveCenterShared;
  const WINDOWS = ['1h', '6h', '24h', '7d', '30d'];
  const LINKS = { uuid: 'by GPU UUID', bus_id: 'by PCI bus id', single_gpu_host: 'by its only GPU' };
  let selected = '24h';

  const pct = value => (value == null ? '—' : `${Math.round(value * 100)}%`);
  const num = (value, unit = '') => (value == null ? '—' : `${Math.round(value)}${unit}`);
  const gib = mib => (mib == null ? '—' : (mib / 1024).toFixed(1));

  function duration(ms) {
    const minutes = Math.round((Number(ms) || 0) / 60000);
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
  }

  function coverageCell(gpu) {
    if (!gpu.samples) return '<span class="nc-muted">no sample in this window</span>';
    const missing = gpu.missingMs > 0 ? ` · ${duration(gpu.missingMs)} missing` : '';
    return `${pct(gpu.coverage)} (${gpu.samples} samples${missing})`;
  }

  function resourceLine(gpu) {
    const resource = gpu.resource;
    if (!resource) return '';
    const endpoints = (resource.endpoints || []).map(shared.escapeHtml).join(', ');
    return `<div class="nc-gpu-occ-resource">${shared.escapeHtml(resource.id)} ${LINKS[resource.link] || ''}: ${endpoints}</div>`;
  }

  function gpuRow(gpu) {
    const sampled = gpu.samples > 0;
    const vram = sampled ? `${gib(gpu.memoryUsedMiB?.p95)} / ${gib(gpu.memoryTotalMiB)} GiB (max ${gib(gpu.memoryUsedMiB?.max)})` : '—';
    const power = sampled ? `${num(gpu.powerW?.mean, ' W')} (p95 ${num(gpu.powerW?.p95, ' W')} of ${num(gpu.powerW?.limit, ' W')})` : '—';
    return `<tr>
      <td>GPU ${gpu.index ?? '?'}<div class="nc-muted">${shared.escapeHtml(gpu.name || '')}</div>${resourceLine(gpu)}</td>
      <td>${sampled ? pct(gpu.busy?.share) : '—'}</td>
      <td>${sampled ? num(gpu.utilizationPct?.mean, '%') : '—'}</td>
      <td>${vram}</td>
      <td>${power}</td>
      <td>${sampled ? pct(gpu.throttled?.share) : '—'}</td>
      <td>${coverageCell(gpu)}</td>
    </tr>`;
  }

  function render(data) {
    const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
    const options = WINDOWS.map(key => `<option value="${key}"${key === selected ? ' selected' : ''}>${key}</option>`).join('');
    const topology = data?.topology === 'invalid' ? ' The physical GPU map is invalid, so no GPU is linked to its endpoints.'
      : data?.topology === 'unset' ? ' No physical GPU map is configured, so GPUs are not linked to endpoints.' : '';
    const unlinked = (data?.unlinkedResources || []).length
      ? ` Not linked to a sampled GPU: ${data.unlinkedResources.map(shared.escapeHtml).join(', ')}.` : '';
    const tables = hosts.map(host => `
      <div class="nc-fs-11b">${shared.escapeHtml(host.name)}${host.ollamaHostIds?.length ? ` · ${host.ollamaHostIds.map(shared.escapeHtml).join(', ')}` : ''}</div>
      <table class="nc-gpu-occ-table">
        <thead><tr><th>GPU</th><th>Busy</th><th>Mean util.</th><th>VRAM p95</th><th>Power mean</th><th>Throttled</th><th>Coverage</th></tr></thead>
        <tbody>${(host.gpus || []).map(gpuRow).join('') || '<tr><td colspan="7" class="nc-muted">No GPU reported</td></tr>'}</tbody>
      </table>`).join('');
    return `<div class="nc-gpu-occ-head">
        <strong>GPU occupancy</strong>
        <label>Window <select class="nc-gpu-occ-window" aria-label="GPU occupancy window">${options}</select></label>
      </div>
      <p class="nc-muted">Busy: utilization of at least ${num(data?.busyAtPct, '%')}. Shares are of the time samples cover; time without a sample is missing, not idle.${topology}${unlinked}</p>
      ${tables || '<p class="nc-muted">No GPU collector host reported.</p>'}`;
  }

  async function load(container) {
    container.setAttribute('aria-busy', 'true');
    try {
      const json = await shared.fetchJson(`/api/nerve-center/inference/gpu-occupancy?window=${encodeURIComponent(selected)}`);
      container.innerHTML = render(json.data);
      container.querySelector('.nc-gpu-occ-window')?.addEventListener('change', (event) => {
        selected = WINDOWS.includes(event.target.value) ? event.target.value : '24h';
        load(container);
      });
    } catch (err) {
      container.innerHTML = `<p class="nc-muted">GPU occupancy unavailable: ${shared.escapeHtml(err.message)}</p>`;
    } finally {
      container.removeAttribute('aria-busy');
    }
  }

  function mount(parent) {
    const container = document.createElement('section');
    container.className = 'nc-gpu-occupancy';
    container.setAttribute('aria-label', 'GPU occupancy');
    parent.appendChild(container);
    return load(container);
  }

  window.NerveCenterGpuOccupancy = { mount, render };
})();
