'use strict';

// The Toolbox Activity tab and the "Recent activity" card of the Overview
// (read-only). Loaded before app.js, whose helpers (state, api, e, array,
// number, date, ageLabel, heading, noRows…) it uses when called.
// It reads Data's activity log: what the service did or noticed, kept 30 days.
// New events are read every 15 seconds while the tab is open and visible.
// Messages and details carry host names and file paths written by other
// machines: every value is escaped, and details are shown as plain text.

const ACTIVITY_POLL_MS = 15000;
const ACTIVITY_PAGE_SIZE = 50;
const ACTIVITY_MAX_ROWS = 300;
const ACTIVITY_META_ROWS = 40;
const ACTIVITY_OVERVIEW_ROWS = 4;
const ACTIVITY_FAMILIES = Object.freeze({
  storage: 'Storage', collector: 'Collectors', gpu: 'GPU', network: 'Network', janitor: 'Janitor',
  livedata: 'Live data', mqtt: 'MQTT', external: 'External (recorded by another service)'
});
const ACTIVITY_SEVERITIES = Object.freeze({ error: 'Error', warning: 'Warning', info: 'Info' });
const ACTIVITY_WINDOWS = Object.freeze({ all: 'All kept (30 days)', 168: 'Last 7 days', 24: 'Last 24 hours' });

const activityState = {
  family: '', severity: '', windowKey: 'all', page: 1, rows: [], pagination: null, listError: '', summary: null,
  seen: new Set(), fresh: new Set(), newCount: 0, behind: 0, newestAt: null, notice: '', paused: false,
  loaded: false, busy: false, timer: null, open: new Set()
};

const activitySettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const activityTime = (value) => { const ms = value ? new Date(value).getTime() : NaN; return Number.isFinite(ms) ? ms : null; };

function activityPill(severity) {
  const tone = severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : '';
  return `<span class="pill ${tone}">${e(severity || 'unknown')}</span>`;
}

function activityWhen(value) {
  return activityTime(value) === null ? '—' : `${date(value)} <span class="muted">${e(ageLabel(value))}</span>`;
}

function activityRoute({ page = 1, limit = ACTIVITY_PAGE_SIZE, since, severity = activityState.severity, family = activityState.family } = {}) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  // A family is the beginning of a type: "storage." matches storage.scan_queued.
  if (family) query.set('type', `${family}.`);
  if (severity) query.set('severity', severity);
  const from = since ?? (activityState.windowKey === 'all' ? null : new Date(Date.now() - Number(activityState.windowKey) * 3600000).toISOString());
  if (from) query.set('since', from);
  return `/events?${query}`;
}

