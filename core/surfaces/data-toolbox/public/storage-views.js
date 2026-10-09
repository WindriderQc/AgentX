'use strict';

// The views of the Toolbox Storage tab, and the Reports view. Loaded before
// app.js, whose helpers (state, api, render, e, array, number, bytes, date,
// heading…) it uses when called. "Inventory and scans" stays in app.js and
// storage-tools.js; "Growth" is storage-trends.js.
// Reports sends two of the page's writes: generating a report and deleting
// one. A report is a file Data writes in its own report store; the scanned
// disks are not touched. While a report is being generated the list is read
// again every three seconds, only on a visible Storage tab.
// File names and error texts come from Data: they are always escaped.

const STORAGE_VIEWS = Object.freeze({ scans: 'Inventory and scans', growth: 'Growth', reports: 'Reports' });
const REPORT_POLL_MS = 3000;
const REPORT_NAME = /^export_(full|summary|media|large|stats)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.(json|csv)$/;
const REPORT_TYPES = Object.freeze({
  summary: ['Folder summary', 'one row per folder, with its number of files and their total size, largest first'],
  stats: ['Statistics by extension', 'one row per file extension: files, total, average and largest size'],
  large: ['Large files', 'every file of 100 MB or more, largest first'],
  media: ['Media files', 'every image, video and audio file, largest first'],
  full: ['Full inventory', 'every indexed file with its folder, size and date. JSON only. It is the largest report and can take minutes']
});
const REPORT_FORMATS = Object.freeze({ csv: 'CSV (spreadsheet)', json: 'JSON' });

const storageViews = { view: 'scans' };
const reportState = {
  list: null, outcome: null, posting: false, deleting: '', confirm: '', draft: { type: 'summary', format: 'csv' },
  started: new Set(), loaded: false, busy: false, timer: null
};

const reportSettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const reportOnView = () => state.tab === 'storage' && storageViews.view === 'reports';

function storageViewSwitch() {
  return `<div class="view-switch" role="group" aria-label="Views of the Storage tab">${Object.entries(STORAGE_VIEWS).map(([key, name]) => `<button type="button" class="button${key === storageViews.view ? ' active' : ''}" data-storage-view="${key}" aria-pressed="${key === storageViews.view}">${e(name)}</button>`).join('')}</div>`;
}

// Called first by the Storage tab: true when it drew Growth or Reports, false
// when "Inventory and scans" is the view to draw.
async function storageOtherView() {
  const view = storageViews.view;
  if (view !== 'growth' && view !== 'reports') return false;
  const seq = state.renderSeq;
  const holder = { innerHTML: '' };
  if (view === 'growth') await storageTrendsView(holder); else await reportsView(holder);
  if (seq !== state.renderSeq || state.tab !== 'storage' || view !== storageViews.view) return true;
  content.innerHTML = `${heading('Storage evidence', 'The inventory and its scans, how each root grew, and the reports Data can generate from the index.', '<button class="button" data-action="refresh">Refresh</button>')}
    ${storageViewSwitch()}${holder.innerHTML}`;
  if (view === 'reports') reportFollow();
  return true;
}

function reportUsageSection() {
  const { data, error } = reportState.list || {};
  if (error || !data) return '';
  const ready = array(data.reports).filter((report) => report.status === 'ready').length;
  const maxReports = Number(data.limits?.maxReports); const maxBytes = Number(data.limits?.maxTotalBytes);
  const share = (used, max) => Number.isFinite(max) && max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const bar = (used, max) => `<span class="usage-bar" aria-hidden="true"><span style="width:${share(used, max).toFixed(1)}%"></span></span>`;
  return `<div class="grid two">
    <article class="card"><h3>Reports kept</h3><strong class="metric">${number(ready)} <span class="muted">of ${number(data.limits?.maxReports)}</span></strong>${bar(ready, maxReports)}</article>
    <article class="card"><h3>Space used</h3><strong class="metric">${bytes(data.totalSize)} <span class="muted">of ${bytes(data.limits?.maxTotalBytes)}</span></strong>${bar(Number(data.totalSize) || 0, maxBytes)}</article>
  </div>
  <p class="muted report-help">When a new report takes the store over either limit, Data removes the oldest ones, never the new one. A generation that is running or has failed has no file: Data keeps it in memory only and forgets it when it restarts.</p>`;
}

