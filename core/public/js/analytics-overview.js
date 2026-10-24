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
  let overlay = 'errors';
  let livePending = false;

  function outcome(totals) {
    const t = totals || {};
    if (!finite(t.calls) || t.calls <= 0 || !finite(t.nonSuccesses) || t.nonSuccesses < 0 || t.nonSuccesses > t.calls) return null;
    return (t.calls - t.nonSuccesses) / t.calls * 100;
  }

  function outcomeSplit(t) {
    if (outcome(t) == null || ![t.errors, t.cancellations].every(n => finite(n) && n >= 0)
      || t.errors + t.cancellations !== t.nonSuccesses) return null;
    return { success: t.calls - t.nonSuccesses, errors: t.errors, canceled: t.cancellations, total: t.calls };
  }

  function callSplit(data) {
    const total = data.totals?.calls, local = data.local?.calls, cloud = data.cloud?.calls;
    if (!(total > 0) || ![local, cloud].every(n => finite(n) && n >= 0) || local + cloud !== total) return null;
    return { local, cloud, total, localPct: local / total * 100 };
  }

  // Each mini-chart starts at zero; absent observations create gaps, not a line.
  function sparkPaths(values) {
    const known = values.filter(n => finite(n) && n >= 0);
    if (known.length < 2 || values.length < 2) return null;
    const max = Math.max(...known), groups = [];
    let group = [];
    values.forEach((n, i) => {
      if (!finite(n) || n < 0) { if (group.length) groups.push(group); group = []; return; }
      group.push([2 + i / (values.length - 1) * 96, max > 0 ? 27 - n / max * 24 : 27]);
    });
    if (group.length) groups.push(group);
    const point = p => p.map(n => n.toFixed(2)).join(',');
    return {
      line: groups.map(points => `M${points.map(point).join(' L')}`).join(' '),
      area: groups.filter(points => points.length > 1).map(points => `M${point([points[0][0], 29])} L${points.map(point).join(' L')} L${point([points.at(-1)[0], 29])} Z`).join(' ')
    };
  }

  function renderVisuals(data) {
    const active = data.totals?.calls > 0;
    const rows = active && Array.isArray(data.byBucket) ? buckets(data) : [];
    const series = {
      calls: rows.map(row => row.calls),
      output: rows.map(row => row.calls === 0 ? 0 : row.tokensOut),
      latency: rows.map(row => row.calls > 0 ? row.avgLatencyMs : null)
    };
    for (const [key, values] of Object.entries(series)) {
      const paths = sparkPaths(values);
      const label = `${key === 'output' ? 'Reported output tokens' : key === 'latency' ? 'Mean call latency' : 'Recorded calls'} by ${data.bucketHours === 1 ? 'hourly' : 'daily'} UTC bucket; zero baseline, independent scale, gaps unobserved`;
      $(`ao-${key}-spark`).innerHTML = paths ? `<svg viewBox="0 0 100 32" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><path class="ao-spark-area" d="${paths.area}"/><path class="ao-spark-line" d="${paths.line}"/></svg>` : '';
    }
    const parts = outcomeSplit(data.totals || {}), ring = $('ao-outcome-ring');
    ring.classList.toggle('is-empty', !parts);
    ring.style.setProperty('--success-end', `${parts ? parts.success / parts.total * 100 : 0}%`);
    ring.style.setProperty('--error-end', `${parts ? (parts.success + parts.errors) / parts.total * 100 : 0}%`);
    ring.setAttribute('aria-label', parts ? `${count(parts.success)} successful, ${count(parts.errors)} errors, ${count(parts.canceled)} canceled out of ${count(parts.total)} recorded calls` : 'Outcomes not observed');
    ring.title = ring.getAttribute('aria-label');
    set('ao-outcome-count', parts ? compact(parts.success) : '—');
    const mix = callSplit(data), mixRing = $('ao-mix-ring');
    mixRing.classList.toggle('is-empty', !mix);
    mixRing.style.setProperty('--local-end', `${mix?.localPct ?? 0}%`);
    mixRing.setAttribute('aria-label', mix ? `${count(mix.local)} local calls and ${count(mix.cloud)} cloud calls out of ${count(mix.total)} recorded calls` : 'Local and cloud call split not observed');
    mixRing.title = mixRing.getAttribute('aria-label');
    set('ao-mix-value', mix ? percent(mix.localPct) : '—');
  }

  // Denominators always use all recorded calls, even if only the top rows fit.
  function comparisonRows(data, field, limit = 3) {
    const calls = data.totals?.calls;
    const elapsed = data.totals?.inferenceSeconds;
    const rows = [...(data[field] || [])].sort((a, b) => b.calls - a.calls);
    const shown = rows.slice(0, limit).map(row => ({
      ...row, label: row[field === 'byModel' ? 'model' : 'consumerContract'] || 'Unknown',
      share: calls > 0 ? row.calls / calls * 100 : null,
      timeShare: elapsed > 0 && row.inferenceSeconds > 0 ? row.inferenceSeconds / elapsed * 100 : null
    }));
    const remainder = calls - shown.reduce((sum, row) => sum + row.calls, 0);
    if (remainder > 0) {
      const measured = shown.every(row => finite(row.inferenceSeconds));
      const remainingTime = measured ? elapsed - shown.reduce((sum, row) => sum + row.inferenceSeconds, 0) : null;
      shown.push({ label: 'All other calls', calls: remainder, share: remainder / calls * 100,
        timeShare: elapsed > 0 && remainingTime > 0 ? remainingTime / elapsed * 100 : null, other: true });
    }
    return shown;
  }

  const failureLabels = {
    admission_refused: 'Admission refused (cause unspecified)',
    workload_reserved: 'Workload reserved', workload_yielded: 'Workload yielded',
    inference_recovery_required: 'Inference recovery', maintenance_recovery_required: 'Maintenance recovery',
    workload_recovery_required: 'Workload recovery', inference_active: 'Inference active',
    inference_residency_active: 'Residency conflict', maintenance_active: 'Maintenance active',
    upstream_timeout: 'Timeout', upstream_error: 'Upstream error',
    unclassified_error: 'Cause unrecorded', runtime_inference_admission_denied: 'Admission refused',
    runtime_inference_recovery_required: 'Runtime recovery', benchmark_claim_active: 'Benchmark reserved',
    lane_context_exceeded: 'Lane context exceeded', topology_role_unresolved: 'Topology role unresolved',
  };
  const failureLabel = reason => failureLabels[reason] || String(reason || 'unclassified_error').replaceAll('_', ' ');
  function failureRows(data, limit = 3) {
    if (!data.failureAnalysis || !Array.isArray(data.topErrors)) return null;
    const total = data.totals?.errors;
    if (!(total > 0)) return [];
    const rows = [...data.topErrors].sort((a, b) => b.calls - a.calls).slice(0, limit).map(row => ({
      ...row, label: failureLabel(row.reason), share: row.calls / total * 100,
    }));
    const other = total - rows.reduce((sum, row) => sum + row.calls, 0);
    if (other > 0) rows.push({ label: 'All other errors', calls: other, share: other / total * 100, other: true });
    return rows;
  }

  function renderFailures() {
    const rows = failureRows(summary);
    $('ao-comparison').innerHTML = rows?.length ? rows.map(row => `<div class="ao-model ao-failure${row.other ? ' is-other' : ''}">
      <span class="ao-model-name" style="--share:${Math.max(0, Math.min(100, row.share || 0))}%" title="${esc(`${row.label} · ${row.consumerContract || ''} · ${row.model || ''}`)}"><span>${esc(row.label)}${row.other ? '' : `<small>${esc(row.consumerContract)}</small>`}</span></span>
      <span>${esc(count(row.calls))}</span><span>${esc(duration(row.avgLatencyMs))}</span><span>${esc(percent(row.share))}</span></div>`).join('')
      : `<p class="ao-empty">${rows ? 'No operational errors in this window.' : 'Error causes unavailable from this Core version.'}</p>`;
    set('ao-model-note', 'Recorded attempts · retries may repeat one request');
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

  const { runtimeView, gpuRows } = typeof module !== 'undefined' && module.exports
    ? require('./analytics-live-values') : window.AgentXAnalyticsLiveValues;

  function renderComparison() {
    if (!summary) return;
    const errors = groupBy === 'byErrors';
    set('ao-model-title', errors ? 'Where calls fail' : 'Where the work goes');
    $('ao-comparison-head').innerHTML = errors ? '<span>Cause · consumer</span><span>Errors</span><span>Mean time</span><span>Share</span>' : '<span>Share of recorded calls</span><span>Calls</span><span>Mean time</span><span>Errors</span>';
    $('ao-comparison-key').hidden = errors;
    $('ao-comparison-detail').dataset.analyticsTarget = errors ? 'infErrorLink' : 'analytics-models';
    set('ao-comparison-detail', errors ? 'Error details →' : 'Full comparison →');
    if (errors) return renderFailures();
    const rows = comparisonRows(summary, groupBy);
    $('ao-comparison').innerHTML = rows.length ? rows.map(row => `<div class="ao-model${row.other ? ' is-other' : ''}">
      <span class="ao-model-name" style="--share:${Math.max(0, Math.min(100, row.share || 0))}%;--time-share:${Math.max(0, Math.min(100, row.timeShare || 0))}%" title="${esc(row.label)} · ${esc(percent(row.share))} of calls · ${esc(percent(row.timeShare))} of recorded elapsed time"><span>${esc(row.label)}</span></span>
      <span>${esc(count(row.calls))}</span><span>${row.other ? '—' : esc(duration(row.calls > 0 ? row.avgLatencyMs : null))}</span><span>${row.other ? '—' : esc(percent(row.calls > 0 ? row.errorRate : null))}</span></div>`).join('')
      : '<p class="ao-empty">No recorded activity in this window.</p>';
    set('ao-model-note', groupBy === 'byConsumerContract' ? 'Server-attested consumers · unknown means contract missing' : 'Share of window total · durations include waits');
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
    const rows = buckets(data), empty = !(data.totals?.calls > 0), latency = overlay === 'latency';
    const color = latency ? '#bd9df7' : '#f0b47d';
    set('ao-overlay-label', latency ? 'Mean latency (s)' : 'Errors %');
    $('ao-overlay-label').style.setProperty('--overlay-color', color);
    canvas.setAttribute('aria-label', `Inference calls and ${latency ? 'mean end-to-end latency' : 'operational error rate'} over time; separate labeled axes`);
    canvas.hidden = empty;
    $('ao-trend-empty').hidden = !empty;
    set('ao-trend-empty', 'No recorded calls in this window.');
    const basis = latency ? (rows.some(row => row.calls > 0 && finite(row.avgLatencyMs)) ? 'mean end-to-end latency' : 'latency not observed') : 'errors exclude cancellations';
    set('ao-trend-note', `${data.bucketHours === 1 ? 'Hourly' : 'Daily'} UTC · edge buckets partial · ${basis}`);
    if (empty || typeof Chart === 'undefined') return;
    const hourly = data.bucketHours === 1;
    trend = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(row => new Date(row.at).toLocaleString('en-US', { timeZone: 'UTC', ...(hourly ? { hour: '2-digit', hour12: false } : { month: 'short', day: 'numeric' }) })),
        datasets: [
          { label: 'Calls', data: rows.map(row => row.calls), backgroundColor: '#6d9df580', hoverBackgroundColor: '#8fb7ff', borderRadius: 3, yAxisID: 'calls', order: 2 },
          { type: 'line', label: latency ? 'Mean latency (s)' : 'Operational errors %', data: rows.map(row => latency ? (row.calls > 0 && finite(row.avgLatencyMs) ? row.avgLatencyMs / 1000 : null) : row.errorPct), borderColor: color, backgroundColor: color, yAxisID: 'rate', borderWidth: 2, pointRadius: rows.length < 40 ? 2 : 0, tension: .25, order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: items => items.length ? `${new Date(rows[items[0].dataIndex].at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '',
          label: item => item.dataset.yAxisID === 'rate' ? (latency ? `Mean call latency: ${duration(finite(item.raw) ? item.raw * 1000 : null)}` : `Errors: ${percent(item.raw)}`) : `Calls: ${count(item.raw)}`
        } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8e9db5', maxTicksLimit: 9, maxRotation: 0, font: { size: 10 } } },
          calls: { beginAtZero: true, grid: { color: '#ffffff09' }, ticks: { color: '#8e9db5', maxTicksLimit: 4, precision: 0, font: { size: 10 } } },
          rate: { position: 'right', beginAtZero: true, suggestedMax: 1, grid: { display: false }, ticks: { color, maxTicksLimit: 4, callback: v => `${v}${latency ? 's' : '%'}`, font: { size: 10 } } }
        }
      }
    });
  }

  // Review threshold: a single old failure in a busy window is noise. Flag the
  // window when at least 3 operational errors push the rate above 2 %, or
  // when any error happened in the last hour (a fresh outage must not be
  // diluted by a 7- or 30-day window).
  const REVIEW_MIN_ERRORS = 3;
  const REVIEW_ERROR_RATE_PCT = 2;
  function needsReview(totals = {}, recent = null) {
    if ((Number(recent?.errors) || 0) > 0) return true;
    const errors = Number(totals.errors) || 0;
    const calls = Number(totals.calls) || 0;
    const rate = Number.isFinite(Number(totals.errorRate)) ? Number(totals.errorRate) : (calls > 0 ? errors / calls * 100 : 0);
    return errors >= REVIEW_MIN_ERRORS && rate > REVIEW_ERROR_RATE_PCT;
  }

  function statusText(totals = {}, recent = null) {
    const errors = Number(totals.errors) || 0;
    const recentErrors = Number(recent?.errors) || 0;
    if (!(totals.calls > 0)) return { state: 'empty', text: 'No recorded calls in this window' };
    if (recentErrors > 0) return { state: 'attention', text: `${count(recentErrors)} error${recentErrors === 1 ? '' : 's'} in the last hour need review` };
    if (needsReview(totals)) return { state: 'attention', text: 'Error rate needs review' };
    if (errors > 0) return { state: 'ready', text: `${count(errors)} recorded error${errors === 1 ? '' : 's'} · below the ${REVIEW_ERROR_RATE_PCT}% review threshold` };
    return { state: 'ready', text: 'No operational errors recorded' };
  }

  function renderSummary(data) {
    summary = data;
    const t = data.totals || {}, hasCalls = t.calls > 0;
    const success = outcome(t);
    const status = $('ao-status');
    const view = statusText(t, data.recent);
    status.dataset.state = view.state;
    set('ao-status', view.text);
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
    const focus = $('ao-error-focus'), refusals = data.failureAnalysis?.admissionRefusals;
    focus.hidden = !(t.errors > 0);
    focus.textContent = finite(refusals) ? `${count(refusals)} / ${count(t.errors)} errors: admission refused →` : 'Explore recorded errors →';
    if (finite(data.failureAnalysis?.unclassified) && data.failureAnalysis.unclassified > 0) focus.textContent += ` · ${count(data.failureAnalysis.unclassified)} causes unrecorded`;
    focus.title = 'Recorded attempts, not failed user requests. Refusals do not dispatch inference; retries can create several records.';
    set('ao-local-calls', count(data.local?.calls));
    set('ao-local-share', hasCalls && finite(data.local?.calls) ? `${percent(data.local.calls / t.calls * 100)} of recorded calls` : 'No call share observed');
    set('ao-local-time', data.local?.calls > 0 ? hours(data.local.inferenceHours) : '—');
    const cloud = data.cloud || {};
    set('ao-cloud-cost', cloud.calls === 0 ? 'No calls' : finite(cloud.estimatedCostUsd) ? `$${cloud.estimatedCostUsd.toFixed(2)}` : 'Unpriced');
    set('ao-cloud-note', cloud.calls === 0 ? 'No recorded cloud traffic' : `${count(cloud.calls)} calls · ${cloud.unpricedModels?.length ? `${cloud.unpricedModels.length} unpriced models excluded` : 'USD estimate, configured rates'}`);
    renderAttribution(data);
    const to = new Date(data.window.to);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    set('ao-updated', `${new Date(data.window.from).toLocaleString()} → ${to.toLocaleString()} (${zone}) · refresh on demand`);
    const c = data.coverage;
    set('ao-coverage', `Recorded attempts, including admission refusals; retries may repeat one client request. Native calls bypassing Core are outside this view. ${c ? `${c.retentionDays}-day log retention${c.requestedDays > c.retentionDays ? ` limits this ${c.requestedDays}-day window` : ''}. ` : ''}Reported tokens may omit unreported usage. Summed call time is not GPU busy time.`);
    renderComparison();
    renderTrend(data);
    renderVisuals(data);
  }

  function renderAttribution(data) {
    const a = data.attribution, link = $('ao-attribution-logs');
    link.hidden = true;
    if (!a || !(a.calls > 0)) {
      set('ao-attribution', a?.calls === 0 ? 'No recorded calls to attribute.' : 'Consumer attribution unavailable from this Core version.');
      return;
    }
    const breakdown = (a.missingByCaller || []).map(row => `${count(row.calls)} ${row.caller}`).join(' · ');
    set('ao-attribution', `${count(a.identifiedCalls)} / ${count(a.calls)} calls have an identified consumer · ${count(a.missingCalls)} missing${breakdown ? ` (${breakdown})` : ''}. Runtime and task type do not establish application identity.`);
    if (a.missingCalls > 0) {
      link.href = `/api/analytics/inference/logs?${new URLSearchParams({ consumerContractMissing: 'true', from: data.window.from, to: data.window.to })}`;
      link.hidden = false;
    }
  }

  function clearSummary(state) {
    summary = null;
    set('ao-attribution', 'Consumer attribution unavailable for this window');
    $('ao-attribution-logs').hidden = true;
    if (trend) { trend.destroy(); trend = null; }
    $('ao-trend-chart').hidden = true;
    $('ao-trend-empty').hidden = false;
    const message = state === 'error' ? 'Activity unavailable. Refresh to retry.' : 'Reading this window…';
    set('ao-trend-empty', message);
    $('ao-status').dataset.state = state;
    set('ao-status', message);
    set('ao-updated', '');
    $('ao-error-focus').hidden = true;
    set('ao-error-focus', '');
    ['ao-calls', 'ao-success', 'ao-output', 'ao-latency', 'ao-local-calls', 'ao-local-time', 'ao-cloud-cost'].forEach(id => set(id, '—'));
    ['ao-calls-note', 'ao-outcomes', 'ao-input', 'ao-time', 'ao-fallbacks', 'ao-local-share', 'ao-cloud-note', 'ao-model-note'].forEach(id => set(id, 'Waiting for this window’s data'));
    set('ao-comparison', message);
    renderVisuals({});
  }

  async function readJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.ok === false || body.status === 'error' || body.data == null) throw new Error('Unavailable');
    return body;
  }

  async function refreshRuntime() {
    window.AgentXPresentedLiveContent ||= {};
    window.AgentXPresentedLiveContent.runtime = { status: 'loading' };
    try {
      const body = await readJSON('/api/nerve-center/runtime-coordination/active');
      const view = runtimeView(body.data);
      if (!view) throw new Error('Malformed runtime snapshot');
      set('ao-active', count(view.active.length));
      set('ao-live-status', [view.uncertain ? `${view.uncertain} uncertain; still held` : 'Core admissions, not GPU utilization', view.workloads ? `${view.workloads} workloads held` : '', view.maintenance ? 'Maintenance held' : ''].filter(Boolean).join(' · '));
      const models = new Map();
      view.active.forEach(row => models.set(row.model || 'Unknown model', (models.get(row.model || 'Unknown model') || 0) + 1));
      const rows = [...models.entries()];
      set('ao-active-models', rows.slice(0, 2).map(([model, n]) => `${n} × ${model}`).join(' · ') + (rows.length > 2 ? ` · +${rows.length - 2} models` : ''));
      set('ao-live-updated', `Core ${new Date().toLocaleTimeString()} · every 15 s`);
      window.AgentXPresentedLiveContent.runtime = { status: 'visible', read: body.presentation || null };
    } catch {
      window.AgentXPresentedLiveContent.runtime = { status: 'unavailable' };
      set('ao-active', '—');
      set('ao-live-status', 'Core activity unavailable; current work unknown');
      set('ao-active-models', '');
      set('ao-live-updated', 'Live read failed · retry in 15 s');
    }
  }

  async function refreshGPUs() {
    window.AgentXPresentedLiveContent ||= {};
    window.AgentXPresentedLiveContent.gpus = { status: 'loading' };
    try {
      const body = await readJSON('/api/nerve-center/inference/gpu-status');
      const hosts = body.data;
      if (!Array.isArray(hosts)) throw new Error('Malformed GPU snapshot');
      const rows = gpuRows(hosts);
      $('ao-gpus').innerHTML = rows.map(row => {
        if (!row.fresh) return `<div class="ao-gpu is-unknown"><span>${esc(row.label)}</span><span>Unknown</span><small>GPU telemetry ${esc(row.state.replaceAll('_', ' '))}</small></div>`;
        const utilization = finite(row.utilization) ? Math.max(0, Math.min(100, row.utilization)) : null;
        const vram = finite(row.vramUsed) && row.vramTotal > 0 ? `${(row.vramUsed / 1024).toFixed(1)} / ${(row.vramTotal / 1024).toFixed(1)} GiB VRAM` : 'VRAM unknown';
        const memoryPct = finite(row.vramUsed) && row.vramTotal > 0 ? Math.min(100, Math.max(0, row.vramUsed / row.vramTotal * 100)) : null;
        return `<div class="ao-gpu"><span title="${esc(row.name)}">${esc(row.label)}</span><div class="ao-gpu-tracks"><div class="ao-meter" role="img" aria-label="GPU load ${esc(percent(utilization))}" title="GPU load: ${esc(percent(utilization))}"><span style="width:${utilization ?? 0}%"></span></div><div class="ao-meter ao-meter-memory" role="img" aria-label="VRAM allocation ${esc(percent(memoryPct))}" title="VRAM allocated: ${esc(percent(memoryPct))}"><span style="width:${memoryPct ?? 0}%"></span></div></div><strong>${finite(utilization) ? `${Math.round(utilization)}%` : '—'}</strong><small>${esc(vram)} · ${Math.round(row.age / 1000)}s old${finite(row.powerDraw) ? ` · ${Math.round(row.powerDraw)} W` : ''}</small></div>`;
      }).join('') || '<p class="ao-empty">No GPU collector evidence. Open Nerve Center for hosts.</p>';
      window.AgentXPresentedLiveContent.gpus = { status: 'visible', read: body.presentation || null };
    } catch {
      window.AgentXPresentedLiveContent.gpus = { status: 'unavailable' };
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
      // Only the committed response for this window may be discussed. Loading
      // and failure immediately invalidate the old reference.
      window.AgentXPresentedContent = { contract: 'agentx.presentation/v1', state,
        filters: { window: windowKey }, selection: { groupBy, overlay }, read: state === 'ready' ? data?.presentation || null : null };
      if (state === 'ready') renderSummary(data);
      else clearSummary(state);
    });
    document.querySelectorAll('[data-ao-group]').forEach(button => button.addEventListener('click', () => {
      groupBy = button.dataset.aoGroup;
      if (window.AgentXPresentedContent) window.AgentXPresentedContent.selection = { groupBy, overlay };
      document.querySelectorAll('[data-ao-group]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      renderComparison();
    }));
    $('ao-error-focus').addEventListener('click', () => {
      const target = document.querySelector('[data-ao-group="byErrors"]');
      target.click();
      target.focus();
    });
    document.querySelectorAll('[data-ao-overlay]').forEach(button => button.addEventListener('click', () => {
      overlay = button.dataset.aoOverlay;
      if (window.AgentXPresentedContent) window.AgentXPresentedContent.selection = { groupBy, overlay };
      document.querySelectorAll('[data-ao-overlay]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      if (summary) renderTrend(summary);
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

  if (typeof module !== 'undefined' && module.exports) module.exports = { needsReview, statusText, outcome, outcomeSplit, callSplit, sparkPaths, comparisonRows, failureRows, buckets, runtimeView, gpuRows };
  // Loaded after the markup: subscribe before deferred inference modules run.
  if (typeof document !== 'undefined') init();
})();
