'use strict';
// Real calendar route, calendar service, Nestor board and shared reader. Only
// the Google transport is a fixture; this test never uses a model or account.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { operate } = require('../../src/services/personalCalendarService');
const { presentationEvidence } = require('../../surfaces/household/screen-context');
const { createScreenServices, screenPolicy } = require('../../surfaces/household/screen-services');
const { registerCalendarRoutes } = require('../../surfaces/household/calendar-routes');
const reportDir = process.env.CALENDAR_BROWSER_REPORT;
if (!reportDir) throw new Error('CALENDAR_BROWSER_REPORT must name a local output directory');
fs.mkdirSync(reportDir, { recursive: true });
const root = path.resolve(__dirname, '../..');
const app = express(); app.use(express.json());
app.locals.agentxProfile = 'full';
let fixtureUnlock = null;
const catalog = createScreenServices({ app, env: {} });
app.use((_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; script-src-attr 'none'"); next();
});
app.use((_req, res, next) => { if (fixtureUnlock) res.locals.familyUnlock = { until: fixtureUnlock }; next(); });
app.use(screenPolicy(catalog));
let fail = false, readCount = 0;
const calendar = { operate: input => operate(input, { provider: async request => {
  assert.equal(request.action, 'list'); readCount++;
  if (fail) throw new Error('Fixture offline');
  const other = request.timeMin.startsWith('2026-11-02');
  return { events: [{ id: other ? 'next' : 'fixture', summary: other ? 'Deuxième période' : '<img src=x onerror=alert(1)> Réunion',
    status: 'confirmed', location: 'Salle A', start: { dateTime: '2026-11-01T01:30:00-04:00' }, end: { dateTime: '2026-11-01T01:30:00-05:00' } },
    { id: 'day', summary: 'Journée entière', start: { date: other ? '2026-11-02' : '2026-11-01' }, end: { date: '2026-11-03' } }],
    ...(other ? { nextPageToken: 'fixture-cursor' } : {}) };
} }) };
registerCalendarRoutes({ app, calendar, env: { PLANNING_TIME_ZONE: 'America/Toronto' } });
app.use('/assets/household', express.static(path.join(root, 'surfaces/household/public')));
app.use('/js', express.static(path.join(root, 'public/js')));
app.use('/css', express.static(path.join(root, 'public/css')));
app.get('/panel', (_req, res) => res.type('html').send('<h1>Family fixture</h1>'));
app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/dompurify/dist/purify.min.js')));
app.post('/selected-context', (req, res) => res.json(presentationEvidence(req.body, catalog)));
app.get('/fixture.js', (_req, res) => res.type('js').send(`
  AgentXScreenPages.configure(${JSON.stringify(catalog.entries)});
  window.board = DisplayBoard.createScreen({text:document.getElementById('text'),visual:document.getElementById('visual')},{space:'personal',secrets:false});
`));
app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nestor agenda</title>
<link rel="stylesheet" href="/assets/household/display-board.css"><link rel="stylesheet" href="/assets/household/page-presentation.css">
<script defer src="/vendor/marked.js"></script><script defer src="/vendor/purify.js"></script><script defer src="/js/presentation-markdown.js"></script><script defer src="/js/screen-pages.js"></script>
<script defer src="/assets/household/presentation-observation.js"></script><script defer src="/assets/household/page-presentation.js"></script><script defer src="/assets/household/display-board.js"></script><script defer src="/fixture.js"></script></head>
<body><main id="app"><h1>Nestor et mon agenda</h1><div class="conversation-layout"><section><textarea aria-label="Message">Conversation disponible</textarea><section id="visual"></section><section id="text"></section></section></div></main></body></html>`));

(async () => {
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const show = () => page.evaluate(() => board.add({ kind: 'page', title: 'Agenda', body: 'personal-calendar start=2026-11-01 end=2026-11-03' }));
    const ready = () => page.waitForFunction(() => board.context()[0]?.read?.source === 'calendar.primary' && board.context()[0]?.status === 'visible');
    const context = () => page.evaluate(async () => (await fetch('/selected-context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(board.context()) })).json());
    await show(); await ready();
    let selected = await context();
    assert.equal(selected.read.events[0].id, 'fixture');
    assert.equal(selected.read.filters.start, '2026-11-01');
    const frame = page.frameLocator('iframe');
    assert.equal(await frame.locator('#calendar-events img').count(), 0, 'calendar text is never executable HTML');
    assert.match(await frame.locator('#calendar-events').innerText(), /journée entière, fin exclue/);
    const clock = await frame.locator('#calendar-events li').first().innerText();
    assert.match(clock, /UTC.4/); assert.match(clock, /UTC.5/, 'the repeated 01:30 retains its two UTC offsets');
    const reads = readCount;
    await page.locator('[data-action=toggle]').click();
    assert.equal((await page.evaluate(() => board.context())).length, 0);
    await page.locator('[data-action=toggle]').click();
    await ready(); assert.equal(readCount, reads, 'retained page selection does not repeat Google reads');
    await page.screenshot({ path: path.join(reportDir, 'agenda-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await frame.locator('body').evaluate(el => el.scrollWidth > innerWidth + 1), false);
    assert.equal(await page.locator('textarea').isVisible(), true);
    await frame.locator('input[name=start]').fill('2026-11-02');
    await frame.locator('button').click();
    await page.waitForFunction(() => board.context()[0]?.filters?.start === '2026-11-02');
    selected = await context(); assert.equal(selected.read.events[0].id, 'next');
    assert.equal(selected.read.coverage.hasMore, true);
    assert.match(await frame.locator('#calendar-coverage').innerText(), /partielle/);
    await page.screenshot({ path: path.join(reportDir, 'agenda-mobile.png'), fullPage: true });
    fail = true; await frame.locator('button').click();
    await page.waitForFunction(() => board.context()[0]?.status === 'unavailable');
    assert.equal((await context()).read, undefined);
    assert.equal(await frame.locator('#calendar-events li').count(), 0);
    fail = false; await frame.locator('button').click(); await ready();
    assert.equal((await context()).read.events[0].id, 'next');
    fixtureUnlock = new Date(Date.now() + 2500).toISOString();
    await page.goto(`http://127.0.0.1:${server.address().port}/dad/calendar?start=2026-11-01`);
    assert.equal(await page.locator('.family-unlock-banner').isVisible(), true);
    await page.waitForURL('**/panel', { timeout: 10000 });
    assert.equal(await page.locator('#calendar-events').count(), 0, 'unlock expiry leaves the private agenda');
    fixtureUnlock = null;
    assert.deepEqual(errors, []);
    const result = { ok: true, checks: ['real calendar service and selected Nestor board', 'same snapshot and local dates',
      'untrusted event text', 'retained frame without repeat', 'desktop and mobile layout', 'changed period and partial coverage',
      'unavailable clears stale data and recovers', 'DST clock offsets', 'native unlock banner and expiry redirect'], providerReads: readCount, liveModels: 0, errors };
    fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
