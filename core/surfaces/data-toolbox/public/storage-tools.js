'use strict';

// The scan part of the Toolbox Storage tab. Loaded before app.js, whose
// helpers (state, api, e, array, number, bytes, date, heading, label…) it uses
// when called.
// It sends the page's storage write: a request to the native collector
// to read one configured source again. A scan reads the disks and refreshes
// Data's index; it changes no file. While a scan is queued or running it is
// read again every three seconds, only on a visible Storage tab.
// Source names, paths and error texts come from Data: they are always escaped.

const SCAN_POLL_MS = 3000;
const SCAN_LIST_LIMIT = 12;
const SCAN_ACTIVE = Object.freeze(['queued', 'running', 'hashing']);
const SCAN_SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
const SCAN_FOLLOWED_MAX = 4;
const SCAN_READ_FAILURES_MAX = 5;
// The totals a scan record may carry, in reading order.
const SCAN_COUNTS = Object.freeze({
  files_seen: 'Files seen', files_processed: 'Files processed', inserted: 'New in the index', updated: 'Updated in the index',
  skipped: 'Skipped', stale_removed: 'Index rows removed (files no longer there)', directories: 'Folders holding files',
  hashed: 'Files hashed', hash_bytes: 'Bytes hashed', errors: 'Errors', metadata_errors: 'Metadata errors', hash_errors: 'Hash errors',
  rejected: 'Entries refused (outside the roots)', hashes_rejected: 'Hashes refused (malformed)',
  candidate_groups: 'Duplicate candidate groups', candidate_groups_selected: 'Candidate groups hashed this run',
  candidate_groups_complete: 'Candidate groups fully hashed', candidate_groups_partial: 'Candidate groups partly hashed',
  candidate_groups_deferred: 'Candidate groups left for a later run', candidate_files_deferred: 'Candidate files left for a later run',
  candidate_bytes_deferred: 'Candidate bytes left for a later run', candidate_groups_oversized: 'Candidate groups over the byte budget',
  candidate_files_oversized: 'Candidate files over the byte budget', candidate_bytes_oversized: 'Candidate bytes over the byte budget',
  content_probed: 'Files probed by content', content_probe_matched: 'Content probes that named a type', content_probe_errors: 'Content probe errors'
});
const SCAN_BYTE_COUNTS = Object.freeze(['hash_bytes', 'candidate_bytes_deferred', 'candidate_bytes_oversized']);

const scanState = {
  sources: [], scanners: [], scans: [], followed: new Map(), outcome: null, posting: '', pollError: '',
  loaded: false, busy: false, timer: null, open: new Set()
};

const scanSettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const scanId = (scan) => String(scan?._id ?? scan?.scan_id ?? scan?.scanId ?? '');
const scanIsActive = (scan) => SCAN_ACTIVE.includes(scan?.status);
const scanTime = (value) => { const ms = value ? new Date(value).getTime() : NaN; return Number.isFinite(ms) ? ms : null; };

function scanSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} min`;
}

// Data keeps a scan's source and roots under `config` and its totals under `counts`.
function scanSource(scan) {
  const roots = array(scan.config?.roots).join(', ');
  return scan.config?.source ? [scan.config.source, roots].filter(Boolean).join(' · ') : roots || scan.root || scan.source || scan.hostname || '—';
}

function scanPill(status) {
  const tone = ['complete', 'completed', 'done', 'success'].includes(status) ? 'good' : ['partial', 'failed', 'stopped'].includes(status) ? 'warn' : '';
  return `<span class="pill ${tone}">${e(status || 'unknown')}</span>`;
}

function scanCount(scan, key) {
  const value = scan.counts?.[key];
  return SCAN_BYTE_COUNTS.includes(key) ? bytes(value) : number(value);
}

function scanDuration(scan, now = Date.now()) {
  const started = scanTime(scan.started_at);
  if (started === null) return null;
  const finished = scanTime(scan.finished_at);
  return (finished ?? (scanIsActive(scan) ? now : NaN)) - started;
}

// What the final state means, in plain words. Data never removes index rows
// for a scan that did not complete.
function scanMeaning(scan) {
  const reason = scan.last_error ? ` Data's reason: <span class="mono">${e(scan.last_error)}</span>` : '';
  switch (scan.status) {
    case 'queued': return 'Waiting for the collector. It asks Data for work every 15 seconds and runs one scan at a time.';
    case 'running': return `The collector is reading the disks and sending what it finds.${reason}`;
    case 'hashing': return `The files are listed; hashes are being computed.${reason}`;
    case 'complete': case 'completed': return `Finished. The index matches what this scan saw.${reason}`;
    case 'partial': return `<strong>Partial.</strong> The scan ended without confirming every root, so the index was kept: the rows already recorded there were not removed. Check that the disk is mounted and readable, then scan again.${reason || ' Data gave no reason.'}`;
    case 'failed': return `<strong>Failed.</strong> The scan did not finish and removed nothing from the index.${reason || ' Data gave no reason.'}`;
    case 'stopped': return `<strong>Stopped</strong> before the end. Nothing was removed from the index.${reason}`;
    default: return `Data reports the status “${e(scan.status || 'unknown')}”.${reason}`;
  }
}

