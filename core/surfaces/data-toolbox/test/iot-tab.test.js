'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const request = require('supertest');
const toolbox = require('../index');
const { buildProductNavigation } = require('../../../../shared/productNavigation');

const AT = new Date().toISOString();
const device = (id = 'SYN_1', extra = {}) => ({ id, status: 'online', displayName: null, location: null,
  notes: null, lastSeenAt: AT, info: {}, measures: [
    { key: 'temperature', name: 'Temperature', unit: '°C', value: 23.5, at: AT },
    { key: 'wifi_rssi', name: 'Wi-Fi', unit: 'dBm', value: -60, at: AT }
  ], ...extra });
const status = connected => ({ consumer: { configured: true, connected }, readings: { accepted: 12 } });
const series = (id, keys = ['temperature', 'wifi_rssi']) => ({ device: id, ringSize: 60, measures: Object.fromEntries(keys.map(key => [key, {
  name: key, unit: key === 'temperature' ? '°C' : null, points: [
    { ts: new Date(Date.parse(AT) - 5000).toISOString(), value: 22, mean: 22, min: 21, max: 23, count: 4 },
    { ts: AT, value: 23.5, mean: 23.5, min: 23, max: 24, count: 4 }
  ]
}])) });

async function relayApp(t, respond) {
  const original = global.fetch; const calls = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    return respond ? respond(url, options) : { status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) };
  };
  const app = express(); app.use(express.json()); toolbox.register({ contractVersion: 2, app, express });
  return { app, calls };
}

test('IoT is directly discoverable in the full navigation and stays outside demo', () => {
  const groups = buildProductNavigation({ agentxProfile: 'full' }).navItems;
  assert.ok(groups.flatMap(group => group.children).some(item => item.href === '/data-toolbox#iot' && item.label === 'Appareils IoT'));
  assert.ok(!buildProductNavigation({ agentxProfile: 'demo' }).navItems.flatMap(group => group.children).some(item => item.id === 'iot'));
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /href="#iot" data-tab="iot"/);
  for (const file of ['iot.js', 'iot-charts.js']) assert.ok(html.indexOf(`/assets/data-toolbox/${file}`) < html.indexOf('/assets/data-toolbox/app.js'));
});

test('IoT read relays bound and encode the device and allow only history query fields', async t => {
  const { app, calls } = await relayApp(t);
  await request(app).get('/api/data-toolbox/iot/status?password=never').expect(200);
  await request(app).get('/api/data-toolbox/iot/devices').expect(200);
  await request(app).get('/api/data-toolbox/iot/devices/SYN_1').expect(200);
  await request(app).get('/api/data-toolbox/iot/devices/SYN_1/live?measure=temperature,wifi_rssi&admin=1').expect(200);
  await request(app).get('/api/data-toolbox/iot/devices/SYN_1/history?measure=temperature&from=2026-01-01&to=2026-01-02&resolution=hour&$where=x').expect(200);
  assert.deepEqual(calls.map(call => call.url.pathname), ['/api/v1/iot/status', '/api/v1/iot/devices', '/api/v1/iot/devices/SYN_1', '/api/v1/iot/devices/SYN_1/live', '/api/v1/iot/devices/SYN_1/history']);
  assert.equal(calls[0].url.search, '');
  assert.deepEqual(Object.fromEntries(calls[4].url.searchParams), { measure: 'temperature', from: '2026-01-01', to: '2026-01-02', resolution: 'hour' });
  await request(app).get(`/api/data-toolbox/iot/devices/SYN_1/history?measure=${'x'.repeat(900)}&from=${'x'.repeat(80)}&resolution=bad`).expect(200);
  assert.equal(calls[5].url.searchParams.get('measure').length, 600);
  assert.equal(calls[5].url.searchParams.get('from').length, 40);
  assert.ok(!calls[5].url.searchParams.has('resolution'));
  for (const id of ['constructor', '__proto__', '%2Felsewhere', 'x'.repeat(65)]) await request(app).get(`/api/data-toolbox/iot/devices/${id}`).expect(400);
  assert.equal(calls.length, 6, 'invalid ids never reach Data');
});