// Details as flat key/value text: a nested value takes a dotted key.
function activityMetaRows(meta, prefix = '', rows = [], depth = 0) {
  if (!meta || typeof meta !== 'object') return rows;
  for (const [key, value] of Object.entries(meta)) {
    if (rows.length >= ACTIVITY_META_ROWS) break;
    const name = `${prefix}${key}`;
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 3) activityMetaRows(value, `${name}.`, rows, depth + 1);
    else if (Array.isArray(value)) rows.push([name, value.map((item) => item && typeof item === 'object' ? JSON.stringify(item) : String(item)).join(', ') || '—']);
    else rows.push([name, value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  }
  return rows;
}

function activityDetails(event) {
  const rows = activityMetaRows(event.meta);
  if (!rows.length) return '<span class="muted">—</span>';
  const id = String(event.id ?? '');
  return `<details data-activity-id="${e(id)}"${activityState.open.has(id) ? ' open' : ''}><summary>${rows.length} detail${rows.length === 1 ? '' : 's'}</summary>
    <dl class="activity-meta">${rows.map(([key, value]) => `<dt class="mono">${e(key)}</dt><dd>${e(value)}</dd>`).join('')}</dl></details>`;
}

function activityRow(event) {
  return `<tr class="${activityState.fresh.has(event.id) ? 'activity-new' : ''}"><td>${activityWhen(event.at)}</td>
    <td>${activityPill(event.severity)}</td>
    <td class="mono">${e(event.type || '—')}</td>
    <td>${e(event.message || '—')}${activityState.fresh.has(event.id) ? ' <span class="pill">new</span>' : ''}</td>
    <td>${activityDetails(event)}</td></tr>`;
}

function activitySummarySection() {
  const summary = activityState.summary;
  if (!summary) return '<p class="muted">Reading the last 24 hours…</p>';
  const failed = Object.values(summary).find((read) => read.error);
  if (failed) return `<div class="notice warning">The summary of the last 24 hours could not be read from Data: ${e(failed.error)}.</div>`;
  const total = (severity) => summary[severity].data?.pagination?.total;
  const latest = ['error', 'warning'].map((severity) => array(summary[severity].data?.events)[0]).filter(Boolean)
    .sort((a, b) => (activityTime(b.at) ?? 0) - (activityTime(a.at) ?? 0))[0];
  return `<div class="grid activity-counts">
      ${Object.keys(ACTIVITY_SEVERITIES).map((severity) => `<article class="card"><strong class="metric">${number(total(severity))}</strong><span class="metric-label">${activityPill(severity)} in the last 24 hours</span></article>`).join('')}
    </div>
    <p class="activity-latest">${latest
      ? `Most recent warning or error: ${activityPill(latest.severity)} ${activityWhen(latest.at)} — ${e(latest.message || '—')} <span class="muted mono">${e(latest.type || '')}</span>`
      : '<span class="muted">No warning and no error in the last 24 hours.</span>'}</p>`;
}

function activityControls() {
  const { pagination, page, paused, newCount } = activityState;
  const where = pagination ? `${number(pagination.total)} event${pagination.total === 1 ? '' : 's'} match` : 'no list read';
  const live = paused ? '<strong class="warn">paused</strong>: nothing is read until Resume'
    : `new events are read every ${ACTIVITY_POLL_MS / 1000} s while this tab is open and visible`;
  return `<button type="button" class="button" data-activity-action="pause" aria-pressed="${paused}">${paused ? 'Resume' : 'Pause'}</button>
    <span class="muted">${where} · ${live}${page === 1 && newCount ? ` · <strong>${number(newCount)} new</strong> since this list was opened` : ''}</span>`;
}

function activityNotices() {
  const { listError, behind, notice } = activityState;
  return `${listError ? `<div class="notice warning">The activity log could not be read from Data: ${e(listError)}.${activityState.rows.length ? ' The rows below are the last ones read.' : ''}</div>` : ''}
    ${behind ? `<div class="notice">${number(behind)} new event${behind === 1 ? '' : 's'} arrived while you were on another page. <button type="button" class="link-button" data-activity-page="1">Show the newest</button></div>` : ''}
    ${notice ? `<div class="notice warning">${e(notice)}</div>` : ''}`;
}

function activityListSection() {
  const empty = activityState.listError ? 'Nothing could be read.'
    : activityState.family || activityState.severity || activityState.windowKey !== 'all' ? 'No event matches these filters.'
      : 'Data has recorded no event yet. It records scans, collectors that go silent or come back, new network devices, failing feeds and broker disconnections as they happen.';
  return `<div class="table-wrap activity-table" tabindex="0" role="region" aria-label="Activity, newest first"><table><thead><tr><th scope="col">Time</th><th scope="col">Severity</th><th scope="col">Type</th><th scope="col">What happened</th><th scope="col">Details</th></tr></thead><tbody>
    ${activityState.rows.length ? activityState.rows.map(activityRow).join('') : noRows(5, empty)}
  </tbody></table></div>`;
}

function activityPager() {
  const pagination = activityState.pagination;
  if (!pagination || !(pagination.pages > 1)) return '';
  const page = activityState.page;
  return `<button type="button" class="button" data-activity-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>Newer</button>
    <span class="muted">Page ${number(page)} of ${number(pagination.pages)}</span>
    <button type="button" class="button" data-activity-page="${page + 1}"${page >= pagination.pages ? ' disabled' : ''}>Older</button>`;
}

function activityPaint(selector, html) {
  const target = document.querySelector(selector);
  if (target && state.tab === 'activity') target.innerHTML = html;
}

function activityPaintList() {
  activityPaint('#activityControls', activityControls());
  activityPaint('#activityNotice', activityNotices());
  activityPaint('#activityList', activityListSection());
  activityPaint('#activityPager', activityPager());
}

function activityReadSummary() {
  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  return Promise.all(Object.keys(ACTIVITY_SEVERITIES).map((severity) => activitySettled(api(activityRoute({ limit: 1, since, severity, family: '' })))))
    .then((reads) => Object.fromEntries(Object.keys(ACTIVITY_SEVERITIES).map((severity, index) => [severity, reads[index]])));
}

// Reads one page of the list with the current filters and replaces the rows.
async function activityReadPage(page, seq) {
  const filters = `${activityState.family}|${activityState.severity}|${activityState.windowKey}`;
  const asked = Date.now();
  const read = await activitySettled(api(activityRoute({ page })));
  if (seq !== state.renderSeq || state.tab !== 'activity' || filters !== `${activityState.family}|${activityState.severity}|${activityState.windowKey}`) return false;
  if (read.error) { activityState.listError = read.error; return true; }
  const rows = array(read.data?.events);
  Object.assign(activityState, {
    listError: '', page, rows, pagination: read.data?.pagination || null, fresh: new Set(), newCount: 0, notice: '', open: new Set(),
    ...(page === 1 ? { behind: 0, seen: new Set(rows.map((event) => event.id)), newestAt: activityTime(rows[0]?.at) ?? asked } : {})
  });
  return true;
}

async function activityTab() {
  const seq = state.renderSeq;
  const [summary] = await Promise.all([activityReadSummary(), activityReadPage(1, seq)]);
  if (seq !== state.renderSeq || state.tab !== 'activity') return;
  Object.assign(activityState, { summary, loaded: true });
  const options = (entries, selected, all) => `<option value="">${e(all)}</option>${Object.entries(entries).map(([key, name]) => `<option value="${key}"${key === selected ? ' selected' : ''}>${e(name)}</option>`).join('')}`;
  content.innerHTML = `${heading('Activity', 'What Data did or noticed, newest first: scans, collectors, GPU hosts, network devices, janitor runs, live feeds and the MQTT monitor. Data keeps 30 days. Nothing on this tab changes anything.', '<button class="button" data-action="refresh">Refresh</button>')}
    ${heading('Last 24 hours', 'Every event of the last 24 hours, whatever the filters below.')}
    <section id="activitySummary" aria-live="off">${activitySummarySection()}</section>
    ${heading('Events', `${ACTIVITY_PAGE_SIZE} per page. Only changes are recorded: something that stays broken is not repeated.`)}
    <form id="activityFilters" class="file-filters">
      <label>Family <select name="family">${options(ACTIVITY_FAMILIES, activityState.family, 'All families')}</select></label>
      <label>Severity <select name="severity">${options(ACTIVITY_SEVERITIES, activityState.severity, 'All severities')}</select></label>
      <label>Period <select name="windowKey">${Object.entries(ACTIVITY_WINDOWS).map(([key, name]) => `<option value="${key}"${key === activityState.windowKey ? ' selected' : ''}>${e(name)}</option>`).join('')}</select></label>
    </form>
    <div id="activityControls" class="mqtt-controls">${activityControls()}</div>
    <div id="activityNotice" aria-live="polite">${activityNotices()}</div>
    <section id="activityList" aria-live="off">${activityListSection()}</section>
    <div id="activityPager" class="pager">${activityPager()}</div>`;
  if (!activityState.timer) activityState.timer = setInterval(activityPoll, ACTIVITY_POLL_MS);
}

// The timer stops at its first tick on another tab and asks nothing while the
// page is hidden or the list is paused. An answer is written only into the
// Activity tab that asked for it. The filters are never repainted here.
async function activityPoll() {
  if (state.tab !== 'activity') {
    clearInterval(activityState.timer);
    activityState.timer = null;
    return;
  }
  if (!activityState.loaded || activityState.busy || activityState.paused || document.hidden === true) return;
  const seq = state.renderSeq;
  const filters = `${activityState.family}|${activityState.severity}|${activityState.windowKey}`;
  activityState.busy = true;
  try {
    // Events at the newest known instant are asked for again and told apart by their id.
    const [summary, read] = await Promise.all([
      activityReadSummary(),
      activitySettled(api(activityRoute({ since: new Date(activityState.newestAt ?? Date.now()).toISOString() })))
    ]);
    if (seq !== state.renderSeq || state.tab !== 'activity' || filters !== `${activityState.family}|${activityState.severity}|${activityState.windowKey}`) return;
    activityState.summary = summary;
    activityPaint('#activitySummary', activitySummarySection());
    if (read.error) activityState.listError = read.error;
    else {
      activityState.listError = '';
      const fresh = array(read.data?.events).filter((event) => !activityState.seen.has(event.id));
      for (const event of fresh) activityState.seen.add(event.id);
      if (fresh.length) {
        activityState.newestAt = Math.max(activityState.newestAt ?? 0, activityTime(fresh[0].at) ?? 0);
        if (read.data?.pagination?.total > ACTIVITY_PAGE_SIZE) activityState.notice = `More than ${ACTIVITY_PAGE_SIZE} events arrived at once: only the newest ${ACTIVITY_PAGE_SIZE} were added. Use Refresh to read the list again.`;
        if (activityState.page === 1) {
          for (const event of fresh) activityState.fresh.add(event.id);
          activityState.rows = [...fresh, ...activityState.rows].slice(0, ACTIVITY_MAX_ROWS);
          activityState.newCount += fresh.length;
          if (activityState.pagination) activityState.pagination = { ...activityState.pagination, total: activityState.pagination.total + fresh.length };
        } else activityState.behind += fresh.length;
      }
    }
    activityPaintList();
    updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } finally { activityState.busy = false; }
}

async function activityGoTo(page) {
  if (state.tab !== 'activity' || !activityState.loaded || !Number.isInteger(page) || page < 1) return;
  if (await activityReadPage(page, state.renderSeq)) activityPaintList();
}

async function activitySetFilters({ family, severity, windowKey }) {
  if (state.tab !== 'activity' || !activityState.loaded) return;
  Object.assign(activityState, {
    family: ACTIVITY_FAMILIES[family] ? family : '', severity: ACTIVITY_SEVERITIES[severity] ? severity : '',
    windowKey: ACTIVITY_WINDOWS[windowKey] ? windowKey : 'all', rows: [], pagination: null
  });
  activityPaint('#activityList', '<p class="muted">Reading the events…</p>');
  if (await activityReadPage(1, state.renderSeq)) activityPaintList();
}

function activityTogglePause() {
  if (state.tab !== 'activity' || !activityState.loaded) return;
  activityState.paused = !activityState.paused;
  activityPaintList();
  if (!activityState.paused) activityPoll();
}

// The Overview card: the last warnings and errors, with a link to this tab.
// Its read is independent: a failure shows in the card, not on the Overview.
async function activityOverviewCard() {
  const seq = state.renderSeq;
  const reads = await Promise.all(['error', 'warning'].map((severity) => activitySettled(api(`/events?severity=${severity}&limit=${ACTIVITY_OVERVIEW_ROWS}`))));
  const target = document.querySelector('#overviewActivity');
  if (!target || seq !== state.renderSeq || state.tab !== 'overview') return;
  const failed = reads.find((read) => read.error);
  const events = reads.flatMap((read) => array(read.data?.events))
    .sort((a, b) => (activityTime(b.at) ?? 0) - (activityTime(a.at) ?? 0)).slice(0, ACTIVITY_OVERVIEW_ROWS);
  const body = failed ? `<p class="muted">The activity log could not be read from Data: ${e(failed.error)}.</p>`
    : events.length ? `<ul class="activity-recent">${events.map((event) => `<li>${activityPill(event.severity)} <span>${e(event.message || '—')}</span> <span class="muted">${activityWhen(event.at)}</span></li>`).join('')}</ul>`
      : '<p class="muted">No warning and no error in the 30 days Data keeps.</p>';
  target.innerHTML = `<article class="card activity-card"><div class="card-title"><h3>Recent activity: warnings and errors</h3><a class="link-button" href="#activity">Open the activity log</a></div>${body}</article>`;
}

document.addEventListener('click', (event) => {
  if (event.target.closest?.('[data-activity-action]')?.dataset.activityAction === 'pause') activityTogglePause();
  const page = event.target.closest?.('[data-activity-page]')?.dataset.activityPage;
  if (page) activityGoTo(Number(page));
});

document.addEventListener('change', (event) => {
  if (event.target.form?.id !== 'activityFilters') return;
  const fields = event.target.form.elements;
  activitySetFilters({ family: fields.family.value, severity: fields.severity.value, windowKey: fields.windowKey.value });
});

// `toggle` does not bubble: listen in the capture phase. Opened details stay
// open when new events redraw the table.
document.addEventListener('toggle', (event) => {
  const id = event.target.dataset?.activityId;
  if (!id) return;
  if (event.target.open) activityState.open.add(id); else activityState.open.delete(id);
}, true);

document.addEventListener('visibilitychange', () => { activityPoll(); });
