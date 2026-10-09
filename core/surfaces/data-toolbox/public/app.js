'use strict';

const content = document.querySelector('#content');
const updated = document.querySelector('#lastUpdated');
const state = {
  status: null,
  tab: '',
  filesPage: 1,
  filesQuery: '',
  janitorReview: {},
  janitorReportGeneratedAt: null,
  janitorReviewLoadedFor: null,
  janitorReviewLoaded: false,
  janitorReviewDraftFrom: null,
  janitorReviewImportedAt: null,
  renderSeq: 0
};
const JANITOR_CURRENT_RUN_MS = 24 * 60 * 60 * 1000;
const JANITOR_REVIEW_STORAGE_KEY = 'agentx.data-toolbox.janitor-review-draft.v1';

const e = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const array = (value) => Array.isArray(value) ? value : [];
const measurement = (value) => value == null || (typeof value === 'string' && !value.trim()) ? NaN : Number(value);
const number = (value) => Number.isFinite(measurement(value)) ? measurement(value).toLocaleString() : '—';
const bytes = (value) => {
  const size = measurement(value);
  if (!Number.isFinite(size)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let index = 0; let result = size;
  while (Math.abs(result) >= 1024 && index < units.length - 1) { result /= 1024; index++; }
  return `${result.toFixed(index ? 1 : 0)} ${units[index]}`;
};
const percent = (value) => {
  const ratio = measurement(value);
  if (!Number.isFinite(ratio)) return '—';
  const normalized = ratio <= 1 ? ratio * 100 : ratio;
  return `${normalized.toFixed(normalized < 1 ? 2 : 1)}%`;
};
const date = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? e(value) : parsed.toLocaleString();
};
const statusPill = (ok, yes = 'online', no = 'offline') => `<span class="pill ${ok ? 'good' : ''}">${e(ok ? yes : no)}</span>`;
const label = (value) => String(value || '—').replace(/_/g, ' ');
const signedNumber = (value) => {
  const amount = measurement(value);
  if (!Number.isFinite(amount)) return '—';
  return `${amount > 0 ? '+' : ''}${amount.toLocaleString()}`;
};
const signedBytes = (value) => {
  const amount = measurement(value);
  if (!Number.isFinite(amount)) return '—';
  return `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${bytes(Math.abs(amount))}`;
};

function janitorRunSummary(run) {
  const actions = array(run?.proposed_actions);
  const targetFiles = actions.reduce((sum, action) => sum + array(action.files).length, 0);
  const proposedBytes = actions.reduce((sum, action) => sum + Number(action.space_saved || 0), 0);
  const finishedAt = run?.finished_at || run?.started_at;
  const finishedMs = finishedAt ? new Date(finishedAt).getTime() : NaN;
  const current = Number.isFinite(finishedMs) && Date.now() - finishedMs <= JANITOR_CURRENT_RUN_MS;
  return { actions, targetFiles, proposedBytes, finishedAt, current };
}

function janitorReviewPayload() {
  return {
    schemaVersion: 1,
    kind: 'janitor-review-draft',
    portfolioGeneratedAt: state.janitorReportGeneratedAt,
    capturedAt: new Date().toISOString(),
    authorizesFilesystemMutation: false,
    // Set once the draft was imported into Data; the draft then stays as a backup.
    ...(state.janitorReviewImportedAt ? { importedAt: state.janitorReviewImportedAt } : {}),
    decisions: Object.values(state.janitorReview)
  };
}

function normalizeJanitorReviewDecision(input) {
  if (!input || typeof input !== 'object') return null;
  const sha256 = typeof input.sha256 === 'string' ? input.sha256.trim() : '';
  if (!sha256 || sha256.length > 128) return null;
  if (!['accept_for_preview', 'reject_keep_all'].includes(input.decision)) return null;
  // The file size and the copies seen, when the draft recorded them: an import
  // into Data needs both as the evidence the decision was made on.
  const seen = array(input.paths).filter(path => typeof path === 'string' && path).slice(0, 500);
  const evidence = {
    ...(Number.isSafeInteger(input.size) && input.size > 0 ? { size: input.size } : {}),
    ...(seen.length > 1 ? { paths: seen } : {})
  };
  if (input.decision === 'reject_keep_all') {
    return {
      ...evidence,
      sha256,
      decision: 'reject_keep_all',
      keepPath: null,
      removePaths: [],
      reason: 'operator rejected deletion proposal; keep every member'
    };
  }
  const keepPath = typeof input.keepPath === 'string' ? input.keepPath : '';
  const removePaths = array(input.removePaths)
    .filter(path => typeof path === 'string' && path && path !== keepPath)
    .slice(0, 10000);
  if (!keepPath || !removePaths.length) return null;
  return {
    ...evidence,
    sha256,
    decision: 'accept_for_preview',
    keepPath,
    removePaths,
    reason: 'operator-selected survivor; complete SHA-256 preview required'
  };
}

function persistJanitorReviewDraft() {
  try {
    const decisions = Object.values(state.janitorReview);
    if (!decisions.length) localStorage.removeItem(JANITOR_REVIEW_STORAGE_KEY);
    else localStorage.setItem(JANITOR_REVIEW_STORAGE_KEY, JSON.stringify(janitorReviewPayload()));
    return true;
  } catch {
    return false;
  }
}