test('owner saves and commands use the same validation as Data and reject unexpected fields before dispatch', async t => {
  const { app, calls } = await relayApp(t);
  await request(app).patch('/api/data-toolbox/iot/devices/SYN_1').send({ displayName: '  Garden  ', notes: 'a\u0000b' }).expect(200);
  assert.deepEqual(JSON.parse(calls[0].options.body), { displayName: 'Garden', notes: 'ab' });
  await request(app).post('/api/data-toolbox/iot/devices/SYN_1/commands').send({ command: 'io_on', gpio: 2 }).expect(200);
  assert.deepEqual(JSON.parse(calls[1].options.body), { command: 'io_on', gpio: 2 });
  await request(app).post('/api/data-toolbox/iot/devices/SYN_1/commands').send({ command: 'reboot' }).expect(200);
  assert.deepEqual(JSON.parse(calls[2].options.body), { command: 'reboot' });
  for (const body of [{ command: 'io_on', gpio: '2' }, { command: 'io_off', gpio: 49 }, { command: 'reboot', gpio: null }, { command: 'reboot', retain: true }, { command: 'configIOs' }]) {
    await request(app).post('/api/data-toolbox/iot/devices/SYN_1/commands').send(body).expect(400);
  }
  for (const body of [{}, { status: 'online' }, { notes: 'x'.repeat(1001) }, { displayName: 7 }]) await request(app).patch('/api/data-toolbox/iot/devices/SYN_1').send(body).expect(400);
  assert.equal(calls.length, 3);
});

test('Data refusals survive the relay and a lost command reply is explicitly unknown without retry', async t => {
  let mode = 'offline';
  const { app, calls } = await relayApp(t, async () => {
    if (mode === 'offline') return { status: 503, text: async () => JSON.stringify({ status: 'error', message: 'Broker is disconnected. Nothing was sent.' }) };
    if (mode === 'missing') return { status: 404, text: async () => JSON.stringify({ status: 'error', message: 'Unknown device' }) };
    throw new Error('transport lost');
  });
  const url = '/api/data-toolbox/iot/devices/SYN_1/commands';
  const body = { command: 'reboot' };
  assert.match((await request(app).post(url).send(body).expect(503)).body.message, /Nothing was sent/);
  mode = 'missing'; await request(app).post(url).send(body).expect(404);
  mode = 'lost'; assert.match((await request(app).post(url).send(body).expect(502)).body.message, /outcome unknown/);
  assert.equal(calls.length, 3);
});