function scanRow(name, value) {
  return `<div class="metric-row"><span>${e(name)}</span><strong>${value}</strong></div>`;
}

function scanCollectorFor(source) {
  return scanState.scanners.find((scanner) => scanner.active === true && array(scanner.sources).includes(source)) || null;
}

// The listed scans, each in its freshest known state: a followed scan is read
// by its id even when the list itself could not be read again.
function scanListed() {
  return scanState.scans.map((scan) => scanState.followed.get(scanId(scan)) || scan);
}

function scanActiveFor(source) {
  return [...scanState.followed.values(), ...scanListed()].find((scan) => scanIsActive(scan) && scan.config?.source === source) || null;
}

// Why "Scan now" is not available for a source, or '' when it is.
function scanBlocked(source) {
  if (!SCAN_SOURCE_NAME.test(source.name)) return 'This source name is not one this page can send.';
  if (scanState.posting === source.name) return 'Sending the request…';
  if (scanState.posting) return 'Another request is being sent.';
  const active = scanActiveFor(source.name);
  if (active) return `A scan of this source is already ${active.status}: it is followed below.`;
  if (!scanCollectorFor(source.name)) return 'No active collector announces this source, so nothing would pick the scan up.';
  return '';
}

function scanSourceCard(source, index) {
  const collector = scanCollectorFor(source.name);
  const last = scanListed().find((scan) => scan.config?.source === source.name && !scanIsActive(scan));
  const blocked = scanBlocked(source);
  return `<article class="card scan-source">
    <div class="card-title"><h3>${e(source.name)}</h3><span class="pill ${collector ? 'good' : 'warn'}">${collector ? 'collector active' : 'no active collector'}</span></div>
    ${scanRow('Root', `<span class="mono">${e(source.root || '—')}</span>`)}
    ${scanRow('Collector', collector ? `<span class="mono">${e(collector.scannerId || collector.hostname || 'unknown')}</span>` : '—')}
    ${scanRow('Last finished scan', last ? `${scanPill(last.status)} ${date(last.finished_at || last.started_at)}` : '—')}
    <div class="scan-start">
      <button type="button" class="button" data-scan-source="${e(source.name)}" aria-describedby="scanReason${index}"${blocked ? ' disabled' : ''}>Scan now</button>
      <span id="scanReason${index}" class="muted">${e(blocked || 'Reads this source again. Hashing follows Data\'s default: duplicate candidates only.')}</span>
    </div>
  </article>`;
}

function scanSourcesSection() {
  if (!scanState.sources.length) return '<div class="empty">Data lists no storage source, so no scan can be asked for here.</div>';
  return `<div class="grid two">${scanState.sources.map(scanSourceCard).join('')}</div>`;
}

function scanOutcomeSection() {
  const outcome = scanState.outcome;
  return outcome ? `<div class="notice ${outcome.ok ? 'success' : 'warning'}">${e(outcome.text)}</div>` : '';
}