function reportOutcomeSection() {
  const outcome = reportState.outcome;
  return outcome ? `<div class="notice ${outcome.ok ? 'success' : 'warning'}">${e(outcome.text)}</div>` : '';
}

function reportStatus(report) {
  if (report.status === 'ready') return '<span class="pill good">ready</span>';
  if (report.status === 'running') return '<span class="pill warn">running</span>';
  if (report.status === 'failed') return '<span class="pill bad">failed</span>';
  return `<span class="pill">${e(report.status || 'unknown')}</span>`;
}

function reportActions(report) {
  const name = report.filename;
  if (typeof name !== 'string' || !REPORT_NAME.test(name)) return '<span class="muted">—</span>';
  if (report.status === 'running') return '<span class="muted">Being generated: it cannot be deleted until it ends.</span>';
  const failed = report.status !== 'ready';
  if (reportState.deleting === name) return '<span class="muted">Deleting…</span>';
  if (reportState.confirm === name) {
    return `<div class="report-confirm" role="group" aria-label="Confirm"><span>${failed ? 'Remove this failed generation from the list?' : 'Delete this report from Data? It cannot be recovered.'}</span>
      <button type="button" class="button danger" data-report-delete="${e(name)}">${failed ? 'Remove' : 'Delete'}</button>
      <button type="button" class="button" data-report-keep="${e(name)}">Keep</button></div>`;
  }
  return `<div class="report-actions">${failed ? '' : `<a class="button" href="/api/data-toolbox/reports/${encodeURIComponent(name)}/download" download="${e(name)}">Download</a>`}
    <button type="button" class="button" data-report-ask="${e(name)}"${reportState.deleting ? ' disabled' : ''}>${failed ? 'Remove from list' : 'Delete'}</button></div>`;
}

function reportRow(report) {
  const kind = REPORT_TYPES[report.type]?.[0] || report.type || '—';
  const skipped = Number(report.skippedCount) > 0 ? ` <span class="warn">· ${number(report.skippedCount)} skipped</span>` : '';
  const when = report.createdAt ? date(report.createdAt) : report.requestedAt ? `requested ${date(report.requestedAt)}` : '—';
  return `<tr><th scope="row" class="row-head">${e(kind)}<br><span class="muted mono">${e(report.filename || '—')}</span></th>
    <td data-label="Format">${e(String(report.format || '—').toUpperCase())}</td>
    <td>${reportStatus(report)}${report.status === 'failed' ? `<br><span class="bad">${e(report.error || 'Data gave no reason.')}</span>` : ''}</td>
    <td data-label="Size">${bytes(report.size)}</td>
    <td data-label="Records">${number(report.recordCount)}${skipped}</td>
    <td data-label="Created">${when}</td>
    <td>${reportActions(report)}</td></tr>`;
}

