'use strict';

// Real Famille page and conversation loop, a synthetic recognizer and a Core
// clock/store double. No model, microphone, private inputs or external request.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const { harness } = require('../../surfaces/household/test/fixtures/persona-journey.cjs');
const { memoryMongoose } = require('../../surfaces/household/test/fixtures/kitchen-timer-memory.cjs');
const { registerKitchenTimer } = require('../../surfaces/household/family-kitchen-timer-routes');
const { createFamilyKitchenTimer } = require('../../src/services/familyKitchenTimer');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
let now = 1_000_000, heard = '', browser, server, claims = 0;
const errors = [];
const timer = createFamilyKitchenTimer({ mongoose: memoryMongoose(), now: () => now });
const family = harness({ packId: 'kidx_nestor', backend: 'agentx', kitchenTimer: timer });
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>')
  .replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '')
  .replace('</body>', '<script>(' + function () {
    document.addEventListener('DOMContentLoaded', async () => {
      window.AvatarDock = undefined;
      Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } });
      window.NestorConversation.openAudio = async () => {
        const audio = { canInterrupt: false,
          listen(callback) { audio.utterance = callback; }, quiet() {}, close() {}, holdPlayback() {}, resumePlayback() {},
          async play() {}, async settle() {} };
        window.say = () => audio.utterance(new Blob(['speech']), {});
        return audio;
      };
      window.beeps = 0;
      const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
      window.AudioContext = class {
        state = 'running'; currentTime = 0; destination = {};
        createOscillator() { return { frequency: param, connect() {}, start() { window.beeps++; }, stop() {} }; }
        createGain() { return { gain: param, connect() {} }; }
        async close() {}
      };
      const api = async (url, options = {}) => {
        const response = await fetch(url, { ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
        const body = await response.json();
        if (!response.ok) throw Error(body.message || 'Fixture request failed');
        return body.data;
      };
      try {
        await mountConversation({ app: document.getElementById('app'), api, esc: value => String(value ?? ''), space: 'family', autoStart: false });
        window.fixtureReady = true;
      } catch (error) { window.fixtureError = error.stack; }
    });
  }.toString() + ')();</script></body>');

(async () => {
  const app = express();
  app.post('/api/voix/transcribe', (_req, res) => res.json({ data: { text: heard } }));
  app.use(express.json());
  app.use('/assets/household', express.static(publicDir));
  app.use('/js', express.static(path.join(core, 'public/js')));
  app.use('/css', express.static(path.join(core, 'public/css')));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/panel', (_req, res) => res.type('html').send(html));
  const router = express.Router();
  registerKitchenTimer(router, { ...timer, claimAlert: async id => {
    const result = await timer.claimAlert(id);
    if (result.claimed) claims++;
    return result;
  } });
  app.use('/api/family', router);
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'agentx' } } }));
  app.get('/api/voice-personas/family/screen-pages', (_req, res) => res.json({ data: { destinations: [] } }));
  app.post('/api/voice-personas/family/sessions', (req, res) => {
    Object.assign(family.session, req.body, { defaultLanguage: 'fr' });
    res.status(201).json({ data: { session: family.session } });
  });
  app.post('/api/voice-personas/family/sessions/:sessionId/turns/text', async (req, res) => {
    await family.handle(req, res, 'child', { packId: family.pack.id, modeId: family.pack.defaultMode, scopeId: 'family', browser: true });
    if (!res.writableEnded) res.status(res.failure?.status || 200).json(res.failure || { data: res.payload });
  });
  app.use('/api', (req, res) => {
    if (req.path.endsWith('/recap/latest')) return res.json({ data: null });
    res.json({ data: { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } });
  });
  // Windows can hand port zero an HTTP port Chromium explicitly blocks.
  for (let attempt = 0; !server?.listening && attempt < 10; attempt++) {
    server = app.listen(49152 + Math.floor(Math.random() * 16384), '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    });
  }
  assert.ok(server?.listening, 'No high loopback port was available');
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  async function ready(page) {
    await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  }
  await page.goto(origin + '/panel');
  await ready(page);
  const prompt = page.locator('#conversationMessage');
  const typed = async text => {
    await prompt.fill(text);
    await prompt.press('Enter');
  };
  await page.locator('#conversationStart').click();
  await page.waitForFunction(() => document.getElementById('conversationPresence').dataset.state === 'listening');
  heard = 'Hey Nestor, mets une minuterie de 2 minutes.';
  await page.evaluate(() => window.say());
  assert.equal(family.turns[0]?.channel, 'voice');
  await page.locator('#conversationStart').click();
  const panel = page.locator('.family-kitchen-timer');
  await panel.waitFor({ state: 'visible' });
  assert.match(await panel.innerText(), /Minuterie\s+02:00/);
  assert.equal(family.sent.length, 0);
  const persistedId = (await timer.read()).id;
  now += 20_000;
  await page.reload();
  await ready(page);
  await panel.waitFor({ state: 'visible' });
  assert.match(await panel.innerText(), /01:40/);
  assert.equal((await timer.read()).id, persistedId);
  await typed('Combien il reste?');
  await page.getByText('Il reste 1 minute et 40 secondes.', { exact: true }).waitFor();
  now += 100_000;
  await page.clock.fastForward(101_000);
  await page.waitForFunction(() => window.beeps === 1);
  assert.equal(claims, 1);
  assert.match(await panel.innerText(), /00:00/);
  await page.reload();
  await ready(page);
  await panel.waitFor({ state: 'visible' });
  await page.locator('#conversationMessage').click();
  await page.clock.fastForward(6_000);
  assert.equal(await page.evaluate(() => window.beeps), 0);
  assert.equal(claims, 1);
  await typed('Pars le chrono pour 30 secondes.');
  await page.getByText(/C’est parti\./).waitFor();
  await typed('Annule la minuterie.');
  await page.getByText('Minuterie annulée.', { exact: true }).waitFor();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(family.sent.length, 0);
  assert.deepEqual(errors, []);
  console.log('PASS Famille timer: real page, Core deterministic route, reload, status, expiry once, cancel; simulated time and audio.');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
