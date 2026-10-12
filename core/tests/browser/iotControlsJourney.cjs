'use strict';
// Actual Toolbox -> Core relay -> Data routes, disposable Mongo, synthetic device.
// Run with Playwright installed in NODE_PATH; never connects to a LAN broker.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const tree = path.resolve(__dirname, '../../..'), core = tree + '/core', reportDir = process.env.IOT_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(tree + path.sep)) throw Error('Set IOT_REPORT_DIR outside the checkout');
fs.mkdirSync(reportDir, { recursive: true });
const req = createRequire(core + '/package.json'), dataReq = createRequire(tree + '/data/package.json');
const express = req('express'), { MongoMemoryServer } = req('mongodb-memory-server'), { MongoClient } = dataReq('mongodb');
const { chromium } = require('playwright');
process.env.NODE_ENV = 'test'; process.env.MONGOMS_VERSION ||= '7.0.24';
const id = 'SYN_UI', pin = { io: 15, mode: 'OUT', lbl: 'D15', isA: false, name: 'Lampe' };
const applied = { version: 1, bootId: 'abcdef01', serial: 1, config: [pin], timers: [],
  outputs: [{ io: 15, active: false, available: true, inverted: false }], clockValid: true,
  timezone: 'UTC-0500', localTime: '2026-01-01 07:00:00', lastError: null };
const publications = [], errors = [], external = [];
let connected = true, deviceReport = true, service, controls, mongo, client, db, dataServer, coreServer, browser;
async function report() {
  applied.serial++; service.handleMessage(`esp32/${id}/state`, Buffer.from(JSON.stringify(applied))); await controls.drain();
}
const monitor = { addListener: () => () => {}, status: () => ({ connected, configured: true, broker: 'Synthetic loopback', subscribes: ['#'] }),
  async publish(message) {
    if (!connected) throw Object.assign(Error('Synthetic broker disconnected'), { statusCode: 503 });
    publications.push(message);
    if (message.topic.endsWith('/configIOs')) applied.config = JSON.parse(message.payload);
    if (message.topic.endsWith('/io/sunrise')) {
      applied.timers = [{ io: 15, tStart: message.payload.slice(3), tStop: '06:00:00', enabled: true, nextStart: null }];
    }
    if (message.topic.endsWith('/io/nightfall')) applied.timers[0].tStop = message.payload.slice(3);
    if (message.topic.endsWith('/timer/disable')) applied.timers[0].enabled = false;
    if (deviceReport && !message.topic.endsWith('/io/sunrise')) setTimeout(() => report().catch(error => errors.push(error.message)), 20);
    return { ...message, qos: 0, publishedAt: new Date().toISOString() };
  } };
