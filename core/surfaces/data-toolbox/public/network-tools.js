'use strict';

// The Toolbox Network tab below its metrics. Loaded before app.js, whose
// helpers (state, api, e, array, number, date, heading, collectorCard,
// observationPill, networkOverview…) it uses when called.
// It shows the collectors (active, then silent), sends two of the page's
// writes — one scan request for the active collector, and the edit of one
// device record (name, known flag, type, location, notes) — and searches,
// filters and sorts the loaded device list in the browser.
// Hostnames, vendors and every other device field come from the network or
// from a form: they are always escaped.

const NET_SCAN_POLL_MS = 2000;
// Data hands a queued request to collectors for two minutes (REQUEST_TTL_MS).
const NET_SCAN_TTL_MS = 120000;
const NET_SCAN_GRACE_MS = 5000;
const NET_NEW_MS = 24 * 60 * 60 * 1000;
const NET_MIN_SCAN_PREFIX = 16;
// The same bounds as the relay (index.js): Data itself sets none.
const NET_LIMITS = Object.freeze({ alias: 80, location: 80, notes: 500 });
const NET_TYPES = Object.freeze([
  ['computer', 'Computer'], ['server', 'Server'], ['phone-tablet', 'Phone or tablet'], ['iot', 'IoT'],
  ['network', 'Network equipment'], ['media', 'Media'], ['printer', 'Printer'], ['other', 'Other']
]);
const NET_FILTERS = Object.freeze([
  ['all', 'All'], ['unnamed', 'Unnamed'], ['online', 'Online now'], ['new', 'New in the last 24 h'], ['unacknowledged', 'Not acknowledged']
]);
const NET_SORT_DEFAULT_DIR = Object.freeze({ name: 'asc', ip: 'asc', lastSeen: 'desc', firstSeen: 'desc' });

const netState = {
  devices: [], agents: [], summary: null, capability: {},
  view: 'all', search: '', filter: 'all', sort: { key: 'lastSeen', dir: 'desc' },
  drafts: {}, notices: {}, editing: null, editDraft: null, saving: null,
  target: '', targetEdited: false, scan: null, outcome: null, timer: null, busy: false
};

// ── Pure helpers ────────────────────────────────────────────────────────────

/** The same rule as Data (data/utils/networkInput.js): IPv4, or CIDR /16 to /32. */
function netIsScanTarget(value) {
  if (typeof value !== 'string') return false;
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length > 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  if (!address.split('.').every((octet) => Number(octet) <= 255)) return false;
  if (prefix === undefined) return true;
  return /^\d{1,2}$/.test(prefix) && Number(prefix) >= NET_MIN_SCAN_PREFIX && Number(prefix) <= 32;
}

// The same refusal, in the same words, as Data.
function netScanTargetProblem(value) {
  return netIsScanTarget(value) ? '' : `Invalid target format. Use an IPv4 address or CIDR notation x.x.x.x/xx with a prefix from /${NET_MIN_SCAN_PREFIX} to /32`;
}

// A device is addressed by its MAC, or by its record id when Data has no MAC
// for it (a collector does not see the MAC of its own address) or stored the
// MAC in another spelling than the relay accepts.
const NET_MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const netKey = (device) => {
  const mac = String(device?.mac || device?.mac_address || '');
  return NET_MAC.test(mac) ? mac : String(device?._id || mac);
};
const netIp = (device) => String(device?.ip || device?.ip_address || '');
const netAlias = (device) => String(device?.alias || '').trim();
const netName = (device) => netAlias(device) || String(device?.hostname || '').trim();
const netType = (device) => String(device?.hardware?.type || '').trim();
const netSource = (device) => device.observation?.source || device.scanSource || '—';
const netLastSeen = (device) => device?.observation?.lastSeenAt || device?.lastSeen || device?.last_seen || null;
const netTime = (value) => {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
};
const netNow = () => netTime(netState.summary?.referenceTime) ?? Date.now();
const netTypeLabel = (type) => (NET_TYPES.find(([value]) => value === type) || [type, type])[1];

/** An IPv4 address as one number, so .9 sorts before .10; anything else sorts last. */
function netIpKey(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!match || match.slice(1).some((octet) => Number(octet) > 255)) return Number.POSITIVE_INFINITY;
  return match.slice(1).reduce((sum, octet) => sum * 256 + Number(octet), 0);
}

// Acknowledged the way Core's new-device alert reads it: a name or the known flag.
const netAcknowledged = (device) => Boolean(netAlias(device) || device?.knownAt);
function netIsNew(device, now = netNow()) {
  const first = netTime(device?.firstSeen);
  return first !== null && now - first < NET_NEW_MS;
}

