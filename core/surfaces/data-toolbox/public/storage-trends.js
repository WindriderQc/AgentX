'use strict';

// The Growth view of the Toolbox Storage tab (read-only). Loaded before
// app.js, whose helpers (state, api, e, array, number, bytes, date, heading…)
// it uses when called; storage-views.js opens it.
// It reads Data's /storage/trends: one snapshot per root and day, written
// when a scan ends complete. Each root has its own read, so one that fails
// shows a notice in its place. Charts are inline SVG, each with one measure
// and one axis, and the same figures as a table.
// Root paths and folder names come from the disks: they are always escaped.

const TREND_DAY_MS = 86400000;
const TREND_MAX_ROOTS = 8;
const TREND_FOLDER_LIMIT = 42; // Data's ceiling: every folder of a snapshot level
const TREND_ALL_DAYS = 799; // an 800-day window, the most Data keeps and accepts
const TREND_WINDOWS = Object.freeze({ 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last year', all: 'All kept (800 days)' });
const TREND_MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const TREND_UNITS = Object.freeze(['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']);
const TREND_DOTS_MAX = 31;

const trendState = { windowKey: '90', roots: [], known: new Map(), blocks: new Map(), indexError: '', loaded: false };

const trendSettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const trendDayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const trendDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const trendFinite = (value) => typeof value === 'number' && Number.isFinite(value);

// Sizes on a chart need more digits than elsewhere: two snapshots a day apart
// often differ by less than a tenth of the unit.
function trendBytes(value) {
  if (!trendFinite(value)) return '—';
  let index = 0; let result = Math.abs(value);
  while (result >= 1024 && index < TREND_UNITS.length - 1) { result /= 1024; index++; }
  return `${value < 0 ? '−' : ''}${result.toFixed(index >= 3 ? 2 : index ? 1 : 0)} ${TREND_UNITS[index]}`;
}
const trendSigned = (value, format) => !trendFinite(value) ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${format(Math.abs(value))}`;
const trendCount = (value) => trendFinite(value) ? value.toLocaleString() : '—';
const trendValue = (kind, value) => kind === 'bytes' ? trendBytes(value) : `${trendCount(value)} files`;

function trendRange() {
  const to = trendDay(Date.now());
  const days = trendState.windowKey === 'all' ? TREND_ALL_DAYS : Number(trendState.windowKey);
  return { from: trendDay(trendDayMs(to) - days * TREND_DAY_MS), to };
}

function trendNiceStep(raw, whole) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 && !whole ? 2.5 : fraction <= 5 ? 5 : 10;
  return whole ? Math.max(1, nice * power) : nice * power;
}

// The vertical axis: round ticks in one unit. It starts at zero when the
// values span a wide range, and near the lowest value otherwise, so that a
// small change on a large total stays visible; the caller says which.
function trendAxis(values, kind) {
  const dataMax = Math.max(...values);
  let unitIndex = 0;
  if (kind === 'bytes') { let top = dataMax; while (top >= 1024 && unitIndex < TREND_UNITS.length - 1) { top /= 1024; unitIndex++; } }
  const size = 1024 ** unitIndex;
  let min = Math.min(...values) / size; let max = dataMax / size;
  if (min <= max * 0.5) min = 0;
  if (min === max) {
    const pad = Math.max(max * 0.01, kind === 'bytes' ? 0.01 : 2);
    min = Math.max(0, min - pad); max += pad;
  }
  const step = trendNiceStep((max - min) / 4, kind !== 'bytes');
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const decimals = [0, 1, 2, 3].find((digits) => Math.abs(step * 10 ** digits - Math.round(step * 10 ** digits)) < 1e-6) ?? 3;
  const ticks = [];
  for (let tick = lo; tick <= hi + step / 2; tick += step) {
    ticks.push({ value: tick * size, text: kind === 'bytes' ? `${tick.toFixed(decimals)} ${TREND_UNITS[unitIndex]}` : Math.round(tick).toLocaleString() });
  }
  return { lo: lo * size, hi: hi * size, ticks, fromZero: lo === 0 };
}

function trendTimeTicks(first, last, wanted) {
  const spanDays = Math.round((last - first) / TREND_DAY_MS);
  const count = Math.max(2, Math.min(wanted, spanDays + 1));
  const withYear = spanDays > 300;
  const ticks = [];
  for (let index = 0; index < count; index++) {
    const at = first + Math.round((index * spanDays) / (count - 1)) * TREND_DAY_MS;
    const day = new Date(at);
    ticks.push({ at, text: withYear ? `${TREND_MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}` : `${day.getUTCDate()} ${TREND_MONTHS[day.getUTCMonth()]}` });
  }
  return ticks;
}

// One line chart of one measure. `points` are { day, value }, oldest first, at
// least two of them on different days.
function trendSvg(points, kind, { width, height, timeTicks, tone, description, variant }) {
  const margin = { left: 70, right: 18, top: 12, bottom: 30 };
  const axis = trendAxis(points.map((point) => point.value), kind);
  const first = trendDayMs(points[0].day); const last = trendDayMs(points.at(-1).day);
  const plotWidth = width - margin.left - margin.right; const plotHeight = height - margin.top - margin.bottom;
  const x = (day) => margin.left + ((trendDayMs(day) - first) / (last - first)) * plotWidth;
  const y = (value) => margin.top + (1 - (value - axis.lo) / (axis.hi - axis.lo)) * plotHeight;
  const xs = points.map((point) => x(point.day));
  const grid = axis.ticks.map((tick) => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick.value).toFixed(1)}" y2="${y(tick.value).toFixed(1)}"/><text x="${margin.left - 8}" y="${(y(tick.value) + 4).toFixed(1)}" text-anchor="end">${e(tick.text)}</text>`).join('');
  const ticks = trendTimeTicks(first, last, timeTicks);
  const time = ticks.map((tick, index) => {
    const at = margin.left + ((tick.at - first) / (last - first)) * plotWidth;
    const anchor = index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle';
    return `<line x1="${at.toFixed(1)}" x2="${at.toFixed(1)}" y1="${height - margin.bottom}" y2="${height - margin.bottom + 4}"/><text x="${at.toFixed(1)}" y="${height - 9}" text-anchor="${anchor}">${e(tick.text)}</text>`;
  }).join('');
  const dots = points.map((point, index) => {
    const end = index === 0 || index === points.length - 1;
    if (!end && points.length > TREND_DOTS_MAX) return '';
    return `<circle class="${end ? 'end' : ''}" cx="${xs[index].toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="${end ? 4.5 : 3}"/>`;
  }).join('');
  // A wider target than the mark: hovering anywhere above a day names its value.
  const hits = points.map((point, index) => {
    const left = index ? (xs[index - 1] + xs[index]) / 2 : margin.left;
    const right = index < points.length - 1 ? (xs[index] + xs[index + 1]) / 2 : width - margin.right;
    return `<rect x="${left.toFixed(1)}" y="${margin.top}" width="${Math.max(1, right - left).toFixed(1)}" height="${plotHeight}"><title>${e(point.day)}: ${e(trendValue(kind, point.value))}</title></rect>`;
  }).join('');
  return `<svg class="trend-svg ${variant} ${tone}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${e(description)}"><title>${e(description)}</title>
    <g class="chart-grid">${grid}</g>
    <g class="chart-time"><line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}"/>${time}</g>
    <polyline class="chart-line" points="${points.map((point, index) => `${xs[index].toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')}"/>
    <g class="chart-dots">${dots}</g><g class="chart-hits">${hits}</g></svg>`;
}

// A titled chart with its first and last values in words. Two drawings of the
// same line: the stylesheet shows the one that fits the screen, so the labels
// keep a readable size on a phone.
function trendFigure(title, points, kind, tone = 'size') {
  const usable = points.filter((point) => trendFinite(point.value) && Number.isFinite(trendDayMs(point.day)));
  if (usable.length < 2 || usable[0].day === usable.at(-1).day) return '';
  const first = usable[0]; const last = usable.at(-1);
  const values = usable.map((point) => point.value);
  const axis = trendAxis(values, kind);
  const description = `${title}: ${usable.length} points from ${first.day} to ${last.day}. First ${trendValue(kind, first.value)}, last ${trendValue(kind, last.value)}, lowest ${trendValue(kind, Math.min(...values))}, highest ${trendValue(kind, Math.max(...values))}.`;
  return `<figure class="trend-figure">
    <figcaption><strong>${e(title)}</strong><span class="muted">First ${e(trendValue(kind, first.value))} on ${e(first.day)} → last ${e(trendValue(kind, last.value))} on ${e(last.day)} · ${number(usable.length)} points</span></figcaption>
    ${trendSvg(usable, kind, { width: 560, height: 230, timeTicks: 5, tone, description, variant: 'wide' })}
    ${trendSvg(usable, kind, { width: 350, height: 220, timeTicks: 3, tone, description, variant: 'narrow' })}
    <p class="muted trend-note">${axis.fromZero ? 'The vertical axis starts at zero.' : `The vertical axis starts at ${e(axis.ticks[0].text)}${kind === 'bytes' ? '' : ' files'}, not at zero, so that the change stays visible.`} Days are UTC days.</p>
  </figure>`;
}

function trendFolderLabel(entry) {
  if (entry.kind === 'other') return entry.parent ? `Other folders of ${entry.parent}, together` : 'Other folders, together';
  if (entry.kind === 'files') return entry.parent ? `Files directly in ${entry.parent}` : 'Files directly in the root';
  return entry.name ?? entry.key ?? '—';
}

// The entries of one level in the newest snapshot: folders largest first, then
// what Data summed as "other", then the files that sit directly there.
function trendLatestEntries(folders, lastDay, parent) {
  const order = { folder: 0, other: 1, files: 2 };
  return array(folders).filter((entry) => (entry.parent ?? null) === parent && entry.key !== parent)
    .map((entry) => ({ ...entry, latest: array(entry.points).findLast((point) => point.day === lastDay) }))
    .filter((entry) => entry.latest)
    .sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0) || b.latest.bytes - a.latest.bytes);
}

function trendShare(share) {
  if (!Number.isFinite(share)) return '—';
  if (share > 0 && share < 0.0001) return '&lt; 0.01%';
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
}

function trendBars(entries, total, rootIndex, canOpen, whole) {
  if (!entries.length) return '';
  const largest = Math.max(...entries.map((entry) => entry.latest.bytes), 1);
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Size by folder"><table class="trend-bars"><caption>Largest first. Share is the part of ${e(whole)} on that day.</caption><thead><tr><th scope="col">Folder</th><th scope="col">Size</th><th scope="col" title="Share of ${e(whole)}">Share</th><th scope="col">Files</th>${canOpen ? '<th scope="col">Subfolders</th>' : ''}</tr></thead><tbody>
    ${entries.map((entry) => {
      const share = total > 0 ? entry.latest.bytes / total : NaN;
      const plain = entry.kind !== 'folder';
      return `<tr><th scope="row" class="row-head ${plain ? 'muted' : ''}">${e(trendFolderLabel(entry))}</th>
        <td>${e(trendBytes(entry.latest.bytes))}<span class="trend-bar" aria-hidden="true"><span style="width:${((entry.latest.bytes / largest) * 100).toFixed(1)}%"></span></span></td>
        <td>${trendShare(share)}</td>
        <td>${trendCount(entry.latest.files)}</td>
        ${canOpen ? `<td>${plain ? '<span class="muted">—</span>' : `<button type="button" class="button" data-trend-root="${rootIndex}" data-trend-folder="${e(entry.key)}">Open</button>`}</td>` : ''}</tr>`;
    }).join('')}
  </tbody></table></div>`;
}

function trendGrowth(growth, what) {
  if (!growth) return '';
  const perDay = (value) => trendFinite(value) && growth.days > 0 ? value / growth.days : null;
  const files = perDay(growth.filesAdded);
  const grown = array(growth.folders);
  return `<div class="grid two trend-growth">
    <article class="card"><h3>Growth of ${e(what)}, ${e(growth.from?.day)} to ${e(growth.to?.day)} (${number(growth.days)} days)</h3>
      <div class="metric-row"><span>Size added</span><strong>${e(trendSigned(growth.bytesAdded, trendBytes))}</strong></div>
      <div class="metric-row"><span>Files added</span><strong>${e(trendSigned(growth.filesAdded, trendCount))}</strong></div>
      <div class="metric-row"><span>Per day, on average</span><strong>${e(trendSigned(perDay(growth.bytesAdded), trendBytes))} · ${e(trendSigned(files, (value) => value.toLocaleString(undefined, { maximumFractionDigits: 1 })))} files</strong></div>
      <p class="muted trend-note">The difference between the first and the last snapshot of the window, not a forecast.</p>
    </article>
    <article class="card"><h3>Folders that grew the most</h3>
      ${grown.length ? `<ol class="trend-grown">${grown.map((folder) => `<li><strong>${e(trendFolderLabel(folder))}</strong> <span>${e(trendSigned(folder.bytesAdded, trendBytes))}</span> <span class="muted">${e(trendBytes(folder.fromBytes))} → ${e(trendBytes(folder.toBytes))} · ${e(trendSigned(folder.filesAdded, trendCount))} files</span></li>`).join('')}</ol>` : '<p class="muted">No folder grew over this window.</p>'}
      <p class="muted trend-note">At most five. A folder that was counted among the “other folders” at the start of the window is left out: its growth is not known.</p>
    </article>
  </div>`;
}

function trendTable(caption, columns, rows) {
  return `<details class="trend-table"><summary>${e(caption)}</summary><div class="table-wrap" tabindex="0" role="region" aria-label="${e(caption)}"><table><thead><tr>${columns.map((column) => `<th scope="col">${e(column)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div></details>`;
}

// What the collector walked at each completed scan: another measure, kept
// apart from the totals and never drawn on their charts.
function trendScanHistory(history) {
  const points = array(history?.points).filter((point) => trendFinite(point.files)).map((point) => ({ day: point.day, value: point.files }));
  if (!points.length) return '';
  const figure = trendFigure('Files walked per collector scan', points, 'count', 'walked');
  return `<section class="trend-walked"><h4>Another measure: files walked by the collector</h4>
    <p class="muted trend-note">What the collector counted on the disks at each completed scan, one point per day, from the scan records. It is not the number of files in the index and it has no size, so it is drawn apart and is not part of the totals or of the growth above.</p>
    ${figure || `<p class="muted">One scan in this window: ${e(trendCount(points[0].value))} files walked on ${e(points[0].day)}.</p>`}
    ${trendTable(`Files walked per scan as a table (${points.length} days)`, ['Day (UTC)', 'Files walked'], points.map((point) => [point.day, trendCount(point.value)]).reverse())}
  </section>`;
}

function trendFolderPanel(block, rootIndex) {
  const { folderKey, folder } = block;
  const crumbs = `<div class="crumbs"><button type="button" class="link-button" data-trend-root="${rootIndex}" data-trend-folder="">All folders of this root</button><span class="muted">/</span><strong>${e(folderKey)}</strong></div>`;
  if (!folder) return `${crumbs}<p class="muted">Reading this folder…</p>`;
  if (folder.error) return `${crumbs}<div class="notice warning">This folder could not be read from Data: ${e(folder.error)}.</div>`;
  const data = folder.data || {};
  const own = array(data.folders).find((entry) => entry.key === folderKey);
  const lastDay = array(data.totals).at(-1)?.day;
  const latest = array(own?.points).findLast((point) => point.day === lastDay);
  if (!own || !latest) return `${crumbs}<p class="muted">This folder is not in the snapshots of this window.</p>`;
  const children = trendLatestEntries(data.folders, lastDay, folderKey);
  return `${crumbs}
    <p class="muted trend-note">${e(trendBytes(latest.bytes))} · ${trendCount(latest.files)} files on ${e(lastDay)}.</p>
    ${trendFigure(`Size of ${own.name ?? folderKey}`, array(own.points).map((point) => ({ day: point.day, value: point.bytes })), 'bytes')}
    ${trendGrowth(data.growth, own.name ?? folderKey)}
    ${children.length ? trendBars(children, latest.bytes, rootIndex, false, 'this folder')
      : '<p class="muted">Data has no figures for the subfolders of this folder: it has none, or the root had more than five top-level folders when the snapshot was taken.</p>'}`;
}

function trendRootBody(root, block, rootIndex) {
  if (!block) return '<p class="muted">Reading the snapshots…</p>';
  if (block.error) return `<div class="notice warning">The trend of this root could not be read from Data: ${e(block.error)}. The other roots do not depend on it.</div>`;
  const data = block.data || {};
  const totals = array(data.totals);
  const last = totals.at(-1);
  const known = trendState.known.get(root);
  const walked = trendScanHistory(data.scanHistory);
  if (!last) {
    const elsewhere = known && known.snapshots > 0
      ? `No snapshot between ${e(data.window?.from)} and ${e(data.window?.to)}. Data holds ${number(known.snapshots)} for this root, from ${e(known.firstDay)} to ${e(known.lastDay)}: choose a longer window.`
      : 'No snapshot yet. Data records the first one when the next scan of this root ends complete; a scan that ends partial, failed or stopped records nothing. A scan can be asked for in “Inventory and scans”.';
    return `<div class="notice">${elsewhere}</div>${walked}`;
  }
  const single = totals.length < 2;
  const topLevel = trendLatestEntries(data.folders, last.day, null);
  const openLimit = Number(data.limits?.secondLevelWhenTopFoldersAtMost) || 5;
  const folderCount = topLevel.filter((entry) => entry.kind === 'folder').length;
  const canOpen = folderCount > 0 && folderCount <= openLimit;
  return `<div class="grid trend-now">
      ${metric(trendBytes(last.bytes), `size on ${last.day}`)}
      ${metric(trendCount(last.files), `files on ${last.day}`)}
      ${metric(number(totals.length), `snapshot${totals.length === 1 ? '' : 's'} in this window`)}
    </div>
    ${single ? `<div class="notice"><strong>One snapshot so far.</strong> A trend needs two points: the next one is recorded when the next scan of this root ends complete, at most one per day (a later scan of the same day replaces the point). Until then, this is the current state only.</div>`
    : `<div class="trend-charts">
        ${trendFigure('Total size', totals.map((point) => ({ day: point.day, value: point.bytes })), 'bytes')}
        ${trendFigure('Number of files', totals.map((point) => ({ day: point.day, value: point.files })), 'count', 'files')}
      </div>
      ${trendTable(`The two charts as a table (${totals.length} snapshots)`, ['Day (UTC)', 'Size', 'Files', 'Recorded'], totals.map((point) => [point.day, trendBytes(point.bytes), trendCount(point.files), point.at ? new Date(point.at).toLocaleString() : '—']).reverse())}
      ${trendGrowth(data.growth, 'the root')}`}
    <h4>${block.folderKey ? 'Inside a folder' : `Size by folder on ${e(last.day)}`}</h4>
    ${block.folderKey ? trendFolderPanel(block, rootIndex) : `${topLevel.length ? trendBars(topLevel, last.bytes, rootIndex, canOpen, 'the root') : '<p class="muted">The snapshot lists no folder.</p>'}
      ${topLevel.length && !canOpen && folderCount > openLimit ? `<p class="muted trend-note">This root has more than ${number(openLimit)} top-level folders: Data keeps their totals only, so a folder cannot be opened here.</p>` : ''}`}
    ${walked}`;
}

function trendBlocks() {
  if (trendState.indexError) return `<div class="notice warning">The storage trends could not be read from Data: ${e(trendState.indexError)}.</div>`;
  if (!trendState.roots.length) return '<div class="empty">Data knows no storage root yet: no source is configured and no snapshot was recorded.</div>';
  return trendState.roots.map((root, index) => {
    const block = trendState.blocks.get(root);
    return `<article class="card trend-root" id="trendRoot${index}"><div class="card-title"><h3 class="mono">${e(root)}</h3></div>${trendRootBody(root, block, index)}</article>`;
  }).join('');
}

function trendPaint() {
  const target = document.querySelector('#trendBlocks');
  if (target && state.tab === 'storage') target.innerHTML = trendBlocks();
}

function trendRoute(root, folder) {
  const { from, to } = trendRange();
  const query = new URLSearchParams({ root, from, to, limit: String(TREND_FOLDER_LIMIT) });
  if (folder) query.set('folder', folder);
  return `/storage/trends?${query}`;
}

async function trendLoadRoots(seq) {
  const windowKey = trendState.windowKey;
  const reads = await Promise.all(trendState.roots.map((root) => trendSettled(api(trendRoute(root)))));
  if (seq !== state.renderSeq || state.tab !== 'storage' || windowKey !== trendState.windowKey) return false;
  trendState.blocks = new Map(trendState.roots.map((root, index) => [root, reads[index]]));
  return true;
}

// Called by storage-views.js: returns once the view is on the page.
async function storageTrendsView(target) {
  const seq = state.renderSeq;
  const [index, agents] = await Promise.all([trendSettled(api('/storage/trends')), trendSettled(api('/storage/agents'))]);
  if (seq !== state.renderSeq || state.tab !== 'storage') return;
  const snapshots = array(index.data?.roots);
  const sources = agents.data?.sources && typeof agents.data.sources === 'object' && !Array.isArray(agents.data.sources) ? Object.values(agents.data.sources) : [];
  // A configured source with no snapshot yet is listed too, with what is missing.
  const roots = [...snapshots.map((row) => row.root), ...sources.map((source) => String(source?.canonicalRoot || '').replace(/\/+$/, ''))]
    .filter((root) => typeof root === 'string' && root.startsWith('/'));
  Object.assign(trendState, {
    indexError: index.error || '', roots: [...new Set(roots)].sort().slice(0, TREND_MAX_ROOTS),
    known: new Map(snapshots.map((row) => [row.root, row])), blocks: new Map(), loaded: true
  });
  if (!trendState.indexError && !(await trendLoadRoots(seq))) return;
  const windows = Object.entries(TREND_WINDOWS).map(([key, name]) => `<option value="${key}"${key === trendState.windowKey ? ' selected' : ''}>${e(name)}</option>`).join('');
  target.innerHTML = `${heading('Growth', 'How each storage root grew: its size and its number of files at each snapshot. Data records one snapshot per root and day, when a scan ends complete, and keeps them 800 days.', `<label class="gpu-window">Window <select id="trendWindow">${windows}</select></label>`)}
    <section id="trendBlocks" class="trend-blocks">${trendBlocks()}</section>`;
}

async function setTrendWindow(value) {
  if (!TREND_WINDOWS[value] || state.tab !== 'storage' || !trendState.loaded || trendState.indexError) return;
  trendState.windowKey = value;
  trendState.blocks = new Map();
  trendPaint();
  if (await trendLoadRoots(state.renderSeq)) trendPaint();
}

async function trendOpenFolder(rootIndex, folderKey) {
  const root = trendState.roots[rootIndex];
  const block = trendState.blocks.get(root);
  if (!block || block.error || state.tab !== 'storage') return;
  block.folderKey = folderKey || '';
  block.folder = null;
  trendPaint();
  if (!folderKey) return;
  const seq = state.renderSeq; const windowKey = trendState.windowKey;
  const read = await trendSettled(api(trendRoute(root, folderKey)));
  if (seq !== state.renderSeq || state.tab !== 'storage' || windowKey !== trendState.windowKey || block.folderKey !== folderKey) return;
  block.folder = read;
  trendPaint();
}

document.addEventListener('change', (event) => {
  if (event.target.id === 'trendWindow') setTrendWindow(event.target.value);
});

document.addEventListener('click', (event) => {
  const dataset = event.target.closest?.('[data-trend-root]')?.dataset;
  if (dataset) trendOpenFolder(Number(dataset.trendRoot), dataset.trendFolder);
});