async function listen(app) { const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return server; }
async function waitNote(page, text) { await page.waitForFunction(text => document.querySelector('#iotConfigNote')?.textContent.includes(text), text); }
async function open(page, name) { const detail = page.locator('#iotConfiguration details').filter({ has: page.locator('summary', { hasText: name }) }); if (!await detail.evaluate(el => el.open)) await detail.locator('summary').click(); }
async function refresh(page) { await report(); await page.locator('[data-iot-config-refresh]').click(); await page.waitForFunction(() => !iotConfiguration.data.inFlight); }
async function prepare(page, selector) { await page.locator(selector).click(); await page.locator('[data-iot-config-confirm]').waitFor(); }
(async () => {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'agentx_iot_browser_fixture' } });
  client = await new MongoClient(mongo.getUri()).connect(); db = client.db('agentx_iot_browser_fixture');
  service = dataReq('./services/iot').createIot({ monitor });
  await service.start(db, { env: { NODE_ENV: 'fixture', MQTT_BROKER_URL: 'mqtt://127.0.0.1' } }); controls = await service.control(db);
  service.handleMessage(`sensors/${id}/availability`, Buffer.from('online'));
  await report();
  Object.assign(dataReq('./services/iot'), service);
  const data = express(); data.use(express.json()); data.locals.db = db;
  data.use('/api/v1/iot', dataReq('./routes/iot.routes'));
  data.get('/api/v1/events', (_r, res) => res.json({ data: { events: [] } }));
  data.get('/api/v1/mqtt/status', (_r, res) => res.json({ data: monitor.status() }));
  data.get('/health', (_r, res) => res.json({ status: 'ok' }));
  dataServer = await listen(data); process.env.DATAAPI_BASE_URL = `http://127.0.0.1:${dataServer.address().port}`;
  const app = express(); app.use(express.json());
  app.use('/vendor/chart.js/4.5.1', express.static(core + '/node_modules/chartjs-4-5-1/dist'));
  app.use('/vendor/fontawesome/6.4.0', express.static(core + '/node_modules/@fortawesome/fontawesome-free'));
  app.use('/vendor/fonts', express.static(core + '/public/vendor/fonts'));
  app.use(express.static(core + '/public'));
  req('./surfaces/data-toolbox').register({ contractVersion: 2, app, express });
  coreServer = await listen(app); const base = `http://127.0.0.1:${coreServer.address().port}`;
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); await page.clock.install(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(base + '/data-toolbox#iot'); await page.locator('#iotProfileEditor').waitFor({ state: 'attached' });
  await open(page, 'Créer ou modifier');
  await page.locator('#iotProfileEditor [name=profileName]').fill('Culture');
  await page.locator('[data-iot-config-add]').click();
  await page.locator('[data-field=name]').fill('<img src=x onerror=alert(1)>');
  await page.locator('#iotProfileEditor button[type=submit]').click(); await waitNote(page, 'Profil enregistré'); assert.equal(publications.length, 0);
  await open(page, 'Affecter');
  await page.locator('#iotProfileAssignment [name=profileName]').selectOption('Culture');
  await page.locator('#iotProfileAssignment button[type=submit]').click(); await waitNote(page, 'Affectation enregistrée'); assert.equal(publications.length, 0);
  await open(page, 'Affecter'); await prepare(page, '[data-iot-profile-prepare]');
  assert.equal(publications.length, 0); assert.equal(await page.locator('#iotConfigConfirmation img').count(), 0);
  await page.locator('[data-iot-config-cancel]').click(); assert.equal(publications.length, 0);
  // Preview must equal the shared backend packet, including the original five fields.
  await prepare(page, '[data-iot-profile-prepare]');
  const preview = await page.evaluate(() => iotConfiguration.armed.messages);
  await page.locator('[data-iot-config-confirm]').dblclick(); await waitNote(page, 'Publié');
  assert.equal(publications.length, 1); assert.deepEqual(preview, publications.map(({ topic, payload }) => ({ topic, payload })));
  await refresh(page); await page.locator('#iotConfiguration').screenshot({ path: reportDir + '/desktop-profiles.png' });
  await open(page, 'Minuteries quotidiennes');
  await page.locator('#iotTimerEditor [name=tStart]').fill('23:00:00'); await page.locator('#iotTimerEditor [name=tStop]').fill('06:00:00');
  await page.locator('#iotTimerEditor [name=enabled]').check(); await page.locator('#iotTimerEditor button[type=submit]').click();
  await waitNote(page, 'Horaires enregistrés'); assert.equal(publications.length, 1);
  await open(page, 'Minuteries quotidiennes'); await prepare(page, '[data-iot-timer-prepare="15"]');
  const timerPreview = await page.evaluate(() => iotConfiguration.armed.messages);
  assert.deepEqual(timerPreview, req('../shared/iotControlRules').timerMessages(id, { io: 15, tStart: '23:00:00', tStop: '06:00:00', enabled: true }).map(({ topic, payload }) => ({ topic, payload })));
  await page.locator('[data-iot-config-confirm]').click(); await waitNote(page, 'Publié'); await refresh(page);
  assert.deepEqual(publications.slice(1).map(row => row.payload), ['15:23:00:00', '15:06:00:00']);
  // A response lost after Data accepted the action is recovered by reading, never resubmitting.
  await open(page, 'Minuteries quotidiennes'); await page.locator('#iotTimerEditor [name=enabled]').uncheck();
  await page.locator('#iotTimerEditor button[type=submit]').click(); await waitNote(page, 'Horaires enregistrés');
  await open(page, 'Minuteries quotidiennes'); await prepare(page, '[data-iot-timer-prepare="15"]');
  await page.route('**/timers/15/apply', async route => { await route.fetch(); await route.abort('failed'); });
  await page.locator('[data-iot-config-confirm]').click();
  await page.waitForFunction(() => !iotState.pending && !iotConfiguration.armed);
  assert.equal(publications.length, 4); assert.equal(publications.at(-1).topic, `esp32/${id}/io/timer/disable`);
  await page.unroute('**/timers/15/apply'); await refresh(page);
  await page.reload(); await page.locator('#iotProfileEditor').waitFor({ state: 'attached' }); assert.equal(publications.length, 4);
  // Expiration, tab navigation and changes discard the frozen preview.
  await open(page, 'Affecter'); await prepare(page, '[data-iot-profile-prepare]');
  await page.clock.fastForward(21000); assert.equal(await page.locator('[data-iot-config-confirm]').count(), 0);
  assert.equal(publications.length, 4); await page.clock.resume();
  await prepare(page, '[data-iot-profile-prepare]'); await page.evaluate(() => { location.hash = '#mqtt'; });
  await page.waitForFunction(() => !iotConfiguration.armed); await page.goto(base + '/data-toolbox#iot'); await page.locator('#iotProfileEditor').waitFor({ state: 'attached' });
  // Refusal must preserve an unsaved draft.
  await open(page, 'Créer ou modifier'); await page.locator('#iotProfileEditorSelect').selectOption('Culture');
  await page.locator('[data-field=name]').fill('Brouillon conservé');
  await controls.saveProfile('Culture', { revision: 1, config: [pin] });
  await page.locator('#iotProfileEditor button[type=submit]').click(); await waitNote(page, 'Actualise');
  assert.equal(await page.locator('[data-field=name]').inputValue(), 'Brouillon conservé');
  // Broker disconnect after preview: no publish and no deferred work on reconnection.
  await open(page, 'Affecter'); await prepare(page, '[data-iot-profile-prepare]'); connected = false;
  await page.locator('[data-iot-config-confirm]').click(); await page.waitForFunction(() => !iotState.pending);
  assert.equal(publications.length, 4); connected = true; await refresh(page); assert.equal(publications.length, 4);
  // Inspect layout in an actual narrow Chromium viewport, with forms open.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'Créer ou modifier'); await open(page, 'Affecter'); await open(page, 'Minuteries quotidiennes');
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth })); assert.ok(widths.scroll <= widths.viewport + 1, JSON.stringify(widths));
  await page.locator('#iotConfiguration').screenshot({ path: reportDir + '/phone-controls.png' });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  fs.writeFileSync(reportDir + '/result.json', JSON.stringify({ passed: true, publications, errors, external, widths }, null, 2));
  console.log('PASS IoT browser journey: real UI/relay/Data, four synthetic packets, desktop/mobile, lost response/offline/cancel/expiry/CAS.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (coreServer) await new Promise(resolve => coreServer.close(resolve));
  if (dataServer) await new Promise(resolve => dataServer.close(resolve));
  if (service) await service.stop(); if (db) await db.dropDatabase(); if (client) await client.close(); if (mongo) await mongo.stop();
});
