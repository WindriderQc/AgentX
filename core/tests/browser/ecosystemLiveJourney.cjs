'use strict';
// Real Core page, polling, reference reader and GraphysX embed. Only the native
// observations are fixtures. No model, deployed service, scanner or GPU access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const { presentationReader } = require('../../src/services/presentationReadService');
const { presentationEvidence, screenContext } = require('../../surfaces/household/screen-context');
const { screenDestinations } = require('../../../shared/screenDestinations');
const catalog = require('../../public/js/screen-pages').createCatalog(screenDestinations({ agentxProfile: 'full' }));
const modulePath = process.env.DISKX_TEST_MODULE, report = process.env.ECOSYSTEM_BROWSER_REPORT;
if (!modulePath || !report) throw new Error('DISKX_TEST_MODULE and ECOSYSTEM_BROWSER_REPORT are required');
fs.mkdirSync(report, { recursive: true });
const instance = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-live-'));
fs.mkdirSync(path.join(instance, 'config'));
fs.writeFileSync(path.join(instance, 'config/ecosystem-live.json'), JSON.stringify({ version: 1, nodes: [] }));
let config = { version: 1, nodes: [{ id: 'core', services: ['core'] }] }, mode = 'online', failure = false, serviceDown = false;
let collections = 0;
const app = express(), core = path.resolve(__dirname, '../..');
app.use('/api/nerve-center', require('../../routes/nerve-center-ecosystem-live')({
  config: () => config, reader: presentationReader,
  buildSnapshot: async () => {
    collections += 1;
    if (failure) throw new Error('Synthetic unavailable collector');
    const at = new Date().toISOString();
    return { authority: 'agentx-product', readOnly: true, schemaVersion: 2, generatedAt: at,
      cluster: [{ hostKey: 'primary', status: mode, checkedAt: at }],
      evidence: { servicesObservedAt: at }, hostPreferences: [],
      services: [{ id: 'core', status: serviceDown ? 'down' : 'ok', identity: serviceDown ? null : { ts: at } }] };
  }
}));
app.use('/diskx', (_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; img-src 'self' data: blob:"); next();
});
require('../../surfaces/diskx').register({ app, express, env: { AGENTX_INSTANCE_ROOT: instance, DISKX_MODULE_URL: 'https://assets.example/embed/diskx.js' },
  fetchData: () => assert.fail('No datalake access'),
  fetchWithTimeout: async () => ({ ok: true, headers: new Map([['content-type', 'text/javascript']]), text: async () => fs.readFileSync(modulePath, 'utf8') }) });
app.use('/js', express.static(path.join(core, 'public/js')));
app.use('/assets/household', express.static(path.join(core, 'surfaces/household/public')));
app.get('/', (_req, res) => res.send('<!doctype html><title>Fixture conversation</title><iframe title="Carte" src="/diskx?app=ecosystem&presentation=live-fixture" style="width:100%;height:950px;border:0"></iframe>'));

