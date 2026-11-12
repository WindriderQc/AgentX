'use strict';

// Actual conversation composer and sky renderer, synthetic Core snapshots and
// replies only. No live agent, model, microphone or household data is used.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createArtxService } = require('../../src/services/artxService');
const { artxContext } = require('../../surfaces/household/artx-context');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const report = process.env.ARTX_REPORT_DIR;
if (!report || path.resolve(report).startsWith(core + path.sep)) throw Error('Use ARTX_REPORT_DIR outside the checkout');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const artx = createArtxService({ ambient: { snapshot: async () => ({ at: new Date().toISOString(),
  weather: { kind: 'clear' }, sun: { elevationDeg: -20 }, paintings: [],
  sky: { sun: { altDeg: -20, azDeg: 250 }, moon: { altDeg: 40, azDeg: 180, name: 'croissant', illumination: 0.1 },
    planets: [{ id: 'saturn', name: 'Saturne', altDeg: 30, azDeg: 125, mag: 1, sunSeparationDeg: 100 }],
    planetPositions: [{ id: 'saturn', name: 'Saturne', altDeg: 30, azDeg: 125 },
      { id: 'jupiter', name: 'Jupiter', altDeg: -25, azDeg: 70 }], stars: [], figures: [] } }) },
  decide: async () => { throw Error('No idle inference in this fixture'); } });
const app = express(), sessions = new Map(), submissions = [], errors = [];
let browser, server;
app.use(express.json());
app.use('/assets/household', express.static(publicDir));
app.use('/js', express.static(path.join(core, 'public/js')));
app.use('/css', express.static(path.join(core, 'public/css')));
app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
app.get('/api/family/ambient', async (req, res) => res.json({ data: await artx.snapshot(req.query.displayId) }));
app.post('/api/family/ambient/activity', (req, res) => { artx.activity(req.body.displayId); res.json({ data: {} }); });
app.get('/fixture', (req, res) => {
  const space = req.query.space === 'family' ? 'family' : 'personal';
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
    .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>')
    .replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '')
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', async () => {
      const api=async(url,options={})=>{const r=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const b=await r.json();if(!r.ok)throw Error(b.message);return b.data};
      try { await mountConversation({app:document.getElementById('app'),api,esc:v=>String(v??''),space:${JSON.stringify(space)},autoStart:false});window.fixtureReady=true; }
      catch(e){window.fixtureError=e.stack;}
    });</script></body>`);
  res.type('html').send(html);
});
app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas,
  runtime: { defaultBackend: 'hermes', hermesConfigured: true, openclawConfigured: true } } }));
app.get('/api/voice-personas/private/agents', (_req, res) => res.json({ data: { agents: [{ id: 'main', name: 'Main' }] } }));
app.post('/api/voice-personas/:scope/sessions', (req, res) => {
  const session = { ...req.body, sessionId: randomUUID(), status: 'active', turnCount: 0 };
  sessions.set(session.sessionId, session); res.status(201).json({ data: { session } });
});
app.post('/api/voice-personas/:scope/sessions/:id/turns/text', (req, res) => {
  const session = sessions.get(req.params.id); session.turnCount++;
  let evidence;
  artxContext(artx, req.body.artx, value => { evidence = value; });
  submissions.push({ scope: req.params.scope, body: req.body, evidence, backend: session.backend });
  res.type('application/x-ndjson').end(JSON.stringify({ type: 'done', data: { session,
    reply: { text: 'Réponse synthétique.' }, routing: { backend: session.backend },
    tools: { status: 'observed', receipts: [] } } }) + '\n');
});
app.use('/api', (req, res) => res.json({ data: req.path.endsWith('/recap/latest') ? null
  : { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } }));

(async () => {
  fs.mkdirSync(report, { recursive: true });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }), args: ['--disable-gpu'] });
  for (const space of ['personal', 'family']) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/fixture?space=' + space);
    await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    assert.equal(await page.evaluate(() => window.fixtureError), undefined);
    await page.waitForFunction(() => document.querySelector('.nestor-ambient-sky')?.width > 0);
    await page.waitForTimeout(200);
    await page.locator('.avatar-scene-input input').fill('Où sont les astres dans ton ciel ?');
    await page.locator('.avatar-scene-input input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#conversationTranscript .assistant'));
    const received = submissions.at(-1);
    assert.ok(received.body.artx?.current, space + ' omitted its actual sky observation');
    assert.equal(received.body.artx.current.visible, true);
    assert.equal(received.evidence.current.planets.find(p => p.id === 'saturn').rendered, true);
    assert.equal(received.evidence.current.planets.find(p => p.id === 'jupiter').reason, 'below_horizon');
    assert.equal(received.evidence.current.moon.reason, 'face');
    assert.equal(received.backend, space === 'personal' ? 'hermes' : 'openclaw');
    await page.screenshot({ path: path.join(report, space + '-sky-conversation.png') });
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(report, 'conversation-receipt.json'), JSON.stringify({ submissions, errors, modelCalls: 0 }, null, 2));
  console.log('Personal Hermes and Family forward actual canvas observations; Core distinguishes visible, face-masked and below-horizon bodies.');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
