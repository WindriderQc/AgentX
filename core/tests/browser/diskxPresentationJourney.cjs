'use strict';
// Composes the real Core page, Nestor presentation components and a supplied
// GraphysX bundle. All domain data is synthetic; no model or native service.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { presentationEvidence } = require('../../surfaces/household/screen-context');
const { presentationReader } = require('../../src/services/presentationReadService');
const { readJanitorReportView } = require('../../src/services/janitorReportView');
const { screenDestinations } = require('../../../shared/screenDestinations');
const catalog = require('../../public/js/screen-pages').createCatalog(screenDestinations({ agentxProfile: 'full' }));
const { screenPolicy } = require('../../surfaces/household/screen-services');
const core = path.resolve(__dirname, '../..');
const modulePath = process.env.DISKX_TEST_MODULE;
if (!modulePath) throw new Error('DISKX_TEST_MODULE must name the built GraphysX embed');
const reportDir = process.env.DISKX_BROWSER_REPORT;
if (!reportDir) throw new Error('DISKX_BROWSER_REPORT must name an output directory');
fs.mkdirSync(reportDir, { recursive: true });
const SHA = 'a'.repeat(64), DATE = '2026-01-02T12:00:00.000Z', NEXT = '2026-01-02T13:00:00.000Z';
let currentDate = DATE;
const report = () => ({ generatedAt: currentDate, status: 'ready_for_review', policy: { duplicateSurvivor: 'newest' },
  evidence: { verifiedDuplicateGroups: 1, verifiedDuplicateFiles: 2, provenSavingsBytes: 100 } });
const groups = () => ({ report: { id: currentDate, generatedAt: currentDate, status: 'ready_for_review' },
  total: 1, offset: 0, limit: 20, nextOffset: null, scanBoundReached: false,
  groups: [{ sha256: SHA, proof: 'sha256-current-metadata', size: 100, count: 2, provenSavingsBytes: 100,
    filesOmitted: 0, policySurvivorPath: '/data/a/x.bin', review: null,
    files: [{ path: '/data/a/x.bin' }, { path: '/data/c/x.bin' }] }] });
const fetchData = async route => ({ response: { ok: true, status: 200 }, body: { data: route.endsWith('/groups') ? groups() : { report: report() } } });
const app = express(); app.use(express.json()); app.use(screenPolicy(catalog));
app.use('/diskx', (_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; img-src 'self' data: blob:"); next();
});
require('../../surfaces/diskx').register({ app, express, fetchData, env: { DISKX_ROOTS: '/data', DISKX_MODULE_URL: 'https://assets.example/embed/diskx.js' },
  fetchWithTimeout: async () => ({ ok: true, headers: new Map([['content-type', 'text/javascript']]), text: async () => fs.readFileSync(modulePath, 'utf8') }) });
app.get('/api/data-toolbox/storage/summary', (_req, res) => res.json({ status: 'success', data: { totalFiles: 30, totalSize: 3000, lastScan: { finished_at: DATE } } }));
app.get('/api/data-toolbox/storage/tree', (_req, res) => res.json({ status: 'success', data: { truncated: false,
  tree: ['a', 'b', 'c'].map(name => ({ path: '/data/' + name, fileCount: 10, totalSize: 1000 })) } }));
app.get('/api/data-toolbox/storage/files', (_req, res) => res.json({ status: 'success', data: { files: [] } }));
app.get('/api/data-toolbox/janitor/strategy/latest', (_req, res) => res.json({ status: 'success', data: {
  generatedAt: currentDate, status: 'ready_for_review', summary: { verifiedGroups: 1, provenSavingsBytes: 100,
    candidateGroups: 0, candidateBytes: 0, filesToHash: 0, bytesToHash: 0, executableActions: 0 } } }));