function scanProgressCard(scan) {
  const active = scanIsActive(scan);
  const now = Date.now();
  const requested = scanTime(scan.requested_at) ?? scan.requestedHere ?? null;
  const duration = scanDuration(scan, now);
  const waiting = scan.status === 'queued' && requested !== null ? scanSpan(now - requested) : null;
  const lastBatch = scanTime(scan.last_batch_at);
  return `<article class="card scan-progress ${active ? '' : 'ended'}">
    <div class="card-title"><h3>${e(scanSource(scan))}</h3>${scanPill(scan.status)}</div>
    <p class="scan-meaning">${scanMeaning(scan)}</p>
    ${scan.joined ? '<p class="muted">Joined: this scan was already there when you asked, no second one was started.</p>' : ''}
    ${scan.readError ? `<div class="notice warning">This scan could not be read from Data: ${e(scan.readError)}.${scan.abandoned ? ' It is no longer followed; use Refresh.' : ' The values below are the last ones read.'}</div>` : ''}
    <div class="scan-figures">
      ${scanRow('Files seen', scanCount(scan, 'files_seen'))}
      ${scanRow('Files processed', scanCount(scan, 'files_processed'))}
      ${scanRow('Files hashed', scanCount(scan, 'hashed'))}
      ${scanRow('Errors', scanCount(scan, 'errors'))}
      ${scanRow(waiting ? 'Waiting for' : active ? 'Elapsed' : 'Duration', e(waiting || scanSpan(duration ?? NaN)))}
      ${scanRow('Started', date(scan.started_at))}
      ${active ? scanRow('Last batch received', lastBatch === null ? '—' : `${e(scanSpan(now - lastBatch))} ago`) : scanRow('Finished', date(scan.finished_at))}
      ${scan.last_path ? scanRow('Last path', `<span class="mono">${e(scan.last_path)}</span>`) : ''}
    </div>
    <p class="muted mono">scan ${e(scanId(scan))}${scan.claimed_by ? ` · run by ${e(scan.claimed_by)}` : ''}</p>
    ${active && scan.config?.external !== false ? '<p class="muted">A scan run by the collector cannot be stopped from here: Data has no stop for it. It ends on its own.</p>' : ''}
  </article>`;
}

function scanProgressSection() {
  const followed = [...scanState.followed.values()];
  const notice = scanState.pollError ? `<div class="notice warning">The scan list could not be read from Data: ${e(scanState.pollError)}. What is shown is the last state read.</div>` : '';
  if (!followed.length) return notice;
  const active = followed.some(scanIsActive);
  return `${heading(active ? 'Scan in progress' : 'Scan followed from this page', active
    ? `Read again every ${SCAN_POLL_MS / 1000} s while this tab is open and visible.`
    : 'The final state of the scans that ran while this page was open.')}${notice}
    <div class="grid two">${followed.map(scanProgressCard).join('')}</div>`;
}

function scanDetail(scan) {
  const id = scanId(scan);
  const requested = scanTime(scan.requested_at);
  const started = scanTime(scan.started_at);
  const duration = scanDuration(scan);
  const counts = scan.counts && typeof scan.counts === 'object' ? scan.counts : {};
  const known = Object.keys(SCAN_COUNTS).filter((key) => key in counts || ['files_seen', 'files_processed', 'hashed', 'errors'].includes(key));
  const other = Object.keys(counts).filter((key) => !(key in SCAN_COUNTS)).slice(0, 20);
  const files = counts.files_seen ?? counts.files_processed ?? scan.file_count ?? scan.fileCount ?? scan.files;
  const config = scan.config || {};
  return `<details class="scan-detail" data-scan-detail="${e(id)}"${scanState.open.has(id) ? ' open' : ''}>
    <summary>${scanPill(scan.status)} <strong>${e(scanSource(scan))}</strong> <span class="muted">${date(scan.started_at || scan.requested_at || scan.created_at)} · ${number(files)} files · ${e(scanSpan(duration ?? NaN))}</span></summary>
    <p class="scan-meaning">${scanMeaning(scan)}</p>
    <div class="grid two">
      <article class="card"><h3>Timing</h3>
        ${scanRow('Requested', date(scan.requested_at))}
        ${scanRow('Waited in the queue', e(requested !== null && started !== null ? scanSpan(started - requested) : '—'))}
        ${scanRow('Started', date(scan.started_at))}
        ${scanRow('Finished', date(scan.finished_at))}
        ${scanRow('Duration', e(scanSpan(duration ?? NaN)))}
        ${scanRow('Last batch received', date(scan.last_batch_at))}
        ${scanRow('Run by', `<span class="mono">${e(scan.claimed_by || (config.external === true ? '—' : 'Data itself'))}</span>`)}
        ${scanRow('Hashing', e(config.hash_mode ? `${label(config.hash_mode)}${config.hash_max_files ? ` · at most ${number(config.hash_max_files)} files, ${bytes(config.hash_max_bytes)}` : ''}` : '—'))}
        ${scanRow('Scan id', `<span class="mono">${e(id || '—')}</span>`)}
      </article>
      <article class="card"><h3>Counts</h3>
        ${known.map((key) => scanRow(SCAN_COUNTS[key], scanCount(scan, key))).join('')}
        ${other.map((key) => scanRow(label(key), number(counts[key]))).join('')}
      </article>
    </div>
  </details>`;
}