function netMatches(device, term) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return true;
  const mac = String(device.mac || device.mac_address || '').toLowerCase();
  const haystack = [netAlias(device), device.hostname, netIp(device), mac, mac.replace(/:/g, ''), mac.replace(/:/g, '-'),
    device.vendor, netType(device), netTypeLabel(netType(device)), device.location]
    .map((value) => String(value || '').toLowerCase());
  return haystack.some((value) => value.includes(needle));
}

function netPasses(device, filter, now = netNow()) {
  if (filter === 'unnamed') return !netAlias(device);
  if (filter === 'online') return device.observation?.state === 'online';
  if (filter === 'new') return netIsNew(device, now);
  if (filter === 'unacknowledged') return !netAcknowledged(device);
  return true;
}

function netCounts(devices, now = netNow()) {
  return Object.fromEntries(NET_FILTERS.map(([filter]) => [filter, devices.filter((device) => netPasses(device, filter, now)).length]));
}

/** Sorted copy. A device without the sorted value comes last in both directions. */
function netSorted(devices, sort = netState.sort) {
  const direction = sort.dir === 'desc' ? -1 : 1;
  const value = (device) => {
    if (sort.key === 'ip') { const key = netIpKey(netIp(device)); return Number.isFinite(key) ? key : null; }
    if (sort.key === 'name') return netName(device).toLowerCase() || null;
    if (sort.key === 'firstSeen') return netTime(device.firstSeen);
    return netTime(netLastSeen(device));
  };
  return devices.map((device, index) => ({ device, index, value: value(device) })).sort((left, right) => {
    if (left.value === null || right.value === null) {
      if (left.value !== right.value) return left.value === null ? 1 : -1;
    } else if (left.value !== right.value) {
      return direction * (typeof left.value === 'string' ? left.value.localeCompare(right.value) : left.value - right.value);
    }
    return (netIpKey(netIp(left.device)) - netIpKey(netIp(right.device))) || (left.index - right.index);
  }).map((entry) => entry.device);
}

function netVisible() {
  const matching = netState.devices.filter((device) => netMatches(device, netState.search));
  const filter = netState.view === 'unnamed' ? 'unnamed' : netState.filter;
  return { matching, rows: netSorted(matching.filter((device) => netPasses(device, filter))) };
}

const netActiveAgents = () => netState.agents.filter((agent) => agent.active === true);
const netAgentId = (agent) => String(agent.scannerId || agent.id || '').trim() || 'unknown';
const netIsSilent = (source) => netState.agents.some((agent) => netAgentId(agent) === source && agent.active !== true);

// ── Sections ────────────────────────────────────────────────────────────────

function netPaint(selector, html) {
  const target = document.querySelector(selector);
  if (target && state.tab === 'network') target.innerHTML = html;
}

// Repaints the list and puts the keyboard focus back where it was (a chip, a
// column header, a name field), or on `focusKey` when the caller names one.
function netPaintList(focusKey) {
  const active = document.activeElement;
  const key = focusKey || active?.dataset?.focus;
  const caret = focusKey ? null : active?.selectionStart;
  netPaint('#netList', netListSection());
  if (!key || state.tab !== 'network') return;
  let next = null;
  try { next = document.querySelector(`[data-focus="${key}"]`); } catch { /* a key that is not a valid selector has no field to focus */ }
  if (!next || typeof next.focus !== 'function') return;
  next.focus();
  if (typeof caret === 'number' && typeof next.setSelectionRange === 'function') next.setSelectionRange(caret, caret);
}

function netSilentCard(agent) {
  const id = netAgentId(agent);
  const placement = state.status?.collectorPlacement?.network?.[id];
  const kept = netState.devices.filter((device) => netSource(device) === id).length;
  return `<article class="card collector-card net-silent">
    <div class="card-title"><h3>${e(id)}</h3><span class="pill warn">silent since ${date(agent.lastSeen)}</span></div>
    <div class="metric-row"><span>Ran on</span><strong>${e(agent.hostname || 'unknown host')} · ${e(agent.platform || 'unknown platform')}</strong></div>
    <div class="metric-row"><span>Last scan</span><strong>${date(agent.lastScanAt)}</strong></div>
    <div class="metric-row"><span>CIDR</span><strong class="mono">${e(agent.cidr || 'CIDR unavailable')}</strong></div>
    <div class="metric-row"><span>Collector version</span><strong class="mono">${e(agent.agentVersion || 'unknown')}</strong></div>
    <div class="metric-row"><span>Devices it reported last</span><strong>${number(kept)} kept in the list</strong></div>
    ${placement ? `<p class="net-help warn">Still declared in the placement configuration (${e(placement.host || placement.supervisor || 'no host given')}): it is expected to run.</p>` : ''}
  </article>`;
}