(async () => {
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], httpErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', timezoneId: 'America/Toronto' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400 && !response.url().endsWith('/api/nerve-center/ecosystem/live')) httpErrors.push(response.url());
    });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    // Accelerate only the requested ten-second polling timer in this fixture.
    // Server cache, HTTP, rendering and after-render acknowledgements stay real.
    await page.addInitScript(() => {
      const original = window.setInterval.bind(window);
      window.__requestedPollIntervals = [];
      window.setInterval = (fn, ms, ...args) => {
        window.__requestedPollIntervals.push(ms);
        return original(fn, ms === 10000 ? 200 : ms, ...args);
      };
    });
    await page.goto(origin);
    const frame = page.frames().find(frame => new URL(frame.url()).pathname === '/diskx');
    assert.ok(frame);
    await frame.waitForFunction(() => document.querySelector('agentx-ecosystem')?.state()?.presentation?.live?.status === 'available');
    const initial = await frame.evaluate(() => document.querySelector('agentx-ecosystem').state());
    const host = initial.nodes.find(node => node.kind === 'host');
    assert.ok(host);
    config = { version: 1, nodes: [{ id: host.id, hosts: ['primary'] }, { id: 'core', services: ['core'] }] };
    const state = () => frame.evaluate(() => document.querySelector('agentx-ecosystem').state());
    const awaitState = expected => frame.waitForFunction(({ id, expected }) =>
      document.querySelector(`.gx-eco-live li[data-node-id="${id}"]`)?.dataset.state === expected,
    { id: host.id, expected }, { timeout: 20000 });
    await awaitState('online');
    const before = await state();
    assert.equal(before.presentation.selection, null, 'no selection is needed for live state');
    mode = 'offline';
    await awaitState('offline');
    const offline = await state();
    assert.equal(offline.presentation.instance, before.presentation.instance);
    assert.equal(offline.presentation.documentRevision, before.presentation.documentRevision);
    assert.deepEqual(offline.nodes.map(node => node.screen), before.nodes.map(node => node.screen), 'automatic refresh preserves framing');
    assert.equal(offline.presentation.selection, null);
    await page.screenshot({ path: path.join(report, 'automatic-offline.png'), fullPage: true });

    await frame.locator(`.gx-eco-live li[data-node-id="${host.id}"] button`).click();
    await frame.waitForFunction(id => document.querySelector('agentx-ecosystem').state().presentation.selection?.id === id, host.id);
    const selected = await state();
    const evidence = presentationEvidence([{ contract: 'agentx.presentation/v1', id: 'live-fixture', revision: 'live-fixture',
      kind: 'page', page: 'ecosystem', status: 'visible', observation: selected.presentation }], catalog);
    assert.equal(evidence.selection.id, host.id);
    assert.equal(evidence.read.live.data.nodes.find(node => node.id === host.id).state, 'offline');
    assert.equal(evidence.read.live.data.revision, selected.presentation.live.read.revision);
    const context = screenContext([], catalog, evidence);
    assert.match(context, /core.ecosystem.live/);
    assert.match(context, /offline/);
    assert.equal(presentationReader.read(evidence.read).live.data.revision, selected.presentation.live.read.revision);

    serviceDown = true;
    await frame.waitForFunction(() => document.querySelector('.gx-eco-live li[data-node-id="core"]')?.dataset.state === 'offline', null, { timeout: 20000 });
    assert.equal((await state()).presentation.selection.id, host.id, 'a different service updates while this host remains selected');
    serviceDown = false;
    mode = 'online';
    await awaitState('online');
    assert.equal((await state()).presentation.selection.id, host.id, 'recovery preserves selected component');
    failure = true;
    await frame.waitForFunction(() => document.querySelector('agentx-ecosystem').state().presentation.live.status === 'unavailable', null, { timeout: 20000 });
    const unavailable = await state();
    assert.ok(unavailable.presentation.live.read, 'unavailable retains last-known reference');
    assert.equal(await frame.locator(`.gx-eco-live li[data-node-id="${host.id}"]`).getAttribute('data-state'), 'unknown');
    const lastKnown = presentationReader.observeEcosystem(unavailable.presentation, 'live-fixture');
    assert.equal(lastKnown.live.status, 'unavailable');
    assert.equal(lastKnown.live.data.nodes.find(node => node.id === host.id).state, 'online');
    failure = false;
    await awaitState('online');
    await page.setViewportSize({ width: 390, height: 950 });
    await frame.locator('.gx-eco-live').scrollIntoViewIfNeeded();
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await frame.locator(`.gx-eco-live li[data-node-id="${host.id}"] button`).isVisible(), true);
    await page.screenshot({ path: path.join(report, 'live-mobile.png'), fullPage: true });
    assert.equal(await frame.evaluate(() => window.__requestedPollIntervals.includes(10000)), true);
    assert.deepEqual(errors, []); assert.deepEqual(httpErrors, []);
    const result = { ok: true, nativeModelCalls: 0, actualDeployedInterface: false, acceleratedPollingFixture: true,
      collections, checks: ['automatic whole-map update without click', 'same frame and camera', 'selected component recovery',
        'Nestor reads exact rendered Core revision', 'source failure removes healthy appearance', 'last known read remains unavailable',
        'a failed service probe updates without selecting it', 'recovery', 'mobile keyboard controls', 'requested ten-second cadence'], errors, httpErrors };
    fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(instance, { recursive: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