function scanHistorySection() {
  if (!scanState.scans.length) return '<div class="empty">Data has no scan on record.</div>';
  return scanListed().map(scanDetail).join('');
}

function scanPaint(selector, html) {
  const target = document.querySelector(selector);
  if (target && state.tab === 'storage') target.innerHTML = html;
}

function scanPaintAll() {
  scanPaint('#scanSources', scanSourcesSection());
  scanPaint('#scanOutcome', scanOutcomeSection());
  scanPaint('#scanProgress', scanProgressSection());
  scanPaint('#scanHistory', scanHistorySection());
}

// Keeps what is already known about a followed scan (when it was requested,
// that it was joined) and lays the newer read over it.
function scanFollow(scan, extra = {}) {
  const id = scanId(scan);
  if (!id) return;
  scanState.followed.set(id, { ...scanState.followed.get(id), ...scan, _id: id, ...extra });
  const ended = [...scanState.followed.values()].filter((item) => !scanIsActive(item));
  for (const item of ended.slice(0, Math.max(0, scanState.followed.size - SCAN_FOLLOWED_MAX))) scanState.followed.delete(scanId(item));
}

function scanTakeList(scans) {
  scanState.scans = array(scans);
  for (const scan of scanState.scans) {
    if (scanIsActive(scan) || scanState.followed.has(scanId(scan))) scanFollow(scan, { readError: '', failures: 0 });
  }
}

// Called by the Storage tab with what it has just read; returns the sections.
function storageScanSections(agentsBody, scansBody) {
  const registry = agentsBody?.sources && typeof agentsBody.sources === 'object' && !Array.isArray(agentsBody.sources) ? agentsBody.sources : {};
  scanState.sources = Object.keys(registry).slice(0, 50).map((name) => ({ name, root: registry[name]?.canonicalRoot }));
  scanState.scanners = array(agentsBody?.scanners || agentsBody?.agents || agentsBody);
  scanState.pollError = '';
  scanTakeList(scansBody?.scans || scansBody);
  return `${heading('Scan now', 'Ask the native collector to read a source again. A scan reads the disks and refreshes the index, where the rows of files no longer there are removed. Nothing on the disks is changed.')}
    <section id="scanSources">${scanSourcesSection()}</section>
    <div id="scanOutcome" role="status" aria-live="polite">${scanOutcomeSection()}</div>
    <section id="scanProgress" aria-live="off">${scanProgressSection()}</section>
    ${heading('Scan history', `The last ${SCAN_LIST_LIMIT} scans Data started, newest first. Open one for its timing, counts and error.`)}
    <section id="scanHistory">${scanHistorySection()}</section>`;
}

// Called once the sections are on the page.
function storageScanStart() {
  scanState.loaded = true;
  if (!scanState.timer && [...scanState.followed.values()].some(scanIsActive)) scanState.timer = setInterval(scanPoll, SCAN_POLL_MS);
}