function netCollectorsSection() {
  const active = netActiveAgents();
  const silent = netState.agents.filter((agent) => agent.active !== true);
  if (!netState.agents.length) return `${heading('Collectors', 'The host-native programs that scan the real LAN and report to Data.')}<div class="empty">No network collector has ever registered with Data. Nothing scans the LAN until one runs.</div>`;
  return `${heading('Active collectors', 'A collector is active while Data has heard from it in the last 90 seconds. Only an active collector runs a scan.')}
    ${active.length ? `<div class="grid two">${active.map((agent) => collectorCard(agent, 'network')).join('')}</div>` : '<div class="notice warning"><strong>No active collector.</strong> Nothing is scanning the LAN right now: the list below only ages.</div>'}
    ${silent.length ? `${heading('Silent collectors', 'They no longer report. Their record and the devices they reported are kept: nothing is deleted from this page, and each of their devices stays in the list with its last sighting.')}
    <div class="grid two">${silent.map(netSilentCard).join('')}</div>` : ''}`;
}

function netOutcomeSection() {
  const outcome = netState.outcome;
  if (!outcome) return '';
  const items = array(outcome.items);
  return `<div class="notice ${outcome.tone === 'good' ? 'success' : outcome.tone === 'bad' ? 'warning' : ''}">${e(outcome.text)}${items.length ? `<ul class="net-new-list">${items.map((item) => `<li class="mono">${e(item)}</li>`).join('')}</ul>` : ''}</div>`;
}

function netScanDisabledReason() {
  if (netActiveAgents().length) return '';
  const latest = netState.agents[0];
  return latest
    ? `No collector is active, so nobody would run the scan. The last one heard was ${netAgentId(latest)}, on ${new Date(latest.lastSeen).toLocaleString()}.`
    : 'No collector has registered with Data, so nobody would run the scan.';
}

function netScanSection() {
  const active = netActiveAgents();
  if (!netState.targetEdited) netState.target = String(active[0]?.cidr || '');
  const reason = netScanDisabledReason();
  const following = netState.scan?.phase === 'following';
  return `${heading('Scan now', 'Ask the active collector for one discovery scan (nmap ping scan) of a target, without waiting for its next sweep.')}
    ${reason ? `<div class="notice warning" id="netScanReason"><strong>Scan unavailable.</strong> ${e(reason)}</div>` : ''}
    <form id="netScanForm" class="net-scan" novalidate>
      <label for="netScanTarget">Target</label>
      <input id="netScanTarget" name="target" class="mono" value="${e(netState.target)}" maxlength="18" autocomplete="off" spellcheck="false" inputmode="decimal" aria-describedby="netScanHelp"${reason ? ' disabled' : ''}>
      <button class="button" type="submit" id="netScanButton"${reason || following ? ' disabled' : ''}>${following ? 'Scanning…' : 'Scan now'}</button>
    </form>
    <p class="muted net-help" id="netScanHelp">An IPv4 address or a CIDR from /${NET_MIN_SCAN_PREFIX} to /32${active[0]?.cidr ? `; pre-filled with the network ${e(netAgentId(active[0]))} sweeps` : ''}. Data queues the request and the collector takes it at its next poll (every 5 seconds unless configured otherwise). A collector runs one scan at a time: a request that arrives during its own periodic sweep is skipped at that poll and tried again at the following ones. Data hands a request out for two minutes; if the collector could not finish it in that time (sweep still running, nmap failure), it gets no result and shows here as expired.</p>
    <div id="netScanOutcome" role="status" aria-live="polite">${netOutcomeSection()}</div>`;
}

function netSyncScan() {
  if (state.tab !== 'network') return;
  const button = document.querySelector('#netScanButton');
  if (!button) return;
  const following = netState.scan?.phase === 'following';
  button.disabled = Boolean(netScanDisabledReason()) || following;
  button.textContent = following ? 'Scanning…' : 'Scan now';
}

function netNewPill(device) {
  return netIsNew(device) ? ' <span class="pill warn" title="First seen in the last 24 hours">new</span>' : '';
}

function netNoticeFor(key) {
  const notice = netState.notices[key];
  return `<div class="net-row-notice ${notice ? (notice.ok ? 'good' : 'bad') : ''}" role="status">${notice ? e(notice.text) : ''}</div>`;
}

function netKnownButton(device) {
  const key = netKey(device);
  const known = Boolean(device.knownAt);
  return `<button class="button" type="button" data-action="net-known" data-key="${e(key)}" data-known="${known ? 'false' : 'true'}" data-focus="known-${e(key)}" aria-pressed="${known}"${netState.saving === key ? ' disabled' : ''}>${known ? 'Unmark known' : 'Mark known'}</button>`;
}

function netSourceCell(device) {
  const source = netSource(device);
  return `${e(source)}${netIsSilent(source) ? ' <span class="muted">(silent)</span>' : ''}`;
}

