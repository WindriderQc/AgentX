'use strict';

// The Toolbox GPU tab (read-only). Loaded before app.js, whose helpers
// (state, api, e, heading, number, bytes, percent, date…) it uses when called.
// Four independent reads of Data's /hardware routes: each section keeps its
// own result, so one failed read shows a notice in its place and the others
// still render. Only "Now" refreshes on a timer.

const GPU_REFRESH_MS = 30000;
const GPU_TREND_MS = 6 * 3600000;
const GPU_TREND_LIMIT = 2000; // Data's ceiling for one history read
const GPU_TREND_BUCKETS = 72; // five-minute means across six hours
const GPU_TREND_HOSTS = 8;
const GPU_WINDOWS = Object.freeze({ 24: 'Last 24 hours', 168: 'Last 7 days', 720: 'Last 30 days' });
// Clock reasons that limit performance. Idle, application and display clocks
// are reported by the driver too and are not throttling.
const GPU_THROTTLES = Object.freeze({
  sw_power_cap: 'power cap', hw_power_brake: 'power brake', sw_thermal: 'thermal',
  hw_thermal: 'thermal (hardware)', hw_slowdown: 'hardware slowdown'
});

const gpuState = { latest: null, collectors: null, occupancy: null, trend: null, loaded: false, windowHours: 24 };

