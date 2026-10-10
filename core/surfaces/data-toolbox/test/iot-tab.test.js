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

function browser(respond, localStorage) {
  const elements = {}; const listeners = {}; const requests = []; const timers = [];
  const element = selector => elements[selector] ||= { innerHTML: '', textContent: '', value: '', disabled: false,
    setAttribute() {}, querySelectorAll() { return []; }, contains() { return false; } };
  const document = { hidden: false, querySelector: element, querySelectorAll() { return []; }, addEventListener(name, handler) { (listeners[name] ||= []).push(handler); } };
  const context = { document, location: { hash: '#iot' }, window: { addEventListener() {} }, localStorage, console, URLSearchParams, Date,
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
  const source = ['refresh.js', 'iot-visuals.js', 'iot-appearance.js', 'iot-charts.js', 'iot-combined.js', 'iot.js', 'app.js'].map(file => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.page = { state, render, iotState, iotTab, iotSelect, iotLoadSeries, iotSubmit, iotRefresher, iotChart, iotCards, iotCombinedModel, iotNearestValue, iotCombinedBounds, iotCurveStyle, iotStoreCurveStyle };');
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
  assert.match(page.elements['#iotSeries'].innerHTML, /<canvas id="iotCombinedChart"/);
  assert.equal(page.requests.filter(call => call.method !== 'GET').length, 0);
  assert.deepEqual(plain(page.iotState.keys), ['temperature', 'wifi_rssi']);
});

test('no devices or no live points stays empty and never fabricates charts', async () => {
  const empty = await open({ devices: [] }); assert.match(empty.content.innerHTML, /Aucun appareil reçu/);
  assert.equal(empty.requests.length, 2);
  const page = await open({ read: () => ({ measures: {} }) });
  assert.match(page.elements['#iotSeries'].innerHTML, /Aucune mesure reçue/);
  assert.doesNotMatch(page.elements['#iotSeries'].innerHTML, /class="iot-chart"|id="iotCombinedChart"/);
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
  assert.match(page.elements['#iotSeries'].innerHTML, /<canvas id="iotCombinedChart"/);
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
  const plotted = [...chart.matchAll(/data-iot-point[^>]*cx="([0-9.]+)"/g)].map(match => Number(match[1]));
  assert.equal((plotted[1] - plotted[0]) / (plotted[2] - plotted[0]), 1 / 60, 'a minute occupies one sixtieth of the hour');
  assert.match(chart, /dernière période en cours/);
  assert.match(chart, /<table>/);
  assert.match(chart, /&lt;temperature&gt;/);
  assert.doesNotMatch(chart, /NaN|Infinity/);
});


test('superposed metrics share exact time bounds while keeping distinct scales and real values', async () => {
  const page = await open({});
  const start = Date.parse('2026-01-01T00:00:00Z');
  page.iotState.period = '24'; page.iotState.keys = ['temperature', 'battery_voltage'];
  page.iotState.series = { bucketSeconds: 60, from: new Date(start).toISOString(), to: new Date(start + 7200000).toISOString(), measures: {
    temperature: { unit: '°C', points: [{ ts: start, mean: 20, min: 19, max: 21 }, { ts: start + 60000, mean: 21, min: 20, max: 22 }] },
    battery_voltage: { unit: 'V', points: [{ ts: start + 900000, mean: 4.1, min: 4, max: 4.2 }, { ts: start + 960000, mean: 4.2, min: 4.1, max: 4.3 }] }
  } };
  const model = page.iotCombinedModel();
  assert.equal(model.start, start); assert.equal(model.end, start + 7200000);
  assert.equal(model.metrics[1].data[0].x - model.metrics[0].data[0].x, 900000, 'a later series does not move to the start of the chart');
  assert.notEqual(model.metrics[0].axis, model.metrics[1].axis);
  assert.equal(model.metrics[1].unit, 'V');
  assert.equal(model.metrics[1].data[0].y * model.metrics[1].divisor, 4.1);
  assert.equal(model.metrics[0].points[0].value, 20);
  assert.notEqual(model.metrics[0].color, model.metrics[1].color);
});

test('the comparison leaves explicit missing readings and historical gaps empty, including during hover', async () => {
  const page = await open({}); const start = Date.parse('2026-01-01T00:00:00Z');
  page.iotState.period = '24'; page.iotState.keys = ['temperature'];
  page.iotState.series = { bucketSeconds: 60, measures: { temperature: { points: [
    { ts: start, mean: 0 }, { ts: start + 60000, mean: null }, { ts: start + 180000, mean: 10 },
    { ts: 'invalid', mean: 9 }, { ts: start + 240000, mean: Infinity }
  ] } } };
  const metric = page.iotCombinedModel().metrics[0];
  assert.equal(metric.points.length, 2);
  assert.equal(metric.points[0].value, 0);
  assert.ok(metric.data.some(point => point.x === start + 60000 && point.y === null));
  assert.ok(metric.data.some(point => point.x === start + 120000 && point.y === null), 'large time gaps break the line');
  assert.equal(page.iotNearestValue(metric, start + 60000), null);
  assert.equal(page.iotNearestValue(metric, start + 180000).value, 10);
  assert.equal(page.iotNearestValue(metric, start + 240000), null);
});

test('comparison scales stay finite for extreme numbers and min/max is an explicit history option', async () => {
  const page = await open({}); page.iotState.period = '24'; page.iotState.keys = ['temperature'];
  page.iotState.series = { measures: { temperature: { points: [
    { ts: AT, mean: -1e308, min: -1.5e308, max: 1e308 },
    { ts: Date.parse(AT) + 60000, mean: 1e308, min: -1e308, max: 1.5e308 }
  ] } } };
  const metric = page.iotCombinedModel().metrics[0];
  assert.ok(Number.isFinite(metric.low) && Number.isFinite(metric.high));
  assert.ok(metric.data.every(point => point.y === null || Number.isFinite(point.y)));
  assert.equal(metric.min, -1e308); assert.equal(metric.max, 1e308);
  page.iotState.ranges = true;
  const ranges = page.iotCombinedModel().metrics[0];
  assert.equal(ranges.min, -1.5e308); assert.equal(ranges.max, 1.5e308);
  assert.ok(Number.isFinite(ranges.low) && Number.isFinite(ranges.high));
});

test('curve preferences survive reload per device and measure without writing to Data', async () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  const first = browser(fakeData(), storage); await first.render();
  first.iotStoreCurveStyle(['temperature'], { width: .75, line: 'dashed', curve: 'step', fill: 'gradient', opacity: 24 });
  const second = browser(fakeData(), storage); await second.render();
  assert.equal(second.iotCurveStyle('temperature').width, .75);
  assert.equal(second.iotCurveStyle('temperature').fill, 'gradient');
  assert.equal(second.iotCurveStyle('wifi_rssi').fill, 'none');
  second.iotState.selected = 'OTHER_DEVICE';
  assert.equal(second.iotCurveStyle('temperature').width, 1.5);
  assert.ok([...first.requests, ...second.requests].every(call => call.method === 'GET'));
});

