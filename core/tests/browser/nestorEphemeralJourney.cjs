'use strict';

// Complete browser mount and HTTP submission with loopback-only CPU fixtures.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const { privacyForNew, registerPrivacyRoutes } = require('../../surfaces/household/ephemeral-policy');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const sessions = new Map(), submissions = [], errors = [];
let browser, server, pendingResponses = 0;
const output = process.env.EPHEMERAL_BROWSER_OUTPUT_DIR || '/tmp/agentx-nestor-ephemeral-browser';
fs.mkdirSync(output, { recursive: true });
(async () => {
  const app = express(); app.use(express.json());
  app.use('/assets/household', express.static(publicDir));
  app.use('/js', express.static(path.join(core, 'public/js')));
  app.use('/css', express.static(path.join(core, 'public/css')));
  app.use('/psyx/assets', express.static(path.join(core, 'surfaces/psyx/public')));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/fixture', (_req, res) => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>')
      .replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '')
      .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', async () => {
        window.AvatarDock = undefined;
        const api = async (url, options={}) => { const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}}); const body=await response.json(); if(!response.ok)throw Error(body.message||'fixture request failed'); return body.data; };
        try { await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),autoStart:false});window.fixtureReady=true; }
        catch(error){window.fixtureError=error.stack;}
      });</script></body>`);
    res.type('html').send(html);
  });
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'openclaw', openclawConfigured: true } } }));
  app.get('/api/voice-personas/private/agents', (_req, res) => res.json({ data: { agents: [{ id: 'main', name: 'Main' }] } }));
  app.post('/api/voice-personas/private/sessions', (req, res) => {
    const session = { ...req.body, ...privacyForNew(req.body, req.body.inference?.open), sessionId: randomUUID(), status: 'active', turnCount: 0 };
    sessions.set(session.sessionId, session); res.status(201).json({ data: { session } });
  });
  const privacyRouter = express.Router();
  registerPrivacyRoutes(privacyRouter, { activePersonaTurns: new Map(),
    envelope: (res, data) => res.json({ data }), fail: (res, status, message) => res.status(status).json({ message }),
    conversations: { getSession: async query => sessions.get(query.sessionId), listTurns: async () => [],
      recordTurn: async () => {}, updateSession: async (query, update) => Object.assign(sessions.get(query.sessionId), update.$set),
      createSession: async input => { const session = { ...input, turnCount: 0 }; sessions.set(input.sessionId, session); return session; } }
  });
  app.use('/api/voice-personas', privacyRouter);
  app.post('/api/voice-personas/private/sessions/:id/turns/text', (req, res) => {
    submissions.push({ sessionId: req.params.id, ...req.body });
    const session = sessions.get(req.params.id); session.turnCount++;
    pendingResponses++;
    res.type('application/x-ndjson');
    res.write(JSON.stringify({ type: 'delta', delta: 'Réponse synthétique.' }) + '\n');
    setTimeout(() => { pendingResponses--; res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(),
      reply: { text: 'Réponse synthétique.' }, routing: { backend: 'agentx' },
      tools: { status: 'not_supported', authority: 'agentx/ollama', receipts: [] } } }) + '\n'); }, 500);
  });
  app.get('/api/voice-personas/private/sessions/recent', (_req, res) => res.json({ data: { sessions: [...sessions.values()].filter(row => !row.ephemeral && row.turnCount) } }));
  app.use('/api', (req, res) => {
    if (req.path.endsWith('/recap/latest')) return res.json({ data: null });
    res.json({ data: { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } });
  });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/fixture');
  await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  await page.locator('#conversationSettingsToggle').click();
  const ephemeral = page.locator('#conversationEphemeral'), open = page.locator('#conversationOpen');
  const toggle = async (field, value) => { if (await field.isChecked() !== value) await field.locator('..').click(); };
  assert.equal(await ephemeral.isEnabled(), true); assert.equal(await ephemeral.isChecked(), false);
  await toggle(open, true); assert.equal(await ephemeral.isChecked(), true);
  await toggle(open, false); assert.equal(await ephemeral.isChecked(), true);
  await toggle(ephemeral, false); await toggle(open, true); assert.equal(await ephemeral.isChecked(), false);
  await page.locator('#conversationNew').click(); assert.equal(await ephemeral.isChecked(), true);
  await page.locator('#conversationPrivacyDirect').click();
  assert.equal(await page.locator('#conversationBackend').inputValue(), 'agentx');
  await page.screenshot({ path: path.join(output, 'ephemeral-on-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'ephemeral-on-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator('#conversationMessage').fill('EPHEMERAL_BROWSER_MARKER');
  await page.locator('#conversationText button').click();
  await page.waitForFunction(() => document.querySelector('#conversationTranscript .assistant'));
  assert.equal(pendingResponses, 1);
  await toggle(ephemeral, false);
  await page.waitForFunction(() => document.querySelector('#conversationStatus').textContent === 'Mic off.');
  assert.equal(submissions[0].ephemeral, true, 'a mid-stream switch cannot reclassify the submitted request');
  assert.match(await page.locator('#conversationPrivacyNotice').textContent(), /nouveau contexte/);
  await page.locator('#conversationMessage').fill('RETAINED_BROWSER_MARKER');
  await page.locator('#conversationText button').click();
  await page.waitForFunction(() => document.querySelectorAll('#conversationTranscript .assistant').length === 2);
  await page.waitForFunction(() => document.querySelector('#conversationStatus').textContent === 'Mic off.');
  assert.equal(submissions[1].ephemeral, false); assert.notEqual(submissions[0].sessionId, submissions[1].sessionId);
  assert.equal(submissions[1].screen.length, 0);
  assert.match(await page.locator('#conversationTranscript').textContent(), /EPHEMERAL_BROWSER_MARKER/);
  await page.screenshot({ path: path.join(output, 'ephemeral-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'ephemeral-mobile.png'), fullPage: true });
  await page.reload(); await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  assert.equal(await page.locator('#conversationTranscript .conversation-message').count(), 0);
  assert.equal(await page.locator('#conversationEphemeral').isChecked(), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: 'Chromium', submissions: submissions.length, policy: [true, false], reloadRestoresEphemeral: false, errors, output, liveModelCalls: 0 }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