const decimal = (value) => measurement(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
const pct = (value) => Number.isFinite(measurement(value)) ? `${decimal(value)}%` : '—';
const withUnit = (value, unit) => Number.isFinite(measurement(value)) ? `${decimal(value)} ${unit}` : '—';
const mib = (value) => Number.isFinite(measurement(value)) ? bytes(measurement(value) * 1048576) : '—';
const span = (value) => {
  const ms = measurement(value);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  if (ms < 172800000) return `${(ms / 3600000).toFixed(1)} h`;
  return `${(ms / 86400000).toFixed(1)} d`;
};
const settled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const gpuLabel = (gpu) => `${Number.isInteger(gpu.index) ? `#${gpu.index} ` : ''}${gpu.name || 'GPU'}`;
const gpuNotice = (what, error) => `<div class="notice warning">${e(what)} could not be read from Data: ${e(error)}. The other sections do not depend on it.</div>`;

function gpuPaint(selector, html) {
  const target = document.querySelector(selector);
  if (target && state.tab === 'gpu') target.innerHTML = html;
}

function gpuThrottle(gpu) {
  const reasons = array(gpu.throttleReasons);
  if (!reasons.length) return gpu.throttleReasonsActive ? '<span class="muted">none</span>' : '—';
  return reasons.map((reason) => GPU_THROTTLES[reason]
    ? `<span class="pill warn">throttled: ${e(GPU_THROTTLES[reason])}</span>`
    : `<span class="muted">${e(label(reason))}</span>`).join(' ');
}

function gpuNowRow(gpu) {
  const used = measurement(gpu.memoryUsedMiB);
  const total = measurement(gpu.memoryTotalMiB);
  const known = Number.isFinite(used) && Number.isFinite(total) && total > 0;
  const fill = known ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return `<tr><th scope="row" class="row-head">${e(gpuLabel(gpu))}</th>
    <td>${pct(gpu.utilizationPct)}</td>
    <td>${mib(gpu.memoryUsedMiB)} / ${mib(gpu.memoryTotalMiB)}${known ? ` <span class="muted">(${pct(fill)})</span><span class="gpu-bar" aria-hidden="true"><span style="width:${fill.toFixed(1)}%"></span></span>` : ''}</td>
    <td>${withUnit(gpu.temperatureC, '°C')}</td>
    <td>${withUnit(gpu.powerDrawW, 'W')} / ${withUnit(gpu.powerLimitW, 'W')}</td>
    <td>${gpuThrottle(gpu)}</td></tr>`;
}

function gpuHostCard(host) {
  const freshness = host.freshness === 'fresh' || host.freshness === 'stale' ? host.freshness : 'no_data';
  const name = host.name || host.hostId || 'unknown host';
  const gpus = array(host.gpus);
  const age = freshness === 'fresh'
    ? `<p class="muted">Sample ${e(span(host.ageMs))} old · expected every ${e(span(host.intervalMs))}.</p>`
    : freshness === 'stale'
      ? `<div class="notice warning"><strong>Stale.</strong> The last sample is ${e(span(host.ageMs))} old (${date(host.lastSampleAt)}); one is expected every ${e(span(host.intervalMs))}. The values below are the last ones received, not the current state.</div>`
      : '<div class="notice warning"><strong>No data.</strong> No sample has been received from this host.</div>';
  const caption = freshness === 'fresh' ? `GPUs on ${name}, sample ${span(host.ageMs)} old` : `GPUs on ${name}: last values received, ${span(host.ageMs)} old, not current`;
  return `<article class="card gpu-host ${freshness === 'fresh' ? '' : 'stale'}">
    <div class="card-title"><h3>${e(name)}</h3><span class="pill ${freshness === 'fresh' ? 'good' : freshness === 'stale' ? 'warn' : ''}">${e(label(freshness))}</span></div>
    ${age}
    <div class="metric-row"><span>Reported by</span><strong class="mono">${e(host.collectorId || '—')}</strong></div>
    <div class="metric-row"><span>Last sample</span><strong>${date(host.lastSampleAt)}</strong></div>
    ${host.lastError ? `<div class="metric-row"><span>Last error${host.lastErrorAt ? ` (${date(host.lastErrorAt)})` : ''}</span><strong class="bad">${e(host.lastError)}</strong></div>` : ''}
    ${measurement(host.consecutiveFailures) > 0 ? `<div class="metric-row"><span>Consecutive failures</span><strong class="bad">${number(host.consecutiveFailures)}</strong></div>` : ''}
    ${gpus.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="GPUs on ${e(name)}"><table><caption>${e(caption)}</caption><thead><tr><th scope="col">GPU</th><th scope="col">Utilisation</th><th scope="col">VRAM used / total</th><th scope="col">Temperature</th><th scope="col">Power draw / limit</th><th scope="col">Throttle</th></tr></thead><tbody>
      ${gpus.map(gpuNowRow).join('')}
    </tbody></table></div>` : '<p class="muted">No GPU reported for this host.</p>'}
  </article>`;
}

function gpuNowSection() {
  const { data, error } = gpuState.latest;
  if (error) return gpuNotice('The current GPU state', error);
  const hosts = array(data?.hosts);
  if (!hosts.length) return '<div class="empty">No GPU host has reported to Data yet.</div>';
  return `<p class="muted">Read ${date(data.observedAt)} · ${number(hosts.filter((host) => host.freshness === 'fresh').length)} of ${number(hosts.length)} hosts fresh · refreshed every ${GPU_REFRESH_MS / 1000} s while this tab is open and visible.</p>
    <div class="gpu-hosts">${hosts.map(gpuHostCard).join('')}</div>`;
}

function gpuOccupancyRow(host, gpu) {
  const coverage = measurement(gpu.coverage);
  const observed = Number.isFinite(coverage) && coverage > 0;
  const throttled = gpu.throttled || {};
  const causes = [['power cap', throttled.powerCapMs], ['thermal', throttled.thermalMs], ['hardware', throttled.hardwareMs]]
    .filter(([, ms]) => measurement(ms) > 0).map(([name, ms]) => `${name} ${span(ms)}`).join(' · ');
  return `<tr><th scope="row" class="row-head">${e(host.name || host.hostId)}<br><span class="muted">${e(gpuLabel(gpu))}</span></th>
    <td>${observed ? `${percent(coverage)} observed` : '<strong>not observed</strong>'}${observed && coverage < 0.5 ? ' <span class="pill warn">partial data</span>' : ''}<br><span class="muted">${number(gpu.samples)} samples · ${e(span(gpu.missingMs))} without data</span></td>
    <td>${percent(gpu.busy?.share)}${observed ? `<br><span class="muted">${e(span(gpu.busy?.ms))}</span>` : ''}</td>
    <td>${pct(gpu.utilizationPct?.mean)}</td>
    <td>${pct(gpu.utilizationPct?.p95)}</td>
    <td>${mib(gpu.memoryUsedMiB?.p95)} / ${mib(gpu.memoryUsedMiB?.max)}<br><span class="muted">of ${mib(gpu.memoryTotalMiB)}</span></td>
    <td>${percent(throttled.share)}${observed ? `<br><span class="muted">${e(span(throttled.ms))}${causes ? ` · ${e(causes)}` : ''}</span>` : ''}</td></tr>`;
}

function gpuOccupancySection() {
  const { data, error } = gpuState.occupancy;
  if (error) return gpuNotice('GPU occupancy', error);
  const rows = array(data?.hosts).flatMap((host) => array(host.gpus).map((gpu) => gpuOccupancyRow(host, gpu)));
  return `<p class="muted">${date(data?.from)} to ${date(data?.to)} · busy means utilisation at or above ${pct(data?.busyAtPct)} · busy, utilisation and throttled figures describe the observed time only. Coverage is the share of the window Data has samples for: time without data is unknown, not idle, and history older than Data's retention lowers the coverage of a long window.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="GPU occupancy table"><table><thead><tr><th scope="col">Host / GPU</th><th scope="col">Coverage</th><th scope="col">Busy</th><th scope="col">Mean utilisation</th><th scope="col">p95 utilisation</th><th scope="col">VRAM p95 / max</th><th scope="col">Throttled</th></tr></thead><tbody>
      ${rows.length ? rows.join('') : noRows(7, 'No GPU is known to Data for this window.')}
    </tbody></table></div>`;
}

function sparkline(buckets, description) {
  const width = 240; const height = 36;
  const x = (index) => ((index / (buckets.length - 1)) * (width - 4) + 2).toFixed(1);
  const y = (value) => (height - 3 - (Math.min(100, Math.max(0, value)) / 100) * (height - 6)).toFixed(1);
  // A bucket without samples breaks the line: a gap is drawn as a gap.
  const runs = [];
  let run = [];
  buckets.forEach((value, index) => {
    if (value == null) { if (run.length) runs.push(run); run = []; } else run.push([x(index), y(value)]);
  });
  if (run.length) runs.push(run);
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${e(description)}"><title>${e(description)}</title><line class="axis" x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}"/>${runs.map((points) => points.length > 1
    ? `<polyline points="${points.map((point) => point.join(',')).join(' ')}"/>`
    : `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="1.5"/>`).join('')}</svg>`;
}