test('unreadable or invalid saved curve styles leave readings available with bounded rendering settings', async () => {
  for (const raw of ['invalid json', JSON.stringify({ version: 1, devices: [{ id: 'SYN_1', curves: [{ key: 'temperature', width: 999, line: '<script>', fill: 'unexpected', opacity: -100 }] }] })]) {
    const page = browser(fakeData(), { getItem: () => raw, setItem() { throw new Error('storage unavailable'); } });
    await page.render();
    const model = page.iotCombinedModel();
    assert.equal(model.metrics[0].points[0].value, 22);
    assert.equal(model.metrics[0].style.width, 1.5);
    assert.equal(model.metrics[0].style.line, 'solid');
    assert.equal(model.metrics[0].style.fill, 'none');
    assert.ok(model.metrics[0].style.opacity >= 0 && model.metrics[0].style.opacity <= 40);
    page.iotStoreCurveStyle(['temperature'], { width: 2, fill: 'solid' });
    assert.equal(page.iotCurveStyle('temperature').width, 2, 'denied storage retains session preferences');
    assert.ok(page.requests.every(call => call.method === 'GET'));
  }
});

test('context scales do not magnify a quantized sensor step into a full-height swing', async () => {
  const page = await open({});
  const bounds = page.iotCombinedBounds(1013.01, 1013.02, 'pressure', 'hPa');
  const span = (bounds.high - bounds.low) * bounds.divisor;
  assert.ok(span >= 5, 'pressure keeps a viewing span rather than stretching its hundredth-unit step');
  assert.ok(.01 / span < .01);
  const shifted = page.iotCombinedBounds(1013.02, 1013.03, 'pressure', 'hPa');
  assert.ok(Math.abs(bounds.low * bounds.divisor - shifted.low * shifted.divisor) < 1e-9);
  assert.ok(Math.abs(bounds.high * bounds.divisor - shifted.high * shifted.divisor) < 1e-9);
  const detail = page.iotCombinedBounds(1013.01, 1013.02, 'pressure', 'hPa', 'detail');
  assert.ok((detail.high - detail.low) * detail.divisor < .02, 'detail preserves access to small real variations');
});

test('context bounds expand for outliers and keep all observations, zero and extreme values', async () => {
  const page = await open({});
  for (const [min, max, key, unit] of [
    [-140, 400, 'temperature', '°C'], [-180, 10, 'wifi_rssi', 'dBm'], [0, 150, 'battery_voltage', 'V'],
    [0, 0, 'unknown', ''], [-1.5e308, 1.5e308, 'unknown', ''], [1e-320, 2e-320, 'unknown', ''], [8, 9, 'unknown', 'constructor']
  ]) {
    const bounds = page.iotCombinedBounds(min, max, key, unit);
    assert.ok(Number.isFinite(bounds.low) && Number.isFinite(bounds.high) && Number.isFinite(bounds.divisor));
    assert.ok(bounds.high > bounds.low);
    assert.ok(min / bounds.divisor >= bounds.low && max / bounds.divisor <= bounds.high, 'viewing spans never cap a valid observation');
  }
  page.iotStoreCurveStyle(['temperature'], { scale: 'detail' });
  assert.equal(page.iotCurveStyle('temperature').scale, 'detail');
  assert.equal(page.iotCurveStyle('wifi_rssi').scale, 'context');
  const model = page.iotCombinedModel();
  assert.equal(model.metrics[0].points[0].value, 22);
});
