/**
 * Host Full Test — Frontend Logic
 *
 * Provides an operational cockpit for host-side probes and a bridge into the
 * leaderboard's model-ranking context.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'agentx-host-test-ui';
  const HOST_COLORS = {
    primary: '#7cf0ff',
    secondary: '#a78bfa',
    tertiary: '#fbbf24',
    default: '#94a3b8'
  };

  const state = {
    hosts: [],
    selectedHost: null,
    results: [],
    activeTestId: null,
    pollTimer: null,
    tpsChart: null,
    latencyChart: null,
    sortField: 'testedAt',
    sortDir: 'desc',
    latestOnly: true
  };

  const $ = (sel) => document.querySelector(sel);
  const hostCardsEl = $('#hostCards');
  const actionBar = $('#actionBar');
  const modelSelect = $('#modelSelect');
  const testOneBtn = $('#testOneBtn');
  const testAllBtn = $('#testAllBtn');
  const compareBtn = $('#compareBtn');
  const selectedHostLabel = $('#selectedHostLabel');
  const progressContainer = $('#progressContainer');
  const progressFill = $('#progressFill');
  const progressLabel = $('#progressLabel');
  const resultsBody = $('#resultsBody');
  const filterHost = $('#filterHost');
  const latestOnlyToggle = $('#latestOnlyToggle');
  const toastEl = $('#toast');

  let toastTimer;

  function showToast(msg, type = 'info') {
    toastEl.textContent = msg;
    toastEl.className = `toast visible ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 4000);
  }

  function loadUiState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      state.sortField = parsed.sortField || state.sortField;
      state.sortDir = parsed.sortDir || state.sortDir;
      state.latestOnly = parsed.latestOnly !== undefined ? !!parsed.latestOnly : state.latestOnly;
      if (filterHost) filterHost.value = parsed.filterHost || '';
      if (latestOnlyToggle) latestOnlyToggle.checked = state.latestOnly;
    } catch (_) {
      if (latestOnlyToggle) latestOnlyToggle.checked = state.latestOnly;
    }
  }

  function persistUiState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sortField: state.sortField,
      sortDir: state.sortDir,
      latestOnly: state.latestOnly,
      filterHost: filterHost?.value || ''
    }));
  }

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api/host-test${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data.data;
  }

  function mergeResults(existing, incoming) {
    const merged = new Map();
    for (const result of [...existing, ...incoming]) {
      const key = `${result.modelName || result.displayName}|${result.hostUrl || result.hostId}|${result.testedAt || ''}`;
      merged.set(key, result);
    }
    return [...merged.values()].sort((a, b) => new Date(b.testedAt || 0) - new Date(a.testedAt || 0));
  }

  function getFilteredResults() {
    let results = filterHost.value
      ? state.results.filter(r => r.hostUrl === filterHost.value)
      : [...state.results];

    if (state.latestOnly) {
      const latest = new Map();
      for (const result of results.sort((a, b) => new Date(b.testedAt || 0) - new Date(a.testedAt || 0))) {
        const key = `${result.modelName}|${result.hostUrl || result.hostId}`;
        if (!latest.has(key)) latest.set(key, result);
      }
      results = [...latest.values()];
    }

    return results;
  }

  function sortResults(results) {
    return [...results].sort((a, b) => {
      let va = a[state.sortField];
      let vb = b[state.sortField];
      if (state.sortField === 'testedAt') {
        va = new Date(va || 0).getTime();
        vb = new Date(vb || 0).getTime();
      } else if (typeof va === 'string') {
        va = va.toLowerCase();
      }
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va == null) va = state.sortDir === 'desc' ? -Infinity : Infinity;
      if (vb == null) vb = state.sortDir === 'desc' ? -Infinity : Infinity;
      if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
      if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  function updateSummaryCards(results) {
    const hostsOnline = state.hosts.filter(host => host.available).length;
    $('#statHostsOnline').textContent = `${hostsOnline}/${state.hosts.length}`;
    $('#statHostsSubtext').textContent = hostsOnline === state.hosts.length
      ? 'All configured hosts reachable'
      : `${state.hosts.length - hostsOnline} host(s) unavailable`;

    const latestSnapshots = getFilteredResults();
    const passCount = latestSnapshots.filter(result => result.status === 'pass').length;
    $('#statPassRate').textContent = latestSnapshots.length > 0
      ? `${Math.round((passCount / latestSnapshots.length) * 100)}%`
      : '--';
    $('#statPassRateSubtext').textContent = latestSnapshots.length > 0
      ? `${passCount}/${latestSnapshots.length} latest snapshots passing`
      : 'Latest snapshots only';

    const passing = results.filter(result => result.status === 'pass');
    const avgTps = passing.length > 0
      ? (passing.reduce((sum, result) => sum + (result.tokensPerSec || 0), 0) / passing.length).toFixed(1)
      : '--';
    $('#statAvgTps').textContent = avgTps;
    $('#statAvgTpsSubtext').textContent = passing.length > 0
      ? `${passing.length} passing probe(s) in current view`
      : 'Across visible passing probes';

    const lastRun = results[0];
    $('#statLastRun').textContent = lastRun ? timeAgo(new Date(lastRun.testedAt)) : '--';
    $('#statLastRunSubtext').textContent = lastRun
      ? `${lastRun.modelName} on ${lastRun.hostId || shortUrl(lastRun.hostUrl)}`
      : 'No snapshots loaded yet';
  }

  function updateInsights(results) {
    const visible = getFilteredResults();
    const passing = visible.filter(result => result.status === 'pass');
    const failures = visible.filter(result => result.status !== 'pass');
    const fastest = [...passing].sort((a, b) => (b.tokensPerSec || 0) - (a.tokensPerSec || 0))[0];

    if (fastest) {
      $('#insightFastestTitle').textContent = `${fastest.modelName} @ ${fastest.hostId || shortUrl(fastest.hostUrl)}`;
      $('#insightFastestBody').textContent = `Measured ${formatNumber(fastest.tokensPerSec)} tok/s with ${formatLatency(fastest.latencyMs)} end-to-end latency.`;
      $('#insightFastestMetaLeft').textContent = `TTFT ${formatMs(fastest.timeToFirstTokenMs)}`;
      $('#insightFastestMetaRight').textContent = fastest.vramUsedMiB != null
        ? `VRAM ${Math.round(fastest.vramUsedMiB)} MiB`
        : 'VRAM unavailable';
    } else {
      $('#insightFastestTitle').textContent = 'No passing probes yet';
      $('#insightFastestBody').textContent = 'Run a probe to surface the best current measured throughput across the visible result set.';
      $('#insightFastestMetaLeft').textContent = '--';
      $('#insightFastestMetaRight').textContent = '--';
    }

    const freshnessBuckets = visible.reduce((acc, result) => {
      const ageHours = hoursSince(result.testedAt);
      if (ageHours <= 24) acc.fresh += 1;
      else if (ageHours <= 72) acc.aging += 1;
      else acc.stale += 1;
      return acc;
    }, { fresh: 0, aging: 0, stale: 0 });

    $('#insightReliabilityTitle').textContent = visible.length > 0
      ? `${passPercentage(visible)} pass on latest visible probes`
      : 'Waiting for signal';
    $('#insightReliabilityBody').textContent = visible.length > 0
      ? `${freshnessBuckets.fresh} fresh, ${freshnessBuckets.aging} aging, ${freshnessBuckets.stale} stale probe(s). ${failures.length > 0 ? `${failures.length} failure snapshot(s) need attention.` : 'No visible failures.'}`
      : 'Latest snapshots will summarize pass rate, recency, and whether the current host picture is fresh enough to trust for routing conversations.';
    $('#insightReliabilityMetaLeft').textContent = `${passing.length} pass / ${failures.length} fail`;
    $('#insightReliabilityMetaRight').textContent = visible[0] ? `Latest ${timeAgo(new Date(visible[0].testedAt))}` : '--';

    const leaderboardReady = passing.length > 0
      ? `${passing.length} verified probe(s) ready for leaderboard context`
      : 'No verified probe data yet';
    $('#insightBridgeTitle').textContent = leaderboardReady;
  }

  function renderHostCards() {
    if (state.hosts.length === 0) {
      hostCardsEl.innerHTML = '<div class="empty-state"><i class="fas fa-server"></i><p>No Ollama hosts configured</p></div>';
      return;
    }

    hostCardsEl.innerHTML = state.hosts.map(host => {
      const selected = state.selectedHost?.id === host.id ? ' selected' : '';
      const offline = !host.available ? ' offline' : '';
      return `
        <div class="host-card${selected}${offline}" data-host-id="${host.id}">
          <div class="host-card-header">
            <span class="host-card-name"><i class="fas fa-server" style="margin-right:6px;color:var(--muted);"></i>${host.name}</span>
            <span class="host-status-dot ${host.available ? 'online' : 'offline'}"></span>
          </div>
          <div class="host-card-url">${host.url}</div>
          <div class="host-card-stats">
            <span><i class="fas fa-cube"></i> ${host.modelCount} models</span>
            <span><i class="fas fa-clock"></i> ${host.latency}ms</span>
            ${host.error ? `<span style="color:#ef4444;"><i class="fas fa-circle-exclamation"></i> ${escapeHtml(host.error)}</span>` : ''}
          </div>
        </div>`;
    }).join('');

    hostCardsEl.querySelectorAll('.host-card:not(.offline)').forEach(card => {
      card.addEventListener('click', () => selectHost(card.dataset.hostId));
    });
  }

  function populateHostFilter() {
    const currentValue = filterHost.value;
    filterHost.innerHTML = '<option value="">All Hosts</option>';
    for (const host of state.hosts) {
      const option = document.createElement('option');
      option.value = host.url;
      option.textContent = host.name;
      filterHost.appendChild(option);
    }
    filterHost.value = currentValue;
  }

  function selectHost(hostId) {
    state.selectedHost = state.hosts.find(host => host.id === hostId) || null;
    renderHostCards();

    if (!state.selectedHost) {
      actionBar.classList.remove('visible');
      return;
    }

    actionBar.classList.add('visible');
    selectedHostLabel.textContent = `${state.selectedHost.name} • ${state.selectedHost.models.length} model(s) on ${state.selectedHost.url}`;

    modelSelect.innerHTML = '<option value="">-- Select Model --</option>';
    for (const modelName of state.selectedHost.models) {
      const option = document.createElement('option');
      option.value = modelName;
      option.textContent = modelName;
      modelSelect.appendChild(option);
    }

    testOneBtn.disabled = true;
    compareBtn.disabled = true;
  }

  async function loadHosts() {
    try {
      const data = await api('GET', '/hosts-status');
      state.hosts = data.hosts || [];
      renderHostCards();
      populateHostFilter();
      updateSummaryCards(getFilteredResults());
    } catch (err) {
      hostCardsEl.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function runSingleTest() {
    const modelName = modelSelect.value;
    const host = state.selectedHost;
    if (!modelName || !host) return;

    testOneBtn.disabled = true;
    testOneBtn.innerHTML = '<i class="fas fa-spinner spin"></i> Testing...';

    try {
      const snapshot = await api('POST', '/run', {
        modelName,
        hostUrl: host.url,
        hostId: host.id
      });
      state.results = mergeResults(state.results, [{ modelName, ...snapshot }]);
      renderAll();
      showToast(`${modelName}: ${formatNumber(snapshot.tokensPerSec)} tok/s`, snapshot.status === 'pass' ? 'success' : 'error');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      testOneBtn.disabled = !modelSelect.value || !!state.activeTestId;
      testOneBtn.innerHTML = '<i class="fas fa-play"></i> Test Selected';
    }
  }

  async function runAllTests() {
    const host = state.selectedHost;
    if (!host) return;

    testAllBtn.disabled = true;
    testOneBtn.disabled = true;
    compareBtn.disabled = true;
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

  async function runCompare() {
    const modelName = modelSelect.value;
    if (!modelName) return;

    compareBtn.disabled = true;
    compareBtn.innerHTML = '<i class="fas fa-spinner spin"></i> Comparing...';

    try {
      const data = await api('POST', '/compare', { modelName });
      const hostResults = (data.hostResults || []).map(result => ({ modelName, ...result }));
      state.results = mergeResults(state.results, hostResults);
      renderAll();

      const passing = hostResults.filter(result => result.status === 'pass');
      showToast(
        passing.length > 0
          ? `${modelName}: compared across ${passing.length} host(s)`
          : `${modelName}: no passing host comparison yet`,
        passing.length > 0 ? 'success' : 'error'
      );
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      compareBtn.disabled = !modelSelect.value || !!state.activeTestId;
      compareBtn.innerHTML = '<i class="fas fa-code-compare"></i> Compare Across Hosts';
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

        if (Array.isArray(data.results) && data.results.length > 0) {
          state.results = mergeResults(state.results, data.results);
          renderAll();
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
        state.activeTestId = null;
        progressLabel.textContent = 'Polling interrupted';
        resetRunAllUI();
      }
    }, 2000);
  }

  function resetRunAllUI() {
    testAllBtn.disabled = false;
    testAllBtn.innerHTML = '<i class="fas fa-rocket"></i> Test All Models';
    testOneBtn.disabled = !modelSelect.value;
    compareBtn.disabled = !modelSelect.value;
  }

  async function loadResults(hostUrl) {
    try {
      const query = hostUrl ? `?hostUrl=${encodeURIComponent(hostUrl)}` : '';
      const data = await api('GET', `/results${query}`);
      state.results = data.results || [];
      renderAll();
    } catch (err) {
      showToast(`Failed to load results: ${err.message}`, 'error');
    }
  }

  function renderResults() {
    const sorted = sortResults(getFilteredResults());
    if (sorted.length === 0) {
      resultsBody.innerHTML = '<tr><td colspan="8" class="empty-state"><p>No results yet. Select a host and run tests.</p></td></tr>';
      return;
    }

    resultsBody.innerHTML = sorted.map(result => {
      const tpsCls = result.tokensPerSec >= 20 ? 'tps-high' : result.tokensPerSec >= 5 ? 'tps-mid' : 'tps-low';
      const statusBadge = result.status === 'pass' ? 'badge-pass'
        : result.status === 'timeout' ? 'badge-timeout' : 'badge-error';
      const hostLabel = result.hostId || shortUrl(result.hostUrl);
      const vram = result.vramUsedMiB != null ? `${Math.round(result.vramUsedMiB)}/${Math.round(result.vramTotalMiB || 0)} MiB` : '—';
      return `
        <tr>
          <td style="font-weight:600; color:#fff;">${escapeHtml(result.modelName || result.displayName || '—')}</td>
          <td>${escapeHtml(hostLabel)}</td>
          <td class="${tpsCls}">${formatNumber(result.tokensPerSec)}</td>
          <td>${formatLatency(result.latencyMs)}</td>
          <td>${formatMs(result.timeToFirstTokenMs)}</td>
          <td style="font-size:12px;">${escapeHtml(vram)}</td>
          <td><span class="${statusBadge}">${escapeHtml(result.status)}</span></td>
          <td style="font-size:12px;color:var(--muted);">${escapeHtml(timeAgo(new Date(result.testedAt)))}</td>
        </tr>`;
    }).join('');
  }

  function renderCharts() {
    const passing = getFilteredResults().filter(result => result.status === 'pass');
    if (passing.length === 0) {
      destroyCharts();
      return;
    }

    const data = [...passing].sort((a, b) => (b.tokensPerSec || 0) - (a.tokensPerSec || 0));
    const labels = data.map(result => `${shortModel(result.modelName)} • ${result.hostId || shortUrl(result.hostUrl)}`);
    const colors = data.map(result => HOST_COLORS[result.hostId] || HOST_COLORS.default);

    renderTpsChart(labels, data.map(result => result.tokensPerSec || 0), colors);
    renderLatencyChart(
      labels,
      data.map(result => result.timeToFirstTokenMs || 0),
      data.map(result => Math.max(0, (result.latencyMs || 0) - (result.timeToFirstTokenMs || 0)))
    );
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
          backgroundColor: colors.map(color => `${color}99`),
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

  function renderLatencyChart(labels, ttft, generation) {
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
            data: generation,
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
            ticks: {
              color: '#94a3b8',
              callback: (value) => value > 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`
            }
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

  function renderAll() {
    const filtered = getFilteredResults();
    updateSummaryCards(filtered);
    updateInsights(filtered);
    renderResults();
    renderCharts();
  }

  function shortUrl(url) {
    if (!url) return '—';
    try { return new URL(url).hostname; } catch (_) { return url; }
  }

  function shortModel(name) {
    if (!name) return '—';
    return name.length > 30 ? `${name.slice(0, 27)}...` : name;
  }

  function formatNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : '—';
  }

  function formatMs(value) {
    return Number.isFinite(Number(value)) ? `${Math.round(Number(value))}ms` : '—';
  }

  function formatLatency(value) {
    return Number.isFinite(Number(value)) ? `${(Number(value) / 1000).toFixed(1)}s` : '—';
  }

  function timeAgo(date) {
    const sec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  function hoursSince(value) {
    return Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000);
  }

  function passPercentage(results) {
    if (!results.length) return '0%';
    return `${Math.round((results.filter(result => result.status === 'pass').length / results.length) * 100)}%`;
  }

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  document.querySelectorAll('.ht-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sortField = field;
        state.sortDir = field === 'modelName' || field === 'hostId' ? 'asc' : 'desc';
      }
      persistUiState();
      renderResults();
    });
  });

  modelSelect.addEventListener('change', () => {
    testOneBtn.disabled = !modelSelect.value || !!state.activeTestId;
    compareBtn.disabled = !modelSelect.value || !!state.activeTestId;
  });

  testOneBtn.addEventListener('click', runSingleTest);
  testAllBtn.addEventListener('click', runAllTests);
  compareBtn.addEventListener('click', runCompare);
  $('#refreshBtn').addEventListener('click', () => {
    loadHosts();
    loadResults(filterHost.value || undefined);
  });
  filterHost.addEventListener('change', () => {
    persistUiState();
    renderAll();
  });
  latestOnlyToggle.addEventListener('change', () => {
    state.latestOnly = latestOnlyToggle.checked;
    persistUiState();
    renderAll();
  });

  loadUiState();
  if (latestOnlyToggle) latestOnlyToggle.checked = state.latestOnly;
  loadHosts();
  loadResults();
})();