function reportListSection() {
  const { data, error } = reportState.list || {};
  if (error) return `<div class="notice warning">The reports could not be read from Data: ${e(error)}.</div>`;
  const reports = array(data?.reports);
  if (!reports.length) return '<div class="empty">No report yet. Generate one above.</div>';
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Reports, newest first"><table class="report-table"><thead><tr><th scope="col">Report</th><th scope="col">Format</th><th scope="col">Status</th><th scope="col">Size</th><th scope="col">Records</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead><tbody>
    ${reports.map(reportRow).join('')}
  </tbody></table></div>`;
}

function reportPaint() {
  if (!reportOnView()) return;
  for (const [selector, html] of [['#reportUsage', reportUsageSection()], ['#reportOutcome', reportOutcomeSection()], ['#reportList', reportListSection()]]) {
    const target = document.querySelector(selector);
    if (target) target.innerHTML = html;
  }
  const button = document.querySelector('#reportGenerate');
  if (button) { button.disabled = reportState.posting; button.textContent = reportState.posting ? 'Starting…' : 'Generate'; }
}

const reportTypeHelp = () => `${e(REPORT_TYPES[reportState.draft.type][0])}: ${e(REPORT_TYPES[reportState.draft.type][1])}.`;

async function reportsView(target) {
  const seq = state.renderSeq;
  const list = await reportSettled(api('/reports'));
  if (seq !== state.renderSeq || state.tab !== 'storage') return;
  Object.assign(reportState, { list, loaded: true, confirm: '', deleting: '' });
  const draft = reportState.draft;
  const options = (entries, selected, text) => Object.entries(entries).map(([key, value]) => `<option value="${key}"${key === selected ? ' selected' : ''}${key === 'csv' && draft.type === 'full' ? ' disabled' : ''}>${e(text(value))}</option>`).join('');
  target.innerHTML = `${heading('Reports', 'Files Data generates from its index, to download and open elsewhere. Generating reads the index only; the scanned disks are not read or changed.')}
    <section id="reportUsage">${reportUsageSection()}</section>
    <form id="reportForm" class="report-form">
      <label for="reportType">Report</label>
      <select id="reportType" name="type" aria-describedby="reportTypeHelp">${options(REPORT_TYPES, draft.type, (value) => value[0])}</select>
      <label for="reportFormat">Format</label>
      <select id="reportFormat" name="format">${options(REPORT_FORMATS, draft.format, (value) => value)}</select>
      <button class="button" type="submit" id="reportGenerate">Generate</button>
    </form>
    <p id="reportTypeHelp" class="muted report-help">${reportTypeHelp()}</p>
    <div id="reportOutcome" role="status" aria-live="polite">${reportOutcomeSection()}</div>
    <section id="reportList" aria-live="off">${reportListSection()}</section>`;
}

const reportRunning = () => array(reportState.list?.data?.reports).some((report) => report.status === 'running');

function reportFollow() {
  if (!reportState.timer && (reportRunning() || reportState.started.size)) reportState.timer = setInterval(reportPoll, REPORT_POLL_MS);
}

// What became of the generations started from this page, once the list says.
function reportSettle() {
  const reports = array(reportState.list?.data?.reports);
  for (const name of [...reportState.started]) {
    const report = reports.find((item) => item.filename === name);
    if (report?.status === 'running') continue;
    reportState.started.delete(name);
    if (!report) reportState.outcome = { ok: false, text: `${name} is no longer listed by Data. A restart of Data ends a running generation and forgets it: generate it again.` };
    else if (report.status === 'ready') reportState.outcome = { ok: true, text: `${name} is ready: ${bytes(report.size)}, ${number(report.recordCount)} records. It can be downloaded below.` };
    else reportState.outcome = { ok: false, text: `${name} failed: ${report.error || 'Data gave no reason.'} No file was kept.` };
  }
}

// The timer stops at its first tick away from the Reports view, and when no
// generation is running. It asks nothing while the page is hidden.
async function reportPoll() {
  if (!reportOnView() || (!reportRunning() && !reportState.started.size)) {
    clearInterval(reportState.timer);
    reportState.timer = null;
    return;
  }
  if (!reportState.loaded || reportState.busy || document.hidden === true) return;
  const seq = state.renderSeq;
  reportState.busy = true;
  try {
    const list = await reportSettled(api('/reports'));
    if (seq !== state.renderSeq || !reportOnView()) return;
    // A failed read keeps the last list on the page and tries again.
    if (list.error) reportState.outcome = { ok: false, text: `The reports could not be read from Data: ${list.error}. The list below is the last one read.` };
    else { reportState.list = list; reportSettle(); }
    reportPaint();
    updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } finally { reportState.busy = false; }
}

async function reportReload(seq) {
  const list = await reportSettled(api('/reports'));
  if (seq !== state.renderSeq || !reportOnView()) return;
  reportState.list = list;
  reportSettle();
  reportPaint();
  reportFollow();
}

async function reportGenerate({ type, format }) {
  if (reportState.posting || !reportOnView() || !reportState.loaded) return;
  reportState.draft = { type, format };
  if (!REPORT_TYPES[type] || !REPORT_FORMATS[format] || (type === 'full' && format !== 'json')) {
    reportState.outcome = { ok: false, text: type === 'full' ? 'Not started: a full report exists in JSON only.' : 'Not started: choose a report and a format from the lists.' };
    reportPaint();
    return;
  }
  const seq = state.renderSeq;
  reportState.posting = true;
  reportState.outcome = null;
  reportPaint();
  try {
    const started = await api('/reports', { method: 'POST', payload: { type, format } });
    if (typeof started.filename !== 'string' || !REPORT_NAME.test(started.filename)) throw new Error('Data accepted the request without naming a report. Use Refresh to see it.');
    reportState.started.add(started.filename);
    reportState.outcome = { ok: true, text: `Generation of ${started.filename} started. The list is read again every ${REPORT_POLL_MS / 1000} s until it is ready or has failed.` };
  } catch (error) {
    reportState.outcome = { ok: false, text: `Not started: ${error.message}` };
  } finally { reportState.posting = false; }
  reportPaint();
  await reportReload(seq);
}

async function reportDelete(name) {
  if (reportState.deleting || !reportOnView() || !REPORT_NAME.test(name) || reportState.confirm !== name) return;
  const seq = state.renderSeq;
  Object.assign(reportState, { deleting: name, confirm: '', outcome: null });
  reportPaint();
  try {
    await api(`/reports/${encodeURIComponent(name)}`, { method: 'DELETE' });
    reportState.outcome = { ok: true, text: `${name} was deleted.` };
  } catch (error) {
    reportState.outcome = { ok: false, text: `Not deleted: ${error.message}` };
  } finally { reportState.deleting = ''; }
  reportPaint();
  await reportReload(seq);
}

document.addEventListener('click', (event) => {
  const view = event.target.closest?.('[data-storage-view]')?.dataset.storageView;
  if (view && STORAGE_VIEWS[view] && state.tab === 'storage' && view !== storageViews.view) {
    storageViews.view = view;
    render();
    return;
  }
  const ask = event.target.closest?.('[data-report-ask]')?.dataset.reportAsk;
  const keep = event.target.closest?.('[data-report-keep]')?.dataset.reportKeep;
  if ((ask || keep) && reportOnView()) { reportState.confirm = ask || ''; reportPaint(); }
  const remove = event.target.closest?.('[data-report-delete]')?.dataset.reportDelete;
  if (remove) reportDelete(remove);
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'reportForm') return;
  event.preventDefault();
  const fields = event.target.elements;
  reportGenerate({ type: fields.type.value, format: fields.format.value });
});

// A full report exists in JSON only: the choice follows the type.
document.addEventListener('change', (event) => {
  if (event.target.form?.id !== 'reportForm') return;
  const fields = event.target.form.elements;
  const type = REPORT_TYPES[fields.type.value] ? fields.type.value : 'summary';
  if (type === 'full') fields.format.value = 'json';
  const csv = [...(fields.format.options || [])].find((option) => option.value === 'csv');
  if (csv) csv.disabled = type === 'full';
  reportState.draft = { type, format: REPORT_FORMATS[fields.format.value] ? fields.format.value : 'json' };
  const help = document.querySelector('#reportTypeHelp');
  if (help && reportOnView()) help.innerHTML = reportTypeHelp();
});

document.addEventListener('visibilitychange', () => { if (reportState.timer) reportPoll(); });