function netEditor(device, columns) {
  const key = netKey(device);
  const draft = netState.editDraft || {};
  const current = netType(device);
  const options = [['', 'Not set'], ...NET_TYPES, ...(current && !NET_TYPES.some(([value]) => value === current) ? [[current, `${current} (current value, not in the list)`]] : [])];
  const id = (field) => `netEdit-${field}`;
  return `<tr class="net-editor-row"><td colspan="${columns}">
    <form class="net-editor" data-net-form="edit" data-key="${e(key)}">
      <strong>Edit ${e(netIp(device) || key)}${device.mac ? ` · <span class="mono">${e(device.mac)}</span>` : ''}</strong>
      <label for="${id('alias')}">Name</label>
      <input id="${id('alias')}" data-net-edit="alias" data-focus="edit-alias" value="${e(draft.alias)}" maxlength="${NET_LIMITS.alias}" autocomplete="off">
      <label for="${id('type')}">Type</label>
      <select id="${id('type')}" data-net-edit="type">${options.map(([value, text]) => `<option value="${e(value)}"${value === draft.type ? ' selected' : ''}>${e(text)}</option>`).join('')}</select>
      <label for="${id('location')}">Location</label>
      <input id="${id('location')}" data-net-edit="location" value="${e(draft.location)}" maxlength="${NET_LIMITS.location}" autocomplete="off">
      <label for="${id('notes')}">Notes</label>
      <textarea id="${id('notes')}" data-net-edit="notes" rows="3" maxlength="${NET_LIMITS.notes}">${e(draft.notes)}</textarea>
      <div class="net-editor-actions">
        <button class="button" type="submit"${netState.saving === key ? ' disabled' : ''}>Save</button>
        <button class="button" type="button" data-action="net-edit-cancel" data-focus="edit-${e(key)}">Cancel</button>
        <span class="muted">An empty name, location or note clears it. A name acknowledges the device.</span>
      </div>
      ${netNoticeFor(key)}
    </form></td></tr>`;
}