app.get('/api/data-toolbox/janitor/strategy/latest/groups', (_req, res) => res.json({ status: 'success', data: groups() }));
app.post('/selected-context', (req, res) => res.json(presentationEvidence(req.body, catalog)));
app.use('/assets/household', express.static(path.join(core, 'surfaces/household/public')));
app.use('/js', express.static(path.join(core, 'public/js')));
app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(core, 'node_modules/marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.join(core, 'node_modules/dompurify/dist/purify.min.js')));
app.get('/', (_req, res) => res.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nestor et DiskX</title><link rel="stylesheet" href="/assets/household/display-board.css"><link rel="stylesheet" href="/assets/household/page-presentation.css">
<style>:root{--line:#24414a;--panel:#10242c;--panel-2:#15313a;--cyan:#68dedb;--soft:#b2ccd3;color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:16px;background:#07181e;color:#edf7fb;font:16px system-ui}.conversation-layout{display:grid;gap:12px}textarea{width:100%;min-height:60px}button,select,textarea{font:inherit;background:#10242c;color:inherit;border:1px solid #34535d;padding:8px}.page-presentation-board iframe{min-height:620px}</style>
<main id="app"><h1>Nestor et DiskX</h1><div class="conversation-layout"><section><p>Explique-moi le groupe affiché.</p><textarea aria-label="Message">La conversation reste disponible.</textarea><section id="visual"></section><section id="text"></section></section></div></main>
<script src="/vendor/marked.js"></script><script src="/vendor/purify.js"></script><script src="/js/presentation-markdown.js"></script><script src="/js/screen-pages.js"></script>
<script src="/assets/household/presentation-observation.js"></script><script src="/assets/household/page-presentation.js"></script><script src="/assets/household/display-board.js"></script>
<script>AgentXScreenPages.configure(${JSON.stringify(catalog.entries)});window.board=DisplayBoard.createScreen({text:document.getElementById('text'),visual:document.getElementById('visual')},{space:'personal',secrets:false});</script></html>`));

(async () => {
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch({ headless: true, ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], requests = [], consoleErrors = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.route('**/*', route => {
      const request = route.request(); requests.push(request.method() + ' ' + request.url());
      return new URL(request.url()).origin === origin ? route.continue() : route.abort();
    });
    await page.goto(origin);
    const show = async () => {
      const result = await readJanitorReportView({ group: SHA }, { fetchData, env: {} });
      await page.evaluate(body => board.add({ kind: 'page', title: 'Rapport Janitor', body }), result.screenPage);
    };
    const context = async () => presentationEvidence(await page.evaluate(() => board.context()), catalog);
    const loaded = async () => page.waitForFunction(() => {
      const observed = board.context()[0]; return observed?.status === 'visible' && observed.filters?.group === 'a'.repeat(64) && observed.read?.source === 'janitor.report';
    }, null, { timeout: 30000 });
    await show(); await loaded();
    let current = await context();
    assert.equal(current.read.counts.verifiedGroups, 1); assert.equal(current.read.group.copies, 2);
    assert.equal(current.read.filters.report, DATE); assert.equal(current.read.physicalSpaceMeasured, false);
    await page.screenshot({ path: path.join(reportDir, 'diskx-nestor-desktop.png'), fullPage: true });
    const calls = requests.length;
    await page.locator('[data-action="toggle"]').click(); assert.equal((await context()).status, 'none');
    await page.locator('[data-action="toggle"]').click(); assert.equal((await context()).read.group.copies, 2);
    assert.equal(requests.length, calls, 'reopening the retained frame does not rerun its reads');
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await page.locator('textarea').isVisible(), true);
    await page.screenshot({ path: path.join(reportDir, 'diskx-nestor-mobile.png'), fullPage: true });
    currentDate = NEXT;
    await page.frameLocator('iframe').locator('[data-action="janitor-read"]').click();
    await page.waitForFunction(() => board.context()[0]?.status === 'unavailable');
    current = await context(); assert.equal(current.read, undefined);
    await show(); await loaded(); assert.equal((await context()).read.generatedAt, NEXT);
    assert.equal(requests.filter(value => /\/api\//.test(value) && !value.startsWith('GET ')).length, 0);
    assert.deepEqual(errors, []);
    const result = { ok: true, checks: ['real bundle and Core page', 'same-origin GET reads', 'selected group snapshot', 'close and reopen without replay', 'mobile layout', 'changed report refusal and fresh selection'], errors,
      moduleSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'), liveModels: 0 };
    fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true }).catch(() => {});
      const frames = await Promise.all(page.frames().map(frame => frame.evaluate(() => ({
        url: location.href, body: document.body?.innerText.slice(0, 4000), content: window.AgentXPresentedContent,
        state: document.querySelector('diskx-city')?.state?.()
      })).catch(cause => ({ error: cause.message }))));
      fs.writeFileSync(path.join(reportDir, 'failure.json'), JSON.stringify({ errors, consoleErrors, requests, frames }, null, 2));
    }
    throw error;
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
