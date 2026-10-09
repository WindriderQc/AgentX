'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolbox = require('../index');
const dataInput = require('../../../../data/utils/networkInput');

const publicRoot = path.resolve(__dirname, '..', 'public');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const NOW = Date.parse('2026-10-08T20:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 3600000;
const JOB = 'a1b2c3d4e5f6a1b2c3d4e5f6';

// Shapes of Data's /api/v1/network answers; every host and device is synthetic.
function device(ip, mac, overrides = {}) {
  const lastSeen = overrides.lastSeen || ago(5 * 60000);
  const state = overrides.state || 'online';
  const scanSource = overrides.scanSource || 'collector-a';
  const { state: _state, ...rest } = overrides;
  return {
    _id: `${String(ip.split('.').pop()).padStart(4, '0')}${'0'.repeat(20)}`, mac, alias: '', notes: '', hostname: '', vendor: '', ip,
    firstSeen: ago(30 * 24 * HOUR), lastSeen, lastScanAt: lastSeen, scanSource, status: 'online',
    observation: { state, lastSeenAt: lastSeen, ageMs: NOW - Date.parse(lastSeen), reportedStatus: 'online', source: scanSource, lastScanAt: lastSeen },
    ...rest
  };
}
const fixtureDevices = () => [
  device('192.168.50.10', 'AA:BB:CC:00:00:10', { vendor: 'Example Networks', lastSeen: ago(2 * 60000) }),
  device('192.168.50.9', 'AA:BB:CC:00:00:09', { alias: 'Office printer', hostname: 'printer.lan', vendor: 'Example Print', hardware: { type: 'printer' }, location: 'Office', lastSeen: ago(3 * 60000) }),
  device('192.168.50.100', 'AA:BB:CC:00:01:00', { hostname: 'tablet.lan', firstSeen: ago(2 * HOUR), lastSeen: ago(4 * 60000) }),
  device('192.168.50.2', 'AA:BB:CC:00:00:02', { knownAt: ago(HOUR), state: 'recent', lastSeen: ago(5 * HOUR) }),
  device('192.168.50.77', '', { hostname: 'collector-b.lan', scanSource: 'collector-b', state: 'historical', lastSeen: ago(40 * 24 * HOUR) })
];
const devicesBody = (devices) => ({
  devices,
  summary: { referenceTime: new Date(NOW).toISOString(), onlineTtlMs: 1800000, recentTtlMs: 86400000, total: devices.length,
    online: devices.filter((item) => item.observation.state === 'online').length, recent: 1, historical: 1, never_confirmed: 0, reportedOnline: devices.length }
});
const agentsBody = ({ active = true } = {}) => ({
  scanners: [
    { scannerId: 'collector-a', hostname: 'host-a', platform: 'linux', cidr: '192.168.50.0/24', agentVersion: 'net-1.1.0', lastSeen: ago(active ? 3000 : 3 * HOUR), lastScanAt: ago(10 * 60000), capabilities: { nmap: true }, active },
    { scannerId: 'collector-b', hostname: 'host-b', platform: 'win32', cidr: '192.168.50.0/24', agentVersion: 'net-1.0.0', lastSeen: ago(30 * 24 * HOUR), lastScanAt: ago(30 * 24 * HOUR), active: false }
  ],
  active: active ? 1 : 0
});

function networkBrowser(respond) {
  const elements = {};
  const focused = [];
  const element = (selector) => (elements[selector] ||= { innerHTML: '', textContent: '', value: '', disabled: false, focus() { focused.push(selector); } });
  const listeners = {};
  const requests = [];
  const timers = [];
  const cleared = [];
  const clock = { offset: 0 };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW + clock.offset); }
    static now() { return NOW + clock.offset; }
  }
  const failing = (name) => (text) => { throw new Error(`unexpected ${name}: ${text}`); };
  const document = {
    hidden: false,
    querySelector: element,
    querySelectorAll() { return []; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const context = {
    document, location: { hash: '#network' }, console, URLSearchParams, TextEncoder, Date: FakeDate,
    // Every outcome is reported inline: a blocking dialog would fail the test.
    window: { addEventListener() {}, alert: failing('alert'), prompt: failing('prompt'), confirm: failing('confirm') },
    alert: failing('alert'), prompt: failing('prompt'),
    setInterval(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url, 'http://localhost');
      const request = { path: decodeURIComponent(parsed.pathname.replace('/api/data-toolbox', '')), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      const answer = await respond(request);
      if (answer instanceof Error) {
        return { ok: false, status: answer.status || 502, json: async () => ({ ok: false, status: 'error', message: answer.message }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  const names = 'state, render, netState, netMount, netReload, netScan, netScanPoll, netSaveName, netToggleKnown, netOpenEditor, netSaveEdit, netListSection, netCollectorsSection, netScanSection, '
    + 'netIsScanTarget, netScanTargetProblem, netIpKey, netSorted, netMatches, netPasses, netCounts, netVisible, netIsNew, NET_TYPES, NET_LIMITS';
  const source = ['network-tools.js', 'app.js'].map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, `\nglobalThis.page = { ${names} };`);
  vm.runInNewContext(source, context);
  return { ...context.page, document, elements, listeners, requests, timers, cleared, focused, clock, content: element('#content') };
}

// A Data whose network store is `store`; writes follow Data's contract.
function dataService(store = {}) {
  store.devices ||= fixtureDevices();
  store.agents ||= agentsBody();
  return (request) => {
    if (request.path === '/network/devices' && request.method === 'GET') return store.devicesError || devicesBody(store.devices);
    if (request.path === '/network/agents') return store.agents;
    if (request.path === '/network/capability') return { nmap: false };
    if (request.path === '/network/scan') return store.scan ? store.scan(request) : new Error('unexpected scan');
    if (request.path.startsWith('/network/scan-requests/')) return store.job ? store.job(request) : new Error('unexpected status read');
    if (request.path.startsWith('/network/devices/') && request.method === 'PATCH') {
      if (store.patchError) return store.patchError;
      const id = request.path.split('/').pop();
      const found = store.devices.find((item) => item.mac === id || item._id === id);
      if (!found) return Object.assign(new Error('Device not found'), { status: 404 });
      const { alias, notes, location, type, known } = request.body;
      if (alias !== undefined) found.alias = alias;
      if (notes !== undefined) found.notes = notes;
      if (location !== undefined) found.location = location;
      if (type !== undefined) found.hardware = { ...found.hardware, type };
      if (known === true) found.knownAt = new Date(NOW).toISOString();
      if (known === false) delete found.knownAt;
      const { observation: _observation, ...stored } = found;
      return { device: stored };
    }
    return new Error(`unexpected ${request.method} ${request.path}`);
  };
}

async function openNetwork(store = {}) {
  const browser = networkBrowser(dataService(store));
  await browser.render();
  return browser;
}
const list = (browser) => browser.elements['#netList']?.innerHTML || browser.content.innerHTML;
const outcome = (browser) => browser.elements['#netScanOutcome']?.innerHTML || '';
const writes = (browser) => browser.requests.filter((request) => request.method !== 'GET');
const plain = (value) => JSON.parse(JSON.stringify(value));
const ipsIn = (html) => [...html.matchAll(/<td class="mono" data-label="IP">([\d.]+)<\/td>/g)].map((match) => match[1]);

async function relayApp(t, respond) {
  const express = require('express');
  const original = global.fetch;
  const calls = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    return respond ? respond(url, options) : { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) };
  };
  const app = express();
  app.use(express.json());
  toolbox.register({ contractVersion: 2, app, express });
  return { app, calls, request: require('supertest') };
}

// ── Relays ──────────────────────────────────────────────────────────────────

test('the scan target rule and its wording are the same in the relay, the page and Data', () => {
  const browser = networkBrowser(() => new Error('no request expected'));
  const cases = ['192.168.50.0/24', '192.168.50.7', '10.0.0.0/16', '10.0.0.1/32', '10.0.0.0/15', '10.0.0.0/8', '10.0.0.0/33', '256.1.1.1', '1.2.3', '1.2.3.4/',
    '1.2.3.4/24/1', '1.2.3.4 -oN /tmp/x', '-sS 1.2.3.4', 'example.org', '', ' 1.2.3.4', '1.2.3.4/024', 'fe80::1', null, 42, ['1.2.3.4'], { target: '1.2.3.4' }];
  for (const value of cases) {
    assert.equal(toolbox.isScanTarget(value), dataInput.isScanTarget(value), `relay vs Data on ${JSON.stringify(value)}`);
    assert.equal(browser.netIsScanTarget(value), dataInput.isScanTarget(value), `page vs Data on ${JSON.stringify(value)}`);
  }
  const controller = fs.readFileSync(path.join(repoRoot, 'data', 'controllers', 'networkController.js'), 'utf8');
  assert.ok(controller.includes('Invalid target format. Use an IPv4 address or CIDR notation x.x.x.x/xx with a prefix from /${MIN_SCAN_PREFIX} to /32'));
  const wording = `Invalid target format. Use an IPv4 address or CIDR notation x.x.x.x/xx with a prefix from /${dataInput.MIN_SCAN_PREFIX} to /32`;
  assert.equal(toolbox.SCAN_TARGET_MESSAGE, wording);
  assert.equal(browser.netScanTargetProblem('10.0.0.0/8'), wording);
  assert.equal(browser.netScanTargetProblem('192.168.50.0/24'), '');
});

test('the scan relay forwards only a valid target and refuses everything else before Data', async (t) => {
  const { app, calls, request } = await relayApp(t, async () => ({ ok: true, status: 202,
    text: async () => JSON.stringify({ status: 'success', message: 'Scan queued to network agent', data: { jobId: JOB, mode: 'agent', target: '192.168.50.0/24' } }) }));
  const queued = await request(app).post('/api/data-toolbox/network/scan').send({ target: '192.168.50.0/24' }).expect(202);
  assert.equal(queued.body.data.jobId, JOB);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/v1/network/scan');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { target: '192.168.50.0/24', source: 'toolbox' });

  for (const body of [
    {}, { target: '' }, { target: '10.0.0.0/8' }, { target: '1.2.3.4 -oN /tmp/x' }, { target: ['192.168.50.0/24'] }, { target: { $ne: '' } },
    { target: '192.168.50.0/24', pruneMissing: true }, { target: '192.168.50.0/24', source: 'elsewhere' }, { target: '192.168.50.0/24', __proto__x: 1 }
  ]) {
    const refused = await request(app).post('/api/data-toolbox/network/scan').send(body).expect(400);
    assert.equal(refused.body.code, 'INVALID_SCAN_REQUEST', JSON.stringify(body));
  }
  const bad = await request(app).post('/api/data-toolbox/network/scan').send({ target: '10.0.0.0/8' });
  assert.equal(bad.body.message, toolbox.SCAN_TARGET_MESSAGE);
  const unknown = await request(app).post('/api/data-toolbox/network/scan').send({ target: '192.168.50.0/24', pruneMissing: true });
  assert.match(unknown.body.message, /Unknown field "pruneMissing": expected target/);
  await request(app).post('/api/data-toolbox/network/scan').send([{ target: '192.168.50.0/24' }]).expect(400);
  assert.equal(calls.length, 1, 'no refused body reached Data');
});

test('the scan relay passes Data\'s refusal through and says when a timeout leaves the outcome unknown', async (t) => {
  let mode = 'unavailable';
  const { app, request } = await relayApp(t, async () => {
    if (mode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    return { ok: false, status: 503, text: async () => JSON.stringify({ status: 'error', message: 'Scan unavailable: nmap is not installed on the host.' }) };
  });
  const unavailable = await request(app).post('/api/data-toolbox/network/scan').send({ target: '192.168.50.0/24' }).expect(503);
  assert.match(unavailable.body.message, /Scan unavailable/);
  mode = 'timeout';
  const late = await request(app).post('/api/data-toolbox/network/scan').send({ target: '192.168.50.0/24' }).expect(502);
  assert.equal(late.body.code, 'DATA_TIMEOUT');
  assert.match(late.body.message, /may or may not have been queued/);
});

test('the scan request status relay only reads a 24-hex request id', async (t) => {
  const { app, calls, request } = await relayApp(t);
  await request(app).get(`/api/data-toolbox/network/scan-requests/${JOB.toUpperCase()}?scannerId=x`).expect(200);
  assert.equal(calls[0].url.pathname, `/api/v1/network/scan-requests/${JOB}`);
  assert.equal(calls[0].url.search, '', 'no query reaches Data: with a scannerId, Data\'s list route registers a collector');
  for (const id of ['abc', `${JOB}0`, '..%2Fdevices', 'g'.repeat(24)]) {
    await request(app).get(`/api/data-toolbox/network/scan-requests/${id}`).expect(400);
  }
  // The collector's own routes are not relayed at all.
  await request(app).get('/api/data-toolbox/network/scan-requests').expect(404);
  await request(app).post('/api/data-toolbox/network/scan-results').send({ devices: [] }).expect(404);
  await request(app).post('/api/data-toolbox/network/devices/AA:BB:CC:00:00:01/enrich').expect(404);
  assert.equal(calls.length, 1);
});

test('the device relay accepts exactly the fields Data accepts, bounded, and refuses unknown keys', async (t) => {
  const { app, calls, request } = await relayApp(t);
  const patch = (id, body) => request(app).patch(`/api/data-toolbox/network/devices/${id}`).send(body);
  await patch('aa:bb:cc:00:00:01', { alias: '  Living room TV ', known: true, type: 'media', location: ' Living room ', notes: ' Wall mounted\nHDMI 2 ' }).expect(200);
  assert.equal(calls[0].url.pathname, '/api/v1/network/devices/AA%3ABB%3ACC%3A00%3A00%3A01');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), { alias: 'Living room TV', location: 'Living room', notes: 'Wall mounted\nHDMI 2', type: 'media', known: true });

  // A device Data holds without a MAC is addressed by its record id.
  await patch('0123456789ABCDEF01234567', { alias: 'Collector host' }).expect(200);
  assert.equal(calls[1].url.pathname, '/api/v1/network/devices/0123456789abcdef01234567');
  // Empty text clears a field; an empty type clears the type.
  await patch('AA:BB:CC:00:00:01', { alias: '', type: '', location: '', notes: '' }).expect(200);
  assert.deepEqual(JSON.parse(calls[2].options.body), { alias: '', location: '', notes: '', type: '' });
  await patch('AA:BB:CC:00:00:01', { alias: 'x'.repeat(80), location: 'y'.repeat(80), notes: 'z'.repeat(500) }).expect(200);
  assert.equal(calls.length, 4);

  const refusals = [
    [{}, /at least one of alias, known, type, location, notes/],
    [{ alias: 'x'.repeat(81) }, /alias must be at most 80 characters/],
    [{ location: 'y'.repeat(81) }, /location must be at most 80 characters/],
    [{ notes: 'z'.repeat(501) }, /notes must be at most 500 characters/],
    [{ alias: { $ne: '' } }, /alias must be a string/],
    [{ notes: ['a'] }, /notes must be a string/],
    [{ location: 7 }, /location must be a string/],
    [{ type: 'toaster' }, /type must be empty or one of computer, server, phone-tablet, iot, network, media, printer, other/],
    [{ type: ['printer'] }, /type must be empty or one of/],
    [{ known: 'yes' }, /known must be a boolean/],
    [{ alias: 'ok', hostname: 'spoofed' }, /Unknown field "hostname"/],
    [{ alias: 'ok', knownAt: '2026-01-01' }, /Unknown field "knownAt"/],
    [{ alias: 'ok', 'hardware.os': 'x' }, /Unknown field "hardware.os"/],
    [{ $set: { alias: 'x' } }, /Unknown field "\$set"/]
  ];
  for (const [body, message] of refusals) {
    const refused = await patch('AA:BB:CC:00:00:01', body).expect(400);
    assert.equal(refused.body.code, 'INVALID_DEVICE_UPDATE');
    assert.match(refused.body.message, message);
  }
  for (const id of ['not-a-mac', 'AA:BB:CC:00:00', '0123', 'AA-BB-CC-00-00-01']) await patch(id, { known: true }).expect(400);
  assert.equal(calls.length, 4, 'no refused update reached Data');
  assert.deepEqual([...toolbox.DEVICE_TYPES], ['computer', 'server', 'phone-tablet', 'iot', 'network', 'media', 'printer', 'other']);
});

// ── Page wiring ─────────────────────────────────────────────────────────────

test('the Network tools load before the page script and use no blocking dialog or raw-HTML sink', () => {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  assert.ok(html.indexOf('/assets/data-toolbox/network-tools.js') > 0);
  assert.ok(html.indexOf('/assets/data-toolbox/network-tools.js') < html.indexOf('/assets/data-toolbox/app.js'));
  assert.match(html, /\/assets\/data-toolbox\/network-tools\.css/);
  const source = fs.readFileSync(path.join(publicRoot, 'network-tools.js'), 'utf8');
  assert.doesNotMatch(source, /alert\(|confirm\(|prompt\(|insertAdjacentHTML|document\.write|eval\(/);
  const app = fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /prompt\(/, 'naming a device no longer goes through window.prompt');
  assert.doesNotMatch(app, /device-name|device-known/);
  // Two writes leave this file: the scan request and the device update.
  assert.deepEqual(source.match(/method:\s*'(?:POST|PUT|PATCH|DELETE)'/g), ["method: 'POST'", "method: 'PATCH'"]);
  assert.doesNotMatch(source, /enrich|scan-results/);
  const css = fs.readFileSync(path.join(publicRoot, 'network-tools.css'), 'utf8');
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.ok(app.split('\n').length < 1200 && source.split('\n').length < 1200, 'both files stay under the frontend limit');
});

// ── Search, filters, sorting ────────────────────────────────────────────────

test('IP addresses sort by value, not as text, and unsortable ones come last', () => {
  const browser = networkBrowser(() => new Error('no request expected'));
  assert.ok(browser.netIpKey('192.168.50.9') < browser.netIpKey('192.168.50.10'));
  assert.ok(browser.netIpKey('192.168.50.100') > browser.netIpKey('192.168.50.20'));
  assert.ok(browser.netIpKey('10.0.0.1') < browser.netIpKey('192.168.1.1'));
  assert.equal(browser.netIpKey('999.1.1.1'), Infinity);
  assert.equal(browser.netIpKey(''), Infinity);
  const rows = ['192.168.50.100', '192.168.50.9', '', '192.168.50.10', '192.168.50.2', '10.0.0.200'].map((ip, index) => device(ip || '192.168.50.1', `AA:BB:CC:00:10:0${index}`, ip ? {} : { ip: '' }));
  const ascending = plain(browser.netSorted(rows, { key: 'ip', dir: 'asc' })).map((item) => item.ip);
  assert.deepEqual(ascending, ['10.0.0.200', '192.168.50.2', '192.168.50.9', '192.168.50.10', '192.168.50.100', '']);
  const descending = plain(browser.netSorted(rows, { key: 'ip', dir: 'desc' })).map((item) => item.ip);
  assert.deepEqual(descending, ['192.168.50.100', '192.168.50.10', '192.168.50.9', '192.168.50.2', '10.0.0.200', ''], 'a device without an IP stays last');
});

test('devices sort by last seen, first seen and name, with the missing value last', () => {
  const browser = networkBrowser(() => new Error('no request expected'));
  const rows = fixtureDevices();
  rows.push(device('192.168.50.200', 'AA:BB:CC:00:02:00', { lastSeen: null, firstSeen: null, observation: { state: 'never_confirmed', lastSeenAt: null } }));
  const ips = (sort) => plain(browser.netSorted(rows, sort)).map((item) => item.ip.split('.').pop());
  assert.deepEqual(ips({ key: 'lastSeen', dir: 'desc' }), ['10', '9', '100', '2', '77', '200']);
  assert.deepEqual(ips({ key: 'lastSeen', dir: 'asc' }), ['77', '2', '100', '9', '10', '200']);
  assert.deepEqual(ips({ key: 'firstSeen', dir: 'desc' }).slice(0, 1), ['100']);
  assert.equal(ips({ key: 'firstSeen', dir: 'asc' }).at(-1), '200');
  // Name: the alias, else the hostname; unnamed devices last, by IP.
  assert.deepEqual(ips({ key: 'name', dir: 'asc' }), ['77', '9', '100', '2', '10', '200']);
  assert.deepEqual(ips({ key: 'name', dir: 'desc' }), ['100', '9', '77', '2', '10', '200']);
  assert.equal(rows[0].ip, '192.168.50.10', 'the loaded list is not reordered in place');
});

test('search covers name, IP, MAC, vendor and hostname; chips count what they would show', async () => {
  const browser = await openNetwork();
  const found = (term) => plain(browser.netState.devices.filter((item) => browser.netMatches(item, term)).map((item) => item.ip.split('.').pop()));
  assert.deepEqual(found('office PRINT'), ['9']);
  assert.deepEqual(found('192.168.50.1'), ['10', '100']);
  assert.deepEqual(found('aa:bb:cc:00:01'), ['100']);
  assert.deepEqual(found('AABBCC000010'), ['10']);
  assert.deepEqual(found('aa-bb-cc-00-00-02'), ['2']);
  assert.deepEqual(found('example networks'), ['10']);
  assert.deepEqual(found('tablet.lan'), ['100']);
  assert.deepEqual(found('nothing-like-this'), []);
  assert.equal(found('').length, 5);

  assert.deepEqual(plain(browser.netCounts(browser.netState.devices)), { all: 5, unnamed: 4, online: 3, new: 1, unacknowledged: 3 });
  const html = list(browser);
  for (const [filter, count] of [['all', 5], ['unnamed', 4], ['online', 3], ['new', 1], ['unacknowledged', 3]]) {
    assert.match(html, new RegExp(`data-filter="${filter}"[^>]*>[^<]+<span class="net-count">${count}</span>`));
  }
  assert.match(html, /New in the last 24 h/);
  assert.match(html, /5 of 5 devices shown/);

  browser.netState.filter = 'unacknowledged';
  assert.deepEqual(ipsIn(browser.netListSection()), ['192.168.50.10', '192.168.50.100', '192.168.50.77'], 'a name or the known flag acknowledges, as Core reads it');
  browser.netState.filter = 'online';
  browser.netState.sort = { key: 'ip', dir: 'asc' };
  assert.deepEqual(ipsIn(browser.netListSection()), ['192.168.50.9', '192.168.50.10', '192.168.50.100']);
  assert.match(browser.netListSection(), /<th aria-sort="ascending"><button class="net-sort" type="button" data-action="net-sort" data-sort="ip"/);
  browser.netState.search = 'example';
  assert.deepEqual(ipsIn(browser.netListSection()), ['192.168.50.9', '192.168.50.10']);
  assert.match(browser.netListSection(), /data-filter="unnamed"[^>]*>[^<]+<span class="net-count">1<\/span>/, 'counts follow the search');
  browser.netState.search = 'zzz';
  assert.match(browser.netListSection(), /No device matches this search and filter\./);
});

test('a device first seen in the last 24 hours is marked "new" in words; type and location show when set', async () => {
  const browser = await openNetwork();
  const html = list(browser);
  assert.equal(html.match(/<span class="pill warn" title="First seen in the last 24 hours">new<\/span>/g).length, 1);
  assert.match(html, /tablet\.lan <span class="pill warn" title="First seen in the last 24 hours">new<\/span>/);
  assert.equal(browser.netIsNew({ firstSeen: ago(25 * HOUR) }), false);
  assert.equal(browser.netIsNew({ firstSeen: ago(23 * HOUR) }), true);
  assert.equal(browser.netIsNew({}), false);
  assert.match(html, /<th>Type<\/th><th>Location<\/th>/);
  assert.match(html, /<td data-label="Type">Printer<\/td>\s*<td data-label="Location">Office<\/td>/);
  assert.match(html, /not acknowledged/);

  const bare = await openNetwork({ devices: [device('192.168.50.10', 'AA:BB:CC:00:00:10')] });
  assert.doesNotMatch(list(bare), /<th>Type<\/th>|<th>Location<\/th>/);
  const empty = await openNetwork({ devices: [] });
  assert.match(list(empty), /Data holds no network device yet/);
});

test('hostile hostnames, vendors, names and notes are escaped everywhere they are shown', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const store = { devices: [
    device('192.168.50.10', 'AA:BB:CC:00:00:10', { hostname: hostile, vendor: `"><script>alert('v')</script>` }),
    device('192.168.50.11', 'AA:BB:CC:00:00:11', { alias: `</td>${hostile}`, hostname: hostile, notes: `${hostile}'"`, location: hostile, hardware: { type: hostile }, scanSource: hostile,
      observation: { state: 'online', lastSeenAt: ago(1000), source: hostile } })
  ] };
  const browser = await openNetwork(store);
  browser.netOpenEditor('AA:BB:CC:00:00:11');
  browser.netState.search = hostile;
  const views = [list(browser), browser.netListSection()];
  browser.netState.view = 'unnamed';
  browser.netState.drafts['AA:BB:CC:00:00:10'] = `" autofocus onfocus="alert(2)`;
  views.push(browser.netListSection());
  for (const html of views) {
    assert.doesNotMatch(html, /<img|<script|onerror="|onfocus="/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  }
  assert.match(views[1], /<option value="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;" selected>/, 'a stored type outside the list is kept as an escaped option');
  assert.match(views[2], /value="&quot; autofocus onfocus=&quot;alert\(2\)"/);
});

// ── Collectors ──────────────────────────────────────────────────────────────

test('silent collectors are listed apart, dated, with the devices they reported kept', async () => {
  const browser = await openNetwork();
  const html = browser.content.innerHTML;
  const activeAt = html.indexOf('Active collectors');
  const silentAt = html.indexOf('Silent collectors');
  assert.ok(activeAt > 0 && silentAt > activeAt);
  assert.ok(html.indexOf('<h3>collector-a</h3>') < silentAt && html.indexOf('<h3>collector-b</h3>') > silentAt);
  assert.match(html, new RegExp(`<h3>collector-b</h3><span class="pill warn">silent since ${new Date(ago(30 * 24 * HOUR)).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>`));
  assert.match(html, /Their record and the devices they reported are kept: nothing is deleted from this page/);
  assert.match(html, /Devices it reported last<\/span><strong>1 kept in the list<\/strong>/);
  assert.match(list(browser), /collector-b <span class="muted">\(silent\)<\/span>/);
  assert.equal(writes(browser).length, 0, 'opening the tab writes nothing');

  const none = await openNetwork({ agents: { scanners: [], active: 0 } });
  assert.match(none.content.innerHTML, /No network collector has ever registered with Data/);
});

// ── Scan request ────────────────────────────────────────────────────────────

test('Scan now is pre-filled with the active collector\'s network and disabled, with the reason, without one', async () => {
  const browser = await openNetwork();
  assert.match(browser.content.innerHTML, /<input id="netScanTarget" name="target" class="mono" value="192\.168\.50\.0\/24"/);
  assert.match(browser.content.innerHTML, /<button class="button" type="submit" id="netScanButton">Scan now<\/button>/);
  assert.match(browser.content.innerHTML, /a request that arrives during its own periodic sweep is skipped at that poll and tried again at the following ones/);

  const idle = await openNetwork({ agents: agentsBody({ active: false }) });
  assert.match(idle.content.innerHTML, /<strong>Scan unavailable\.<\/strong> No collector is active, so nobody would run the scan\. The last one heard was collector-a/);
  assert.match(idle.content.innerHTML, /id="netScanTarget"[^>]* disabled>/);
  assert.match(idle.content.innerHTML, /id="netScanButton" disabled>/);
  await idle.netScan('192.168.50.0/24');
  assert.equal(writes(idle).length, 0, 'nothing is sent when nobody could run the scan');
  assert.match(outcome(idle), /Not started: No collector is active/);
});

test('an invalid target is refused in the page, in Data\'s words, without a request', async () => {
  const browser = await openNetwork();
  for (const target of ['10.0.0.0/8', '', 'printer.lan', '192.168.50.0/24 -oN x']) {
    await browser.netScan(target);
    assert.match(outcome(browser), /Not started: Invalid target format\. Use an IPv4 address or CIDR notation x\.x\.x\.x\/xx with a prefix from \/16 to \/32\./);
  }
  assert.equal(writes(browser).length, 0);
  assert.equal(browser.timers.length, 0);
});

test('a scan is followed every 2 s until done, then the list is read again and new devices are named', async () => {
  const store = {};
  let reads = 0;
  store.scan = () => ({ jobId: JOB, mode: 'agent', target: '192.168.50.0/24' });
  store.job = () => {
    reads += 1;
    if (reads < 3) return { jobId: JOB, target: '192.168.50.0/24', status: 'pending', completedBy: [], results: [], done: false };
    return { jobId: JOB, target: '192.168.50.0/24', status: 'done', done: true, completedBy: ['collector-a'],
      results: [{ scannerId: 'collector-a', discovered: 6, updated: 6, markedOffline: 0, rejected: 1 }] };
  };
  const browser = await openNetwork(store);
  await browser.netScan(' 192.168.50.0/24 ');
  assert.deepEqual(plain(writes(browser)), [{ path: '/network/scan', method: 'POST', body: { target: '192.168.50.0/24' } }]);
  assert.deepEqual(browser.timers.map((timer) => timer.ms), [2000]);
  assert.match(outcome(browser), /Request for 192\.168\.50\.0\/24 queued/);
  assert.equal(browser.elements['#netScanButton'].disabled, true);
  assert.equal(browser.elements['#netScanButton'].textContent, 'Scanning…');
  await browser.netScan('192.168.50.0/24');
  assert.equal(writes(browser).length, 1, 'a second click while following sends nothing');

  browser.clock.offset = 2000;
  await browser.timers[0].callback();
  assert.equal(browser.requests.at(-1).path, `/network/scan-requests/${JOB}`);
  assert.match(outcome(browser), /Waiting for the collector&#39;s result… 2 s \(gives up after 2 min\)/);
  browser.clock.offset = 4000;
  await browser.timers[0].callback();
  // The collector posts: one device the list did not hold appears.
  store.devices.unshift(device('192.168.50.42', 'AA:BB:CC:00:00:42', { vendor: 'Example Cameras', hostname: '<b>cam</b>', firstSeen: new Date(NOW).toISOString() }));
  const before = browser.requests.length;
  browser.clock.offset = 6000;
  await browser.timers[0].callback();
  assert.deepEqual(browser.requests.slice(before).map((request) => request.path).sort(), ['/network/agents', '/network/devices', `/network/scan-requests/${JOB}`]);
  assert.match(outcome(browser), /Scan of 192\.168\.50\.0\/24 done by collector-a \([^)]+\): 6 devices seen, 1 entries refused by Data, 1 new:/);
  assert.match(outcome(browser), /<li class="mono">192\.168\.50\.42 · AA:BB:CC:00:00:42 · Example Cameras · &lt;b&gt;cam&lt;\/b&gt;<\/li>/);
  assert.match(outcome(browser), /notice success/);
  assert.match(list(browser), /192\.168\.50\.42/, 'the table shows the refreshed list');
  assert.match(browser.elements['#netOverview'].innerHTML, /6<\/strong><span class="metric-label">known devices/);
  assert.equal(browser.cleared.length, 1, 'the follow-up stops');
  assert.equal(browser.elements['#netScanButton'].disabled, false);
  const after = browser.requests.length;
  await browser.timers[0].callback();
  assert.equal(browser.requests.length, after, 'a late tick asks nothing');
});

test('a scan that finds nothing new says so', async () => {
  const store = { scan: () => ({ jobId: JOB, mode: 'agent', target: '192.168.50.7' }),
    job: () => ({ jobId: JOB, status: 'done', done: true, results: [{ scannerId: 'collector-a', discovered: 1, updated: 1, markedOffline: 0, rejected: 0 }] }) };
  const browser = await openNetwork(store);
  await browser.netScan('192.168.50.7');
  await browser.timers[0].callback();
  assert.match(outcome(browser), /Scan of 192\.168\.50\.7 done by collector-a \([^)]+\): 1 device seen, none new\. The list below is up to date\./);
});

test('a scan with no result after two minutes is reported as expired, and unreadable status reads are retried', async () => {
  const store = { scan: () => ({ jobId: JOB, mode: 'agent', target: '192.168.50.0/24' }) };
  let fail = true;
  store.job = () => (fail ? new Error('Data service request timed out') : { jobId: JOB, status: 'pending', completedBy: [], results: [], done: false });
  const browser = await openNetwork(store);
  await browser.netScan('192.168.50.0/24');
  browser.clock.offset = 2000;
  await browser.timers[0].callback();
  assert.match(outcome(browser), /The status of the request could not be read \(Data service request timed out\)\. Trying again every 2 seconds/);
  assert.equal(browser.cleared.length, 0, 'a failed read does not end the follow-up');
  fail = false;
  browser.clock.offset = 120000;
  await browser.timers[0].callback();
  assert.match(outcome(browser), /Waiting for the collector&#39;s result… 120 s/);
  assert.equal(browser.cleared.length, 0);
  browser.clock.offset = 126000;
  await browser.timers[0].callback();
  assert.match(outcome(browser), /No result for 192\.168\.50\.0\/24 within two minutes: the request expired/);
  assert.match(outcome(browser), /This request changed nothing; you can scan again\./);
  assert.match(outcome(browser), /notice warning/);
  assert.equal(browser.cleared.length, 1);
  assert.equal(browser.elements['#netScanButton'].disabled, false);
  // A new scan can start after an expiry.
  await browser.netScan('192.168.50.0/24');
  assert.equal(writes(browser).length, 2);
});

test('a scan Data or the relay refuses is reported inline and nothing is followed', async () => {
  const store = { scan: () => Object.assign(new Error('Scan unavailable: nmap is not installed on the host.'), { status: 503 }) };
  const browser = await openNetwork(store);
  await browser.netScan('192.168.50.0/24');
  assert.match(outcome(browser), /notice warning">Not started: Scan unavailable: nmap is not installed on the host\./);
  assert.equal(browser.timers.length, 0);
  assert.equal(browser.requests.filter((request) => request.path.startsWith('/network/scan-requests')).length, 0);
  assert.equal(browser.elements['#netScanButton'].disabled, false);
});

test('the follow-up stops on another tab and resumes when the Network tab is opened again', async () => {
  const store = { scan: () => ({ jobId: JOB, mode: 'agent', target: '192.168.50.0/24' }),
    job: () => ({ jobId: JOB, status: 'pending', completedBy: [], results: [], done: false }) };
  const browser = await openNetwork(store);
  await browser.netScan('192.168.50.0/24');
  browser.state.tab = 'overview';
  const before = browser.requests.length;
  await browser.timers[0].callback();
  assert.equal(browser.requests.length, before, 'nothing is asked from another tab');
  assert.equal(browser.cleared.length, 1);
  await browser.render();
  assert.equal(browser.timers.length, 2, 'the follow-up is taken up again');
  assert.match(browser.content.innerHTML, /id="netScanButton" disabled>Scanning…/);
});

// ── Unnamed devices ─────────────────────────────────────────────────────────

test('the unnamed view lists what helps recognise a device and a name field per device', async () => {
  const browser = await openNetwork();
  browser.netState.view = 'unnamed';
  browser.netState.sort = { key: 'ip', dir: 'asc' };
  const html = browser.netListSection();
  assert.equal(html.match(/data-net-form="name"/g).length, 4);
  assert.doesNotMatch(html, /Office printer/, 'a named device is not in the working view');
  assert.match(html, /4 of 5 devices shown · unnamed only\. Type a name and press Enter/);
  for (const term of ['MAC', 'Vendor', 'Hostname', 'First seen', 'Last seen', 'Seen by']) assert.match(html, new RegExp(`<dt>${term}</dt>`));
  assert.match(html, /<dd class="mono">AA:BB:CC:00:00:10<\/dd>/);
  assert.match(html, /<dd class="">Example Networks<\/dd>/);
  assert.match(html, /<dd class="">tablet\.lan<\/dd>/);
  assert.match(html, /<label for="netName-AA:BB:CC:00:00:10">Name for 192\.168\.50\.10<\/label>/);
  assert.match(html, /<input id="netName-AA:BB:CC:00:00:10" data-net-draft="AA:BB:CC:00:00:10" data-focus="name-AA:BB:CC:00:00:10" value="" maxlength="80"/);
  // A known but unnamed device stays, shown as known, with the toggle pressed.
  assert.match(html, /192\.168\.50\.2<\/strong>.*<span class="pill good">known<\/span>/s);
  assert.match(html, /data-key="AA:BB:CC:00:00:02" data-known="false"[^>]*aria-pressed="true">Unmark known/);
  // A device without a MAC is named through its record id.
  assert.match(html, /none reported — usually the collector's own address/);
  assert.match(html, /data-net-form="name" data-key="007700000000000000000000"/);
});

test('saving a name sends only the alias, removes the row and moves the focus to the next field', async () => {
  const browser = await openNetwork();
  browser.netState.view = 'unnamed';
  browser.netState.sort = { key: 'ip', dir: 'asc' };
  browser.netState.drafts['AA:BB:CC:00:01:00'] = 'half-typed';
  await browser.netSaveName('AA:BB:CC:00:00:10', '  Router  ');
  assert.deepEqual(plain(writes(browser)), [{ path: '/network/devices/AA:BB:CC:00:00:10', method: 'PATCH', body: { alias: 'Router' } }]);
  assert.equal(browser.focused.at(-1), '[data-focus="name-007700000000000000000000"]', 'the next device in IP order takes the focus');
  const html = list(browser);
  assert.equal(html.match(/data-net-form="name"/g).length, 3);
  assert.doesNotMatch(html, /Name for 192\.168\.50\.10</);
  assert.match(html, /value="half-typed"/, 'what was typed in another row stays');
  assert.match(browser.elements['#netViews'].innerHTML, /Unnamed devices \(3\)/);
  assert.equal(browser.netState.devices.find((item) => item.mac === 'AA:BB:CC:00:00:10').observation.state, 'online', 'the observation survives the update answer');

  // The last one in the list hands the focus to the one before it.
  await browser.netSaveName('AA:BB:CC:00:01:00', 'Tablet');
  assert.equal(browser.focused.at(-1), '[data-focus="name-007700000000000000000000"]');
  await browser.netSaveName('007700000000000000000000', 'Collector B host');
  assert.equal(writes(browser).at(-1).path, '/network/devices/007700000000000000000000');
  await browser.netSaveName('AA:BB:CC:00:00:02', 'Known thing');
  assert.match(list(browser), /Every device has a name\./);
});

test('an empty name asks for one, and a refused save stays on its row with the reason', async () => {
  const store = {};
  const browser = await openNetwork(store);
  browser.netState.view = 'unnamed';
  await browser.netSaveName('AA:BB:CC:00:00:10', '   ');
  assert.equal(writes(browser).length, 0);
  assert.match(list(browser), /<div class="net-row-notice bad" role="status">Type a name first\.<\/div>/);
  assert.equal(browser.focused.at(-1), '[data-focus="name-AA:BB:CC:00:00:10"]');
  await browser.netSaveName('AA:BB:CC:00:00:10', 'x'.repeat(81));
  assert.equal(writes(browser).length, 0);
  assert.match(list(browser), /Not saved: alias must be at most 80 characters/);

  store.patchError = Object.assign(new Error('Data service request timed out'), { status: 502 });
  await browser.netSaveName('AA:BB:CC:00:00:10', 'Router');
  assert.match(list(browser), /<div class="net-row-notice bad" role="status">Not saved: Data service request timed out<\/div>/);
  assert.match(list(browser), /data-focus="name-AA:BB:CC:00:00:10" value="Router"/, 'the typed name is kept');
  assert.equal(browser.focused.at(-1), '[data-focus="name-AA:BB:CC:00:00:10"]');
  assert.equal(list(browser).match(/data-net-form="name"/g).length, 4);
});

test('Mark known toggles the known flag from either view', async () => {
  const browser = await openNetwork();
  await browser.netToggleKnown('AA:BB:CC:00:00:10', true);
  assert.deepEqual(plain(writes(browser).at(-1)), { path: '/network/devices/AA:BB:CC:00:00:10', method: 'PATCH', body: { known: true } });
  assert.match(list(browser), /data-key="AA:BB:CC:00:00:10" data-known="false"[^>]*aria-pressed="true">Unmark known/);
  assert.match(list(browser), /Marked known\./);
  assert.equal(browser.netPasses(browser.netState.devices.find((item) => item.mac === 'AA:BB:CC:00:00:10'), 'unacknowledged'), false);
  await browser.netToggleKnown('AA:BB:CC:00:00:10', false);
  assert.deepEqual(plain(writes(browser).at(-1).body), { known: false });
  assert.match(list(browser), /data-key="AA:BB:CC:00:00:10" data-known="true"[^>]*aria-pressed="false">Mark known/);
});

// ── Inline editor ───────────────────────────────────────────────────────────

test('the inline editor offers the fixed type list and sends only what changed', async () => {
  const browser = await openNetwork();
  browser.netOpenEditor('AA:BB:CC:00:00:09');
  let html = list(browser);
  assert.equal(browser.focused.at(-1), '[data-focus="edit-alias"]');
  assert.match(html, /<form class="net-editor" data-net-form="edit" data-key="AA:BB:CC:00:00:09">/);
  assert.match(html, /data-net-edit="alias" data-focus="edit-alias" value="Office printer" maxlength="80"/);
  assert.match(html, /data-net-edit="location" value="Office" maxlength="80"/);
  assert.match(html, /<textarea id="netEdit-notes" data-net-edit="notes" rows="3" maxlength="500">/);
  assert.deepEqual([...html.matchAll(/<option value="([^"]*)"( selected)?>([^<]+)<\/option>/g)].map((match) => `${match[1]}=${match[3]}${match[2] ? '*' : ''}`),
    ['=Not set', 'computer=Computer', 'server=Server', 'phone-tablet=Phone or tablet', 'iot=IoT', 'network=Network equipment', 'media=Media', 'printer=Printer*', 'other=Other']);
  assert.deepEqual(plain(browser.NET_TYPES).map(([value]) => value), [...toolbox.DEVICE_TYPES], 'the page and the relay hold the same list');
  assert.deepEqual(plain(browser.NET_LIMITS), { ...toolbox.DEVICE_TEXT_LIMITS });

  await browser.netSaveEdit('AA:BB:CC:00:00:09');
  assert.equal(writes(browser).length, 0);
  assert.match(list(browser), /Nothing has changed\./);

  Object.assign(browser.netState.editDraft, { location: ' Basement ', notes: 'Second tray jams', type: 'printer' });
  await browser.netSaveEdit('AA:BB:CC:00:00:09');
  assert.deepEqual(plain(writes(browser)), [{ path: '/network/devices/AA:BB:CC:00:00:09', method: 'PATCH', body: { location: 'Basement', notes: 'Second tray jams' } }]);
  html = list(browser);
  assert.doesNotMatch(html, /net-editor-row/, 'the editor closes after a save');
  assert.match(html, /<td data-label="Type">Printer<\/td>\s*<td data-label="Location">Basement<\/td>/);
  assert.match(html, /Second tray jams/);
  assert.match(html, /<div class="net-row-notice good" role="status">Saved\.<\/div>/);
  assert.equal(browser.focused.at(-1), '[data-focus="edit-AA:BB:CC:00:00:09"]', 'the focus returns to the row\'s Edit button');

  // Renaming through the editor replaces the prompt: clearing the name works too.
  browser.netOpenEditor('AA:BB:CC:00:00:09');
  Object.assign(browser.netState.editDraft, { alias: '', type: '' });
  await browser.netSaveEdit('AA:BB:CC:00:00:09');
  assert.deepEqual(plain(writes(browser).at(-1).body), { alias: '', type: '' });
  assert.match(browser.elements['#netViews'].innerHTML, /Unnamed devices \(5\)/);
});

test('the editor keeps a stored type outside the list, refuses over-long text and stays open on a failed save', async () => {
  const store = { devices: [device('192.168.50.20', 'AA:BB:CC:00:00:20', { alias: 'Printer host', hardware: { type: '3d-printer-controller' } })] };
  const browser = await openNetwork(store);
  browser.netOpenEditor('AA:BB:CC:00:00:20');
  assert.match(list(browser), /<option value="3d-printer-controller" selected>3d-printer-controller \(current value, not in the list\)<\/option>/);
  browser.netState.editDraft.location = 'Workshop';
  await browser.netSaveEdit('AA:BB:CC:00:00:20');
  assert.deepEqual(plain(writes(browser).at(-1).body), { location: 'Workshop' }, 'an untouched type is not sent, so it is not refused');

  browser.netOpenEditor('AA:BB:CC:00:00:20');
  browser.netState.editDraft.notes = 'n'.repeat(501);
  await browser.netSaveEdit('AA:BB:CC:00:00:20');
  assert.equal(writes(browser).length, 1);
  assert.match(list(browser), /Not saved: notes must be at most 500 characters/);

  store.patchError = Object.assign(new Error('Device not found'), { status: 404 });
  browser.netState.editDraft.notes = 'short';
  await browser.netSaveEdit('AA:BB:CC:00:00:20');
  assert.match(list(browser), /net-editor-row/);
  assert.match(list(browser), /Not saved: Device not found/);
  assert.match(list(browser), /<textarea[^>]*>short<\/textarea>/, 'the draft is kept');
  // Opening Edit again on the same row closes the editor.
  browser.netOpenEditor('AA:BB:CC:00:00:20');
  assert.doesNotMatch(list(browser), /net-editor-row/);
});

test('a device whose MAC Data stored in another spelling is edited through its record id', async () => {
  const store = { devices: [device('192.168.50.55', 'aa-bb-cc-00-00-55')] };
  const browser = await openNetwork(store);
  assert.match(list(browser), /data-action="net-edit" data-key="005500000000000000000000"/);
  await browser.netToggleKnown('005500000000000000000000', true);
  assert.equal(writes(browser).at(-1).path, '/network/devices/005500000000000000000000');
});