function restoreJanitorReviewDraft(portfolioGeneratedAt) {
  // Decisions are keyed by content hash (SHA-256), so they stay valid across
  // portfolio reports and across page loads. The stored envelope is only
  // discarded when it is structurally invalid — never because the report was
  // regenerated, is still loading, or failed to load: those are exactly the
  // moments when an operator would lose an afternoon of review work.
  if (state.janitorReviewLoadedFor === portfolioGeneratedAt && state.janitorReviewLoaded) return;
  state.janitorReviewLoadedFor = portfolioGeneratedAt;
  state.janitorReviewLoaded = true;
  const restored = {};
  try {
    const raw = localStorage.getItem(JANITOR_REVIEW_STORAGE_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    const validEnvelope = draft?.schemaVersion === 1
      && draft.kind === 'janitor-review-draft'
      && draft.authorizesFilesystemMutation === false
      && Array.isArray(draft.decisions);
    if (!validEnvelope) {
      localStorage.removeItem(JANITOR_REVIEW_STORAGE_KEY);
      return;
    }
    for (const input of draft.decisions.slice(0, 10000)) {
      const decision = normalizeJanitorReviewDecision(input);
      if (decision) restored[decision.sha256] = decision;
    }
    state.janitorReviewDraftFrom = draft.portfolioGeneratedAt || null;
    state.janitorReviewImportedAt = typeof draft.importedAt === 'string' ? draft.importedAt.slice(0, 40) : null;
  } catch {
    try { localStorage.removeItem(JANITOR_REVIEW_STORAGE_KEY); } catch {}
  }
  // Keep whatever this session already holds in memory: a failed restore must
  // never erase decisions taken seconds ago.
  state.janitorReview = { ...restored, ...state.janitorReview };
}

function clearJanitorReviewDraft() {
  state.janitorReview = {};
  state.janitorReviewDraftFrom = null;
  state.janitorReviewImportedAt = null;
  state.janitorReviewLoadedFor = state.janitorReportGeneratedAt;
  try { localStorage.removeItem(JANITOR_REVIEW_STORAGE_KEY); } catch {}
}

async function copyJanitorReview() {
  await navigator.clipboard.writeText(JSON.stringify(janitorReviewPayload(), null, 2));
}

function downloadJanitorReview() {
  const blob = new Blob([JSON.stringify(janitorReviewPayload(), null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `janitor-review-draft-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(href);
}

async function api(route, { method = 'GET', payload } = {}) {
  const headers = { Accept: 'application/json', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) };
  const response = await fetch(`/api/data-toolbox${route}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  let body;
  try { body = await response.json(); } catch { throw new Error('Data projection returned an unreadable response. Try again.'); }
  if (!body || typeof body !== 'object') throw new Error('Data projection returned an unreadable response. Try again.');
  if (!response.ok || body.ok === false || body.status === 'error') throw new Error(body.message || body.error || `${route} returned ${response.status}`);
  return body.data ?? body;
}

function loading(label = 'Loading Data…') {
  content.innerHTML = `<div class="loading"><span></span>${e(label)}</div>`;
}

function errorView(error) {
  content.innerHTML = `<div class="error"><div><strong>Data projection unavailable</strong><p>${e(error.message)}</p><button class="button" data-action="refresh">Try again</button></div></div>`;
}

function heading(title, detail, action = '') {
  return `<header class="section-head"><div><h2>${e(title)}</h2><p>${e(detail)}</p></div>${action}</header>`;
}

function metric(value, label) {
  return `<article class="card"><strong class="metric">${e(value)}</strong><span class="metric-label">${e(label)}</span></article>`;
}

function collectorCard(agent, kind) {
  const id = String(agent.scannerId || agent.id || '').trim() || 'unknown';
  const placement = state.status?.collectorPlacement?.[kind]?.[id];
  const active = agent.active === true;
  const host = placement?.host || `${agent.hostname || 'Unknown host'} · ${agent.platform || 'unknown platform'}`;
  const supervisor = placement?.supervisor || 'No current placement contract';
  const runtime = placement?.runtime || 'Historical registration only';
  const cadence = placement?.cadence || 'not scheduled';
  const scope = kind === 'network'
    ? (agent.cidr || 'CIDR unavailable')
    : (array(agent.sources).join(', ') || 'sources unavailable');
  return `<article class="card collector-card">
    <div class="card-title"><h3>${e(id)}</h3>${statusPill(active, 'active', placement ? 'inactive' : 'historical')}</div>
    <div class="metric-row"><span>Runs on</span><strong>${e(host)}</strong></div>
    <div class="metric-row"><span>Supervisor</span><strong>${e(supervisor)}</strong></div>
    <div class="metric-row"><span>Unit / task</span><strong class="mono">${e(runtime)}</strong></div>
    <div class="metric-row"><span>Cadence</span><strong>${e(cadence)}</strong></div>
    <div class="metric-row"><span>Last heartbeat</span><strong>${date(agent.lastSeen)}</strong></div>
    ${kind === 'network' ? `<div class="metric-row"><span>Last scan</span><strong>${date(agent.lastScanAt)}</strong></div>` : ''}
    <div class="metric-row"><span>${kind === 'network' ? 'CIDR' : 'Sources'}</span><strong class="mono">${e(scope)}</strong></div>
    <div class="metric-row"><span>Collector version</span><strong class="mono">${e(agent.agentVersion || 'unknown')}</strong></div>
  </article>`;
}

function trend(value, label, positiveIsGood = true, formatter = signedNumber) {
  const amount = measurement(value);
  if (!Number.isFinite(amount)) return `<article class="trend"><strong>—</strong><span>${e(label)}</span></article>`;
  const directionIsGood = amount === 0 || (amount > 0) === positiveIsGood;
  return `<article class="trend ${directionIsGood ? 'positive' : 'attention'}"><strong>${e(formatter(amount))}</strong><span>${e(label)}</span></article>`;
}

function noRows(columns, message = 'No records returned.') {
  return `<tr><td colspan="${columns}" class="muted">${e(message)}</td></tr>`;
}

async function ensureStatus(force = false) {
  if (!state.status || force) {
    const status = await api('/status');
    const sources = status?.sources;
    const entries = sources && typeof sources === 'object' && !Array.isArray(sources)
      ? Object.values(sources) : [];
    const counts = status?.dataService;
    if (!Number.isSafeInteger(counts?.healthy) || !Number.isSafeInteger(counts?.total)
      || counts.healthy < 0 || counts.total < 1 || counts.healthy > counts.total
      || !entries.length || entries.length !== counts.total
      || !['health', 'resources', 'storage', 'network', 'liveData', 'databases', 'janitor']
        .every((key) => Object.hasOwn(sources, key))
      || !entries.every((source) => source && typeof source.ok === 'boolean')
      || entries.filter((source) => source.ok).length !== counts.healthy) {
      throw new Error('Data projection returned an unexpected response. Try again.');
    }
    state.status = status;
  }
  updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  return state.status;
}

async function overview() {
  const status = await ensureStatus(true);
  const sources = status.sources || {};
  const storage = sources.storage?.data || {};
  const devices = sources.network?.data?.devices || [];
  const networkSummary = sources.network?.data?.summary || null;
  const feeds = array(sources.liveData?.data);
  const database = sources.databases?.data || {};
  const profiles = sources.janitor?.data?.profiles || [];
  content.innerHTML = `${heading('Operational overview', 'A bounded health projection assembled from the existing Data service engines.', '<button class="button" data-action="refresh">Refresh</button>')}
    <div class="grid">
      ${metric(`${status.dataService?.healthy ?? 0}/${status.dataService?.total ?? 0}`, 'healthy Data capabilities')}
      ${metric(number(storage.totalFiles), 'indexed files')}
      ${metric(sources.network?.ok ? number(devices.length) : '—', 'known network devices')}
      ${metric(networkSummary ? number(networkSummary.online) : '—', networkSummary ? `online now (≤ ${ttlLabel(networkSummary.onlineTtlMs)})` : 'online now (not observed)')}
      ${metric(number(database.totalCollections), 'MongoDB collections')}
    </div>
    <div class="source-list">${Object.entries(sources).map(([name, source]) => `<div class="source ${source.ok ? 'ok' : ''}"><span class="dot"></span><strong>${e(name)}</strong></div>`).join('')}</div>
    <div class="grid two" style="margin-top:14px">
      <article class="card"><h3>Storage evidence</h3>
        <div class="metric-row"><span>Inventory size</span><strong>${e(storage.totalSizeFormatted || bytes(storage.totalSize))}</strong></div>
        <div class="metric-row"><span>File hash coverage</span><strong>${percent(storage.hashCoverageFiles)}</strong></div>
        <div class="metric-row"><span>Duplicate candidates</span><strong>${number(storage.duplicateCandidates?.groups ?? storage.duplicateCandidates)}</strong></div>
        <div class="metric-row"><span>Last inventory</span><strong>${date(storage.lastScan?.finished_at || storage.lastScan?.started_at || storage.lastScan)}</strong></div>
      </article>
      <article class="card"><h3>Automation visibility</h3>
        <div class="metric-row"><span>Live feeds</span><strong>${sources.liveData?.ok ? `${feeds.filter((feed) => feed.enabled).length}/${feeds.length} enabled` : '—'}</strong></div>
        <div class="metric-row"><span>Janitor profiles</span><strong>${sources.janitor?.ok ? number(profiles.length) : '—'}</strong></div>
        <div class="metric-row"><span>Write routes</span><strong>9 in 7 families · network device record, network scan request, MQTT publish, storage scan request, Janitor review decisions (save, import, remove), report generation, report deletion</strong></div>
        <div class="metric-row"><span>Projection authority</span><strong>AgentX Data</strong></div>
      </article>
    </div>
    <section id="overviewActivity"></section>`;
  // The last warnings and errors of the activity log: activity.js reads them apart.
  if (typeof activityOverviewCard === 'function') activityOverviewCard();
}

async function storage() {
  // Growth and Reports are views of this tab: storage-views.js draws them.
  if (typeof storageOtherView === 'function' && await storageOtherView()) return;
  const [summary, scansBody, agentsBody] = await Promise.all([
    api('/storage/summary'), api('/storage/scans?limit=12'), api('/storage/agents')
  ]);
  const agents = array(agentsBody.scanners || agentsBody.agents || agentsBody);
  content.innerHTML = `${heading('Storage evidence', 'Inventory coverage, scan receipts, and the native Data collector that can see shared storage. A scan can be asked for below; it only reads the disks.', '<button class="button" data-action="refresh">Refresh</button>')}
    ${typeof storageViewSwitch === 'function' ? storageViewSwitch() : ''}
    <div class="grid">
      ${metric(number(summary.totalFiles), 'files inventoried')}
      ${metric(summary.totalSizeFormatted || bytes(summary.totalSize), 'inventory size')}
      ${metric(percent(summary.hashCoverageFiles), 'files hash-current')}
      ${metric(number(summary.duplicateCandidates?.groups ?? summary.duplicateCandidates), 'duplicate candidate groups')}
    </div>
    <div class="notice warning">Duplicate groups larger than a run's byte budget can progress across runs when each individual file fits that budget. An individual unhashed file above its root's recorded byte budget remains unverified until that limit is raised.</div>
    <div class="grid two">
      <article class="card"><h3>Evidence coverage</h3>
        <div class="metric-row"><span>Hashed files</span><strong>${number(summary.hashedFiles)}</strong></div>
        <div class="metric-row"><span>Hashed bytes</span><strong>${bytes(summary.hashedBytes)}</strong></div>
        <div class="metric-row"><span>Metadata coverage</span><strong>${percent(summary.metadataCoverageFiles)}</strong></div>
        <div class="metric-row"><span>Verification queue</span><strong>${number(summary.verificationQueue?.filesToHash ?? summary.verificationQueue)}</strong></div>
      </article>
      <article class="card"><h3>Native Data collector</h3>
        <div class="metric-row"><span>Active</span><strong>${agents.filter((agent) => agent.active === true).length}/${agents.length}</strong></div>
        <div class="metric-row"><span>Purpose</span><strong>read-only Media / Datalake inventory</strong></div>
        <div class="metric-row"><span>Destination</span><strong class="mono">Data :3083 /storage</strong></div>
        <div class="metric-row"><span>Product dependency</span><strong class="good">none</strong></div>
      </article>
    </div>
    ${heading('Where storage collection runs', 'This is a host-native Data process, not an AgentX Product or LLM agent.')}
    <div class="grid two">${agents.length ? agents.map((agent) => collectorCard(agent, 'storage')).join('') : '<div class="empty">No storage collectors registered.</div>'}</div>
    ${storageScanSections(agentsBody, scansBody)}`;
  storageScanStart();
}

// The Files tab (inventory, folders, duplicates, cleanup) lives in files-tools.js.

const OBSERVATION_LABELS = Object.freeze({
  online: 'online now',
  recent: 'recently seen',
  historical: 'historical',
  never_confirmed: 'never confirmed'
});

function observationPill(observation) {
  const state = observation?.state && OBSERVATION_LABELS[observation.state] ? observation.state : null;
  if (!state) return '<span class="pill">not observed</span>';
  return `<span class="pill ${state === 'online' ? 'good' : ''}" title="${e(observation.source ? `Reported by ${observation.source}` : 'Reporting collector unknown')}">${e(OBSERVATION_LABELS[state])}</span>`;
}

function ttlLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value >= 3600000 ? `${Math.round(value / 3600000)}h` : `${Math.round(value / 60000)}m`;
}

// The metrics and the line stating Data's observation windows. network-tools.js
// repaints this block after a scan or a reload.
function networkOverview(devicesBody, agentsBody, capability) {
  const devices = array(devicesBody.devices || devicesBody);
  const agents = array(agentsBody.scanners || agentsBody.agents || agentsBody);
  // Data owns the temporal semantics: `summary` states the reference time and
  // the windows behind every count. Without it, "currently online" is not
  // observed rather than recomputed from the raw flag.
  const summary = devicesBody.summary && typeof devicesBody.summary === 'object' ? devicesBody.summary : null;
  const onlineNow = summary ? number(summary.online) : '—';
  const referenceLine = summary
    ? `Reference time ${date(summary.referenceTime)} · online = seen within ${ttlLabel(summary.onlineTtlMs)} by a reporting collector · recent = within ${ttlLabel(summary.recentTtlMs)} · ${number(summary.reportedOnline)} rows still carry a raw online flag`
    : 'Data did not report the observation windows; "online now" is not observed.';
  return `<div class="grid">
      ${metric(number(devices.length), 'known devices')}
      ${metric(onlineNow, 'online now')}
      ${metric(summary ? number(summary.recent) : '—', 'recently seen')}
      ${metric(summary ? number(summary.historical + summary.never_confirmed) : '—', 'historical / never confirmed')}
      ${metric(`${agents.filter((agent) => agent.active === true).length}/${agents.length}`, 'active / registered collectors')}
      ${metric(capability.nmap === true || capability.nmap?.available || capability.nmapAvailable || agents.some((agent) => agent.active === true && agent.capabilities?.nmap) ? 'ready' : 'bounded', 'native scan capability')}
    </div>
    <p class="muted" id="networkObservationRules">${e(referenceLine)}</p>`;
}

// The collectors, the scan request, the device list and its editors live in
// network-tools.js, which the page loads before this file.
async function network() {
  const [devicesBody, agentsBody, capability] = await Promise.all([api('/network/devices'), api('/network/agents'), api('/network/capability')]);
  content.innerHTML = `${heading('Network inventory', 'Observed devices and the host-native Data collectors that can see the real LAN. From here you can ask the active collector for a scan and edit what Data records about a device: its name, known flag, type, location and notes.', '<button class="button" data-action="refresh">Refresh</button>')}
    <div id="netOverview">${networkOverview(devicesBody, agentsBody, capability)}</div>
    ${typeof netMount === 'function' ? netMount(devicesBody, agentsBody, capability) : '<div class="notice warning">The network tools script did not load. Reload the page.</div>'}`;
}

async function databases() {
  const result = await api('/databases/collections');
  const collections = array(result.collections);
  content.innerHTML = `${heading('Database browser', `MongoDB ${result.database || ''}: collection metadata and bounded document inspection.`)}
    <div class="notice warning">Document contents may contain operational or personal data. Open a collection only when needed; this browser cannot modify it.</div>
    <div class="table-wrap"><table><thead><tr><th>Collection</th><th>Documents</th><th>Logical size</th><th>Storage</th><th>Inspection</th></tr></thead><tbody>
      ${collections.length ? collections.map((collection) => `<tr><td class="mono">${e(collection.name)}</td><td>${number(collection.count)}</td><td>${bytes(collection.size)}</td><td>${bytes(collection.storageSize)}</td><td><button class="button" data-collection="${e(collection.name)}">Inspect</button></td></tr>`).join('') : noRows(5)}
    </tbody></table></div><section id="documentInspector"></section>`;
}

// ── Structured, read-only inspectors ─────────────────────────────────────
// Documents and feed points render as bounded tables first; the raw JSON
// stays available under an expert disclosure, never as the default view.

const INSPECT_LIMIT = 20;
const TIMESTAMP_KEYS = ['timeStamp', 'timestamp', 'ts', 'createdAt', 'updatedAt', 'lastSeen', 'observedAt', 'at', 'time'];

function valueKind(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) return 'date';
  return typeof value;
}

function ageLabel(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

function cellValue(value) {
  const kind = valueKind(value);
  if (kind === 'null') return '<span class="muted">—</span>';
  if (kind === 'date') return `${e(date(value))} <span class="muted">${e(ageLabel(value))}</span>`;
  if (kind === 'array') return `<span class="muted">[${value.length} item${value.length === 1 ? '' : 's'}]</span>`;
  if (kind === 'object') return `<span class="muted">{${Object.keys(value).length} field${Object.keys(value).length === 1 ? '' : 's'}}</span>`;
  if (kind === 'boolean') return `<span class="pill ${value ? 'good' : ''}">${value ? 'true' : 'false'}</span>`;
  if (kind === 'number') return `<span class="mono">${e(Number(value).toLocaleString())}</span>`;
  const text = String(value);
  return text.length > 80 ? `${e(text.slice(0, 80))}…` : e(text);
}

function documentColumns(docs, hintedFields) {
  const counts = new Map();
  for (const doc of docs) for (const key of Object.keys(doc || {})) counts.set(key, (counts.get(key) || 0) + 1);
  const ordered = [...new Set(['_id', ...array(hintedFields), ...[...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))])]
    .filter((key) => counts.has(key));
  return ordered.slice(0, 8);
}

function fieldTypes(docs) {
  const types = new Map();
  for (const doc of docs) for (const [key, value] of Object.entries(doc || {})) {
    const set = types.get(key) || new Set();
    set.add(valueKind(value));
    types.set(key, set);
  }
  return [...types.entries()].map(([key, kinds]) => `${key}: ${[...kinds].join('|')}`);
}

function newestTimestamp(docs) {
  let newest = null;
  for (const doc of docs) {
    for (const key of TIMESTAMP_KEYS) {
      const value = doc?.[key];
      if (valueKind(value) !== 'date') continue;
      const time = new Date(value).getTime();
      if (Number.isFinite(time) && (!newest || time > newest)) newest = time;
    }
    const id = String(doc?._id || '');
    if (/^[0-9a-f]{24}$/i.test(id)) {
      const time = parseInt(id.slice(0, 8), 16) * 1000;
      if (Number.isFinite(time) && (!newest || time > newest)) newest = time;
    }
  }
  return newest ? new Date(newest) : null;
}

function documentTable(docs, columns, { rowId = 'row' } = {}) {
  return `<div class="table-wrap"><table class="inspector-table"><thead><tr>${columns.map((column) => `<th data-sort-key="${e(column)}" title="Click to sort">${e(column)}</th>`).join('')}<th>Raw</th></tr></thead><tbody>
    ${docs.length ? docs.map((doc, index) => `<tr data-inspector-row="${e(String(doc?._id ?? index))}" data-search="${e(JSON.stringify(doc).toLowerCase().slice(0, 4000))}">${columns.map((column) => `<td>${cellValue(doc?.[column])}</td>`).join('')}<td><details class="expert"><summary>JSON</summary><pre class="json">${e(JSON.stringify(doc, null, 2))}</pre></details></td></tr>`).join('') : noRows(columns.length + 1)}
  </tbody></table></div>`;
}

function wireInspector(target, docs, columns, render) {
  const search = target.querySelector('[data-inspector-search]');
  const state = { term: '', sortKey: null, sortDir: 1 };
  const apply = () => {
    let rows = docs.slice();
    if (state.term) rows = rows.filter((doc) => JSON.stringify(doc).toLowerCase().includes(state.term));
    if (state.sortKey) {
      const key = state.sortKey;
      rows.sort((a, b) => {
        const av = a?.[key]; const bv = b?.[key];
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        return (av > bv ? 1 : -1) * state.sortDir;
      });
    }
    target.querySelector('[data-inspector-body]').innerHTML = render(rows);
    target.querySelector('[data-inspector-count]').textContent = `${number(rows.length)} of ${number(docs.length)} shown`;
    target.querySelectorAll('[data-sort-key]').forEach((th) => th.addEventListener('click', () => {
      state.sortDir = state.sortKey === th.dataset.sortKey ? -state.sortDir : 1;
      state.sortKey = th.dataset.sortKey;
      apply();
    }));
  };
  if (search) search.addEventListener('input', () => { state.term = search.value.trim().toLowerCase(); apply(); });
  apply();
}

async function inspectCollection(name) {
  const target = document.querySelector('#documentInspector');
  target.innerHTML = '<div class="loading"><span></span>Loading bounded documents…</div>';
  try {
    const [result, stats] = await Promise.all([
      api(`/databases/collections/${encodeURIComponent(name)}/documents?limit=${INSPECT_LIMIT}`),
      api(`/databases/collections/${encodeURIComponent(name)}/stats`)
    ]);
    const docs = array(result);
    const columns = documentColumns(docs, stats.fields);
    const newest = newestTimestamp(docs);
    target.innerHTML = `${heading(name, `${number(stats.count)} documents · bounded preview of the newest ${number(Math.min(docs.length, INSPECT_LIMIT))} · read-only`)}
      <div class="grid">
        ${metric(number(stats.count), 'documents')}
        ${metric(stats.size != null ? bytes(stats.size) : '—', 'logical size')}
        ${metric(stats.storageSize != null ? bytes(stats.storageSize) : '—', 'storage')}
        ${metric(newest ? ageLabel(newest) : '—', newest ? `newest record (${date(newest)})` : 'newest record (no timestamp observed)')}
      </div>
      <p class="muted">Fields and types in this preview: <span class="mono">${e(fieldTypes(docs).join(' · ') || 'none')}</span></p>
      <label class="inspector-search"><span>Search this preview</span><input type="search" data-inspector-search placeholder="Filter the loaded documents"></label>
      <p class="muted" data-inspector-count></p>
      <div data-inspector-body></div>
      <p class="muted">Raw JSON is available per row under <em>JSON</em>. This browser cannot modify, delete, or export documents.</p>`;
    wireInspector(target, docs, columns, (rows) => documentTable(rows, columns));
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    target.innerHTML = `<div class="notice warning">${e(error.message)}. Collection metadata remains visible; document browsing is restricted to the Data service allowlist.</div>`;
  }
}

async function liveData() {
  const [feedsBody, liveState] = await Promise.all([api('/live-data/feeds'), api('/live-data/state')]);
  const feeds = array(feedsBody);
  content.innerHTML = `${heading('Live Data', 'Feed health and latest retained observations. Configuration stays in the Data service.', '<button class="button" data-action="refresh">Refresh</button>')}
    <section id="liveMap"></section>
    <div class="grid">
      ${metric(number(feeds.length), 'registered feeds')}
      ${metric(number(feeds.filter((feed) => feed.enabled).length), 'enabled feeds')}
      ${metric(number(feeds.reduce((sum, feed) => sum + Number(feed.count || 0), 0)), 'retained observations')}
      ${metric(liveState.liveDataEnabled === false ? 'paused' : 'active', 'master state')}
    </div>
    ${heading('Feed registry', 'Select a feed to inspect its five latest points.')}
    <div class="grid two">${feeds.map((feed) => `<article class="card clickable" data-feed="${e(feed.id)}"><h3>${e(feed.label || feed.id)} ${statusPill(feed.enabled, 'enabled', 'disabled')}</h3><div class="metric-row"><span>Category</span><strong>${e(feed.category || feed.kind)}</strong></div><div class="metric-row"><span>Records</span><strong>${number(feed.count)}</strong></div><div class="metric-row"><span>Last fetch</span><strong>${date(feed.lastFetchAt)}</strong></div><div class="metric-row"><span>Last error</span><strong class="${feed.lastError ? 'bad' : 'good'}">${e(feed.lastError || 'none')}</strong></div></article>`).join('') || '<div class="empty">No feeds registered.</div>'}</div>
    <section id="feedInspector"></section>`;
  // The world map lives in live-map.js, which the page loads before this file.
  if (typeof liveMapOpen === 'function') await liveMapOpen(feeds, liveState);
}

// Main fields per feed kind; anything else is discoverable per row.
const FEED_COLUMNS = Object.freeze({
  iss: ['latitude', 'longitude', 'altitude', 'velocity'],
  quakes: ['magnitude', 'mag', 'place', 'depth'],
  pressure: ['pressure', 'lat', 'lon'],
  weather: ['temperature', 'temp', 'humidity', 'pressure', 'condition'],
  air: ['pm2_5', 'pm10', 'us_aqi', 'european_aqi']
});

function feedColumns(feed, points) {
  const preferred = FEED_COLUMNS[String(feed).toLowerCase()] || [];
  const present = new Set(points.flatMap((point) => Object.keys(point || {})));
  const tsKey = TIMESTAMP_KEYS.find((key) => present.has(key)) || null;
  const main = preferred.filter((key) => present.has(key));
  const rest = [...present].filter((key) => key !== tsKey && !main.includes(key) && !['_id', 'feedId'].includes(key)
    && points.some((point) => ['number', 'string', 'boolean'].includes(valueKind(point?.[key]))));
  return { tsKey, columns: [...main, ...rest].slice(0, 6) };
}

function feedTable(points, tsKey, columns) {
  return `<div class="table-wrap"><table class="inspector-table"><thead><tr><th>Observed</th><th>Age</th>${columns.map((column) => `<th data-sort-key="${e(column)}" title="Click to sort">${e(column)}</th>`).join('')}<th>Raw</th></tr></thead><tbody>
    ${points.length ? points.map((point, index) => `<tr data-inspector-row="${e(String(point?._id ?? index))}"><td>${tsKey ? e(date(point?.[tsKey])) : '<span class="muted">no timestamp</span>'}</td><td>${tsKey ? e(ageLabel(point?.[tsKey])) : '—'}</td>${columns.map((column) => `<td>${cellValue(point?.[column])}</td>`).join('')}<td><details class="expert"><summary>JSON</summary><pre class="json">${e(JSON.stringify(point, null, 2))}</pre></details></td></tr>`).join('') : noRows(columns.length + 3)}
  </tbody></table></div>`;
}

async function inspectFeed(feed) {
  const target = document.querySelector('#feedInspector');
  target.innerHTML = '<div class="loading"><span></span>Loading latest feed points…</div>';
  try {
    const result = await api(`/live-data/${encodeURIComponent(feed)}/latest?limit=5`);
    const points = array(result.data || result);
    const { tsKey, columns } = feedColumns(feed, points);
    const newest = points.length && tsKey ? points[0]?.[tsKey] : null;
    const geo = String(feed).toLowerCase() === 'iss' && points[0] && Number.isFinite(Number(points[0].latitude)) && Number.isFinite(Number(points[0].longitude))
      ? `<p class="muted">Latest position: <span class="mono">${e(Number(points[0].latitude).toFixed(3))}, ${e(Number(points[0].longitude).toFixed(3))}</span> (latitude, longitude). It is drawn on the world map above.</p>`
      : '';
    target.innerHTML = `${heading(`${feed}: latest`, `${number(points.length)} most recent retained observation${points.length === 1 ? '' : 's'} · read-only`)}
      <div class="grid">
        ${metric(number(points.length), 'points loaded')}
        ${metric(newest ? ageLabel(newest) : '—', newest ? `latest observation (${date(newest)})` : 'latest observation (no timestamp)')}
        ${metric(tsKey ? tsKey : '—', 'timestamp field')}
      </div>
      ${geo}
      <p class="muted" data-inspector-count></p>
      <div data-inspector-body></div>
      <p class="muted">Raw JSON is available per row under <em>JSON</em>.</p>`;
    wireInspector(target, points, columns, (rows) => feedTable(rows, tsKey, columns));
  } catch (error) { target.innerHTML = `<div class="notice warning">${e(error.message)}</div>`; }
}

async function janitor() {
  const [profileBody, report] = await Promise.all([api('/janitor/profiles'), api('/janitor/strategy/latest')]);
  const profiles = array(profileBody.profiles).slice(0, 20);
  const runBodies = await Promise.all(profiles.map(async (profile) => {
    const id = profile._id || profile.id;
    if (!id) return { runs: [], error: 'profile id unavailable' };
    try { return await api(`/janitor/profiles/${encodeURIComponent(id)}/runs?page=1&limit=1`); }
    catch (error) { return { runs: [], error: error.message }; }
  }));
  const assessments = profiles.map((profile, index) => ({
    profile,
    run: array(runBodies[index]?.runs)[0] || null,
    error: runBodies[index]?.error || null
  }));
  const summary = report.summary || {};
  const verification = report.verification || {};
  const comparison = report.comparison || {};
  const duplicateDelta = comparison.deltas?.duplicates || {};
  const candidateDelta = comparison.deltas?.candidates || {};
  const roots = array(report.metadata?.perRoot);
  const metadataTotalsKnown = Number.isFinite(report.metadata?.indexedFiles)
    && Number.isFinite(report.metadata?.indexedBytes);
  const metadataSummary = metadataTotalsKnown
    ? `${number(report.metadata.indexedFiles)} indexed files · ${bytes(report.metadata.indexedBytes)} total, counted once.`
    : 'Current portfolio total unavailable. Last recorded inventories are shown per root.';
  const workItems = array(report.organization?.workItems);
  const organizationCounts = comparison.organization?.counts || {};
  state.janitorReportGeneratedAt = report.generatedAt || null;
  restoreJanitorReviewDraft(state.janitorReportGeneratedAt);
  const actions = `<div class="actions"><a class="button" href="/api/data-toolbox/janitor/strategy/latest/raw" target="_blank" rel="noopener">Open full JSON</a><a class="button" href="/api/data-toolbox/janitor/strategy/latest/raw" download="shared-drive-janitor-latest.json">Download full JSON</a><button class="button" data-action="refresh">Refresh</button></div>`;
  content.innerHTML = `${heading('Shared-drive Janitor', `Portfolio report ${report.status || 'unavailable'} · generated ${date(report.generatedAt)}.`, actions)}
    ${report.available === false ? '<div class="notice"><strong>No strategy report yet.</strong> The scheduled shared-drive assessment generates it; profiles and their latest runs are listed below.</div>' : ''}
    <div class="notice success"${report.available === false ? ' hidden' : ''}><strong>Portfolio evidence ready for policy review.</strong> This is not an executable deletion plan. Exact candidates come from a current profile run and still require a separate SHA-256 preview; this dashboard is read-only.</div>
    ${heading('Execution boundary', 'Pinned near the top so the current safety state is always easy to verify.')}
    <div class="grid">
      ${metric(number(report.safety?.sharedDriveMutations), 'shared-drive mutations')}
      ${metric(report.safety?.approvalEndpointsCalled ? 'yes' : 'no', 'approval endpoint called')}
      ${metric(number(report.maintenance?.executableActions), 'executable actions')}
      ${metric(report.safety?.deleteMoveArchiveExecuted ? 'executed' : 'not executed', 'delete / move / archive')}
    </div>
    <div class="grid">
      ${metric(bytes(summary.provenSavingsBytes), 'proven duplicate savings · lower bound')}
      ${metric(number(summary.verifiedGroups), 'SHA-256 verified groups')}
      ${metric(number(summary.filesToHash), `files awaiting verification · ${bytes(summary.bytesToHash)}`)}
      ${metric(number(summary.proposals), 'portfolio proposal groups · not approvals')}
    </div>
    ${comparison.status === 'compared' ? `<div class="trend-strip" aria-label="Change since ${e(date(comparison.previousGeneratedAt))}">
      ${trend(duplicateDelta.provenSavingsBytes, 'proven evidence since prior report', true, signedBytes)}
      ${trend(duplicateDelta.verifiedGroups, 'verified groups since prior report')}
      ${trend(candidateDelta.candidateBytes, 'candidate bytes still requiring proof', false, signedBytes)}
      ${trend(candidateDelta.groups, 'candidate groups since prior report', false)}
    </div>` : '<div class="notice">This report is the comparison baseline; trends will appear after a compatible subsequent assessment.</div>'}

    ${heading('Verification runway', 'Current hashing workload and measured lower-bound pace. Candidate bytes are work to verify, not savings.')}
    <div class="grid two">
      <article class="card"><h3>Backlog</h3>
        <div class="metric-row"><span>Candidate groups</span><strong>${number(summary.candidateGroups)}</strong></div>
        <div class="metric-row"><span>Candidate files</span><strong>${number(summary.candidateFiles)}</strong></div>
        <div class="metric-row"><span>Files still to hash</span><strong>${number(verification.filesToHash)}</strong></div>
        <div class="metric-row"><span>Bytes still to hash</span><strong>${bytes(verification.bytesToHash)}</strong></div>
      </article>
      <article class="card"><h3>Latest completed cycle</h3>
        ${verification.latestCompletedCycle ? `<div class="metric-row"><span>Files hashed</span><strong>${number(verification.latestCompletedCycle.hashedFiles)}</strong></div>
        <div class="metric-row"><span>Bytes hashed</span><strong>${bytes(verification.latestCompletedCycle.hashedBytes)}</strong></div>
        <div class="metric-row"><span>Measured throughput</span><strong>${Number(verification.latestCompletedCycle.filesPerSecond).toFixed(1)} files/s</strong></div>
        <div class="metric-row"><span>Comparable cycles lower bound</span><strong>${number(verification.latestCompletedCycle.estimatedComparableCyclesLowerBound)}</strong></div>` : '<p class="muted">A comparable two-root hashing cycle is not yet available.</p>'}
      </article>
    </div>
    <div class="notice"><strong>No calendar ETA is inferred.</strong> The cycle estimate is constrained by both file count and bytes. Duplicate groups larger than a run's byte budget can progress across runs when each individual file fits that budget. An individual unhashed file above its root's recorded byte budget remains unverified until that limit is raised.</div>

    ${heading('Canonical roots', metadataSummary)}
    <div class="grid two">${roots.map((root) => `<article class="card root-card"><div class="card-title"><h3>${e(root.root)}</h3>${statusPill(root.latestScan?.status === 'complete', root.latestScan?.status || 'complete', root.latestScan?.status || 'unavailable')}</div>
      <strong class="root-size">${bytes(root.totalBytes)}</strong><span class="metric-label">${number(root.totalFiles)} files</span>
      <div class="metric-row"><span>Unclassified</span><strong>${number(root.unclassifiedFiles)}</strong></div>
      <div class="metric-row"><span>Unresolved extension</span><strong>${number(root.missingExtensionUnresolvedFiles)}</strong></div>
      <div class="metric-row"><span>Extensionless by design</span><strong>${number(root.extensionlessByDesignFiles)}</strong></div>
      <div class="metric-row"><span>Timestamp review</span><strong>${number(root.timestampReviewFiles)}</strong></div>
      <div class="metric-row"><span>Latest hash cycle</span><strong>${date(root.latestHashingScan?.finishedAt)}</strong></div>
      <div class="metric-row"><span>Recorded hash byte limit</span><strong>${bytes(root.latestHashingScan?.hashMaxBytes)}</strong></div>
    </article>`).join('') || '<div class="empty">No canonical root evidence is available.</div>'}</div>

    ${typeof janitorReviewSection === 'function' ? janitorReviewSection() : ''}`;

  content.innerHTML += `${heading('Organization priorities', `${number(report.organization?.workItemsTotal)} bounded, evidence-backed work items. None can mutate the filesystem.`)}
    <div class="priority-list">${workItems.map((item) => `<article class="priority-item"><span class="rank">${number(item.rank)}</span><div><div class="priority-heading"><h3>${e(item.title)}</h3><span class="pill ${item.priority === 'high' ? 'warn' : ''}">${e(item.priority)}</span></div><p>${e(item.rationale)}</p><div class="priority-meta"><span>${e(item.root)}</span><span>${number(item.evidence?.files)} files</span><span>${bytes(item.evidence?.bytes)}</span><span>${e(label(item.disposition))}</span></div></div></article>`).join('') || '<div class="empty">No organization work items are retained.</div>'}</div>
    ${comparison.organization?.status === 'compared' ? `<div class="notice"><strong>Organization change:</strong> ${number(organizationCounts.new)} new · ${number(organizationCounts.improved)} improved · ${number(organizationCounts.worsened)} worsened · ${number(organizationCounts.resolved)} resolved · ${number(organizationCounts.unchanged)} unchanged.</div>` : ''}

    ${heading('Policy and safety', 'Selected review rules and the independent execution boundary.')}
    <div class="grid policy-grid">
      ${metric(label(report.policy?.duplicateSurvivor), 'duplicate survivor')}
      ${metric(label(report.policy?.backupRetention), 'backup retention')}
      ${metric(label(report.policy?.generatedCache), 'generated cache')}
      ${metric(label(report.policy?.maintenanceAuthorization), 'maintenance authorization')}
    </div>
    <div class="grid">
      <article class="card"><h3>Decision impact</h3>
        <div class="metric-row"><span>Survivor choice may differ</span><strong>${number(report.decisionSupport?.duplicateSurvivor?.maximumGroupsWithDifferentSelection)} groups</strong></div>
        <div class="metric-row"><span>Backup-context groups</span><strong>${number(report.decisionSupport?.backupRetention?.verifiedGroups)}</strong></div>
        <div class="metric-row"><span>Generated-cache groups</span><strong>${number(report.decisionSupport?.generatedCache?.verifiedGroups)}</strong></div>
        <div class="metric-row"><span>Overlapping contexts</span><strong>${number(report.decisionSupport?.overlap?.verifiedGroups)}</strong></div>
      </article>
    </div>

    ${heading('Assessment profiles and exact-action readiness', 'Exact deletion candidates come from profile runs, not the portfolio total. Historical sets must be regenerated before preview; every preview re-verifies the survivor and targets.')}
    <div class="table-wrap"><table><thead><tr><th>Profile / scope</th><th>Latest run</th><th>Exact action set</th><th>Review state</th></tr></thead><tbody>
      ${assessments.length ? assessments.map(({ profile, run, error }) => {
        const summary = janitorRunSummary(run);
        const runId = run?._id || run?.id;
        const scope = array(profile.roots).map(root => `<code>${e(root)}</code>`).join('<br>') || '<span class="muted">scope unavailable</span>';
        const actionSet = run
          ? `${number(summary.actions.length)} actions · ${number(summary.targetFiles)} targets · ${bytes(summary.proposedBytes)}`
          : 'No retained action set';
        const review = error
          ? `<span class="pill warn">run unavailable</span><div class="muted">${e(error)}</div>`
          : run
            ? `<span class="pill ${summary.current ? 'good' : 'warn'}">${summary.current ? 'current proposal' : 'historical · rerun required'}</span>${runId ? `<div><a href="/api/data-toolbox/janitor/runs/${encodeURIComponent(runId)}" target="_blank" rel="noopener">Open exact run JSON</a></div>` : ''}`
            : '<span class="pill warn">new run required</span>';
        return `<tr><td><strong>${e(profile.name || profile.id || profile._id)}</strong><div class="muted">${scope}</div></td><td>${run ? `${e(run.status || 'unknown')}<div class="muted">${date(summary.finishedAt)}</div>` : '—'}</td><td>${actionSet}</td><td>${review}</td></tr>`;
      }).join('') : noRows(4)}
    </tbody></table></div>`;
  // The duplicate review (stored decisions, paging, import) lives in
  // janitor-review.js, which the page loads before this file.
  if (typeof janitorReviewMount === 'function') await janitorReviewMount(report);
}

const renderers = { overview, storage, network, databases, 'live-data': liveData, janitor };
// The Files tab lives in files-tools.js, which the page loads before this file.
if (typeof files === 'function') renderers.files = files;
// The GPU tab lives in gpu.js, which the page loads before this file.
if (typeof gpu === 'function') renderers.gpu = gpu;
// The MQTT tab lives in mqtt.js, loaded the same way.
if (typeof mqttTab === 'function') renderers.mqtt = mqttTab;
// The Activity tab lives in activity.js, loaded the same way.
if (typeof activityTab === 'function') renderers.activity = activityTab;

async function render(force = false) {
  const tab = location.hash.slice(1) || 'overview';
  state.tab = renderers[tab] ? tab : 'overview';
  // A render that is no longer the latest one must not report on the page.
  const seq = ++state.renderSeq;
  document.querySelectorAll('[data-tab]').forEach((link) => link.classList.toggle('active', link.dataset.tab === state.tab));
  loading();
  try {
    if (force) state.status = null;
    await renderers[state.tab]();
    if (seq === state.renderSeq) updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (error) { if (seq === state.renderSeq) errorView(error); }
}

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  try {
    if (action === 'refresh') await render(true);
    if (action === 'files-next' || action === 'files-previous') {
      state.filesPage = Math.max(1, state.filesPage + (action === 'files-next' ? 1 : -1));
      loading('Loading file evidence…');
      try { await files(); } catch (error) { errorView(error); }
    }
    if (action === 'janitor-copy-review') {
      await copyJanitorReview();
      event.target.textContent = 'Copied';
    }
    if (action === 'janitor-download-review') downloadJanitorReview();
    if (action === 'janitor-clear-review') {
      clearJanitorReviewDraft();
      await janitor();
    }
  } catch (error) {
    window.alert(error.message);
  }
  const collection = event.target.closest('[data-collection]')?.dataset.collection;
  if (collection) inspectCollection(collection);
  const feed = event.target.closest('[data-feed]')?.dataset.feed;
  if (feed) inspectFeed(feed);
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'fileFilters') return;
  event.preventDefault();
  state.filesPage = 1;
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(event.target)) if (String(value).trim()) params.set(key, String(value).trim());
  loading('Filtering file evidence…');
  files(params).catch(errorView);
});

window.addEventListener('hashchange', () => render());
render();
