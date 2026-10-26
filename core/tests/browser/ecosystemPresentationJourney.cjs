'use strict';
// Actual Core presentation components + actual GraphysX embed, served on loopback.
// The conversational provider is deliberately simulated. No native model or domain action.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const express = require('express');
const { presentationEvidence, screenContext } = require('../../surfaces/household/screen-context');
const { presentationReader } = require('../../src/services/presentationReadService');
const { createReplyChannels, contract } = require('../../surfaces/household/reply-channels');
const { screenDestinations } = require('../../../shared/screenDestinations');
const { screenPolicy, requestsScreenVisit } = require('../../surfaces/household/screen-services');
const catalog = require('../../public/js/screen-pages').createCatalog(screenDestinations({ agentxProfile: 'full' }));
const core = path.resolve(__dirname, '../..');
const modulePath = process.env.DISKX_TEST_MODULE;
const reportDir = process.env.ECOSYSTEM_BROWSER_REPORT;
if (!modulePath || !reportDir) throw new Error('DISKX_TEST_MODULE and ECOSYSTEM_BROWSER_REPORT are required');
fs.mkdirSync(reportDir, { recursive: true });
const FIRST = 'Montre-moi où passent les données', SECOND = 'Et ce composant sert à quoi ?';
const turns = [];
const app = express(); app.use(express.json()); app.use(screenPolicy(catalog));
app.use('/diskx', (_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; img-src 'self' data: blob:"); next();
});
require('../../surfaces/diskx').register({ app, express, env: { DISKX_MODULE_URL: 'https://assets.example/embed/diskx.js' },
  fetchData: () => assert.fail('The ecosystem visit must not read or change the datalake'),
  fetchWithTimeout: async () => ({ ok: true, headers: new Map([['content-type', 'text/javascript']]), text: async () => fs.readFileSync(modulePath, 'utf8') }) });
