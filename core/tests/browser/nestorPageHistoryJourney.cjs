'use strict';
// Actual Nestor mount/resume, publicAudit, catalogue and workspace. Synthetic
// canonical receipts and loopback domain pages; no model, microphone or LAN.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const { publicAudit } = require('../../surfaces/household/persona-records');
const { createPresentationReader } = require('../../src/services/presentationReadService');
const output = process.env.PAGE_HISTORY_REPORT_DIR || '/tmp/agentx-page-history-924';
assert.ok(!path.resolve(output).startsWith(path.resolve(core, '..') + path.sep)); fs.mkdirSync(output, { recursive: true });
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const selected = personas.find(row => row.id === 'nestor') || personas[0];
const session = { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', packId: 'personal_operator', scopeId: 'personal',
  backend: 'agentx', agentId: 'main', persona: selected, voice: { language: 'fr' }, status: 'active', label: 'Saved synthetic', turnCount: 3 };
const other = { ...session, sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'Other synthetic', turnCount: 0 };
let at = Date.parse('2026-01-02T00:00:00Z');
const reader = createPresentationReader({ now: () => at });
function summary(calls) { return { source: 'inferencelogs', window: { key: '24h', from: new Date(at - 86400000), to: new Date(at) },
  totals: { calls, errors: 0, avgLatencyMs: null }, byModel: [], byBucket: [] }; }
