'use strict';
// Production Core page/board/workflow modules + the built GraphysX embed, synthetic GET data.
// No native instance, inference, scan or business mutation. Evidence is written outside Git.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const express = require('../../node_modules/express');
const { chromium } = require('playwright');
const { renderPage, checkQuery } = require('../../surfaces/diskx');
const graph = process.env.GRAPHYSX_CHECKOUT;
const output = process.env.PRESENTATIONS_REPORT_DIR;
if (!graph || !output || path.resolve(output).startsWith(path.resolve(__dirname, '../../..') + path.sep)) {
  throw new Error('Set GRAPHYSX_CHECKOUT (built embed) and PRESENTATIONS_REPORT_DIR (outside Git).');
}
const SHA = 'c'.repeat(64), DATE = '2026-01-01T00:00:00Z';
const publicDir = path.resolve(__dirname, '../../surfaces/household/public');
const app = express();
app.use('/assets/household', express.static(publicDir));
app.use('/assets/diskx', express.static(path.resolve(__dirname, '../../surfaces/diskx/public')));
app.use('/js', express.static(path.resolve(__dirname, '../../public/js')));
app.get('/api/diskx/diskx.js', (_req, res) => res.sendFile(path.resolve(graph, 'dist/embed/diskx.js')));
app.get('/diskx', (req, res) => res.type('html').send(renderPage({ roots: ['/data'], attributes: checkQuery(req.query, ['/data']) })));
const ok = data => ({ ok: true, status: 'success', data });
app.get('/api/data-toolbox/:area/*', (req, res) => {
  const name = req.params.area + '/' + req.params[0];
  if (name === 'storage/summary') return res.json(ok({ totalFiles: 30, totalSize: 3000, lastScan: { finished_at: DATE } }));
  if (name === 'storage/tree') return res.json(ok({ truncated: false, tree: ['a', 'b', 'c'].map(x => ({ path: `/data/${x}`, fileCount: 10, totalSize: 1000 })) }));
  if (name === 'storage/files') return res.json(ok({ files: [] }));
  if (name === 'janitor/strategy/latest') return res.json(ok({ generatedAt: DATE, status: 'ready_for_review',
    summary: { verifiedGroups: 1, provenSavingsBytes: 100, candidateGroups: 0, candidateBytes: 0, filesToHash: 0, bytesToHash: 0, executableActions: 0 } }));
  if (name === 'janitor/strategy/latest/groups') return res.json(ok({ report: { id: 'fixture-report', generatedAt: DATE, status: 'ready_for_review' }, total: 1, offset: 0, limit: 20, nextOffset: null,
    groups: [{ sha256: SHA, proof: 'sha256-current-metadata', size: 100, count: 2, provenSavingsBytes: 100, filesOmitted: 0, policySurvivorPath: '/data/a/x.bin', review: null,
      files: [{ path: '/data/a/x.bin' }, { path: '/data/c/x.bin' }] }] }));
  res.status(404).json({ ok: false });
});
app.get('/api/diskx/presentation', (_req, res) => res.json(ok({ read: { id: 'fixture-read', revision: '1' }, filters: {} })));
app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/household/app.css"><link rel="stylesheet" href="/assets/household/avatar-dock.css"><link rel="stylesheet" href="/assets/household/nestor-progress.css">
<style>body{margin:0}#app{padding:8px}#board iframe{width:100%;height:65dvh;min-height:360px;border:0}.display-block{margin:0}.avatar-scene-bar{bottom:12px}body[data-avatar-view=menu] .avatar-scene-bar{display:none}.fixture-face{width:72px;height:72px;border-radius:50%;background:#52cfc5;margin:auto}.display-block-header{display:flex;flex-wrap:wrap;gap:6px}</style>
</head><body data-avatar-view="menu"><main id="app"><div class="fixture-face" aria-label="Avatar"></div><div id="badge" hidden></div><textarea aria-label="Conversation">La conversation reste accessible.</textarea><section id="board"></section><section id="workflow" hidden></section></main>
<div class="avatar-scene-bar"><div class="avatar-scene-actions"><button>Conversation</button></div></div>
${['journey-timings','nestor-progress','workflow-panel'].map(x => `<script src="/assets/household/${x}.js"></script>`).join('')}
<script src="/js/screen-pages.js"></script><script src="/assets/household/display-board.js"></script>
<script>
AgentXScreenPages.configure([{id:'diskx',label:'DiskX',href:'/diskx?janitor=latest',mode:'frame'},{id:'ecosystem',label:'Écosystème',href:'/diskx?app=ecosystem',mode:'frame'}]);
const progress=NestorProgress.create({host:document.querySelector('#badge'),getLanguage:()=> 'fr'});
window.workflow=NestorWorkflow.create({host:document.querySelector('#workflow'),onSnapshot:view=>progress.update(view)});
window.board=DisplayBoard.create(document.querySelector('#board'),{space:'personal'});
window.run=kind=>{workflow.begin('fixture-session',kind,'text');workflow.stream(kind,{type:'accepted'});
workflow.stream(kind,{type:'status',phase:'activity',activity:{kind:'processing'}});
workflow.stream(kind,{type:'status',phase:'activity',activity:{kind:'tool',tool:'fixture_read'}});};
window.show=kind=>{workflow.stream(kind,{type:'status',phase:'activity',activity:{kind:'tool_result',tool:'fixture_read',status:'completed'}});
board.add({kind:'page',body:kind==='diskx'?'diskx janitor=latest group=${SHA}':'ecosystem play=overview,watch',title:kind});
workflow.stream(kind,{type:'done',data:{}});};
</script></body></html>`));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { acquireVerifyLock, machineVerifyLockPath } = await import(pathToFileURL(path.resolve(graph, 'scripts/verify-guard.mjs')));
  const release = await acquireVerifyLock(machineVerifyLockPath());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const results = [], errors = [], requests = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_CHROMIUM || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 1600, height: 1000 }]) {
      for (const kind of ['diskx', 'ecosystem']) {
        console.log('journey', kind, viewport.width);
        const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
        page.setDefaultTimeout(45000);
        page.on('pageerror', e => errors.push(String(e)));
        page.on('request', req => requests.push({ method: req.method(), path: new URL(req.url()).pathname }));
        await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
        await page.goto(base + '/fixture');
        await page.evaluate(kind => window.run(kind), kind);
        // Keep one real browser turn alive beyond the badge threshold. No inference is launched.
        await page.locator('#badge summary').waitFor({ state: 'visible' });
        assert.match(await page.locator('#badge summary').textContent(), /Outil en cours/);
        assert.ok(!(await page.locator('#badge summary').textContent()).includes('restantes'));
        await page.getByRole('textbox', { name: 'Conversation' }).fill('Toujours utilisable');
        if (viewport.width === 390 && kind === 'diskx') {
          for (const mode of ['plein', 'montre', 'menu']) {
            await page.evaluate(mode => { document.body.dataset.avatarView = mode; }, mode);
            await page.waitForFunction(mode => document.querySelector('#badge').parentNode.classList.contains('avatar-scene-bar') === (mode !== 'menu'), mode);
            const badge = await page.locator('#badge').boundingBox();
            assert.ok(badge && badge.x >= 0 && badge.x + badge.width <= viewport.width && badge.y + badge.height <= viewport.height);
            await page.screenshot({ path: path.join(output, `badge-${mode}.png`) });
          }
        }
        await page.evaluate(kind => window.show(kind), kind);
        assert.match(await page.locator('#badge summary').textContent(), /Terminé/);
        await page.locator('iframe').waitFor();
        const frame = await page.locator('iframe').elementHandle().then(el => el.contentFrame());
        await frame.waitForURL('**/diskx?**');
        await frame.waitForFunction(() => AgentXJourneyTimings.snapshot().presentations.some(p => Number.isFinite(p.firstFrameAt)));
        const surface = frame.locator(kind === 'diskx' ? '.gx-diskx' : '.gx-eco');
        const panel = surface.locator(kind === 'diskx' ? '.gx-diskx-panel' : '.gx-eco-nestor');
        const disclosure = panel.locator('> details');
        await page.locator('iframe').scrollIntoViewIfNeeded();

        const toolbar = await surface.locator(kind === 'diskx' ? '.gx-diskx-show' : '.gx-eco-tour').boundingBox();
        const panelBox = await panel.boundingBox();
        const frameViewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.equal(await disclosure.getAttribute('open') !== null, frameViewport.width > 820, 'disclosure follows available frame width');
        // boundingBox includes the iframe offset; compare positions in the child document.
        const layout = await frame.evaluate(kind => {
          const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom }; };
          return { panel:box(kind==='diskx'?'.gx-diskx-panel':'.gx-eco-nestor'), toolbar:box(kind==='diskx'?'.gx-diskx-show':'.gx-eco-tour'), header:box(kind==='diskx'?'.gx-diskx-header':'.gx-eco-header') };
        }, kind);
        await page.locator("iframe").screenshot({ path: path.join(output, `${kind}-${viewport.width}-initial.png`) });
        console.log("layout", JSON.stringify(layout));
        if (frameViewport.width <= 820) {
          assert.ok(layout.panel.height <= 60, JSON.stringify(layout));
          assert.ok(layout.toolbar.bottom <= frameViewport.height && layout.toolbar.y >= 0, JSON.stringify(layout));
          assert.ok(layout.panel.bottom <= layout.toolbar.y, 'closed details do not cover player');
          assert.ok((layout.panel.y - layout.header.bottom) / frameViewport.height >= 0.5, `at least half the view stays clear: ${JSON.stringify(layout)}`);
          await disclosure.locator('> summary').click(); assert.equal(await disclosure.getAttribute('open'), '');
          await frame.locator('body').screenshot({ path: path.join(output, `${kind}-${viewport.width}-details.png`) });
          await disclosure.locator('> summary').focus();
          await disclosure.locator('> summary').press('Space');
          assert.equal(await disclosure.getAttribute('open'), null, 'Space closes native details without a tour shortcut');
        }
        await frame.locator('body').screenshot({ path: path.join(output, `${kind}-${viewport.width}.png`) });
        if (kind === 'ecosystem') {
          await frame.getByRole('button', { name: 'Surveillance & points ouverts', exact: true }).click();
          await frame.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.tour.kind === 'watch');
        } else {
          const state = await frame.evaluate(() => document.querySelector('diskx-city').state());
          assert.equal(state.janitor.group.sha256, SHA.slice(0, 12), 'the renderer exposes its intentionally abbreviated hash');
          assert.equal(await frame.evaluate(() => AgentXPresentedContent.selection.group), SHA, 'Core retains the exact displayed group identity');
        }
        const timing = await page.evaluate(() => AgentXJourneyTimings.snapshot());
        assert.equal(timing.presentations.length, 1);
        assert.ok(timing.presentations[0].openingToFirstFrameMs >= 0);
        results.push({ kind, viewport, frameViewport, layout, timing, toolbar, panelBox });
        await page.evaluate(kind => { workflow.begin('fixture-session', kind + '-failure', 'text'); workflow.stream(kind + '-failure', { type: 'error' }); }, kind);
        assert.match(await page.locator('#badge summary').textContent(), /Erreur/);
        if (kind === 'ecosystem' && viewport.width === 1600) {
          await page.evaluate(() => { document.body.dataset.avatarView = 'plein'; });
          await page.waitForFunction(() => document.querySelector('#badge').parentNode.classList.contains('avatar-scene-bar'));
          await page.evaluate(() => document.querySelector('#app').remove());
          await page.waitForFunction(() => !document.querySelector('#badge'));
        }
        await page.close();
      }
    }
    assert.deepEqual(errors, []);
    assert.ok(requests.every(req => req.method === 'GET'), 'all fixture and presentation reads remain GET-only');
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ scope: 'local fixtures; browser and software WebGL; no live Nestor', results, errors, requests }, null, 2));
    console.log(`PASS: ${results.length} composed journeys; mobile disclosure, badge states, timings, GET-only data`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await release(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
