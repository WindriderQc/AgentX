'use strict';

// The shared refresher (refresh.js), the header state, the Overview's source
// reasons, the tabs that read themselves again in place, and the shell markup.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicRoot = path.resolve(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(publicRoot, file), 'utf8');
const html = read('index.html');
// The scripts in page order, as index.html loads them.
const SCRIPTS = [...html.matchAll(/<script src="\/assets\/data-toolbox\/([a-z-]+\.js)/g)].map((match) => match[1]);

const okSource = (data = {}) => ({ ok: true, status: 200, data });
const statusBody = (overrides = {}) => {
  const sources = {
    health: okSource(), resources: okSource(), storage: okSource({ totalFiles: 12 }),
    network: okSource({ devices: [{ mac: 'AA:BB:CC:00:00:01' }], summary: { online: 1, onlineTtlMs: 1800000 } }),
    liveData: okSource([{ id: 'iss', enabled: true }]), databases: okSource({ totalCollections: 3 }),
    janitor: okSource({ profiles: [] }), ...overrides
  };
  return { dataService: { healthy: Object.values(sources).filter((source) => source.ok).length, total: 7 }, collectorPlacement: {}, sources };
};

const device = (overrides = {}) => ({ _id: 'd1', mac: 'AA:BB:CC:00:00:01', ip: '192.0.2.10', hostname: 'example-host', vendor: 'Example',
  firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-10-08T00:00:00.000Z', observation: { state: 'online', source: 'collector-a' }, ...overrides });
const agent = (overrides = {}) => ({ scannerId: 'collector-a', hostname: 'Example', platform: 'linux', ip: '192.0.2.2', cidr: '192.0.2.0/24',
  firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-10-08T00:00:00.000Z', lastScanAt: '2026-10-08T00:00:00.000Z', agentVersion: 'net-1.1.0', active: true, ...overrides });

function liveLike(overrides = {}) {
  return (route) => {
    const routes = {
      '/status': statusBody(),
      '/events': { events: [], pagination: { total: 0 } },
      '/network/devices': { devices: [device()], summary: { online: 1, recent: 0, historical: 0, never_confirmed: 0, reportedOnline: 1, onlineTtlMs: 1800000, recentTtlMs: 86400000, referenceTime: '2026-10-08T00:00:00.000Z' } },
      '/network/agents': { scanners: [agent()] },
      '/network/capability': { nmap: true },
      '/live-data/feeds': [{ id: 'iss', label: 'ISS', enabled: true, count: 10, category: 'space' }],
      '/live-data/state': { liveDataEnabled: true },
      '/databases/collections': { database: 'example', collections: [{ name: 'example_rows', count: 2, size: 10, storageSize: 20 }] },
      ...overrides
    };
    const answer = Object.hasOwn(routes, route) ? routes[route] : new Error(`unexpected ${route}`);
    return typeof answer === 'function' ? answer() : answer;
  };
}

function shellBrowser(respond = liveLike(), { hash = '#overview' } = {}) {
  const elements = {};
  const element = (selector) => (elements[selector] ||= {
    innerHTML: '', textContent: '', hidden: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; }
  });
  const content = element('#content');
  const page = { openDetails: false };
  content.contains = (candidate) => candidate?.inContent !== false;
  content.querySelector = (selector) => (selector === 'details[open]' && page.openDetails ? {} : null);
  content.querySelectorAll = () => [];
  const links = ['overview', 'network', 'live-data', 'databases'].map((tab) => ({
    dataset: { tab }, attributes: {}, classes: new Set(),
    classList: { toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); } },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }
  }));
  links.forEach((link) => { link.classList.owner = link; });
  const listeners = {};
  const requests = [];
  const timers = [];
  const cleared = [];
  const document = {
    hidden: false, activeElement: null,
    querySelector: element,
    querySelectorAll(selector) { return selector === '[data-tab]' ? links : []; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const context = {
    document, window: { addEventListener() {} }, location: { hash }, console, URLSearchParams, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setInterval(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url, 'http://localhost');
      requests.push({ method: options.method || 'GET', route: parsed.pathname.replace('/api/data-toolbox', '') });
      const answer = await respond(parsed.pathname.replace('/api/data-toolbox', ''), parsed.searchParams);
      if (answer instanceof TypeError) throw answer;
      if (answer instanceof Error) return { ok: false, status: 502, json: async () => ({ ok: false, status: 'error', code: answer.code || 'DATA_UNAVAILABLE', message: answer.message }) };
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  const source = SCRIPTS.map(read).join('\n')
    .replace(/\nrender\(\);\s*$/, `\nglobalThis.page = { state, shell, render, ensureStatus, shellRead, shellNotice, tabRefresher, refreshHold, refreshers, sourceList, sourceReason,
      collectorCard, overviewRefresher, netRefresher, netState, netOpenEditor, liveFeedsRefresher, gpuRefresher, mapRefresher };`);
  vm.runInNewContext(source, context);
  const timerOf = (refresher) => timers.find((entry) => entry.callback === refresher.tick);
  return { ...context.page, document, location: context.location, elements, element, content, page, links, listeners, requests, timers, cleared, timerOf };
}

const header = (browser) => ({
  state: browser.element('#shellState').attributes['data-state'],
  label: browser.element('#shellStatus').textContent,
  time: browser.element('#lastUpdated').textContent
});
const gets = (browser, from = 0) => browser.requests.slice(from).map((request) => request.route);

// ── The shared refresher ────────────────────────────────────────────────────

function counted(browser, options = {}) {
  const calls = { read: 0, applied: [] };
  const refresher = browser.tabRefresher({
    tab: 'overview', everyMs: 45000, stamp: 'testStamp',
    read: async () => { calls.read += 1; return `answer ${calls.read}`; },
    apply: (answer) => { calls.applied.push(answer); },
    ...options
  });
  return { refresher, calls };
}

test('a refresher starts its timer when the tab opens and stops at its first tick on another tab', async () => {
  const browser = shellBrowser();
  browser.state.tab = 'overview';
  const { refresher, calls } = counted(browser);
  assert.equal(refresher.timer, null, 'no timer before the tab has drawn itself');
  refresher.opened();
  const timer = browser.timerOf(refresher);
  assert.equal(timer.ms, 45000);
  refresher.opened();
  assert.equal(browser.timers.filter((entry) => entry.callback === refresher.tick).length, 1, 'opening again starts no second timer');
  assert.match(browser.element('#testStamp').textContent, /^Read at \S+.* Refreshes itself every 45 s while this tab is open and visible\.$/);

  await timer.callback();
  assert.deepEqual(calls.applied, ['answer 1']);

  browser.state.tab = 'storage';
  await timer.callback();
  assert.equal(calls.read, 1, 'another tab asks nothing');
  assert.deepEqual(browser.cleared, [browser.timers.indexOf(timer) + 1]);
  assert.equal(refresher.timer, null);
});

test('a refresher asks nothing while the page is hidden and reads at once when it shows again', async () => {
  const browser = shellBrowser();
  browser.state.tab = 'overview';
  const { refresher, calls } = counted(browser);
  refresher.opened();
  browser.document.hidden = true;
  await browser.timerOf(refresher).callback();
  assert.equal(calls.read, 0);
  browser.document.hidden = false;
  // One listener for every refresher: only those whose timer runs are asked.
  assert.equal(browser.listeners.visibilitychange.filter((listener) => String(listener).includes('refreshers')).length, 1);
  browser.listeners.visibilitychange.forEach((listener) => listener());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.read, 1);
});

test('an answer that arrives after a tab change or a newer render is dropped', async () => {
  for (const leave of [(browser) => { browser.state.tab = 'gpu'; }, (browser) => { browser.state.renderSeq += 1; }]) {
    const browser = shellBrowser();
    browser.state.tab = 'overview';
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { refresher, calls } = counted(browser, { read: async () => { await pending; return 'late'; } });
    refresher.opened();
    const stamp = browser.element('#testStamp').textContent;
    const headerBefore = header(browser).time;
    const tick = refresher.tick();
    leave(browser);
    release();
    await tick;
    assert.deepEqual(calls.applied, [], 'a stale answer is never applied');
    assert.equal(browser.element('#testStamp').textContent, stamp);
    assert.equal(header(browser).time, headerBefore, 'and it does not stamp the header');
    assert.equal(refresher.busy, false);
  }
});

test('a holding refresher does not read while a field has the focus, a details panel is open or the tab says so', async () => {
  const browser = shellBrowser();
  browser.state.tab = 'overview';
  let blocked = '';
  const { refresher, calls } = counted(browser, { holds: true, blocked: () => blocked });
  refresher.opened();

  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    browser.document.activeElement = { tagName };
    await refresher.tick();
    assert.equal(calls.read, 0, `${tagName} focused`);
    assert.match(browser.element('#testStamp').textContent, /Automatic refresh \(every 45 s\) is waiting because a field on this tab has the focus; Refresh reads now\./);
    assert.equal(browser.element('#testStamp').attributes['data-state'], 'held');
  }
  // A field outside the tab (the product navigation's search, say) does not hold it.
  browser.document.activeElement = { tagName: 'INPUT', inContent: false };
  await refresher.tick();
  assert.equal(calls.read, 1);
  // A button is not a field.
  browser.document.activeElement = { tagName: 'BUTTON' };
  await refresher.tick();
  assert.equal(calls.read, 2);
  assert.equal(browser.element('#testStamp').attributes['data-state'], 'ok');

  browser.page.openDetails = true;
  await refresher.tick();
  assert.equal(calls.read, 2);
  assert.match(browser.element('#testStamp').textContent, /waiting because a details panel is open on this tab/);
  browser.page.openDetails = false;

  blocked = 'a device editor is open';
  await refresher.tick();
  assert.equal(calls.read, 2);
  assert.match(browser.element('#testStamp').textContent, /waiting because a device editor is open/);
  blocked = '';
  await refresher.tick();
  assert.equal(calls.read, 3);

  // Without `holds` (the GPU "Now" block, the ISS marker) a focused field stops nothing.
  const plain = counted(browser);
  plain.refresher.opened();
  browser.document.activeElement = { tagName: 'INPUT' };
  await plain.refresher.tick();
  assert.equal(plain.calls.read, 1);
});

test('an answer is not applied when a field took the focus while Data was answering', async () => {
  const browser = shellBrowser();
  browser.state.tab = 'overview';
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { refresher, calls } = counted(browser, { holds: true, read: async () => { await pending; return 'answer'; } });
  refresher.opened();
  const tick = refresher.tick();
  browser.document.activeElement = { tagName: 'INPUT' };
  release();
  await tick;
  assert.deepEqual(calls.applied, []);
  assert.equal(refresher.held, 'a field on this tab has the focus');
});

test('a failed automatic read keeps the page, says so on the stamp and turns the header', async () => {
  const browser = shellBrowser();
  browser.state.tab = 'overview';
  let fail = false;
  const { refresher, calls } = counted(browser, { read: async () => { if (fail) throw new Error('Data service request timed out'); return 'fine'; } });
  refresher.opened();
  await refresher.tick();
  assert.equal(header(browser).state, 'ok');
  fail = true;
  await refresher.tick();
  assert.deepEqual(calls.applied, ['fine'], 'nothing is applied from a failed read');
  assert.match(browser.element('#testStamp').textContent, /^Automatic read failed at \S+.*: Data service request timed out\. Still showing what was read at \S+.*; tried again every 45 s\.$/);
  assert.equal(browser.element('#testStamp').attributes['data-state'], 'failed');
  assert.equal(header(browser).state, 'failed');
  assert.match(header(browser).time, /^failed \S+.*: Data service request timed out · last good read /);
  fail = false;
  await refresher.tick();
  assert.equal(browser.element('#testStamp').attributes['data-state'], 'ok');
  assert.equal(header(browser).state, 'ok');

  // `apply` may itself report that what it was given is not a good read.
  const judged = counted(browser, { apply: () => 'fetch failed' });
  judged.refresher.opened();
  await judged.refresher.tick();
  assert.equal(header(browser).state, 'failed');
  assert.match(header(browser).time, /: fetch failed · last good read /);
});

// ── The header ──────────────────────────────────────────────────────────────

test('the header is green only after a clean read and names the time of that read', async () => {
  assert.match(html, /<aside class="contract" id="shellState" data-state="connecting"/);
  assert.match(html, /<small id="shellStatus" class="shell-status" role="status">Connecting to Data…<\/small><small id="lastUpdated">no read yet<\/small>/);
  const css = read('app.css');
  // Green is a state, not the default colour of the dot.
  assert.match(css, /\.contract \.pulse \{[^}]*background: var\(--muted\)/);
  assert.match(css, /\.contract\[data-state="ok"\] \.pulse \{ background: var\(--green\)/);
  assert.match(css, /\.contract\[data-state="degraded"\] \.pulse \{ background: var\(--amber\)/);
  assert.match(css, /\.contract\[data-state="failed"\] \.pulse \{ background: var\(--red\)/);

  const browser = shellBrowser();
  await browser.render();
  assert.deepEqual({ ...header(browser), time: '' }, { state: 'ok', label: 'Data answering', time: '' });
  assert.match(header(browser).time, /^last read \S+/);
});

test('sources that do not answer turn the header amber with their count, and red when none answers', async () => {
  const partial = shellBrowser(liveLike({ '/status': statusBody({ network: { ok: false, status: 0, error: 'timeout' }, janitor: { ok: false, status: 503, data: { message: 'Janitor store is not ready' } } }) }));
  await partial.render();
  assert.equal(header(partial).state, 'degraded');
  assert.equal(header(partial).label, '2 of 7 Data sources unavailable');
  assert.match(header(partial).time, /^read \S+.*, incomplete$/);

  const down = Object.fromEntries(['health', 'resources', 'storage', 'network', 'liveData', 'databases', 'janitor'].map((key) => [key, { ok: false, status: 0, error: 'fetch failed' }]));
  const none = shellBrowser(liveLike({ '/status': statusBody(down) }));
  await none.render();
  assert.equal(header(none).state, 'failed');
  assert.equal(header(none).label, 'Data unreachable: no source answered');
});

test('a failed read turns the header red, says which side is unreachable and keeps the last good read', async () => {
  let answer = statusBody();
  const browser = shellBrowser(liveLike({ '/status': () => answer }));
  await browser.render();
  const good = header(browser).time.replace('last read ', '');

  answer = Object.assign(new Error('connect ECONNREFUSED data:3083'), { code: 'DATA_UNAVAILABLE' });
  await browser.render(true);
  assert.equal(header(browser).state, 'failed');
  assert.equal(header(browser).label, 'Data unreachable');
  assert.equal(header(browser).time.replace(/^failed \S+( [ap]\.?m\.?)?: /i, ''), `connect ECONNREFUSED data:3083 · last good read ${good}`);
  assert.match(browser.content.innerHTML, /<div class="error" role="alert">/);

  answer = new TypeError('Failed to fetch');
  await browser.render(true);
  assert.equal(header(browser).label, 'AgentX unreachable from this page');

  answer = Object.assign(new Error('Invalid collection'), { code: 'BAD_REQUEST' });
  await browser.render(true);
  assert.equal(header(browser).label, 'Last read failed');

  const never = shellBrowser(liveLike({ '/status': Object.assign(new Error('Data service request timed out'), { code: 'DATA_TIMEOUT' }) }));
  await never.render();
  assert.equal(header(never).label, 'Data unreachable');
  assert.match(header(never).time, /: Data service request timed out · no successful read yet$/);
});

test('a status kept from an earlier read never stamps the header as a new read', async () => {
  const browser = shellBrowser();
  await browser.render();
  browser.element('#lastUpdated').textContent = 'sentinel';
  const before = browser.requests.length;
  await browser.ensureStatus(false);
  assert.equal(browser.requests.length, before, 'the kept status is served without a request');
  assert.equal(browser.element('#lastUpdated').textContent, 'sentinel');
  assert.doesNotMatch(SCRIPTS.map(read).join('\n'), /textContent = `updated /);
});

test('a tab that shows a failed read as a notice in its place cannot leave the header green', async () => {
  const browser = shellBrowser(liveLike({ '/hardware/latest': new Error('Data service request timed out'), '/hardware/collectors': { collectors: [] }, '/hardware/occupancy': { hosts: [] } }), { hash: '#gpu' });
  await browser.render();
  assert.match(browser.content.innerHTML, /The current GPU state could not be read from Data: Data service request timed out\./);
  assert.equal(header(browser).state, 'degraded');
  assert.equal(header(browser).label, '1 read of this tab failed: Data service request timed out');
});

// ── The Overview ────────────────────────────────────────────────────────────

test('each Overview source says in words whether it answers, and why not', async () => {
  const browser = shellBrowser(liveLike({ '/status': statusBody({
    network: { ok: false, status: 0, error: 'timeout' },
    janitor: { ok: false, status: 503, data: { message: 'Janitor store is not ready' } },
    databases: { ok: false, status: 200, data: '<html>wrong destination</html>' },
    liveData: { ok: false, status: 404, data: {} }
  }) }));
  await browser.render();
  const list = browser.content.innerHTML.match(/<ul class="source-list"[^>]*>(.*?)<\/ul>/s)[1];
  const rows = [...list.matchAll(/<li class="source (ok|down)"><span class="dot" aria-hidden="true"><\/span><strong>([^<]+)<\/strong><span class="source-state">([^<]+)<\/span><small class="source-reason">([^<]+)<\/small><\/li>/g)]
    .map((match) => match.slice(1));
  assert.deepEqual(rows, [
    ['ok', 'Data service', 'answering', 'HTTP 200'],
    ['ok', 'Host resources', 'answering', 'HTTP 200'],
    ['ok', 'Storage inventory', 'answering', 'HTTP 200'],
    ['down', 'Network devices', 'unavailable', 'timeout'],
    ['down', 'Live Data feeds', 'unavailable', 'HTTP 404'],
    ['down', 'Databases', 'unavailable', 'HTTP 200, but the answer was not a usable Data response'],
    ['down', 'Janitor profiles', 'unavailable', 'HTTP 503: Janitor store is not ready']
  ]);
  // The raw keys of the projection are not what is shown.
  assert.doesNotMatch(list, />liveData<|>health</);
  // A reason that comes from Data or the network is escaped.
  assert.match(browser.sourceList({ storage: { ok: false, status: 0, error: '<img src=x onerror=alert(1)>' } }), /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the Overview reads itself again every 30 s, in place, and keeps the page when a read fails', async () => {
  let files = 12;
  let fail = false;
  const browser = shellBrowser(liveLike({ '/status': () => (fail ? Object.assign(new Error('connect ECONNREFUSED data:3083'), { code: 'DATA_UNAVAILABLE' }) : statusBody({ storage: okSource({ totalFiles: files }) })) }));
  await browser.render();
  const timer = browser.timerOf(browser.overviewRefresher);
  assert.equal(timer.ms, 30000);
  assert.match(browser.content.innerHTML, /<p class="refresh-stamp" id="overviewStamp"/);
  assert.match(browser.element('#overviewStamp').textContent, /Refreshes itself every 30 s while this tab is open and visible\./);
  assert.match(browser.content.innerHTML, /<div id="overviewBody"><div class="grid">/);
  assert.match(browser.content.innerHTML, /data-action="refresh">Refresh<\/button>/);

  const whole = browser.content.innerHTML;
  files = 13;
  let from = browser.requests.length;
  await timer.callback();
  assert.deepEqual(gets(browser, from), ['/status', '/events', '/events']);
  assert.equal(browser.content.innerHTML, whole, 'the tab is not rendered again');
  assert.match(browser.element('#overviewBody').innerHTML, /<strong class="metric">13<\/strong><span class="metric-label">indexed files/);

  fail = true;
  const body = browser.element('#overviewBody').innerHTML;
  await timer.callback();
  assert.equal(browser.element('#overviewBody').innerHTML, body, 'the last good figures stay');
  assert.match(browser.element('#overviewStamp').textContent, /^Automatic read failed at .*: connect ECONNREFUSED data:3083\. Still showing what was read at /);
  assert.deepEqual({ state: header(browser).state, label: header(browser).label }, { state: 'failed', label: 'Data unreachable' });

  // Typing or reading closely on the tab holds it.
  fail = false;
  browser.document.activeElement = { tagName: 'INPUT' };
  from = browser.requests.length;
  await timer.callback();
  assert.deepEqual(gets(browser, from), []);
});

// ── Network and Live Data ───────────────────────────────────────────────────

test('the Network lists read themselves again every 60 s without touching the search box or the scan form', async () => {
  let devices = [device()];
  const browser = shellBrowser(liveLike({ '/network/devices': () => ({ devices, summary: null }) }), { hash: '#network' });
  await browser.render();
  const timer = browser.timerOf(browser.netRefresher);
  assert.equal(timer.ms, 60000);
  assert.match(browser.content.innerHTML, /<p class="refresh-stamp" id="netStamp"/);
  const whole = browser.content.innerHTML;

  devices = [device(), device({ _id: 'd2', mac: 'AA:BB:CC:00:00:02', ip: '192.0.2.11' })];
  const from = browser.requests.length;
  await timer.callback();
  assert.deepEqual(gets(browser, from), ['/network/devices', '/network/agents'], 'two reads, and no write');
  assert.ok(browser.requests.every((request) => request.method === 'GET'));
  assert.equal(browser.content.innerHTML, whole, 'the search box and the scan form are not rendered again');
  assert.match(browser.element('#netList').innerHTML, /192\.0\.2\.11/);
  assert.match(browser.element('#netOverview').innerHTML, /<strong class="metric">2<\/strong><span class="metric-label">known devices/);
});

test('the Network refresh waits for an open editor, an unsaved name, a save and a running scan', async () => {
  const browser = shellBrowser(liveLike(), { hash: '#network' });
  await browser.render();
  const timer = browser.timerOf(browser.netRefresher);
  const reads = async () => { const from = browser.requests.length; await timer.callback(); return gets(browser, from).length; };

  browser.netOpenEditor('AA:BB:CC:00:00:01');
  const list = browser.element('#netList').innerHTML;
  assert.match(list, /class="net-editor"/);
  assert.equal(await reads(), 0);
  assert.equal(browser.element('#netList').innerHTML, list, 'the open editor is not repainted');
  assert.match(browser.element('#netStamp').textContent, /waiting because a device editor is open/);
  browser.netState.editing = null;

  browser.netState.drafts['AA:BB:CC:00:00:01'] = 'Living room';
  assert.equal(await reads(), 0);
  assert.match(browser.element('#netStamp').textContent, /waiting because a typed name is not saved yet/);
  browser.netState.drafts = {};

  browser.netState.saving = 'AA:BB:CC:00:00:01';
  assert.equal(await reads(), 0);
  browser.netState.saving = null;

  browser.netState.scan = { phase: 'following' };
  assert.equal(await reads(), 0);
  assert.match(browser.element('#netStamp').textContent, /waiting because a scan is running/);
  browser.netState.scan = null;

  assert.equal(await reads(), 2);
});

test('the Live Data feed cards read themselves again every 60 s without touching the map or the inspector', async () => {
  let count = 10;
  const settledLayer = new Error('not part of this test');
  const browser = shellBrowser(liveLike({
    '/live-data/feeds': () => [{ id: 'iss', label: 'ISS', enabled: true, count, category: 'space' }],
    '/live-data/iss/latest': settledLayer, '/live-data/quakes/latest': settledLayer, '/live-data/pressure/latest': settledLayer,
    '/live-data/weather/latest': settledLayer, '/live-data/air_quality/latest': settledLayer, '/live-data/sensors/latest': settledLayer
  }), { hash: '#live-data' });
  await browser.render();
  const timer = browser.timerOf(browser.liveFeedsRefresher);
  assert.equal(timer.ms, 60000);
  const whole = browser.content.innerHTML;
  const map = browser.element('#liveMap').innerHTML;
  browser.element('#feedInspector').innerHTML = 'inspector';
  count = 11;
  const from = browser.requests.length;
  await timer.callback();
  assert.deepEqual(gets(browser, from), ['/live-data/feeds', '/live-data/state']);
  assert.match(browser.element('#liveFeeds').innerHTML, /Records<\/span><strong>11</);
  assert.equal(browser.content.innerHTML, whole);
  assert.equal(browser.element('#liveMap').innerHTML, map);
  assert.equal(browser.element('#feedInspector').innerHTML, 'inspector');

  // An open JSON panel of the inspector holds the refresh.
  browser.page.openDetails = true;
  await timer.callback();
  assert.equal(browser.requests.length, from + 2);
});

test('Databases and Janitor stay manual, and every tab offers Refresh', async () => {
  const browser = shellBrowser(liveLike(), { hash: '#databases' });
  await browser.render();
  assert.match(browser.content.innerHTML, /Read when the tab opens and on Refresh\.<\/p><\/div><button class="button" data-action="refresh">Refresh<\/button>/);
  assert.deepEqual(browser.timers, [], 'no timer on the Databases tab');
  // The refreshers that exist, by tab: nothing for Databases, Janitor, Storage or Files.
  assert.deepEqual([...new Set(browser.refreshers.map((refresher) => refresher.tab))].sort(), ['gpu', 'iot', 'live-data', 'network', 'overview']);
  assert.deepEqual(Array.from(browser.refreshers, (refresher) => `${refresher.tab} ${refresher.everyMs}`).sort(),
    ['gpu 30000', 'iot 2000', 'live-data 60000', 'live-data 60000', 'network 60000', 'overview 30000']);
  const sources = Object.fromEntries(SCRIPTS.map((file) => [file, read(file)]));
  for (const [file, heading] of [['app.js', 'Shared-drive Janitor'], ['app.js', 'Storage evidence'], ['files-tools.js', 'File inventory'], ['gpu.js', 'GPU telemetry'], ['mqtt.js', "heading('MQTT'"], ['activity.js', "heading('Activity'"]]) {
    assert.ok(sources[file].includes(heading), `${file} draws ${heading}`);
  }
  assert.ok(Object.values(sources).join('\n').match(/data-(files-)?action="refresh"/g).length >= 9);
});

// ── Collector card ──────────────────────────────────────────────────────────

test('a collector that reports now is shown from its registration, never as historical', () => {
  const browser = shellBrowser();
  browser.state.status = { collectorPlacement: {} };
  const live = browser.collectorCard(agent(), 'network');
  assert.match(live, /<h3>collector-a<\/h3><span class="pill good">active<\/span>/);
  assert.doesNotMatch(live, /Historical registration only|No current placement contract|not scheduled/);
  assert.match(live, /Runs on<\/span><strong>Example · linux/);
  assert.match(live, /Address<\/span><strong class="mono">192\.0\.2\.2/);
  assert.match(live, /Registered since<\/span><strong>/);
  assert.match(live, /Shown from its live registration with Data\. Its supervisor, unit and cadence are not declared for this instance \(no placement metadata is configured\)\./);

  // A collector that stopped reporting and is not declared keeps the historical wording.
  const gone = browser.collectorCard(agent({ active: false }), 'network');
  assert.match(gone, /<span class="pill ">historical<\/span>/);
  assert.match(gone, /Supervisor<\/span><strong>No current placement contract/);
  assert.match(gone, /Unit \/ task<\/span><strong class="mono">Historical registration only/);

  // Declared placement is shown as declared, active or not.
  browser.state.status = { collectorPlacement: { network: { 'collector-a': { host: 'Example node', supervisor: 'systemd', runtime: 'example.service', cadence: 'every 10 min' } } } };
  const declared = browser.collectorCard(agent(), 'network');
  assert.match(declared, /Runs on<\/span><strong>Example node/);
  assert.match(declared, /Supervisor<\/span><strong>systemd/);
  assert.match(declared, /Cadence<\/span><strong>every 10 min/);
  assert.doesNotMatch(declared, /Shown from its live registration/);
});

// ── Shell markup ────────────────────────────────────────────────────────────

test('the open tab is marked for assistive technology and only status messages are announced', async () => {
  const browser = shellBrowser(liveLike(), { hash: '#network' });
  await browser.render();
  assert.deepEqual(browser.links.map((link) => [link.dataset.tab, link.attributes['aria-current'], link.classes.has('active')]),
    [['overview', undefined, false], ['network', 'page', true], ['live-data', undefined, false], ['databases', undefined, false]]);
  browser.location.hash = '#overview';
  await browser.render();
  assert.equal(browser.links[1].attributes['aria-current'], undefined);
  assert.equal(browser.links[0].attributes['aria-current'], 'page');

  // The content region is no longer one live region that reads whole tabs out.
  assert.match(html, /<section id="content" class="content">/);
  assert.doesNotMatch(html, /id="content"[^>]*aria-live/);
  assert.match(html, /<div class="loading" role="status">/);
  assert.match(html, /<div id="shellNotice" class="notice warning" role="alert" hidden><\/div>/);
  const scripts = SCRIPTS.map(read).join('\n');
  assert.doesNotMatch(scripts, /\b(alert|prompt)\(/);
  assert.match(read('app.js'), /shellNotice\(`That did not work: \$\{error\.message\}`\)/);

  browser.shellNotice('That did not work: clipboard unavailable');
  assert.equal(browser.element('#shellNotice').textContent, 'That did not work: clipboard unavailable');
  assert.equal(browser.element('#shellNotice').hidden, false);
  await browser.render();
  assert.equal(browser.element('#shellNotice').hidden, true, 'a new render clears it');
});

test('the helper loads first and the phone rules load last', () => {
  assert.equal(SCRIPTS[0], 'refresh.js');
  assert.equal(SCRIPTS.at(-1), 'app.js');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/assets\/data-toolbox\/([a-z-]+\.css)/g)].map((match) => match[1]);
  assert.equal(sheets.at(-1), 'phone.css');
  const phone = read('phone.css');
  // Nothing in the phone sheet applies to a desktop width.
  assert.equal(phone.replace(/\/\*[\s\S]*?\*\//g, '').split(/@media \(max-width: 620px\) \{/)[0].trim(), '');
  assert.match(phone, /\.tabs a \{[^}]*min-height: 44px/);
  assert.match(phone, /\.hero \.lede \{ display: none; \}/);
  // Stacked tables keep their table roles for assistive technology.
  const app = read('app.js');
  assert.match(app, /const STACKED_TABLES = '\.net-table table, \.activity-table table, table\.report-table, \.stack-table table, \.mqtt-stream table';/);
  assert.match(app, /table\.setAttribute\('role', 'table'\)/);
});