const ref = reader.publishAnalytics(summary(42)), savedRead = reader.read(ref);
at += 360000;
assert.equal(reader.read(ref).status, 'unavailable', 'the live cache no longer retains the saved receipt');
const turns = [
  { clientTurnId: 'saved-analytics', createdAt: '2026-01-02T00:01:00Z', inputText: 'Read the earlier page', replyText: 'Earlier answer',
    presentationContext: { contract: 'agentx.presentation/v1', kind: 'page', page: 'analytics', status: 'visible', title: 'Earlier activity', read: savedRead },
    display: [{ id: 'old-analytics', kind: 'page', title: 'Earlier activity', body: 'analytics' }] },
  { clientTurnId: 'legacy-profiler', replyText: 'Earlier proposal', display: [{ id: 'old-profiler', kind: 'page', title: 'Earlier profiler', body: 'profiler' },
    { id: 'invalid', kind: 'page', title: 'Invalid', body: 'https://arbitrary.test/page' }] },
  { clientTurnId: 'legacy-pipeline', replyText: 'Earlier proposal', display: [{ id: 'old-pipeline', kind: 'page', title: 'Earlier pipeline', body: 'pipeline' }] }
];
let browser, server, base, failProfiler = false;
const requests = [], errors = [];
const pageRequests = () => requests.filter(row => ['/analytics', '/benchmark/profiler', '/pipeline'].includes(row.path)).length;
(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { requests.push({ method: req.method, path: req.path }); next(); });
  app.use('/assets/household', express.static(publicDir)); app.use('/js', express.static(core + '/public/js')); app.use('/css', express.static(core + '/public/css'));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/fixture', (_req, res) => res.type('html').send(fs.readFileSync(publicDir + '/index.html', 'utf8')
    .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>').replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '')
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', async () => {
      window.AvatarDock=undefined;
      const api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const body=await response.json();if(!response.ok)throw Error(body.message||'Unavailable');if(url.endsWith('/history'))window.savedHistory=body.data;return body.data;};
      try{await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),autoStart:false});window.fixtureReady=true;}catch(error){window.fixtureError=error.stack;}
    });</script></body>`)));
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'agentx', openclawConfigured: false, hermesConfigured: false } } }));
  app.get('/api/photos/frame/status', (_req, res) => res.json({ data: { enabled: false } }));
  app.get('/api/voice-personas/private/screen-pages', (_req, res) => res.json({ data: { destinations: [
    { id: 'analytics', label: 'Activity', href: '/analytics', mode: 'frame' }, { id: 'profiler', label: 'Profiler', href: '/benchmark/profiler', mode: 'frame' },
    { id: 'pipeline', label: 'Pipeline', href: '/pipeline', mode: 'frame' }] } }));
  app.get('/api/voice-personas/private/sessions/recent', (_req, res) => res.json({ data: { sessions: [session, other] } }));
  app.get('/api/voice-personas/private/sessions/:id/history', (req, res) => {
    if (![session.sessionId, other.sessionId].includes(req.params.id)) return res.status(404).json({ message: 'Unknown scoped conversation' });
    res.json({ data: { session: req.params.id === session.sessionId ? session : other,
      turns: req.params.id === session.sessionId ? turns.map(publicAudit) : [], policy: { maximumDisplayedTurns: 500 } } });
  });
  app.get('/analytics', (_req, res) => {
    const current = reader.publishAnalytics(summary(99));
    res.send(`<title>Current activity</title><h1>New current observation</h1><script>window.AgentXPresentedContent=${JSON.stringify({ contract: 'agentx.presentation/v1', state: 'ready', read: current, filters: { window: '24h' } })}</script>`);
  });
  app.get('/benchmark/profiler', (_req, res) => res.send(`<title>Profiler</title><h1>Profiler</h1><p>Current read unavailable</p><script>window.AgentXPresentedContent={contract:'agentx.presentation/v1',state:${JSON.stringify(failProfiler ? 'unavailable' : 'ready')}}</script>`));
  app.get('/pipeline', (_req, res) => res.send('<h1>Pipeline</h1>'));
  app.get('/stored-image.svg', (_req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="teal"/></svg>'));
  app.use('/api', (req, res) => {
    if (/\/turns|infer|generate|dispatch/.test(req.path)) return res.status(500).json({ message: 'Forbidden model or action fixture' });
    if (req.path.endsWith('/recap/latest')) return res.json({ data: null });
    res.json({ data: { destinations: [], sessions: [], works: [], notes: [], blocks: [], active: 'primary', phrases: [], revision: 0 } });
  });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  turns[2].display.push({ id: 'old-image', kind: 'image', source: 'web', status: 'found', body: 'Synthetic earlier image',
    image: { url: base + '/stored-image.svg', sourceLabel: 'Stored synthetic asset' } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
  const ready = async () => { await page.waitForFunction(() => window.fixtureReady || window.fixtureError); assert.equal(await page.evaluate(() => window.fixtureError), undefined); };
  const resume = async label => {
    await page.locator('#conversationHistoryToggle').click();
    await page.locator('.conversation-history-item').filter({ hasText: label }).click();
    await page.waitForFunction(() => document.querySelector('#conversationStatus')?.textContent !== 'Loading the conversation…');
  };
  const observe = () => page.evaluate(() => {
    const card = document.querySelector('.page-presentation .display-block[data-selected="true"]');
    return card ? AgentXPresentationObservation.observe(card) : null;
  });
  await page.goto(base + '/fixture'); await ready(); await resume('Saved synthetic');
  const original = JSON.stringify(turns), returned = await page.evaluate(() => JSON.stringify(savedHistory));
  assert.equal(await page.locator('.display-page-history').count(), 3);
  await page.waitForFunction(() => document.querySelector('.display-block img')?.naturalWidth > 0);
  assert.equal(await page.locator('.display-block img').getAttribute('src'), base + '/stored-image.svg', 'images reuse their retained asset, never a new creation');
  assert.equal(await page.locator('iframe').count(), 0); assert.equal(pageRequests(), 0);
  for (const command of ['Agrandis', 'Ferme', 'Réaffiche']) {
    await page.locator('#conversationMessage').fill(command);
    await page.locator('#conversationText button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#conversationMessage').value === '');
  }
  assert.equal(pageRequests(), 0, 'local display commands never load a historical page');
  const historical = page.locator('.display-block').filter({ hasText: 'Historique · Earlier activity' });
  await historical.locator('summary').click();
  assert.match(await historical.locator('pre').innerText(), /"calls": 42/);
  assert.match(await historical.locator('pre').innerText(), /2026-01-02T00:05:00.000Z/);
  for (const index of ['0', '2', '1', '2']) await page.locator('.page-presentation select').selectOption(index);
  assert.equal(pageRequests(), 0, 'rapid historical selection performs no page read');
  assert.equal((await observe()).observation, 'historical_reference'); assert.equal((await observe()).read, undefined);
  await historical.getByRole('button', { name: 'Ouvrir la vue actuelle', exact: true }).click();
  await page.frameLocator('iframe').getByRole('heading', { name: 'New current observation' }).waitFor();
  const current = await observe();
  assert.equal(current.status, 'visible'); assert.notEqual(current.id, 'old-analytics'); assert.equal(reader.read(current.read).totals.calls, 99);
  assert.equal(pageRequests(), 1); assert.equal(await historical.locator('button').isDisabled(), true);
  assert.match(await historical.locator('pre').innerText(), /"calls": 42/);
  assert.equal(await page.evaluate(() => JSON.stringify(savedHistory)), returned); assert.equal(JSON.stringify(turns), original);
  assert.match(await page.locator('.display-block[data-selected="true"]').innerText(), /Vue actuelle demandée le/);
  await historical.locator('.display-block-title').click();
  assert.equal((await observe()).observation, 'historical_reference'); assert.equal((await observe()).read, undefined);
  assert.equal(pageRequests(), 1, 'selecting the old card cannot substitute the current frame read');
  failProfiler = true;
  const legacy = page.locator('.display-block').filter({ hasText: 'Historique · Earlier profiler' });
  assert.match(await legacy.innerText(), /Aucune observation conservée/);
  await legacy.getByRole('button', { name: 'Ouvrir la vue actuelle', exact: true }).click();
  await page.waitForFunction(() => AgentXPresentationObservation.observe(document.querySelector('.display-block[data-selected="true"]')).status === 'unavailable');
  assert.equal(pageRequests(), 2);
  await page.evaluate(() => AgentXScreenPages.configure(AgentXScreenPages.entries.filter(row => row.id !== 'pipeline')));
  const missing = page.locator('.display-block').filter({ hasText: 'Historique · Earlier pipeline' });
  await missing.getByRole('button', { name: 'Ouvrir la vue actuelle', exact: true }).click();
  assert.match(await missing.innerText(), /plus disponible/); assert.equal(pageRequests(), 2);
  await page.evaluate(() => { window.detachedOpen=document.querySelector('.display-page-history button'); });
  await resume('Other synthetic'); await page.evaluate(() => detachedOpen.click());
  assert.equal(await page.locator('iframe').count(), 0); assert.equal(pageRequests(), 2, 'detached history cannot cross into another conversation');
  await page.reload(); await ready(); await resume('Saved synthetic');
  assert.equal(await page.locator('iframe').count(), 0); assert.equal(pageRequests(), 2, 'reconnection starts from history again');
  await page.locator('.display-page-history summary').click();
  assert.match(await page.locator('.display-page-history pre').innerText(), /"calls": 42/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'history-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(row => /\/turns|infer|generate|dispatch|campaign/.test(row.path)).length, 0);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, pageRequests: pageRequests(), errors, requests }, null, 2));
  console.log(JSON.stringify({ ok: true, resumePageReads: 0, explicitPageReads: pageRequests(), localHistoryCommands: 3, modelOrDispatch: 0, output }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