function browser(respond) {
  const elements = {}; const listeners = {}; const requests = []; const timers = [];
  const element = selector => elements[selector] ||= { innerHTML: '', textContent: '', value: '', disabled: false,
    setAttribute() {}, querySelectorAll() { return []; }, contains() { return false; } };
  const document = { hidden: false, querySelector: element, querySelectorAll() { return []; }, addEventListener(name, handler) { (listeners[name] ||= []).push(handler); } };
  const context = { document, location: { hash: '#iot' }, window: { addEventListener() {} }, console, URLSearchParams, Date,
    FormData: class { constructor(form) { return Object.entries(form.fields); } },
    setInterval(callback, ms) { timers.push({ callback, ms }); return timers.length; }, clearInterval() {},
    async fetch(url, options = {}) {
      const parsed = new URL(url, 'http://localhost');
      const call = { path: parsed.pathname.replace('/api/data-toolbox', ''), query: parsed.searchParams, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(call); const answer = await respond(call);
      return answer instanceof Error ? { ok: false, status: answer.status || 502, json: async () => ({ status: 'error', message: answer.message }) }
        : { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  const source = ['refresh.js', 'iot-charts.js', 'iot.js', 'app.js'].map(file => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.page = { state, render, iotState, iotTab, iotSelect, iotLoadSeries, iotSubmit, iotRefresher, iotChart, iotCards };');
  vm.runInNewContext(source, context);
  return { ...context.page, elements, listeners, requests, timers, document, content: element('#content') };
}

function fakeData(store = {}) {
  store.devices ||= [device()];
  return async call => {
    if (call.path === '/iot/status') return store.statusError || status(store.connected !== false);
    if (call.path === '/iot/devices') return store.devicesError || { devices: store.devices };
    const id = decodeURIComponent(call.path.split('/')[3]);
    if (call.path.endsWith('/live')) return store.read ? store.read(call) : series(id, call.query.get('measure').split(','));
    if (call.path.endsWith('/history')) return { ...series(id, call.query.get('measure').split(',')), bucket: call.query.get('resolution') === 'auto' ? 'minute' : call.query.get('resolution'), bucketSeconds: 60, from: call.query.get('from'), to: call.query.get('to') };
    if (call.method !== 'GET') return store.write ? store.write(call) : store.devices.find(item => item.id === id);
    throw new Error(`Unexpected ${call.path}`);
  };
}
const open = async store => { const page = browser(fakeData(store)); await page.render(); return page; };
const plain = value => JSON.parse(JSON.stringify(value));

test('device cards render real latest values, zero and unknowns, escape names, and read live without writes', async () => {
  const page = await open({ devices: [device('SYN_1', { displayName: '<img src=x onerror=evil()>', measures: [
    { key: 'temperature', name: 'Temperature', unit: '°C', value: 0, at: AT }, { key: 'wifi_rssi', name: 'Wi-Fi', value: null }
  ] }), device('SYN_2', { status: 'offline' })] });
  assert.match(page.content.innerHTML, /&lt;img src=x onerror=evil\(\)&gt;/);
  assert.doesNotMatch(page.content.innerHTML, /<img src=x/);
  assert.match(page.elements['#iotCards'].innerHTML, /<strong>0<small>/);
  assert.match(page.elements['#iotCards'].innerHTML, /Hors ligne/);
  assert.match(page.elements['#iotSeries'].innerHTML, /<svg/);
  assert.equal(page.requests.filter(call => call.method !== 'GET').length, 0);
  assert.deepEqual(plain(page.iotState.keys), ['temperature', 'wifi_rssi']);
});

test('no devices or no live points stays empty and never fabricates charts', async () => {
  const empty = await open({ devices: [] }); assert.match(empty.content.innerHTML, /Aucun appareil reçu/);
  assert.equal(empty.requests.length, 2);
  const page = await open({ read: () => ({ measures: {} }) });
  assert.match(page.elements['#iotSeries'].innerHTML, /Aucune mesure reçue/);
  assert.doesNotMatch(page.elements['#iotSeries'].innerHTML, /<svg/);
});

test('an offline broker preserves dated values and disables device commands', async () => {
  const page = await open({ connected: false });
  assert.match(page.content.innerHTML, /MQTT déconnecté/);
  assert.match(page.elements['#iotActions'].innerHTML, /type="submit" disabled>Envoyer/);
  assert.match(page.elements['#iotCards'].innerHTML, /Dernier message/);
});

test('polling discovers the first device and its first measures without requiring a manual refresh', async () => {
  const store = { devices: [] };
  const page = await open(store);
  store.devices = [device('SYN_1', { measures: [] })];
  await page.iotRefresher.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.iotState.selected, 'SYN_1');
  assert.deepEqual(plain(page.iotState.keys), []);
  store.devices = [device('SYN_1')];
  await page.iotRefresher.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(page.iotState.keys), ['temperature', 'wifi_rssi']);
  assert.match(page.elements['#iotControls'].innerHTML, /temperature/);
  assert.match(page.elements['#iotSeries'].innerHTML, /<svg/);
});

test('history uses exact shared bounds and batches devices with more than twelve metrics', async () => {
  const measures = Array.from({ length: 25 }, (_, i) => ({ key: `m${i}`, name: `Metric ${i}`, value: i, at: AT }));
  const page = await open({ devices: [device('SYN_1', { measures })] });
  page.iotState.period = '168'; page.iotState.keys = measures.map(measure => measure.key);
  await page.iotLoadSeries();
  const calls = page.requests.filter(call => call.path.endsWith('/history'));
  assert.deepEqual(calls.map(call => call.query.get('measure').split(',').length), [12, 12, 1]);
  assert.equal(new Set(calls.map(call => call.query.get('from'))).size, 1);
  assert.equal(new Set(calls.map(call => call.query.get('to'))).size, 1);
  assert.equal(Date.parse(calls[0].query.get('to')) - Date.parse(calls[0].query.get('from')), 168 * 3600000);
  assert.equal(Object.keys(page.iotState.series.measures).length, 25);
  assert.match(page.elements['#iotSeries'].innerHTML, /Historique/);
});

test('a delayed device selection and an obsolete poll cannot overwrite the current device', async () => {
  let release; let delayed = false;
  const store = { devices: [device('SYN_1'), device('SYN_2')], read: call => delayed && call.path.includes('/SYN_1/')
    ? new Promise(resolve => { release = () => resolve(series('SYN_1')); }) : series(call.path.split('/')[3]) };
  const page = await open(store); delayed = true;
  const old = page.iotLoadSeries(); await new Promise(resolve => setImmediate(resolve));
  await page.iotSelect('SYN_2'); release(); await old;
  assert.equal(page.iotState.series.device, 'SYN_2');
});

test('polling pauses on a hidden tab, during a command, and drops answers after leaving IoT', async () => {
  const page = await open({}); const before = page.requests.length;
  page.document.hidden = true; await page.iotRefresher.tick(); assert.equal(page.requests.length, before);
  page.document.hidden = false; page.iotState.pending = true; await page.iotRefresher.tick(); assert.equal(page.requests.length, before);
  page.iotState.pending = false; page.state.tab = 'mqtt'; await page.iotRefresher.tick(); assert.equal(page.requests.length, before);
  page.state.tab = 'iot';
  const cardsBefore = page.elements['#iotCards'].innerHTML; page.iotRefresher.busy = false;
  const old = page.iotRefresher.tick(); page.state.tab = 'mqtt'; await old;
  assert.equal(page.elements['#iotCards'].innerHTML, cardsBefore, 'obsolete answer did not draw any card');
});

test('device saves are explicit and a double command click issues one request with no automatic retry', async () => {
  let release;
  const store = { write: call => call.method === 'POST' ? new Promise(resolve => { release = () => resolve(new Error('outcome unknown')); }) : device('SYN_1', call.body) };
  const page = await open(store);
  const form = (id, fields) => ({ id, fields, dataset: { device: 'SYN_1' }, querySelector() { return { disabled: false }; } });
  await page.iotSubmit(form('iotRecord', { displayName: 'Garden', location: 'North', notes: 'Test' }));
  assert.equal(page.iotState.devices[0].displayName, 'Garden');
  const command = form('iotCommand', { command: 'io_on', gpio: '2' });
  const sent = page.iotSubmit(command); await page.iotSubmit(command);
  assert.equal(page.requests.filter(call => call.method === 'POST').length, 1);
  release(); await sent;
  assert.match(page.elements['#iotFeedback'].textContent, /outcome unknown.*Aucun nouvel envoi automatique/);
  assert.deepEqual(plain(page.requests.find(call => call.method === 'POST').body), { command: 'io_on', gpio: 2 });
});

test('charts preserve timestamp spacing, breaks across missing minutes, and export accessible exact values', async () => {
  const page = await open({});
  const chart = page.iotChart([
    { ts: '2026-01-01T00:00:00Z', mean: 1, min: 0, max: 2, count: 3 },
    { ts: '2026-01-01T00:01:00Z', mean: 1, min: 0, max: 2, count: 3 },
    { ts: '2026-01-01T01:00:00Z', mean: 5, min: 4, max: 6, count: 3, partial: true }
  ], { name: '<temperature>', unit: '°C', bucketSeconds: 60 });
  assert.equal((chart.match(/<polyline/g) || []).length, 2);
  assert.match(chart, /56\.00,[0-9.]+ 66\.50,[0-9.]+/);
  assert.match(chart, /dernière période en cours/);
  assert.match(chart, /<table>/);
  assert.match(chart, /&lt;temperature&gt;/);
  assert.doesNotMatch(chart, /NaN|Infinity/);
});