app.post('/fixture-turn', (req, res) => {
  const evidence = presentationEvidence(req.body.screen, catalog);
  const context = screenContext(req.body.screen, catalog, evidence);
  let answer;
  if (req.body.text === FIRST) {
    assert.equal(requestsScreenVisit(req.body.text, catalog), true);
    answer = 'Je t’ouvre le parcours des données.<show kind="page" title="Visite de l’écosystème">ecosystem play=overview,memory,garage</show>';
  } else {
    assert.equal(req.body.text, SECOND);
    assert.match(contract({ pages: true, pageCatalog: catalog }), /ambiguous or absent, ask which component/);
    if (evidence?.read?.status !== 'available') answer = 'La vue doit être actualisée avant de décrire ce composant.';
    else if (evidence.selection.status !== 'selected') answer = 'Quel composant désignes-tu ?';
    else answer = evidence.selection.description;
  }
  const channels = createReplyChannels({ allowPages: true, pageCatalog: catalog }); channels.push(answer);
  const result = channels.end();
  turns.push({ inputText: req.body.text, context, presentationContext: evidence, result, provider: 'simulated' });
  res.json(result);
});
app.use('/assets/household', express.static(path.join(core, 'surfaces/household/public')));
app.use('/js', express.static(path.join(core, 'public/js')));
app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(core, 'node_modules/marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.join(core, 'node_modules/dompurify/dist/purify.min.js')));
app.get('/', (_req, res) => res.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nestor · visite accompagnée (conversation simulée)</title><link rel="stylesheet" href="/assets/household/display-board.css"><link rel="stylesheet" href="/assets/household/page-presentation.css">
<style>:root{--line:#24414a;--panel:#10242c;--panel-2:#15313a;--cyan:#68dedb;--soft:#b2ccd3;color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:16px;background:#07181e;color:#edf7fb;font:16px system-ui}.conversation-layout{display:grid;gap:12px}textarea{width:100%;min-height:60px}button,select,textarea{font:inherit;background:#10242c;color:inherit;border:1px solid #34535d;padding:8px}.page-presentation-board iframe{min-height:620px}</style>
<main id="app"><h1>Nestor · visite accompagnée</h1><p>Conversation simulée · composants Core et GraphysX réels · données de présentation datées</p><div class="conversation-layout"><section><div id="answer" role="status"></div><form id="form"><textarea id="message" aria-label="Message"></textarea><button>Envoyer</button></form><section id="visual"></section><section id="text"></section></section></div></main>
<script src="/vendor/marked.js"></script><script src="/vendor/purify.js"></script><script src="/js/presentation-markdown.js"></script><script src="/js/screen-pages.js"></script>
<script src="/assets/household/presentation-observation.js"></script><script src="/assets/household/page-presentation.js"></script><script src="/assets/household/display-board.js"></script>
<script>AgentXScreenPages.configure(${JSON.stringify(catalog.entries)});window.board=DisplayBoard.createScreen({text:document.getElementById('text'),visual:document.getElementById('visual')},{space:'personal',secrets:false});document.getElementById('form').addEventListener('submit',async event=>{event.preventDefault();const result=await fetch('/fixture-turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:document.getElementById('message').value,screen:board.context()})}).then(r=>r.json());document.getElementById('answer').textContent=result.say;for(const block of result.display)board.add(block);});</script></html>`));

(async () => {
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch({ headless: true, ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], requests = [], httpErrors = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) httpErrors.push({ url: response.url(), status: response.status() }); });
    await page.route('**/*', route => {
      requests.push(route.request().method() + ' ' + route.request().url());
      return new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
    });
    await page.goto(origin);
    const send = async text => { await page.getByRole('textbox', { name: 'Message' }).fill(text); await page.getByRole('button', { name: 'Envoyer', exact: true }).click(); };
    await send(FIRST);
    await page.waitForFunction(() => board.context()[0]?.observation?.application === 'ecosystem');
    const frame = page.frames().find(frame => new URL(frame.url()).pathname === '/diskx');
    assert.ok(frame, 'the existing Core DiskX page carries the tour beside the conversation');
    await frame.evaluate(() => { const view = document.querySelector('agentx-ecosystem'); view.tour.pause(); view.tour.goto(1); });
    await frame.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.presentation.tour.kind === 'memory');
    const workflow = presentationEvidence(await page.evaluate(() => board.context()), catalog);
    assert.equal(workflow.read.source, 'graphysx.ecosystem'); assert.equal(workflow.selection.status, 'ambiguous');
    assert.equal(workflow.selection.clarificationRequired, true);
    await page.screenshot({ path: path.join(reportDir, 'data-flow-opened.png'), fullPage: true });
    console.log('PASS: first simulated turn opens the real tour, with fresh versioned data-flow observation');

    await frame.evaluate(() => document.querySelector('agentx-ecosystem').tour.goto(0));
    await frame.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.presentation.tour.kind === 'overview');
    const state = await frame.evaluate(() => document.querySelector('agentx-ecosystem').state());
    const node = state.nodes.find(node => node.kind === 'host' && node.screen);
    assert.ok(node, 'a rendered host is available to select');
    await page.locator('iframe').scrollIntoViewIfNeeded();
    const box = await page.locator('iframe').boundingBox();
    await page.mouse.click(box.x + node.screen[0], box.y + node.screen[1]);
    await frame.waitForFunction(id => document.querySelector('agentx-ecosystem').state()?.presentation.selection?.id === id, node.id);
    const selected = presentationEvidence(await page.evaluate(() => board.context()), catalog);
    assert.equal(selected.selection.id, node.id); assert.equal(selected.scene.adhoc, 'node-' + node.id);
    assert.equal(selected.instance, workflow.instance); assert.equal(selected.version, workflow.version);
    assert.equal(presentationReader.read(workflow.read).status, 'unavailable', 'the previous frame is no longer current');
    await send(SECOND);
    await page.waitForFunction(() => document.getElementById('answer').textContent.includes('Rôles :'));
    assert.equal(turns.length, 2); assert.equal(turns[1].presentationContext.selection.id, node.id);
    assert.equal(turns[1].presentationContext.instance, selected.instance);
    assert.match(turns[1].context, /browser_after_render/);
    assert.ok(turns[1].result.say.includes(node.name));
    assert.doesNotMatch(turns[1].result.say, /<say>/, 'the fixture uses the real plain-speech/show-block protocol');
    await page.screenshot({ path: path.join(reportDir, 'selected-component-followup.png'), fullPage: true });
    console.log('PASS: real 3D selection supplies the component, instance, step and version to the second simulated turn');

    const stale = await page.evaluate(() => board.context());
    stale[0].observation.observedAt = new Date(Date.now() - 31_000).toISOString();
    assert.equal(presentationEvidence(stale, catalog).status, 'unavailable');
    const wrongVersion = await page.evaluate(() => board.context());
    wrongVersion[0].observation.version = 'b'.repeat(64);
    assert.equal(presentationEvidence(wrongVersion, catalog).read.reason, 'display_version_mismatch');
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.getByRole('textbox', { name: 'Message' }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(reportDir, 'nestor-ecosystem-mobile.png'), fullPage: true });
    // Separate ambiguity branch: a workflow has several candidates, so the simulated
    // provider asks for a referent instead of reusing the preceding selected component.
    await frame.evaluate(() => document.querySelector('agentx-ecosystem').tour.goto(1));
    await frame.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.presentation.tour.kind === 'memory');
    await send(SECOND);
    await page.waitForFunction(() => document.getElementById('answer').textContent === 'Quel composant désignes-tu ?');
    assert.equal(turns[2].presentationContext.selection.status, 'ambiguous');
    assert.equal(turns[2].presentationContext.selection.clarificationRequired, true);
    assert.equal(turns[2].presentationContext.selection.id, undefined);
    await page.screenshot({ path: path.join(reportDir, 'ambiguous-component-clarification.png'), fullPage: true });
    await page.locator('[data-action="toggle"]').click();
    assert.equal((await page.evaluate(() => board.context())).length, 0);
    assert.equal(requests.some(value => /\/api\/data-toolbox|\/diskx-api\//.test(value)), false);
    assert.deepEqual(errors, []); assert.deepEqual(httpErrors, []);
    const result = { ok: true, scope: 'loopback interface with simulated conversation provider; actual Core and GraphysX components',
      nativeModelCalls: 0, actualDeployedInterface: false, sourceVersion: selected.version, displayedInstance: selected.instance,
      moduleSha256: crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex'),
      checks: ['request opens tour', 'after-render observation', 'ambiguous follow-up asks for clarification', 'real 3D node selection',
        'two simulated conversational turns', 'expired observation refusal', 'version mismatch refusal', 'mobile conversation retained', 'closure clears current selection', 'no datalake or external request'], errors, httpErrors };
    fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(reportDir, 'simulated-turns.json'), JSON.stringify(turns, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true }).catch(() => {});
      const frames = await Promise.all(page.frames().map(frame => frame.evaluate(() => ({ url: location.href,
        body: document.body?.innerText.slice(0, 4000), presented: window.AgentXPresentedContent,
        state: document.querySelector('agentx-ecosystem')?.state?.() })).catch(error => ({ error: error.message }))));
      fs.writeFileSync(path.join(reportDir, 'failure.json'), JSON.stringify({ errors, httpErrors, requests, frames }, null, 2));
    }
    throw error;
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