function netSortHeader(key, text) {
  const active = netState.sort.key === key;
  const direction = active ? (netState.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<th aria-sort="${direction}"><button class="net-sort" type="button" data-action="net-sort" data-sort="${key}" data-focus="sort-${key}">${e(text)}<span aria-hidden="true">${active ? (netState.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span></button></th>`;
}

function netTable(rows) {
  const showType = netState.devices.some((device) => netType(device));
  const showLocation = netState.devices.some((device) => String(device.location || '').trim());
  const columns = 9 + (showType ? 1 : 0) + (showLocation ? 1 : 0);
  const body = rows.map((device) => {
    const key = netKey(device);
    const alias = netAlias(device);
    const acknowledged = netAcknowledged(device);
    const editing = netState.editing === key;
    return `<tr${editing ? ' class="net-editing"' : ''}>
      <td data-label="Device">${alias ? `<strong>${e(alias)}</strong>` : (device.hostname ? e(device.hostname) : '<span class="muted">unnamed</span>')}${netNewPill(device)}${alias && device.hostname ? `<br><span class="muted">${e(device.hostname)}</span>` : ''}${device.notes ? `<br><span class="muted net-notes">${e(device.notes)}</span>` : ''}</td>
      <td class="mono" data-label="IP">${e(netIp(device))}</td>
      <td class="mono muted" data-label="MAC">${e(device.mac || device.mac_address || 'no MAC')}</td>
      <td data-label="Vendor">${e(device.vendor || '—')}</td>
      ${showType ? `<td data-label="Type">${e(netType(device) ? netTypeLabel(netType(device)) : '—')}</td>` : ''}
      ${showLocation ? `<td data-label="Location">${e(device.location || '—')}</td>` : ''}
      <td data-label="Observation">${observationPill(device.observation)}</td>
      <td class="mono muted" data-label="Reported by">${netSourceCell(device)}</td>
      <td data-label="Last seen">${date(netLastSeen(device) || device.updated_at)}</td>
      <td data-label="First seen">${date(device.firstSeen)}</td>
      <td data-label="Acknowledged"><span class="pill ${acknowledged ? 'good' : ''}">${acknowledged ? 'known' : 'not acknowledged'}</span>
        ${key ? `<span class="net-actions"><button class="button" type="button" data-action="net-edit" data-key="${e(key)}" data-focus="edit-${e(key)}" aria-expanded="${editing}">Edit</button>${netKnownButton(device)}</span>${editing ? '' : netNoticeFor(key)}` : '<span class="muted">no MAC and no record id</span>'}</td>
    </tr>${editing ? netEditor(device, columns) : ''}`;
  }).join('');
  return `<div class="table-wrap net-table"><table><thead><tr>${netSortHeader('name', 'Device')}${netSortHeader('ip', 'IP')}<th>MAC</th><th>Vendor</th>${showType ? '<th>Type</th>' : ''}${showLocation ? '<th>Location</th>' : ''}<th>Observation</th><th>Reported by</th>${netSortHeader('lastSeen', 'Last seen')}${netSortHeader('firstSeen', 'First seen')}<th>Acknowledged</th></tr></thead><tbody>
    ${body || `<tr><td colspan="${columns}" class="muted">${netState.devices.length ? 'No device matches this search and filter.' : 'Data holds no network device yet. A collector fills this list at its first sweep.'}</td></tr>`}
  </tbody></table></div>`;
}

// The working view: every device without a name, with what helps recognise
// it and a name field. Enter (or Save) names it and moves to the next one.
function netUnnamedList(rows) {
  if (!rows.length) {
    return `<div class="empty">${netState.devices.some((device) => !netAlias(device)) ? 'No unnamed device matches this search.' : 'Every device has a name.'}</div>`;
  }
  const sharing = new Map();
  for (const device of netState.devices) sharing.set(netIp(device), (sharing.get(netIp(device)) || 0) + 1);
  return `<ol class="net-unnamed">${rows.map((device) => {
    const key = netKey(device);
    const others = (sharing.get(netIp(device)) || 1) - 1;
    const facts = [
      ['MAC', device.mac ? e(device.mac) : '<span class="muted">none reported — usually the collector\'s own address</span>'],
      ['Vendor', e(device.vendor || '—')],
      ['Hostname', e(device.hostname || '—')],
      ['First seen', date(device.firstSeen)],
      ['Last seen', `${date(netLastSeen(device))} ${e(typeof ageLabel === 'function' && netLastSeen(device) ? ageLabel(netLastSeen(device)) : '')}`],
      ['Seen by', netSourceCell(device)]
    ];
    return `<li class="card net-unnamed-row">
      <div class="net-facts">
        <div class="net-facts-head"><strong class="mono">${e(netIp(device) || 'no IP')}</strong> ${observationPill(device.observation)}${netNewPill(device)}${device.knownAt ? ' <span class="pill good">known</span>' : ''}</div>
        <dl>${facts.map(([term, value]) => `<div><dt>${term}</dt><dd class="${term === 'MAC' ? 'mono' : ''}">${value}</dd></div>`).join('')}</dl>
        ${others > 0 ? `<p class="muted net-help">${number(others)} other record${others > 1 ? 's' : ''} in the list carried this IP address at some point (another MAC).</p>` : ''}
      </div>
      ${key ? `<form class="net-name" data-net-form="name" data-key="${e(key)}">
        <label for="netName-${e(key)}">Name for ${e(netIp(device) || key)}</label>
        <input id="netName-${e(key)}" data-net-draft="${e(key)}" data-focus="name-${e(key)}" value="${e(netState.drafts[key] || '')}" maxlength="${NET_LIMITS.alias}" autocomplete="off" placeholder="e.g. Living room TV"${netState.saving === key ? ' disabled' : ''}>
        <button class="button" type="submit"${netState.saving === key ? ' disabled' : ''}>Save</button>
        ${netKnownButton(device)}
        ${netNoticeFor(key)}
      </form>` : '<p class="muted">No MAC and no record id: it cannot be named here.</p>'}
    </li>`;
  }).join('')}</ol>`;
}

function netListSection() {
  const { matching, rows } = netVisible();
  const counts = netCounts(matching);
  const unnamed = netState.view === 'unnamed';
  const sortChoices = [['lastSeen', 'Last seen'], ['firstSeen', 'First seen'], ['ip', 'IP'], ['name', 'Hostname']];
  return `${unnamed
    ? `<div class="net-chips" role="group" aria-label="Sort unnamed devices"><span class="muted">Sort by</span>${sortChoices.map(([key, text]) => `<button class="button${netState.sort.key === key ? ' active' : ''}" type="button" data-action="net-sort" data-sort="${key}" data-focus="sort-${key}" aria-pressed="${netState.sort.key === key}">${e(text)}${netState.sort.key === key ? (netState.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>`).join('')}</div>`
    : `<div class="net-chips" role="group" aria-label="Filter devices">${NET_FILTERS.map(([filter, text]) => `<button class="button${netState.filter === filter ? ' active' : ''}" type="button" data-action="net-filter" data-filter="${filter}" data-focus="filter-${filter}" aria-pressed="${netState.filter === filter}">${e(text)} <span class="net-count">${number(counts[filter])}</span></button>`).join('')}</div>`}
    <p class="muted net-help" id="netShown">${number(rows.length)} of ${number(netState.devices.length)} devices shown${netState.search.trim() ? ` · search “${e(netState.search.trim())}”` : ''}${unnamed ? ' · unnamed only. Type a name and press Enter: it is saved and the next field takes the focus.' : ''}</p>
    ${unnamed ? netUnnamedList(rows) : netTable(rows)}`;
}

function netViewSwitch() {
  const unnamed = netState.devices.filter((device) => !netAlias(device)).length;
  return [['all', `All devices (${number(netState.devices.length)})`], ['unnamed', `Unnamed devices (${number(unnamed)})`]]
    .map(([view, text]) => `<button class="button${netState.view === view ? ' active' : ''}" type="button" data-action="net-view" data-view="${view}" aria-pressed="${netState.view === view}">${e(text)}</button>`).join('');
}

function netAccept(devicesBody, agentsBody, capability) {
  netState.devices = array(devicesBody?.devices || devicesBody);
  netState.agents = array(agentsBody?.scanners || agentsBody?.agents || agentsBody);
  netState.summary = devicesBody?.summary && typeof devicesBody.summary === 'object' ? devicesBody.summary : null;
  if (capability) netState.capability = capability;
  if (netState.editing && !netState.devices.some((device) => netKey(device) === netState.editing)) netCloseEditor();
}

/** Called by app.js's network(): takes the three answers, returns the sections below the metrics. */
function netMount(devicesBody, agentsBody, capability) {
  netAccept(devicesBody, agentsBody, capability);
  if (netState.scan?.phase === 'following' && !netState.timer) netState.timer = setInterval(netScanPoll, NET_SCAN_POLL_MS);
  return `<div id="netCollectors">${netCollectorsSection()}</div>
    <div id="netScan">${netScanSection()}</div>
    ${heading('Devices', 'Every retained observation from Data; the state column is derived from the age of the last sighting, not from the raw flag. Search, filters and sorting work on this loaded list.')}
    <div class="net-find">
      <label for="netSearch">Search</label>
      <input id="netSearch" type="search" value="${e(netState.search)}" placeholder="Name, IP, MAC, vendor, hostname" autocomplete="off" spellcheck="false">
      <div class="net-views" id="netViews" role="group" aria-label="Device view">${netViewSwitch()}</div>
    </div>
    <div id="netList">${netListSection()}</div>`;
}

// Reads the devices and collectors again and repaints everything but the
// search box and the scan form, so what is being typed there stays.
async function netReload() {
  const seq = state.renderSeq;
  const [devicesBody, agentsBody] = await Promise.all([api('/network/devices'), api('/network/agents')]);
  if (seq !== state.renderSeq || state.tab !== 'network') return false;
  netAccept(devicesBody, agentsBody);
  if (typeof networkOverview === 'function') netPaint('#netOverview', networkOverview(devicesBody, agentsBody, netState.capability));
  netPaint('#netCollectors', netCollectorsSection());
  netPaint('#netViews', netViewSwitch());
  netPaintList();
  netSyncScan();
  return true;
}

// ── Scan request ────────────────────────────────────────────────────────────

function netStopScanTimer() {
  if (netState.timer) clearInterval(netState.timer);
  netState.timer = null;
}

function netScanResultText(scan, results) {
  const seen = results.reduce((sum, result) => sum + (Number(result.discovered) || 0), 0);
  const by = results.map((result) => result.scannerId).filter(Boolean).join(', ');
  const extras = [];
  const offline = results.reduce((sum, result) => sum + (Number(result.markedOffline) || 0), 0);
  const rejected = results.reduce((sum, result) => sum + (Number(result.rejected) || 0), 0);
  if (offline) extras.push(`${offline} marked offline`);
  if (rejected) extras.push(`${rejected} entries refused by Data`);
  return `Scan of ${scan.target} done${by ? ` by ${by}` : ''} (${new Date().toLocaleTimeString()}): ${seen} device${seen === 1 ? '' : 's'} seen${extras.length ? `, ${extras.join(', ')}` : ''}`;
}

// Ends the follow-up with the collector's result: reads the list again and
// names the devices that were not in it before the request.
async function netFinishScan(scan, results) {
  netStopScanTimer();
  scan.phase = 'done';
  let reloaded = false;
  let reloadError = '';
  try { reloaded = await netReload(); } catch (error) { reloadError = error.message; }
  const summary = netScanResultText(scan, results);
  if (reloaded) {
    const fresh = netState.devices.filter((device) => !scan.before.has(netKey(device)));
    netState.outcome = {
      tone: 'good',
      text: `${summary}, ${fresh.length ? `${fresh.length} new:` : 'none new.'}${fresh.length ? '' : ' The list below is up to date.'}`,
      items: fresh.map((device) => [netIp(device), device.mac || 'no MAC', device.vendor, device.hostname].filter(Boolean).join(' · '))
    };
  } else {
    netState.outcome = { tone: 'good', text: `${summary}. The list below could not be read again${reloadError ? ` (${reloadError})` : ''}: use Refresh to see the result.` };
  }
  netPaint('#netScanOutcome', netOutcomeSection());
  netSyncScan();
}

// One read of the request's status. The timer stops at its first tick on
// another tab; the follow-up resumes when the Network tab is opened again.
async function netScanPoll() {
  const scan = netState.scan;
  if (state.tab !== 'network' || !scan || scan.phase !== 'following') return netStopScanTimer();
  if (netState.busy || document.hidden === true) return undefined;
  const seq = state.renderSeq;
  netState.busy = true;
  let job = null;
  let problem = '';
  try { job = await api(`/network/scan-requests/${encodeURIComponent(scan.jobId)}`); }
  catch (error) { problem = error.message; }
  finally { netState.busy = false; }
  if (seq !== state.renderSeq || state.tab !== 'network' || netState.scan !== scan) return undefined;
  if (job && (job.done === true || job.status === 'done')) return netFinishScan(scan, array(job.results));
  const waited = Date.now() - scan.startedAt;
  if (waited > NET_SCAN_TTL_MS + NET_SCAN_GRACE_MS) {
    netStopScanTimer();
    scan.phase = 'expired';
    netState.outcome = { tone: 'bad', text: `No result for ${scan.target} within two minutes: the request expired and Data no longer hands it to a collector. The collector was busy with its own sweep the whole time, or nmap failed on its side (its log says which).${problem ? ` The last status read also failed: ${problem}.` : ''} This request changed nothing; you can scan again.` };
    try { await netReload(); } catch { /* the outcome above already says the scan gave nothing */ }
  } else {
    netState.outcome = problem
      ? { tone: 'bad', text: `The status of the request could not be read (${problem}). Trying again every 2 seconds, for up to two minutes after the request.` }
      : { tone: '', text: `Request for ${scan.target} queued (${new Date(scan.startedAt).toLocaleTimeString()}). Waiting for the collector's result… ${Math.round(waited / 1000)} s (gives up after 2 min).` };
  }
  netPaint('#netScanOutcome', netOutcomeSection());
  netSyncScan();
  return undefined;
}

async function netScan(target) {
  if (state.tab !== 'network' || netState.scan?.phase === 'following' || netState.scan?.phase === 'sending') return;
  const value = String(target ?? '').trim();
  netState.target = value;
  netState.targetEdited = true;
  const problem = netScanDisabledReason() || netScanTargetProblem(value);
  if (problem) {
    netState.outcome = { tone: 'bad', text: `Not started: ${problem}${/[.!]$/.test(problem) ? '' : '.'}` };
    netPaint('#netScanOutcome', netOutcomeSection());
    return;
  }
  const scan = { target: value, phase: 'sending', startedAt: Date.now(), before: new Set(netState.devices.map(netKey)) };
  netState.scan = scan;
  netState.outcome = { tone: '', text: `Asking Data to queue a scan of ${value}…` };
  netPaint('#netScanOutcome', netOutcomeSection());
  let answer;
  try { answer = await api('/network/scan', { method: 'POST', payload: { target: value } }); }
  catch (error) {
    scan.phase = 'refused';
    netState.outcome = { tone: 'bad', text: `Not started: ${error.message}` };
    netPaint('#netScanOutcome', netOutcomeSection());
    netSyncScan();
    return;
  }
  // Without a collector Data scans from its own container and answers with
  // the result at once: there is no request to follow.
  if (!answer.jobId) return void await netFinishScan(scan, [answer]);
  scan.jobId = String(answer.jobId);
  scan.startedAt = Date.now();
  scan.phase = 'following';
  netState.outcome = { tone: '', text: `Request for ${value} queued (${new Date(scan.startedAt).toLocaleTimeString()}). Waiting for the collector's result…` };
  netPaint('#netScanOutcome', netOutcomeSection());
  netSyncScan();
  netStopScanTimer();
  netState.timer = setInterval(netScanPoll, NET_SCAN_POLL_MS);
}

// ── Device edits ────────────────────────────────────────────────────────────

const netFind = (key) => netState.devices.find((device) => netKey(device) === key);

function netCloseEditor() {
  netState.editing = null;
  netState.editDraft = null;
}

// Sends one device update and merges Data's answer into the loaded list. The
// observation is kept: Data's PATCH answers the stored record without it.
async function netPatch(key, update) {
  const device = netFind(key);
  if (!device) throw new Error('This device is no longer in the list. Refresh and try again.');
  const answer = await api(`/network/devices/${encodeURIComponent(key)}`, { method: 'PATCH', payload: update });
  const stored = answer?.device && typeof answer.device === 'object' ? answer.device : null;
  if (stored) Object.assign(device, stored, { observation: device.observation });
  else {
    for (const field of ['alias', 'location', 'notes']) if (update[field] !== undefined) device[field] = update[field];
    if (update.type !== undefined) device.hardware = { ...device.hardware, type: update.type };
    if (update.known === true) device.knownAt = new Date().toISOString();
    if (update.known === false) delete device.knownAt;
  }
  return device;
}

async function netSave(key, update, saved) {
  if (netState.saving) return false;
  netState.saving = key;
  delete netState.notices[key];
  let ok = false;
  try {
    await netPatch(key, update);
    netState.notices[key] = { ok: true, text: saved };
    ok = true;
  } catch (error) {
    netState.notices[key] = { ok: false, text: `Not saved: ${error.message}` };
  } finally {
    netState.saving = null;
  }
  return ok;
}

// The unnamed view's Save: names the device, which leaves the list, and moves
// the focus to the name field of the device that followed it.
async function netSaveName(key, value) {
  const alias = String(value ?? '').trim();
  netState.drafts[key] = String(value ?? '');
  if (!alias) {
    netState.notices[key] = { ok: false, text: 'Type a name first.' };
    return netPaintList(`name-${key}`);
  }
  if (alias.length > NET_LIMITS.alias) {
    netState.notices[key] = { ok: false, text: `Not saved: alias must be at most ${NET_LIMITS.alias} characters` };
    return netPaintList(`name-${key}`);
  }
  const order = netVisible().rows.map(netKey);
  const index = order.indexOf(key);
  const next = order[index + 1] || order[index - 1] || '';
  const ok = await netSave(key, { alias }, 'Saved.');
  if (ok) delete netState.drafts[key];
  netPaint('#netViews', netViewSwitch());
  return netPaintList(ok && next ? `name-${next}` : `name-${key}`);
}

async function netToggleKnown(key, known) {
  await netSave(key, { known: known === true }, known ? 'Marked known.' : 'No longer marked known.');
  netPaintList(`known-${key}`);
}

function netOpenEditor(key) {
  const device = netFind(key);
  if (!device) return;
  if (netState.editing === key) netCloseEditor();
  else {
    netState.editing = key;
    netState.editDraft = { alias: netAlias(device), type: netType(device), location: String(device.location || ''), notes: String(device.notes || '') };
    delete netState.notices[key];
  }
  netPaintList(netState.editing ? 'edit-alias' : `edit-${key}`);
}

// The inline editor's Save: only the fields that changed are sent.
async function netSaveEdit(key) {
  const device = netFind(key);
  const draft = netState.editDraft;
  if (!device || !draft || netState.editing !== key) return;
  const before = { alias: netAlias(device), type: netType(device), location: String(device.location || '').trim(), notes: String(device.notes || '').trim() };
  const update = {};
  for (const field of ['alias', 'type', 'location', 'notes']) {
    const value = String(draft[field] ?? '').trim();
    if (value !== before[field]) update[field] = value;
  }
  const tooLong = Object.keys(NET_LIMITS).find((field) => update[field] !== undefined && update[field].length > NET_LIMITS[field]);
  if (tooLong || !Object.keys(update).length) {
    netState.notices[key] = { ok: false, text: tooLong ? `Not saved: ${tooLong} must be at most ${NET_LIMITS[tooLong]} characters` : 'Nothing has changed.' };
    return netPaintList();
  }
  const ok = await netSave(key, update, 'Saved.');
  if (ok) netCloseEditor();
  netPaint('#netViews', netViewSwitch());
  netPaintList(ok ? `edit-${key}` : undefined);
}

// ── Events ──────────────────────────────────────────────────────────────────

document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-action^="net-"]');
  if (!button || state.tab !== 'network') return;
  const { action, key } = button.dataset;
  if (action === 'net-filter') { netState.filter = button.dataset.filter; netPaintList(); }
  if (action === 'net-sort') {
    const sort = button.dataset.sort;
    netState.sort = netState.sort.key === sort
      ? { key: sort, dir: netState.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key: sort, dir: NET_SORT_DEFAULT_DIR[sort] || 'asc' };
    netPaintList();
  }
  if (action === 'net-view') {
    netState.view = button.dataset.view === 'unnamed' ? 'unnamed' : 'all';
    netCloseEditor();
    netPaint('#netViews', netViewSwitch());
    netPaintList();
  }
  if (action === 'net-edit') netOpenEditor(key);
  if (action === 'net-edit-cancel') { const open = netState.editing; netCloseEditor(); netPaintList(`edit-${open}`); }
  if (action === 'net-known') netToggleKnown(key, button.dataset.known === 'true');
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form.id === 'netScanForm') {
    event.preventDefault();
    netScan(form.elements.target.value);
  } else if (form.dataset?.netForm === 'name') {
    event.preventDefault();
    netSaveName(form.dataset.key, form.querySelector('[data-net-draft]').value);
  } else if (form.dataset?.netForm === 'edit') {
    event.preventDefault();
    netSaveEdit(form.dataset.key);
  }
});

document.addEventListener('input', (event) => {
  const field = event.target;
  if (state.tab !== 'network' || !field) return;
  if (field.id === 'netSearch') { netState.search = field.value; netPaintList(); }
  else if (field.id === 'netScanTarget') { netState.target = field.value; netState.targetEdited = true; }
  else if (field.dataset?.netDraft) netState.drafts[field.dataset.netDraft] = field.value;
  else if (field.dataset?.netEdit && netState.editDraft) netState.editDraft[field.dataset.netEdit] = field.value;
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || state.tab !== 'network' || !netState.editing || !event.target.closest?.('.net-editor')) return;
  const open = netState.editing;
  netCloseEditor();
  netPaintList(`edit-${open}`);
});
