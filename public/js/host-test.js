/**
 * Host Full Test — Frontend Logic
 *
 * Manages: host card rendering, model selection, test execution,
 * progress polling, results table, Chart.js charts.
 * All test results are persisted to ModelRegistry via the API.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────

  const state = {
    hosts: [],
    selectedHost: null,
    results: [],
    activeTestId: null,
    pollTimer: null,
    tpsChart: null,
    latencyChart: null,
    sortField: 'tokensPerSec',
    sortDir: 'desc'
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const hostCardsEl = $('#hostCards');
  const actionBar = $('#actionBar');
  const modelSelect = $('#modelSelect');
  const testOneBtn = $('#testOneBtn');
  const testAllBtn = $('#testAllBtn');
  const selectedHostLabel = $('#selectedHostLabel');
  const progressContainer = $('#progressContainer');
  const progressFill = $('#progressFill');
  const progressLabel = $('#progressLabel');
  const resultsBody = $('#resultsBody');
  const filterHost = $('#filterHost');
  const toastEl = $('#toast');

  // ── Toast ──────────────────────────────────────────────────────────────────

  let toastTimer;
  function showToast(msg, type = 'info') {
    toastEl.textContent = msg;
    toastEl.className = `toast visible ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 4000);
  }

  // ── API helpers ────────────────────────────────────────────────────────────

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api/host-test${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data.data;
  }

  // ── Host Cards ─────────────────────────────────────────────────────────────

  async function loadHosts() {
    try {
      const data = await api('GET', '/hosts-status');
      state.hosts = data.hosts || [];
      renderHostCards();
      populateHostFilter();
    } catch (err) {
      hostCardsEl.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>${err.message}</p></div>`;
    }
  }

  function renderHostCards() {
    if (state.hosts.length === 0) {
      hostCardsEl.innerHTML = '<div class="empty-state"><i class="fas fa-server"></i><p>No Ollama hosts configured</p></div>';
      return;
    }
    hostCardsEl.innerHTML = state.hosts.map(h => {
      const sel = state.selectedHost?.id === h.id ? ' selected' : '';
      const off = !h.available ? ' offline' : '';
      return `
        <div class="host-card${sel}${off}" data-host-id="${h.id}">
          <div class="host-card-header">
            <span class="host-card-name"><i class="fas fa-server" style="margin-right:6px;color:var(--muted);"></i>${h.name}</span>
            <span class="host-status-dot ${h.available ? 'online' : 'offline'}"></span>
          </div>
          <div class="host-card-url">${h.url}</div>
          <div class="host-card-stats">
            <span><i class="fas fa-cube"></i> ${h.modelCount} models</span>
            <span><i class="fas fa-clock"></i> ${h.latency}ms</span>
            ${h.error ? `<span style="color:#ef4444;"><i class="fas fa-times-circle"></i> ${h.error}</span>` : ''}
          </div>
        </div>`;
    }).join('');

    hostCardsEl.querySelectorAll('.host-card:not(.offline)').forEach(card => {
      card.addEventListener('click', () => {
        const hostId = card.dataset.hostId;
        selectHost(hostId);
      });
    });
  }

  function selectHost(hostId) {
    state.selectedHost = state.hosts.find(h => h.id === hostId) || null;
    renderHostCards();

    if (!state.selectedHost) {
      actionBar.classList.remove('visible');
      return;
    }

    actionBar.classList.add('visible');
    selectedHostLabel.textContent = `${state.selectedHost.name} — ${state.selectedHost.url}`;

    // Populate model select
    modelSelect.innerHTML = '<option value="">-- Select Model --</option>';
    for (const m of state.selectedHost.models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      modelSelect.appendChild(opt);
    }
    testOneBtn.disabled = true;
  }

  // ── Host Filter ────────────────────────────────────────────────────────────

  function populateHostFilter() {
    filterHost.innerHTML = '<option value="">All Hosts</option>';
    for (const h of state.hosts) {
      const opt = document.createElement('option');
      opt.value = h.url;
      opt.textContent = h.name;
      filterHost.appendChild(opt);
    }
  }

  // ── Run Single Test ────────────────────────────────────────────────────────

  async function runSingleTest() {
    const modelName = modelSelect.value;
    const host = state.selectedHost;
    if (!modelName || !host) return;

    testOneBtn.disabled = true;
    testOneBtn.innerHTML = '<i class="fas fa-spinner spin"></i> Testing...';

    try {
      const snapshot = await api('POST', '/run', {
        modelName, hostUrl: host.url, hostId: host.id
      });
      state.results.unshift({ modelName, ...snapshot });
      renderResults();
      renderCharts();
      showToast(`${modelName}: ${snapshot.tokensPerSec} tok/s`, snapshot.status === 'pass' ? 'success' : 'error');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      testOneBtn.disabled = false;
      testOneBtn.innerHTML = '<i class="fas fa-play"></i> Test Selected';
    }
  }

  // ── Run All Tests ──────────────────────────────────────────────────────────

  async function runAllTests() {
    const host = state.selectedHost;
    if (!host) return;

    testAllBtn.disabled = true;
    testOneBtn.disabled = true;
    testAllBtn.innerHTML = '<i class="fas fa-spinner spin"></i> Starting...';
    progressContainer.classList.add('visible');
    progressFill.style.width = '0%';
    progressLabel.textContent = 'Starting test run...';

    try {
      const data = await api('POST', '/run-all', { hostUrl: host.url, hostId: host.id });
      state.activeTestId = data.testId;
      testAllBtn.innerHTML = '<i class="fas fa-spinner spin"></i> Running...';
      startPolling(data.testId, data.totalModels);
    } catch (err) {
      showToast(err.message, 'error');
      resetRunAllUI();
    }
  }

  function startPolling(testId, total) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const data = await api('GET', `/run-all/${testId}/progress`);
        const pct = total > 0 ? Math.round((data.completed / total) * 100) : 0;
        progressFill.style.width = `${pct}%`;
        progressLabel.textContent = data.currentModel
          ? `Testing ${data.currentModel} (${data.completed}/${total})`
          : `${data.completed}/${total} complete`;

        // Merge new results
        if (data.results && data.results.length > state.results.length) {
          state.results = data.results.slice().reverse();
          renderResults();
          renderCharts();
        }

        if (data.testStatus === 'completed' || data.testStatus === 'failed') {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          state.activeTestId = null;
          progressLabel.textContent = data.testStatus === 'completed'
            ? `Done: ${data.summary?.passed || 0} passed, ${data.summary?.failed || 0} failed`
            : `Failed: ${data.error}`;
          resetRunAllUI();
          showToast(
            data.testStatus === 'completed'
              ? `All tests complete: avg ${data.summary?.avgTps || 0} tok/s`
              : `Test run failed: ${data.error}`,
            data.testStatus === 'completed' ? 'success' : 'error'
          );
        }
      } catch (err) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        progressLabel.textContent = 'Polling interrupted';
        resetRunAllUI();
      }
    }, 2000);
  }

  function resetRunAllUI() {
    testAllBtn.disabled = false;
    testOneBtn.disabled = !modelSelect.value;
    testAllBtn.innerHTML = '<i class="fas fa-rocket"></i> Test All Models';
  }

  // ── Load Historical Results ────────────────────────────────────────────────

  async function loadResults(hostUrl) {
    try {
      const query = hostUrl ? `?hostUrl=${encodeURIComponent(hostUrl)}` : '';
      const data = await api('GET', `/results${query}`);
      state.results = data.results || [];
      renderResults();
      renderCharts();
    } catch (err) {
      showToast(`Failed to load results: ${err.message}`, 'error');
    }
  }

  // ── Render Results Table ───────────────────────────────────────────────────

  function renderResults() {
    const filtered = filterHost.value
      ? state.results.filter(r => r.hostUrl === filterHost.value)
      : state.results;

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      let va = a[state.sortField], vb = b[state.sortField];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va == null) va = state.sortDir === 'desc' ? -Infinity : Infinity;
      if (vb == null) vb = state.sortDir === 'desc' ? -Infinity : Infinity;
      if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
      if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    if (sorted.length === 0) {
      resultsBody.innerHTML = '<tr><td colspan="8" class="empty-state"><p>No results yet.</p></td></tr>';
      return;
    }

    resultsBody.innerHTML = sorted.map(r => {
      const tpsCls = r.tokensPerSec >= 20 ? 'tps-high' : r.tokensPerSec >= 5 ? 'tps-mid' : 'tps-low';
      const statusBadge = r.status === 'pass' ? 'badge-pass'
        : r.status === 'timeout' ? 'badge-timeout' : 'badge-error';
      const vram = r.vramUsedMiB != null ? `${Math.round(r.vramUsedMiB)}/${Math.round(r.vramTotalMiB || 0)}` : '—';
      const ttft = r.timeToFirstTokenMs != null ? `${Math.round(r.timeToFirstTokenMs)}ms` : '—';
      const latency = r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—';
      const tested = r.testedAt ? timeAgo(new Date(r.testedAt)) : '—';
      const hostLabel = r.hostId || shortUrl(r.hostUrl);
      return `<tr>
        <td style="font-weight:500;">${r.modelName || r.displayName || '—'}</td>
        <td>${hostLabel}</td>
        <td class="${tpsCls}">${r.tokensPerSec || 0}</td>
        <td>${latency}</td>
        <td>${ttft}</td>
        <td style="font-size:12px;">${vram}</td>
        <td><span class="${statusBadge}">${r.status}</span></td>
        <td style="font-size:12px;color:var(--muted);">${tested}</td>
      </tr>`;
    }).join('');
  }

  // ── Charts ─────────────────────────────────────────────────────────────────

  const HOST_COLORS = {
    primary: '#7cf0ff',
    secondary: '#a78bfa',
    tertiary: '#fbbf24',
    default: '#94a3b8'
  };

  function renderCharts() {
    const passing = state.results.filter(r => r.status === 'pass');
    if (passing.length === 0) {
      destroyCharts();
      return;
    }

    // Deduplicate: latest per model+host
    const latest = new Map();
    for (const r of passing) {
      const key = `${r.modelName}|${r.hostUrl}`;
      if (!latest.has(key) || new Date(r.testedAt) > new Date(latest.get(key).testedAt)) {
        latest.set(key, r);
      }
    }
    const data = [...latest.values()].sort((a, b) => b.tokensPerSec - a.tokensPerSec);
    const labels = data.map(r => shortModel(r.modelName));
    const colors = data.map(r => HOST_COLORS[r.hostId] || HOST_COLORS.default);

    // TPS Chart
    renderTpsChart(labels, data.map(r => r.tokensPerSec), colors);

    // Latency Chart
    const ttftData = data.map(r => r.timeToFirstTokenMs || 0);
    const genData = data.map(r => Math.max(0, (r.latencyMs || 0) - (r.timeToFirstTokenMs || 0)));
    renderLatencyChart(labels, ttftData, genData);
  }

  function renderTpsChart(labels, values, colors) {
    const ctx = document.getElementById('tpsChart');
    if (state.tpsChart) state.tpsChart.destroy();
    state.tpsChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Tokens/sec',
          data: values,
          backgroundColor: colors.map(c => c + '99'),
          borderColor: colors,
          borderWidth: 1
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
          y: { grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 11 } } }
        }
      }
    });
  }

  function renderLatencyChart(labels, ttft, gen) {
    const ctx = document.getElementById('latencyChart');
    if (state.latencyChart) state.latencyChart.destroy();
    state.latencyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'TTFT (ms)',
            data: ttft,
            backgroundColor: 'rgba(124, 240, 255, 0.6)',
            borderColor: '#7cf0ff',
            borderWidth: 1
          },
          {
            label: 'Generation (ms)',
            data: gen,
            backgroundColor: 'rgba(167, 139, 250, 0.6)',
            borderColor: '#a78bfa',
            borderWidth: 1
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
          x: {
            stacked: true,
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#94a3b8', callback: v => v > 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms` }
          },
          y: { stacked: true, grid: { display: false }, ticks: { color: '#e2e8f0', font: { size: 11 } } }
        }
      }
    });
  }

  function destroyCharts() {
    if (state.tpsChart) { state.tpsChart.destroy(); state.tpsChart = null; }
    if (state.latencyChart) { state.latencyChart.destroy(); state.latencyChart = null; }
  }

  // ── Sorting ────────────────────────────────────────────────────────────────

  document.querySelectorAll('.ht-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortField = field;
        state.sortDir = 'desc';
      }
      renderResults();
    });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function shortUrl(url) {
    if (!url) return '—';
    try { return new URL(url).hostname; } catch (_) { return url; }
  }

  function shortModel(name) {
    if (!name) return '—';
    return name.length > 28 ? name.slice(0, 26) + '...' : name;
  }

  function timeAgo(date) {
    const sec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  // ── Event Listeners ────────────────────────────────────────────────────────

  modelSelect.addEventListener('change', () => {
    testOneBtn.disabled = !modelSelect.value || !!state.activeTestId;
  });

  testOneBtn.addEventListener('click', runSingleTest);
  testAllBtn.addEventListener('click', runAllTests);
  $('#refreshBtn').addEventListener('click', () => {
    loadHosts();
    loadResults(filterHost.value || undefined);
  });
  filterHost.addEventListener('change', () => {
    loadResults(filterHost.value || undefined);
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  loadHosts();
  loadResults();
})();
