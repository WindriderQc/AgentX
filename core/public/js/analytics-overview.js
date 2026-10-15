/** Overview reads raw, window-scoped receipts; it never parses rounded DOM tiles. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const count = value => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
  const compact = value => finite(value) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
  const percent = value => finite(value) ? `${value.toFixed(1)}%` : '—';
  const duration = ms => !finite(ms) ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  const hours = value => finite(value) ? `${value.toFixed(2)}h` : '—';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  let summary = null;
  let groupBy = 'byModel';
  let trend = null;
  let livePending = false;

  function outcome(totals) {
    const t = totals || {};
    if (!finite(t.calls) || t.calls <= 0 || !finite(t.nonSuccesses) || t.nonSuccesses < 0 || t.nonSuccesses > t.calls) return null;
    return (t.calls - t.nonSuccesses) / t.calls * 100;
  }

  // Denominators always use all recorded calls, even if only the top rows fit.
  function comparisonRows(data, field, limit = 3) {
    const calls = data.totals?.calls;
    const rows = [...(data[field] || [])].sort((a, b) => b.calls - a.calls);
    const shown = rows.slice(0, limit).map(row => ({
      ...row, label: row[field === 'byModel' ? 'model' : 'consumerContract'] || 'Unknown',
      share: calls > 0 ? row.calls / calls * 100 : null
    }));
    const remainder = calls - shown.reduce((sum, row) => sum + row.calls, 0);
    if (remainder > 0) shown.push({ label: 'All other calls', calls: remainder, share: remainder / calls * 100, other: true });
    return shown;
  }

  function buckets(data) {
    const step = (data.bucketHours || 24) * 3600000;
    const from = Date.parse(data.window?.from), to = Date.parse(data.window?.to);
    if (!finite(from) || !finite(to) || to <= from) return [];
    const observed = new Map((data.byBucket || []).map(row => [Date.parse(row.date), row]));
    const result = [];
    // Only fill empty buckets inside a successfully read historical window.
    for (let at = Math.floor(from / step) * step; at < to && result.length < 100; at += step) {
      const row = observed.get(at) || { calls: 0, errors: 0 };
      result.push({ ...row, at, errorPct: row.calls > 0 ? row.errors / row.calls * 100 : null });
    }
    return result;
  }

  function runtimeView(data, now = Date.now()) {
    if (!Array.isArray(data?.inferences) || !Array.isArray(data?.workloads)) return null;
    const known = data.inferences.filter(row => row.active === true && !row.quarantined && Date.parse(row.expiresAt) > now);
    return { active: known, uncertain: data.inferences.length - known.length, workloads: data.workloads.length, maintenance: Boolean(data.maintenance) };
  }

  function gpuRows(hosts, elapsedMs = 0) {
    const seen = new Set(), rows = [];
    for (const host of hosts || []) {
      if (host.residency === 'cpu') continue;
      const telemetry = host.telemetry || {};
      const age = telemetry.ageMs == null ? null : telemetry.ageMs + elapsedMs;
      const fresh = telemetry.status === 'fresh' && finite(age) && finite(telemetry.staleAfterMs) && age <= telemetry.staleAfterMs;
      if (!fresh || !host.gpus?.length) {
        rows.push({ label: host.hostname || host.hostId, fresh: false, state: telemetry.status === 'fresh' ? 'stale' : telemetry.status || 'unavailable' });
        continue;
      }
      for (const gpu of host.gpus) {
        const key = `${telemetry.collectorHostId || host.hostId}:${gpu.busId || gpu.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ ...gpu, label: `${host.hostname || host.hostId} / GPU ${gpu.index ?? '?'}`, fresh: true, age });
      }
    }
    return rows;
  }

  function renderComparison() {
    if (!summary) return;
    const rows = comparisonRows(summary, groupBy);
    $('ao-comparison').innerHTML = rows.length ? rows.map(row => `<div class="ao-model${row.other ? ' is-other' : ''}">
      <span class="ao-model-name" style="--share:${Math.max(0, Math.min(100, row.share || 0))}%" title="${esc(row.label)} · ${esc(percent(row.share))} of all recorded calls">${esc(row.label)}</span>
      <span>${esc(count(row.calls))}</span><span>${row.other ? '—' : esc(duration(row.calls > 0 ? row.avgLatencyMs : null))}</span><span>${row.other ? '—' : esc(percent(row.calls > 0 ? row.errorRate : null))}</span></div>`).join('')
      : '<p class="ao-empty">No recorded activity in this window.</p>';
    set('ao-model-note', groupBy === 'byModel' ? 'Calls compared with elapsed time · all other models included in remainder' : 'Server-attested consumers · unknown means unattributed');
  }

  function renderTrend(data) {
    if (trend) { trend.destroy(); trend = null; }
    const canvas = $('ao-trend-chart');
    // Older Core payloads can still feed the overview without inventing hourly data.
    if (!Array.isArray(data.byBucket)) {
      canvas.hidden = true;
      $('ao-trend-empty').hidden = false;
      set('ao-trend-empty', 'Time buckets unavailable. See daily detail below.');
      return;
    }
    const rows = buckets(data), empty = !(data.totals?.calls > 0);
    canvas.hidden = empty;
    $('ao-trend-empty').hidden = !empty;
    set('ao-trend-empty', 'No recorded calls in this window.');
    set('ao-trend-note', `${data.bucketHours === 1 ? 'Hourly' : 'Daily'} UTC · edge buckets partial · errors exclude cancellations`);
    if (empty || typeof Chart === 'undefined') return;
    const hourly = data.bucketHours === 1;
    trend = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(row => new Date(row.at).toLocaleString('en-US', { timeZone: 'UTC', ...(hourly ? { hour: '2-digit', hour12: false } : { month: 'short', day: 'numeric' }) })),
        datasets: [
          { label: 'Calls', data: rows.map(row => row.calls), backgroundColor: '#6d9df580', hoverBackgroundColor: '#8fb7ff', borderRadius: 3, yAxisID: 'calls', order: 2 },
          { type: 'line', label: 'Operational errors %', data: rows.map(row => row.errorPct), borderColor: '#f0b47d', backgroundColor: '#f0b47d', yAxisID: 'rate', borderWidth: 2, pointRadius: rows.length < 40 ? 2 : 0, tension: .25, order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: items => items.length ? `${new Date(rows[items[0].dataIndex].at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '',
          label: item => item.dataset.yAxisID === 'rate' ? `Errors: ${percent(item.raw)}` : `Calls: ${count(item.raw)}`
        } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8e9db5', maxTicksLimit: 9, maxRotation: 0, font: { size: 10 } } },
          calls: { beginAtZero: true, grid: { color: '#ffffff09' }, ticks: { color: '#8e9db5', maxTicksLimit: 4, precision: 0, font: { size: 10 } } },
          rate: { position: 'right', beginAtZero: true, suggestedMax: 1, grid: { display: false }, ticks: { color: '#c99b77', maxTicksLimit: 4, callback: v => `${v}%`, font: { size: 10 } } }
        }
      }
    });
  }

  function renderSummary(data) {
    summary = data;
    const t = data.totals || {}, hasCalls = t.calls > 0;
    const success = outcome(t);
    const status = $('ao-status');
    status.dataset.state = hasCalls ? (t.errors > 0 ? 'attention' : 'ready') : 'empty';
    set('ao-status', hasCalls ? (t.errors > 0 ? 'Recorded errors need review' : 'No operational errors recorded') : 'No recorded calls in this window');
    set('ao-calls', count(t.calls));
    set('ao-calls-note', `${count(t.callsPerDay)} / day · ${count(data.coverage?.modelCount ?? data.byModel?.length)} models`);
    set('ao-success', percent(success));
    set('ao-outcomes', `${count(t.errors)} errors · ${count(t.cancellations)} canceled / ${count(t.calls)} calls`);
    set('ao-output', hasCalls ? compact(t.tokensOut) : '—');
    set('ao-input', hasCalls ? `${compact(t.tokensIn)} prompt tokens · reported usage only` : 'No token usage observed');
    set('ao-latency', duration(hasCalls ? t.avgLatencyMs : null));
    set('ao-time', hasCalls ? `${hours(t.inferenceHours)} summed call time · includes waits` : 'No call duration observed');
    if (hasCalls && finite(t.timedCalls) && t.timedCalls < t.calls) set('ao-time', `${count(t.timedCalls)} / ${count(t.calls)} calls timed · includes waits`);
    set('ao-fallbacks', `${count(t.fallbackCalls)} fallbacks${hasCalls ? ` · ${percent(t.fallbackRate)}` : ''}`);
    set('ao-local-calls', count(data.local?.calls));
    set('ao-local-share', hasCalls && finite(data.local?.calls) ? `${percent(data.local.calls / t.calls * 100)} of recorded calls` : 'No call share observed');
    set('ao-local-time', data.local?.calls > 0 ? hours(data.local.inferenceHours) : '—');
    const cloud = data.cloud || {};
    set('ao-cloud-cost', cloud.calls === 0 ? 'No calls' : finite(cloud.estimatedCostUsd) ? `$${cloud.estimatedCostUsd.toFixed(2)}` : 'Unpriced');
    set('ao-cloud-note', cloud.calls === 0 ? 'No recorded cloud traffic' : `${count(cloud.calls)} calls · ${cloud.unpricedModels?.length ? `${cloud.unpricedModels.length} unpriced models excluded` : 'USD estimate, configured rates'}`);
    const to = new Date(data.window.to);
    set('ao-updated', `Snapshot ${to.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · refresh on demand`);
    const c = data.coverage;
    set('ao-coverage', `Recorded AgentX calls only; native calls bypassing Core are outside this view. ${c ? `${c.retentionDays}-day log retention${c.requestedDays > c.retentionDays ? ` limits this ${c.requestedDays}-day window` : ''}. ` : ''}Reported tokens may omit unreported usage. Summed call time is not GPU busy time.`);
    renderComparison();
    renderTrend(data);
  }

  function clearSummary(state) {
    summary = null;
    if (trend) { trend.destroy(); trend = null; }
    $('ao-trend-chart').hidden = true;
    $('ao-trend-empty').hidden = false;
    const message = state === 'error' ? 'Activity unavailable. Refresh to retry.' : 'Reading this window…';
    set('ao-trend-empty', message);
    $('ao-status').dataset.state = state;
    set('ao-status', message);
    set('ao-updated', '');
    ['ao-calls', 'ao-success', 'ao-output', 'ao-latency', 'ao-local-calls', 'ao-local-time', 'ao-cloud-cost'].forEach(id => set(id, '—'));
    ['ao-calls-note', 'ao-outcomes', 'ao-input', 'ao-time', 'ao-fallbacks', 'ao-local-share', 'ao-cloud-note', 'ao-model-note'].forEach(id => set(id, 'Waiting for this window’s data'));
    set('ao-comparison', message);
  }

  async function readJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.ok === false || body.status === 'error' || body.data == null) throw new Error('Unavailable');
    return body.data;
  }

  async function refreshRuntime() {
    try {
      const view = runtimeView(await readJSON('/api/nerve-center/runtime-coordination/active'));
      if (!view) throw new Error('Malformed runtime snapshot');
      set('ao-active', count(view.active.length));
      set('ao-live-status', [view.uncertain ? `${view.uncertain} uncertain; still held` : 'Core admissions, not GPU utilization', view.workloads ? `${view.workloads} workloads held` : '', view.maintenance ? 'Maintenance held' : ''].filter(Boolean).join(' · '));
      const models = new Map();
      view.active.forEach(row => models.set(row.model || 'Unknown model', (models.get(row.model || 'Unknown model') || 0) + 1));
      const rows = [...models.entries()];
      set('ao-active-models', rows.slice(0, 2).map(([model, n]) => `${n} × ${model}`).join(' · ') + (rows.length > 2 ? ` · +${rows.length - 2} models` : ''));
      set('ao-live-updated', `Core ${new Date().toLocaleTimeString()} · every 15 s`);
    } catch {
      set('ao-active', '—');
      set('ao-live-status', 'Core activity unavailable; current work unknown');
      set('ao-active-models', '');
      set('ao-live-updated', 'Live read failed · retry in 15 s');
    }
  }

  async function refreshGPUs() {
    try {
      const hosts = await readJSON('/api/nerve-center/inference/gpu-status');
      if (!Array.isArray(hosts)) throw new Error('Malformed GPU snapshot');
      const rows = gpuRows(hosts);
      $('ao-gpus').innerHTML = rows.map(row => {
        if (!row.fresh) return `<div class="ao-gpu is-unknown"><span>${esc(row.label)}</span><span>Unknown</span><small>GPU telemetry ${esc(row.state.replaceAll('_', ' '))}</small></div>`;
        const utilization = finite(row.utilization) ? Math.max(0, Math.min(100, row.utilization)) : null;
        const vram = finite(row.vramUsed) && row.vramTotal > 0 ? `${(row.vramUsed / 1024).toFixed(1)} / ${(row.vramTotal / 1024).toFixed(1)} GiB VRAM` : 'VRAM unknown';
        return `<div class="ao-gpu"><span title="${esc(row.name)}">${esc(row.label)}</span><div class="ao-meter"><span style="width:${utilization ?? 0}%"></span></div><strong>${finite(utilization) ? `${Math.round(utilization)}%` : '—'}</strong><small>${esc(vram)} · ${Math.round(row.age / 1000)}s old${finite(row.powerDraw) ? ` · ${Math.round(row.powerDraw)} W` : ''}</small></div>`;
      }).join('') || '<p class="ao-empty">No GPU collector evidence. Open Nerve Center for hosts.</p>';
    } catch {
      $('ao-gpus').innerHTML = '<p class="ao-empty">GPU telemetry unavailable · utilization unknown</p>';
    }
  }

  async function refreshLive() {
    if (!$('ao-active') || document.hidden || livePending) return;
    livePending = true;
    try { await Promise.allSettled([refreshRuntime(), refreshGPUs()]); }
    finally { livePending = false; }
  }

  function init() {
    const overview = document.querySelector('.analytics-overview');
    if (!overview) return;
    document.addEventListener('analytics:inference', event => {
      const { state, data, windowKey } = event.detail;
      $('analyticsWindow').value = windowKey;
      overview.dataset.state = state;
      overview.setAttribute('aria-busy', String(state === 'loading'));
      if (state === 'ready') renderSummary(data);
      else clearSummary(state);
    });
    $('analyticsWindow').addEventListener('change', event => {
      $('infWindow').value = event.target.value;
      $('infWindow').dispatchEvent(new Event('change'));
    });
    document.querySelectorAll('[data-ao-group]').forEach(button => button.addEventListener('click', () => {
      groupBy = button.dataset.aoGroup;
      document.querySelectorAll('[data-ao-group]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      renderComparison();
    }));
    document.addEventListener('analytics:refresh-live', refreshLive);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(); });
    refreshLive();
    window.setInterval(() => {
      if (summary && Date.now() - Date.parse(summary.window?.to) > 300000) {
        $('ao-status').dataset.state = 'stale';
        set('ao-status', 'Snapshot older than 5 minutes · refresh to update');
      }
      refreshLive();
    }, 15000);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { outcome, comparisonRows, buckets, runtimeView, gpuRows };
  // Loaded after the markup: subscribe before deferred inference modules run.
  if (typeof document !== 'undefined') init();
})();