// The timer stops at its first tick on another tab, and when no followed scan
// is queued or running. It asks nothing while the page is hidden. An answer is
// written only into the Storage tab that asked for it.
async function scanPoll() {
  const pending = [...scanState.followed.values()].filter((scan) => scanIsActive(scan) && !scan.abandoned);
  if (state.tab !== 'storage' || !pending.length) {
    clearInterval(scanState.timer);
    scanState.timer = null;
    return;
  }
  if (!scanState.loaded || scanState.busy || document.hidden === true) return;
  const seq = state.renderSeq;
  scanState.busy = true;
  try {
    const list = await scanSettled(api(`/storage/scans?limit=${SCAN_LIST_LIMIT}`));
    if (seq !== state.renderSeq || state.tab !== 'storage') return;
    scanState.pollError = list.error || '';
    const listed = list.error ? [] : array(list.data?.scans || list.data);
    if (!list.error) scanTakeList(listed);
    // A queued scan has no start date and sorts after every other in Data's
    // list: what the list does not show is read by its id.
    const seen = new Set(listed.map(scanId));
    for (const scan of pending.filter((item) => !seen.has(scanId(item)))) {
      const read = await scanSettled(api(`/storage/scans/${encodeURIComponent(scanId(scan))}`));
      if (seq !== state.renderSeq || state.tab !== 'storage') return;
      if (read.error) {
        const failures = (scan.failures || 0) + 1;
        scanFollow(scan, { readError: read.error, failures, abandoned: failures >= SCAN_READ_FAILURES_MAX });
      } else scanFollow({ ...read.data, _id: scanId(scan) }, { readError: '', failures: 0 });
    }
    // A scan that has just ended is in the list with its final counts.
    if (!list.error && pending.some((scan) => !scanIsActive(scanState.followed.get(scanId(scan))) && !seen.has(scanId(scan)))) {
      const again = await scanSettled(api(`/storage/scans?limit=${SCAN_LIST_LIMIT}`));
      if (seq !== state.renderSeq || state.tab !== 'storage') return;
      if (!again.error) scanTakeList(again.data?.scans || again.data);
    }
    // The "queued" line has done its job once that scan has ended.
    if (scanState.outcome?.ok && !scanIsActive(scanState.followed.get(scanState.outcome.id))) scanState.outcome = null;
    scanPaintAll();
    updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } finally { scanState.busy = false; }
}

async function scanRequest(source) {
  if (scanState.posting || state.tab !== 'storage' || !scanState.loaded) return;
  const known = scanState.sources.find((item) => item.name === source);
  if (!known || scanBlocked(known)) return;
  scanState.posting = source;
  scanState.outcome = null;
  scanPaintAll();
  try {
    const answer = await api('/storage/scans', { method: 'POST', payload: { source } });
    const id = scanId(answer);
    const joined = answer.coalesced === true;
    if (!id) throw new Error('Data accepted the request without naming a scan. Use Refresh to see it.');
    const already = scanState.followed.get(id);
    scanFollow({ _id: id, status: already?.status || 'queued', config: { external: true, source: answer.source || source, roots: [answer.root || known.root].filter(Boolean), hash_mode: answer.hash_mode, ...already?.config } },
      { joined, ...(joined ? {} : { requestedHere: Date.now() }) });
    scanState.outcome = { ok: true, id, text: joined
      ? `A scan of ${answer.source || source} was already queued or running: joined it (scan ${id}). No second scan was started.`
      : `Scan ${id} queued for ${answer.source || source}${answer.root ? ` (${answer.root})` : ''}. The collector picks it up within about 15 seconds.` };
  } catch (error) {
    scanState.outcome = { ok: false, text: `Not started: ${error.message}` };
  } finally {
    scanState.posting = '';
  }
  scanPaintAll();
  if (scanState.outcome.ok && state.tab === 'storage') {
    if (!scanState.timer) scanState.timer = setInterval(scanPoll, SCAN_POLL_MS);
    scanPoll();
  }
}

document.addEventListener('click', (event) => {
  const source = event.target.closest?.('[data-scan-source]')?.dataset.scanSource;
  if (source) scanRequest(source);
});

// `toggle` does not bubble: listen in the capture phase. An opened scan stays
// open when a poll redraws the history.
document.addEventListener('toggle', (event) => {
  const id = event.target.dataset?.scanDetail;
  if (!id) return;
  if (event.target.open) scanState.open.add(id); else scanState.open.delete(id);
}, true);

document.addEventListener('visibilitychange', () => { scanPoll(); });
