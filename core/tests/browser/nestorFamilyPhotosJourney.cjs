'use strict';

// Screen commands on the real Nestor page (#924): typed and spoken "agrandis",
// "ferme", "suivant"… act on the content workspace without a model turn.
// Loopback CPU fixtures only: no model, microphone, speech service or live data.
// The microphone and speech recognition are simulated; the page, conversation
// loop and content workspace are the shipped code.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const sessions = new Map(), submissions = [], errors = [];
let browser, server, heard = '';
const output = process.env.SCREEN_COMMANDS_BROWSER_OUTPUT_DIR || '/tmp/agentx-nestor-screen-commands-browser';
fs.mkdirSync(output, { recursive: true });

// A fake microphone: `say()` delivers one finished utterance to the conversation loop.
const fakeAudio = `window.NestorConversation.openAudio = async () => {
  const audio = { canInterrupt: false,
    listen(callback) { audio.utterance = callback; }, quiet() {}, close() {}, holdPlayback() {}, resumePlayback() {},
    async play() {}, async settle() {} };
  window.say = () => audio.utterance(new Blob(['speech']), {});
  return audio;
};`;

(async () => {
  const app = express();
  // The simulated recognizer answers before JSON parsing: the page posts the audio as a form.
  app.post('/api/voix/transcribe', (_req, res) => res.json({ data: { text: heard } }));
  app.use(express.json());
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
        ${fakeAudio}
        const api = async (url, options={}) => { const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}}); const body=await response.json(); if(!response.ok)throw Error(body.message||'fixture request failed'); return body.data; };
        try { await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:"family",autoStart:false});window.fixtureReady=true; }
        catch(error){window.fixtureError=error.stack;}
      });</script></body>`);
    res.type('html').send(html);
  });
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'openclaw', hermesConfigured: true } } }));
  app.use('/api/voice-personas/private', (_req, res) => { errors.push('Private API requested by family'); res.sendStatus(403); });
  app.post('/api/voice-personas/family/sessions', (req, res) => {
    const session = { ...req.body, sessionId: randomUUID(), status: 'active', turnCount: 0 };
    sessions.set(session.sessionId, session); res.status(201).json({ data: { session } });
  });
  // The only model stand-in: every request that reaches it is counted.
  app.post('/api/voice-personas/family/sessions/:id/turns/text', (req, res) => {
    submissions.push(req.body.text);
    const session = sessions.get(req.params.id); session.turnCount++;
    res.type('application/x-ndjson');
    res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(), reply: { text: 'Voici.' }, routing: { backend: 'agentx' },
      tools: { status: 'not_supported', authority: 'agentx/ollama', receipts: [] } } }) + '\n');
  });
  const photoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  app.get('/api/photos/frame/status', (_req, res) => res.json({ data: { enabled: true, idleSeconds: 120, intervalSeconds: 30 } }));
  app.get('/api/photos/frame/next', (_req, res) => res.json({ data: { id: photoId, src: '/api/photos/frame/' + photoId + '/image' } }));
  app.get('/api/photos/frame/:id/image', (_req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#145e76"/></svg>'));
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


  const frame = page.locator('.nestor-idle-photos');
  assert.equal(await page.locator('#conversationAgent').inputValue(), 'family');
  assert.equal(await page.locator('#conversationWake').isChecked(), true);
  assert.equal(await page.locator('#conversationWorkflow').count(), 0);
  assert.equal(await page.locator('.page-presentation').count(), 0);
  assert.equal(await page.locator('#conversationBackend').inputValue(), 'openclaw');
  assert.equal(await page.locator('#conversationBackend option[value=hermes]').count(), 0);
  await page.locator('#conversationStart').click();
  const listening = () => page.waitForFunction(() => document.getElementById('conversationPresence').dataset.state === 'listening');
  await listening();
  assert.equal([...sessions.values()].at(-1).agentId, 'family');
  assert.equal([...sessions.values()].at(-1).backend, 'openclaw');
  await page.clock.install();
  const enter = async () => {
    await page.evaluate(() => { document.activeElement?.blur(); document.getElementById('conversationSettings').hidden = true; });
    await page.clock.fastForward(121000); await frame.waitFor({state:'visible'});
  };
  await enter();
  await page.evaluate(() => dispatchEvent(new CustomEvent('persona-presence',{detail:{space:'personal',state:'thinking'}})));
  assert.equal(await frame.isVisible(),true,'personal events cannot dismiss a family frame');
  heard='Conversation ambiante'; await page.evaluate(() => say()); await listening();
  assert.equal(await frame.isVisible(),true,'wake gate ignores ambient speech');
  heard='Hey Nestor'; await page.evaluate(() => say()); await frame.waitFor({state:'hidden'}); await listening();
  assert.equal(submissions.length,0,'wake return creates no model request');
  for(const label of ['Settings','Flow','Diagnostic micro']) {
    await enter();
    if(label!=='Settings') await page.evaluate(() => { AgentXVoiceWorkshop.open = async opts => { window.workshopScope=opts.scope; return {}; }; });
    await frame.getByRole('button',{name:label,exact:true}).click(); await frame.waitFor({state:'hidden'});
    if(label==='Settings') assert.equal(await page.locator('#conversationSettings').isVisible(),true);
    else assert.equal(await page.evaluate(() => workshopScope),'family');
  }
  await enter(); await page.keyboard.press('Escape'); await frame.waitFor({state:'hidden'});
  await enter(); await frame.locator('img').click({position:{x:20,y:20}}); await frame.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,scope:'family',backend:'openclaw',liveModelCalls:0,submissions:submissions.length,errors}));
})().catch(error => { console.error(error.stack); process.exitCode=1; })
.finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
