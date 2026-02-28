/**
 * Host Monitoring Dashboard — Frontend
 *
 * Displays real-time system metrics for all hosts running the AgentX Host Agent.
 * Auto-refreshes every 15 seconds.
 */
const HostMonitor = (() => {
  const REFRESH_MS = 15000;
  let refreshTimer = null;
  let selectedHostId = null;
  let cpuChart = null;
  let memChart = null;
  let currentRange = '1h';

  // ─── API helpers ────────────────────────────────────────

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.data || json;
  }

  // ─── Formatters ─────────────────────────────────────────

  function formatBytes(b) {
    if (!b || b === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  function formatMiB(mib) {
    if (!mib) return '0 MB';
    if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GB`;
    return `${mib} MB`;
  }

  function formatUptime(seconds) {
    if (!seconds) return '-';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h || d) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'never';
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  function barColor(pct) {
    if (pct >= 85) return 'red';
    if (pct >= 70) return 'yellow';
    return 'green';
  }

  function osIcon(platform) {
    if (platform === 'win32') return 'fa-brands fa-windows';
    if (platform === 'darwin') return 'fa-brands fa-apple';
    return 'fa-brands fa-linux';
  }

  function gaugeColor(pct) {
    if (pct >= 85) return '#ef4444';
    if (pct >= 70) return '#f59e0b';
    return '#22c55e';
  }

  // ─── Summary ────────────────────────────────────────────

  async function loadSummary() {
    try {
      const s = await fetchJSON('/api/hosts/summary');
      setText('statTotal', s.totalHosts);
      setText('statOnline', s.online);
      setText('statDegraded', s.degraded);
      setText('statOffline', s.offline);
      setText('statAvgCpu', `${s.avgCpu}%`);
      setText('statAvgMem', `${s.avgMemory}%`);
      setText('statGpus', s.totalGpus);
      setText('statVram', formatMiB(s.totalVramMiB));
    } catch (err) {
      console.error('Summary load failed:', err);
    }
  }

  // ─── Host cards ─────────────────────────────────────────

  async function loadHosts() {
    const filter = document.getElementById('statusFilter')?.value || '';
    try {
      const hosts = await fetchJSON(`/api/hosts${filter ? `?status=${filter}` : ''}`);
      const grid = document.getElementById('hostsGrid');
      const empty = document.getElementById('emptyState');

      if (!hosts || hosts.length === 0) {
        grid.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';
      grid.innerHTML = hosts.map(h => renderHostCard(h)).join('');

      // Attach click handlers
      grid.querySelectorAll('.hm-card').forEach(card => {
        card.addEventListener('click', () => selectHost(card.dataset.hostId));
      });

      // Re-highlight selected
      if (selectedHostId) {
        const sel = grid.querySelector(`[data-host-id="${selectedHostId}"]`);
        if (sel) sel.classList.add('selected');
      }
    } catch (err) {
      console.error('Hosts load failed:', err);
    }
  }

  function renderHostCard(h) {
    const cpuPct = h.cpu?.usage || 0;
    const memPct = h.memory?.usagePercent || 0;
    const maxDisk = (h.disks || []).reduce((max, d) => Math.max(max, d.usagePercent || 0), 0);
    const gpuVramPct = computeGpuPct(h.gpus);
    const selClass = h.hostId === selectedHostId ? ' selected' : '';
    const statusClass = h.status || 'offline';

    return `
      <div class="hm-card ${statusClass}${selClass}" data-host-id="${h.hostId}">
        <div class="hm-card-header">
          <div class="hm-card-hostname">
            <i class="${osIcon(h.platform)} hm-card-os"></i>
            ${esc(h.hostname || h.hostId)}
          </div>
          <div class="hm-status-dot ${statusClass}" title="${statusClass}"></div>
        </div>
        <div class="hm-card-meta">
          <span><i class="fas fa-network-wired"></i> ${esc(h.ip || '-')}</span>
          <span><i class="fas fa-microchip"></i> ${h.cpu?.cores || 0} cores</span>
          ${h.gpus?.length ? `<span><i class="fas fa-bolt"></i> ${h.gpus.length} GPU${h.gpus.length > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="hm-bars">
          ${miniBar('CPU', cpuPct)}
          ${miniBar('RAM', memPct)}
          ${miniBar('Disk', maxDisk)}
          ${h.gpus?.length ? miniBar('GPU', gpuVramPct) : miniBar('GPU', 0)}
        </div>
        ${renderTags(h.tags)}
        <div class="hm-lastseen">Last seen: ${timeAgo(h.lastSeen)}</div>
      </div>`;
  }

  function miniBar(label, pct) {
    const p = Math.round(pct);
    return `
      <div class="hm-bar-item">
        <div class="hm-bar-label"><span>${label}</span><span>${p}%</span></div>
        <div class="hm-bar-track"><div class="hm-bar-fill ${barColor(p)}" style="width:${p}%"></div></div>
      </div>`;
  }

  function renderTags(tags) {
    if (!tags || tags.length === 0) return '';
    return `<div class="hm-tags">${tags.map(t => `<span class="hm-tag">${esc(t)}</span>`).join('')}</div>`;
  }

  function computeGpuPct(gpus) {
    if (!gpus || gpus.length === 0) return 0;
    const totalVram = gpus.reduce((s, g) => s + (g.vramTotal || 0), 0);
    const usedVram = gpus.reduce((s, g) => s + (g.vramUsed || 0), 0);
    return totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0;
  }

  // ─── Detail panel ───────────────────────────────────────

  async function selectHost(hostId) {
    selectedHostId = hostId;

    // Highlight card
    document.querySelectorAll('.hm-card').forEach(c => c.classList.remove('selected'));
    const card = document.querySelector(`[data-host-id="${hostId}"]`);
    if (card) card.classList.add('selected');

    try {
      const host = await fetchJSON(`/api/hosts/${hostId}`);
      renderDetail(host);
      document.getElementById('detailPanel').classList.add('visible');
      document.getElementById('detailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      loadHistory(hostId, currentRange);
    } catch (err) {
      console.error('Detail load failed:', err);
    }
  }

  function renderDetail(h) {
    // Title
    setText('detailHostname', h.hostname || h.hostId);
    const dot = document.getElementById('detailStatusDot');
    dot.className = `hm-status-dot ${h.status || 'offline'}`;

    // CPU gauge
    const cpuPct = h.cpu?.usage || 0;
    const cpuEl = document.getElementById('detailCpuUsage');
    cpuEl.textContent = `${cpuPct}%`;
    cpuEl.style.color = gaugeColor(cpuPct);

    setHTML('detailCpuInfo', `
      ${infoRow('Model', h.cpu?.model || '-')}
      ${infoRow('Cores', `${h.cpu?.physicalCores || 0} physical / ${h.cpu?.cores || 0} logical`)}
      ${infoRow('Speed', `${h.cpu?.speed || 0} GHz`)}
      ${infoRow('Temperature', h.cpu?.temperature ? `${h.cpu.temperature}°C` : 'N/A')}
      ${infoRow('Load Avg', (h.cpu?.loadAvg || []).join(' / ') || '-')}
    `);

    // Memory gauge
    const memPct = h.memory?.usagePercent || 0;
    const memEl = document.getElementById('detailMemUsage');
    memEl.textContent = `${memPct}%`;
    memEl.style.color = gaugeColor(memPct);

    setHTML('detailMemInfo', `
      ${infoRow('Total', formatBytes(h.memory?.total))}
      ${infoRow('Used', formatBytes(h.memory?.used))}
      ${infoRow('Free', formatBytes(h.memory?.free))}
    `);

    // GPUs
    const gpuSection = document.getElementById('detailGpuSection');
    if (h.gpus && h.gpus.length > 0) {
      gpuSection.style.display = '';
      setHTML('detailGpuList', h.gpus.map(renderGpuCard).join(''));
    } else {
      gpuSection.style.display = 'none';
    }

    // System info
    setHTML('detailSysInfo', `
      ${infoRow('Platform', h.platform || '-')}
      ${infoRow('Distro', h.distro || '-')}
      ${infoRow('Kernel', h.kernel || '-')}
      ${infoRow('Arch', h.arch || '-')}
      ${infoRow('IP', h.ip || '-')}
      ${infoRow('Uptime', formatUptime(h.uptime))}
      ${infoRow('Agent Version', h.agentVersion || '-')}
    `);

    // Disks
    setHTML('detailDiskList', (h.disks || []).map(renderDiskRow).join('') || '<span style="color:var(--muted)">No disk data</span>');

    // Processes
    setHTML('detailProcesses', renderProcessTable(h.topProcessesCpu || []));
  }

  function renderGpuCard(g) {
    const pct = g.vramTotal > 0 ? Math.round((g.vramUsed / g.vramTotal) * 100) : 0;
    return `
      <div class="hm-gpu-card">
        <div class="hm-gpu-name">GPU ${g.index}: ${esc(g.name || 'Unknown')}</div>
        ${miniBar('VRAM', pct)}
        <div style="font-size:11px; color:var(--muted); margin-top:4px;">
          ${formatMiB(g.vramUsed)} / ${formatMiB(g.vramTotal)}
          ${g.temperature ? ` | ${g.temperature}°C` : ''}
          ${g.utilization != null ? ` | ${g.utilization}% util` : ''}
        </div>
      </div>`;
  }

  function renderDiskRow(d) {
    const pct = d.usagePercent || 0;
    return `
      <div class="hm-disk-row">
        <div class="hm-disk-mount">${esc(d.mount)} <span style="opacity:0.5">(${esc(d.type || d.fs || '')})</span></div>
        <div class="hm-bar-label"><span>${formatBytes(d.used)} / ${formatBytes(d.total)}</span><span>${Math.round(pct)}%</span></div>
        <div class="hm-bar-track"><div class="hm-bar-fill ${barColor(pct)}" style="width:${pct}%"></div></div>
      </div>`;
  }

  function renderProcessTable(procs) {
    if (!procs || procs.length === 0) return '<span style="color:var(--muted)">No process data</span>';
    return `
      <table class="hm-proc-table">
        <tr><th>PID</th><th>Name</th><th>CPU%</th><th>MEM%</th></tr>
        ${procs.map(p => `<tr><td>${p.pid}</td><td>${esc(p.name)}</td><td>${p.cpu}</td><td>${p.mem}</td></tr>`).join('')}
      </table>`;
  }

  // ─── History charts ─────────────────────────────────────

  async function loadHistory(hostId, range) {
    const ranges = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
    const ms = ranges[range] || 3600000;
    const from = new Date(Date.now() - ms).toISOString();

    try {
      const snapshots = await fetchJSON(`/api/hosts/${hostId}/history?from=${from}&limit=500`);
      renderCharts(snapshots.reverse()); // oldest first for charts
    } catch (err) {
      console.error('History load failed:', err);
    }
  }

  function renderCharts(snapshots) {
    const labels = snapshots.map(s => {
      const d = new Date(s.timestamp);
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    });
    const cpuData = snapshots.map(s => s.cpu?.usage || 0);
    const memData = snapshots.map(s => s.memory?.usagePercent || 0);

    const chartOpts = (label, data, color) => ({
      type: 'line',
      data: {
        labels,
        datasets: [{
          label,
          data,
          borderColor: color,
          backgroundColor: color + '22',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            display: true,
            ticks: { color: '#666', maxTicksLimit: 10, font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.03)' }
          },
          y: {
            min: 0, max: 100,
            ticks: { color: '#666', callback: v => v + '%', font: { size: 10 } },
            grid: { color: 'rgba(255,255,255,0.03)' }
          }
        }
      }
    });

    // Destroy old charts
    if (cpuChart) { cpuChart.destroy(); cpuChart = null; }
    if (memChart) { memChart.destroy(); memChart = null; }

    const cpuCtx = document.getElementById('cpuChart');
    const memCtx = document.getElementById('memChart');
    if (cpuCtx) cpuChart = new Chart(cpuCtx, chartOpts('CPU %', cpuData, '#7cf0ff'));
    if (memCtx) memChart = new Chart(memCtx, chartOpts('RAM %', memData, '#a78bfa'));
  }

  // ─── Utilities ──────────────────────────────────────────

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setHTML(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function infoRow(key, val) {
    return `<div class="hm-info-row"><span class="hm-info-key">${key}</span><span class="hm-info-val">${esc(String(val))}</span></div>`;
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ─── Refresh loop ───────────────────────────────────────

  async function refresh() {
    await Promise.all([loadSummary(), loadHosts()]);
    // If a host is selected, refresh its detail too
    if (selectedHostId) {
      try {
        const host = await fetchJSON(`/api/hosts/${selectedHostId}`);
        renderDetail(host);
      } catch (_) { /* host may have been removed */ }
    }
  }

  // ─── Init ───────────────────────────────────────────────

  function init() {
    // Close detail panel
    document.getElementById('detailClose')?.addEventListener('click', () => {
      document.getElementById('detailPanel').classList.remove('visible');
      selectedHostId = null;
      document.querySelectorAll('.hm-card').forEach(c => c.classList.remove('selected'));
    });

    // Status filter
    document.getElementById('statusFilter')?.addEventListener('change', loadHosts);

    // Chart range buttons
    document.getElementById('chartRange')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.dataset.range) return;
      currentRange = btn.dataset.range;
      document.querySelectorAll('#chartRange button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (selectedHostId) loadHistory(selectedHostId, currentRange);
    });

    // Initial load
    refresh();

    // Auto-refresh
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }

  return { init };
})();
