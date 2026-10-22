'use strict';
// Deterministic browser qualification of the real catalogue, reply projection,
// screen renderer and visit lifecycle. No model, LAN service or credentials.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const core = path.resolve(__dirname, '../..'), req = createRequire(core + '/package.json');
const express = req('express'), { chromium } = require('playwright');
const { registerScreenServices } = req('./surfaces/household/screen-services');
const { workResultPresentation } = req('./surfaces/household/work-result-presentation');
const reportDir = process.env.GUIDED_SERVICES_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(path.resolve(core, '..') + path.sep)) throw Error('Set GUIDED_SERVICES_REPORT_DIR outside the checkout');
fs.mkdirSync(reportDir, { recursive: true });
let server, browser;
(async () => {
  const app = express(), router = express.Router();
  app.locals.publicUrls = { core: 'http://127.0.0.1', benchmark: 'http://127.0.0.1/benchmark', rag: 'http://127.0.0.1/rag' };
  app.locals.agentxProfile = 'full';
  app.use((_req, res, next) => { res.set('X-Frame-Options', 'DENY'); next(); });
  const config = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nestor-screen-browser-'));
  fs.mkdirSync(config + '/config');
  fs.writeFileSync(config + '/config/screen-services.json', JSON.stringify({ version: 1,
    services: [{ id: 'home-assistant', label: 'Home Assistant', href: 'http://127.0.0.1:1', mode: 'link' }] }));
  const catalog = registerScreenServices({ app, router, env: { AGENTX_INSTANCE_ROOT: config },
    envelope: (res, data) => res.json({ ok: true, data }) });
  fs.rmSync(config, { recursive: true });
  app.use('/api/voice-personas', router);
  app.use('/assets/household', express.static(core + '/surfaces/household/public'));
  app.use('/js', express.static(core + '/public/js'));
  app.get('/dad/day', (_req, res) => res.send('<title>Ma journée</title><style>body{font:16px sans-serif;background:#fff;color:#10212b;padding:12px}</style><h1>Ma journée</h1><h2>Mes rendez-vous</h2><h2 hidden>Invisible</h2><input type="password" value="PRIVATE_FIELD">'));
  app.get('/fixture', (_req, res) => res.send(`<!doctype html><html lang="fr"><title>Visiter avec Nestor</title>
    <link rel="stylesheet" href="/assets/household/display-board.css"><style>body{font:16px sans-serif;background:#10212b;color:white;margin:24px;--line:#456;--panel:#142b37;--panel-2:#203848;--soft:#cad;--cyan:#5dd}button,a,summary{color:inherit}button{background:#284e5c;border:1px solid #789;padding:8px;border-radius:6px}header{display:flex;flex-wrap:wrap;gap:12px}.display-board-list{max-height:none}</style>
    <h1>Visiter avec Nestor</h1><p>La conversation reste disponible pendant la visite.</p><header id="toolbar"></header><section id="screen"></section>
    <script src="/js/screen-pages.js"></script><script src="/assets/household/screen-picker.js"></script><script src="/assets/household/guided-visit.js"></script><script src="/assets/household/display-board.js"></script>
    <script>window.ready = fetch('/api/voice-personas/private/screen-pages').then(r=>r.json()).then(({data})=>{
      AgentXScreenPages.configure(data.destinations); window.board=DisplayBoard.create(document.getElementById('screen'));
      NestorScreenPicker.mount({host:document.getElementById('toolbar'),onShow:block=>board.add(block)});
      window.expired=0; window.visit=NestorGuidedVisit.mount({host:document.getElementById('toolbar'),onExpire:()=>expired++,maxMs:30000});
    });</script></html>`));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.GUIDED_SERVICES_BROWSER_EXECUTABLE && { executablePath: process.env.GUIDED_SERVICES_BROWSER_EXECUTABLE }) });
  const errors = [], requests = [], results = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== base) { requests.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(base + '/fixture'); await page.evaluate(() => ready);
    await page.getByText('Pages et services', { exact: true }).click();
    assert.ok(await page.locator('.conversation-screen-destinations button').count() > 30);
    await page.getByRole('button', { name: 'My day', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Mes rendez-vous' }).waitFor();
    const observation = await page.evaluate(() => board.context());
    assert.equal(observation[0].page, 'dad-day'); assert.equal(observation[0].status, 'visible');
    assert.deepEqual(observation[0].headings, ['Ma journée', 'Mes rendez-vous']);
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_FIELD|Invisible/);
    const framed = await page.request.get(base + '/dad/day?view=screen'); assert.equal(framed.headers()['x-frame-options'], 'SAMEORIGIN');
    const normal = await page.request.get(base + '/dad/day'); assert.equal(normal.headers()['x-frame-options'], 'DENY');
    await page.getByText('Pages et services', { exact: true }).click();
    await page.getByRole('button', { name: 'Home Assistant', exact: true }).click();
    assert.match(await page.locator('.display-block').first().innerText(), /ne voit pas le contenu/);
    assert.equal(await page.locator('.display-block').first().locator('iframe').count(), 0);
    const popupPromise = context.waitForEvent('page');
    await page.locator('.display-block').first().getByRole('link').click(); const popup = await popupPromise;
    assert.equal(await page.evaluate(() => visit.active()), true);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.evaluate(() => visit.active()), true);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.evaluate(() => visit.active()), false);
    await popup.close();
    const projected = workResultPresentation({ text: 'Voici votre journée. <show kind="page">dad-day</show>' }, { pageCatalog: catalog });
    await page.evaluate(block => board.add(block), projected.display[0]);
    assert.equal(projected.spokenText, 'Voici votre journée.');
    assert.equal(await page.locator('iframe').count(), 1, 'a restored page replaces its preceding frame');
    const screenshot = path.join(reportDir, `guide-${viewport.width}.png`); await page.screenshot({ path: screenshot, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    results.push({ viewport, observation, destinations: catalog.entries.length, screenshot });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.ok(requests.every(url => url === 'http://127.0.0.1:1/'));
  fs.writeFileSync(path.join(reportDir, 'browser-result.json'), JSON.stringify({ ok: true, modelCalls: 0, errors, blockedExternalRequests: requests, results }, null, 2));
  console.log(JSON.stringify({ ok: true, modelCalls: 0, viewports: results.length, destinations: catalog.entries.length, reportDir }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
