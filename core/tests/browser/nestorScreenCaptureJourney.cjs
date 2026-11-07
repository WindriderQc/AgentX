'use strict';

// Real composer and Chromium's synthetic getDisplayMedia device. HTTP fixtures
// exercise consent UI only; service/Mongo tests qualify the tool separately.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const { privacyForNew } = require('../../surfaces/household/ephemeral-policy');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const sessions = new Map(), submissions = [], errors = [], uploads = [], resolutions = [], archiveWrites = [];
let pendingCapture = null, failUpload = false;
let browser, server, pendingResponses = 0;
const output = process.env.SCREEN_CAPTURE_BROWSER_OUTPUT_DIR || '/tmp/agentx-nestor-screen-capture-browser';
fs.mkdirSync(output, { recursive: true });
(async () => {
  const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use('/assets/household', express.static(publicDir));
  app.use('/js', express.static(path.join(core, 'public/js')));
  app.use('/css', express.static(path.join(core, 'public/css')));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/fixture', (_req, res) => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>')
      .replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '')
      .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', async () => {
        window.AvatarDock = undefined;
        const native = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        window.captureCalls = 0; window.captureStreams = []; window.captureMode = 'native';
        navigator.mediaDevices.getDisplayMedia = options => {
          window.captureCalls++;
          if (window.captureMode === 'denied') return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
          const requested = window.captureMode === 'pending' ? new Promise(resolve => { window.grantCapture = resolve; }) : native(options);
          return requested.then(stream => { window.captureStreams.push(stream); return stream; });
        };
        window.lateGrant = () => {
          const canvas = document.createElement('canvas'); canvas.width=320; canvas.height=200;
          canvas.getContext('2d').fillRect(0,0,320,200); window.grantCapture(canvas.captureStream(1));
        };
        window.streamsStopped = () => window.captureStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
        const api = async (url, options={}) => { const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}}); const body=await response.json(); if(!response.ok)throw Error(body.message||'fixture request failed'); return body.data; };
        try { await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),autoStart:false,space:new URL(location).searchParams.get('space') || 'personal'});window.fixtureReady=true; }
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
  app.get('/api/voice-personas/private/sessions/:id/screen-capture', (req, res) => res.json({ data: {
    request: pendingCapture?.sessionId === req.params.id && pendingCapture.status === 'awaiting_consent' ? pendingCapture : null } }));
  app.post('/api/voice-personas/private/sessions/:id/screen-capture', (req, res) => {
    resolutions.push(req.body); pendingCapture.status = req.body.status;
    res.json({ data: { request: pendingCapture } });
  });
  app.post('/api/voice-personas/private/sessions/:id/attachments', (req, res) => {
    uploads.push(req.body);
    if (failUpload) { failUpload = false; return res.status(503).json({ message: 'Synthetic upload failure' }); }
    res.json({ data: { attachment: { id: '123456789012345678901234', name: req.body.name, kind: 'image', mimeType: 'image/png', size: 100 } } });
  });
  app.post('/api/voice-personas/private/sessions/:id/attachments/:attachmentId/original', (req, res) => {
    archiveWrites.push(req.params); res.json({ data: {} });
  });
  app.get('/api/voice-personas/private/sessions/recent', (_req, res) => res.json({ data: { sessions: [...sessions.values()].filter(row => !row.ephemeral && row.turnCount) } }));
  app.use('/api', (req, res) => {
    if (req.path.endsWith('/recap/latest')) return res.json({ data: null });
    res.json({ data: { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } });
  });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-tab-capture-source-by-title=AgentX synthetic capture target'], ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/fixture');
  await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  await page.evaluate(() => { document.title = 'AgentX synthetic capture target'; });
  const send = async text => {
    const count = await page.locator('.conversation-message.assistant').count();
    await page.locator('#conversationMessage').fill(text);
    await page.locator('#conversationText button[type=submit]').click();
    await page.waitForFunction(n => document.querySelectorAll('.conversation-message.assistant').length > n, count);
    await page.waitForFunction(() => /^(Mic off\.|Micro coupé\.)$/.test(document.querySelector('#conversationStatus').textContent));
  };
  await send('Synthetic request for help.');
  const requestCapture = async purpose => {
    pendingCapture = { sessionId: submissions.at(-1).sessionId, requestId: randomUUID(), purpose,
      status: 'awaiting_consent', expiresAt: new Date(Date.now() + 300000).toISOString() };
    await page.getByRole('region', { name: 'Nestor screen capture request' }).waitFor();
    await page.getByText('Nestor asks for a snapshot: ' + purpose, { exact: true }).waitFor();
    return pendingCapture;
  };
  const choose = () => page.getByRole('button', { name: 'Choose screen or window', exact: true });
  const previews = page.locator('#conversationDraftFiles img');
  await requestCapture('Read this synthetic window.');
  assert.equal(await page.evaluate(() => window.captureCalls), 0, 'tool request must not open the chooser');
  await choose().click();
  await previews.waitFor();
  assert.equal(await page.evaluate(() => window.streamsStopped()), true);
  assert.equal(uploads.length, 0, 'preview stays local until Send');
  await page.locator('#conversationMessage').fill('Please read this synthetic screenshot.');
  failUpload = true;
  await page.locator('#conversationText button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#conversationStatus').textContent.includes('Synthetic upload failure'));
  assert.equal(await previews.count(), 1, 'failed upload preserves snapshot');
  await page.locator('#conversationText button[type=submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('.conversation-message.assistant').length === 2);
  await page.waitForFunction(() => /^(Mic off\.|Micro coupé\.)$/.test(document.querySelector('#conversationStatus').textContent));
  assert.equal(uploads.length, 2); assert.equal(uploads[0].dataUrl, uploads[1].dataUrl);
  assert.match(uploads[0].dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(submissions.at(-1).attachmentIds, ['123456789012345678901234']);
  assert.equal(resolutions.at(-1).status, 'attached'); assert.equal(archiveWrites.length, 0);
  assert.equal(await previews.count(), 0);
  await requestCapture('Permission refusal.');
  await page.evaluate(() => { window.captureMode = 'denied'; });
  await choose().click();
  await page.getByText('Screen capture permission was denied or the chooser was cancelled. No snapshot was added.', { exact: true }).waitFor();
  assert.equal(uploads.length, 2); assert.equal(await previews.count(), 0);
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Nestor screen capture request"]').hidden);
  assert.equal(resolutions.at(-1).status, 'declined');
  await requestCapture('Cancel late browser permission.');
  await page.evaluate(() => { window.captureMode = 'pending'; });
  await choose().click();
  await page.getByRole('button', { name: 'Cancel capture', exact: true }).click();
  await page.evaluate(() => window.lateGrant());
  await page.waitForFunction(() => window.streamsStopped());
  assert.equal(await previews.count(), 0);
  await choose().click();
  await page.getByRole('button', { name: 'Cancel capture', exact: true }).waitFor();
  await page.locator('#conversationNew').click();
  await page.evaluate(() => window.lateGrant());
  await page.waitForFunction(() => window.streamsStopped());
  assert.equal(await previews.count(), 0); assert.equal(uploads.length, 2);
  await send('New synthetic conversation.');
  await requestCapture('Preview and remove.');
  await page.evaluate(() => { window.captureMode = 'native'; });
  await choose().click(); await previews.waitFor();
  await page.screenshot({ path: path.join(output, 'capture-preview.png'), fullPage: true });
  await page.getByRole('button', { name: /^Remove screen-/ }).click();
  await page.waitForFunction(() => !document.querySelector('#conversationDraftFiles img'));
  await choose().click(); await previews.waitFor();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#conversationDraftFiles img'));
  assert.equal(uploads.length, 2, 'removal and decline never upload');
  await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = undefined; });
  await requestCapture('Unsupported browser.');
  await page.getByText('Screen capture is unavailable in this browser. Use HTTPS or localhost in a supported browser.', { exact: true }).waitFor();
  assert.equal(await choose().isDisabled(), true);
  await page.goto(origin + '/fixture?space=family');
  await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  assert.equal(await page.locator('[aria-label="Nestor screen capture request"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: 'Chromium', checks: ['agent request needs click', 'native synthetic capture', 'preview before upload',
    'upload retry', 'message attachment', 'no photo archive', 'denial', 'decline', 'cancel and late grant', 'conversation change', 'remove and retake', 'unsupported browser', 'family excluded'],
    uploads: uploads.length, turns: submissions.length, output, liveModelCalls: 0, errors }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