function gpuTrendRows(host, from, to) {
  if (host.error) return `<tr><th scope="row" class="row-head">${e(host.name || host.hostId)}</th><td colspan="2" class="warn">History could not be read: ${e(host.error)}</td></tr>`;
  const samples = array(host.data?.samples);
  const groups = new Map();
  for (const sample of samples) {
    const key = sample.uuid || `index:${sample.index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  if (!groups.size) return `<tr><th scope="row" class="row-head">${e(host.name || host.hostId)}</th><td>—</td><td class="muted">No sample in the last ${e(span(to - from))}.</td></tr>`;
  const truncated = samples.length >= GPU_TREND_LIMIT;
  return [...groups.values()].sort((a, b) => (a[0].index ?? 99) - (b[0].index ?? 99)).map((group) => {
    // Data returns the newest sample first.
    const read = group.filter((sample) => Number.isFinite(measurement(sample.utilizationPct)));
    const sums = Array.from({ length: GPU_TREND_BUCKETS }, () => [0, 0]);
    for (const sample of read) {
      const at = new Date(sample.sampledAt).getTime();
      const index = Math.floor(((at - from) / (to - from)) * GPU_TREND_BUCKETS);
      if (index >= 0 && index < GPU_TREND_BUCKETS) { sums[index][0] += Number(sample.utilizationPct); sums[index][1] += 1; }
    }
    const values = read.map((sample) => Number(sample.utilizationPct));
    const covered = new Date(group[0].sampledAt).getTime() - new Date(group.at(-1).sampledAt).getTime();
    const summary = read.length
      ? `mean ${pct(values.reduce((sum, value) => sum + value, 0) / values.length)} · min ${pct(Math.min(...values))} · max ${pct(Math.max(...values))} · latest ${pct(group[0].utilizationPct)} at ${date(group[0].sampledAt)}`
      : 'utilisation was not read';
    const detail = `${number(group.length)} samples over ${span(covered)}${truncated ? ` · only the newest ${number(GPU_TREND_LIMIT)} samples of this host were loaded, the start of the window is not shown` : ''}`;
    return `<tr><th scope="row" class="row-head">${e(host.name || host.hostId)}<br><span class="muted">${e(gpuLabel(group[0]))}</span></th>
      <td>${read.length ? sparkline(sums.map(([sum, count]) => count ? sum / count : null), `Utilisation of ${host.name || host.hostId} ${gpuLabel(group[0])} over the last ${span(to - from)}: ${summary}`) : '—'}</td>
      <td>${e(summary)}<br><span class="muted">${e(detail)}</span></td></tr>`;
  }).join('');
}

function gpuTrendSection() {
  const trend = gpuState.trend;
  if (!trend) return '<p class="muted">Loading the last six hours…</p>';
  if (!trend.hosts.length) return '<div class="empty">No GPU host is known, so there is no history to read.</div>';
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="GPU utilisation trend table"><table><thead><tr><th scope="col">Host / GPU</th><th scope="col">Utilisation, ${e(date(trend.from))} to ${e(date(trend.to))} (scale 0–100%)</th><th scope="col">Summary</th></tr></thead><tbody>
    ${trend.hosts.map((host) => gpuTrendRows(host, trend.from, trend.to)).join('')}
  </tbody></table></div>`;
}

function gpuCollectorSection() {
  const { data, error } = gpuState.collectors;
  if (error) return gpuNotice('The GPU collector registration', error);
  const collectors = array(data?.collectors);
  if (!collectors.length) return '<div class="empty">No GPU collector registered. The native gpu-agent registers itself when it first posts to Data.</div>';
  return `<div class="grid two">${collectors.map((collector) => `<article class="card collector-card">
    <div class="card-title"><h3>${e(collector.collectorId || 'unknown')}</h3>${statusPill(collector.active === true, 'active', 'inactive')}</div>
    <div class="metric-row"><span>Runs on</span><strong>${e(collector.hostname || 'Unknown host')} · ${e(collector.platform || 'unknown platform')}</strong></div>
    <div class="metric-row"><span>Interval</span><strong>${e(span(collector.intervalMs))}</strong></div>
    <div class="metric-row"><span>Last seen</span><strong>${date(collector.lastSeen)} <span class="muted">${e(ageLabel(collector.lastSeen))}</span></strong></div>
    <div class="metric-row"><span>Hosts read</span><strong>${e(array(collector.hosts).map((host) => host.name || host.hostId).join(', ') || '—')}</strong></div>
    <div class="metric-row"><span>Collector version</span><strong class="mono">${e(collector.agentVersion || 'unknown')}</strong></div>
  </article>`).join('')}</div>`;
}

function gpuOccupancyRoute() {
  const to = Date.now();
  return `/hardware/occupancy?from=${new Date(to - gpuState.windowHours * 3600000).toISOString()}&to=${new Date(to).toISOString()}`;
}

// Hosts to read history for: the latest snapshot, else what the collector
// declares, else what occupancy lists — whichever read succeeded.
function gpuKnownHosts() {
  const { latest, collectors, occupancy } = gpuState;
  const hosts = [...array(latest.data?.hosts), ...array(collectors.data?.collectors).flatMap((collector) => array(collector.hosts)), ...array(occupancy.data?.hosts)];
  const seen = new Map();
  for (const host of hosts) if (host?.hostId && !seen.has(host.hostId)) seen.set(host.hostId, { hostId: host.hostId, name: host.name || host.hostId });
  return [...seen.values()].slice(0, GPU_TREND_HOSTS);
}

async function gpu() {
  const seq = state.renderSeq;
  const [latest, collectors, occupancy] = await Promise.all([
    settled(api('/hardware/latest')), settled(api('/hardware/collectors')), settled(api(gpuOccupancyRoute()))
  ]);
  if (seq !== state.renderSeq || state.tab !== 'gpu') return;
  Object.assign(gpuState, { latest, collectors, occupancy, trend: null, loaded: true });
  const windows = Object.entries(GPU_WINDOWS).map(([hours, name]) => `<option value="${hours}"${Number(hours) === gpuState.windowHours ? ' selected' : ''}>${e(name)}</option>`).join('');
  content.innerHTML = `${heading('GPU telemetry', 'What the native gpu-agent collector reads from each GPU host. Nothing on this tab changes a host or a collector.', '<button class="button" data-action="refresh">Refresh</button>')}
    ${heading('Now', 'Latest sample per host, with its age.')}
    <section id="gpuNow" aria-live="off">${gpuNowSection()}</section>
    ${heading('Occupancy', 'How much each physical GPU was used over the selected window.', `<label class="gpu-window">Window <select id="gpuWindow">${windows}</select></label>`)}
    <section id="gpuOccupancy">${gpuOccupancySection()}</section>
    ${heading('Recent trend', 'Utilisation over the last six hours, drawn as five-minute means.')}
    <section id="gpuTrend">${gpuTrendSection()}</section>
    ${heading('Collector', 'The host-native process that posts these samples to Data.')}
    <section id="gpuCollector">${gpuCollectorSection()}</section>`;
  gpuRefresher.opened();
  const to = Date.now();
  const from = to - GPU_TREND_MS;
  const hosts = gpuKnownHosts();
  const histories = await Promise.all(hosts.map((host) => settled(api(`/hardware/history?hostId=${encodeURIComponent(host.hostId)}&from=${new Date(from).toISOString()}&limit=${GPU_TREND_LIMIT}`))));
  if (seq !== state.renderSeq || state.tab !== 'gpu') return;
  gpuState.trend = { from, to, hosts: hosts.map((host, index) => ({ ...host, ...histories[index] })) };
  gpuPaint('#gpuTrend', gpuTrendSection());
}

// "Now" on the shared refresher (refresh.js): the timer stops at its first
// tick on another tab and asks nothing while the page is hidden. Its answer is
// written only into the GPU tab that asked for it: a tab change or a newer
// render makes it stale and it is dropped. A failed read replaces the numbers
// with a notice, and the stamp and the header say that it failed.
const gpuRefresher = tabRefresher({
  tab: 'gpu', everyMs: GPU_REFRESH_MS,
  ready: () => gpuState.loaded,
  read: () => settled(api('/hardware/latest')),
  apply(latest) {
    gpuState.latest = latest;
    gpuPaint('#gpuNow', gpuNowSection());
    return latest.error || '';
  }
});
const refreshGpuNow = () => gpuRefresher.tick();

async function setGpuWindow(value) {
  if (!GPU_WINDOWS[value] || state.tab !== 'gpu' || !gpuState.loaded) return;
  const hours = Number(value);
  const seq = state.renderSeq;
  gpuState.windowHours = hours;
  gpuPaint('#gpuOccupancy', '<p class="muted">Loading occupancy…</p>');
  const occupancy = await settled(api(gpuOccupancyRoute()));
  if (seq !== state.renderSeq || state.tab !== 'gpu' || hours !== gpuState.windowHours) return;
  gpuState.occupancy = occupancy;
  gpuPaint('#gpuOccupancy', gpuOccupancySection());
}

document.addEventListener('change', (event) => {
  if (event.target.id === 'gpuWindow') setGpuWindow(event.target.value);
});
