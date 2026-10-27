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
        try { await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),autoStart:false});window.fixtureReady=true; }
        catch(error){window.fixtureError=error.stack;}
      });</script></body>`);
    res.type('html').send(html);
  });
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'agentx' } } }));
  app.get('/api/voice-personas/private/agents', (_req, res) => res.json({ data: { agents: [] } }));
  app.post('/api/voice-personas/private/sessions', (req, res) => {
    const session = { ...req.body, sessionId: randomUUID(), status: 'active', turnCount: 0 };
    sessions.set(session.sessionId, session); res.status(201).json({ data: { session } });
  });
  // The only model stand-in: every request that reaches it is counted.
  app.post('/api/voice-personas/private/sessions/:id/turns/text', (req, res) => {
    submissions.push(req.body.text);
    const session = sessions.get(req.params.id); session.turnCount++;
    res.type('application/x-ndjson');
    if (submissions.length === 1) {
      res.write(JSON.stringify({ type: 'show', block: { kind: 'list', title: 'Tâches clés', body: '- 0918 à revoir\n- 0921 en cours' } }) + '\n');
      res.write(JSON.stringify({ type: 'show', block: { kind: 'text', title: 'Note du jour', body: 'Deux tâches demandent une décision.' } }) + '\n');
    }
    res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(), reply: { text: 'Voici.' }, routing: { backend: 'agentx' },
      tools: { status: 'not_supported', authority: 'agentx/ollama', receipts: [] } } }) + '\n');
  });
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

  const region = page.locator('.page-presentation');
  const state = () => page.evaluate(() => {
    const zone = document.querySelector('.page-presentation');
    return { active: zone.classList.contains('is-active'), expanded: zone.classList.contains('is-expanded'),
      selected: zone.querySelector('.display-block:not([hidden]) .display-block-title')?.textContent,
      feedback: zone.querySelector('.page-presentation-feedback').textContent,
      rows: document.querySelectorAll('#conversationTranscript .conversation-message').length,
      draft: document.querySelector('#conversationMessage').value };
  });
  const type = async text => {
    await page.locator('#conversationMessage').fill(text);
    await page.locator('#conversationText button[type="submit"]').click();
  };
  const steps = [];
  const expectStep = async (how, text, expected) => {
    const before = submissions.length;
    if (how === 'typed') await type(text); else { heard = text; await page.evaluate(() => window.say()); }
    await page.waitForFunction(message => document.querySelector('.page-presentation-feedback').textContent === message, expected.feedback);
    const now = await state();
    for (const [key, value] of Object.entries(expected)) assert.equal(now[key], value, `${how} « ${text} » → ${key}`);
    assert.equal(submissions.length, before, `${how} « ${text} » reached the model`);
    assert.equal(now.draft, '', 'the composer is empty after a command');
    steps.push({ how, text, ...now });
    return now;
  };

  // Content first: one ordinary request; the stand-in shows two blocks.
  await type('Montre-moi mes tâches clés');
  await page.waitForFunction(() => document.querySelectorAll('.page-presentation .display-block').length === 2);
  await page.waitForFunction(() => document.querySelectorAll('#conversationTranscript .assistant').length === 1);
  await page.waitForFunction(() => !document.querySelector('#conversationText textarea').disabled && document.querySelector('#conversationStatus').textContent !== 'Thinking…');
  assert.equal(submissions.length, 1);
  const rows = (await state()).rows;
  assert.equal((await state()).selected, 'Note du jour', 'the newest content is selected');

  // Typed commands, with the voice off.
  await expectStep('typed', 'Agrandis', { expanded: true, feedback: 'Contenu agrandi.', rows });
  await page.screenshot({ path: path.join(output, 'typed-expanded-desktop.png'), fullPage: true });
  await expectStep('typed', 'Agrandis l’écran', { expanded: true, feedback: 'Déjà agrandi.' });
  await expectStep('typed', 'précédent', { selected: 'Note du jour', feedback: 'Déjà au premier contenu.' });
  await expectStep('typed', 'suivant', { selected: 'Tâches clés', feedback: 'Contenu suivant : Tâches clés', rows });
  await expectStep('typed', 'Ferme', { active: false, expanded: false, feedback: 'Contenu fermé.' });
  await expectStep('typed', 'ferme le contenu', { active: false, feedback: 'Le contenu est déjà fermé.' });
  await expectStep('typed', 'show it again', { active: true, selected: 'Tâches clés', feedback: 'Contenu affiché.', rows });

  // A real request that starts like a command still goes to Nestor.
  await type('Ferme la tâche 0918');
  await page.waitForFunction(() => document.querySelectorAll('#conversationTranscript .assistant').length === 2);
  assert.equal(submissions.at(-1), 'Ferme la tâche 0918');
  await page.waitForFunction(() => document.querySelector('#conversationStatus').textContent !== 'Thinking…');

  // Spoken commands: the real voice loop with a simulated microphone and recognizer.
  await page.locator('#conversationStart').click();
  await page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
  const turnsBefore = submissions.length, rowsBefore = (await state()).rows;
  await expectStep('spoken', 'Nestor, agrandis', { expanded: true, feedback: 'Contenu agrandi.', rows: rowsBefore });
  await page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
  await expectStep('spoken', 'Précédent.', { selected: 'Note du jour', feedback: 'Contenu précédent : Note du jour' });
  await page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
  await expectStep('spoken', 'réduis', { expanded: false, feedback: 'Taille normale.' });
  await page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
  await expectStep('spoken', 'cache l’écran', { active: false, feedback: 'Contenu fermé.', rows: rowsBefore });
  await page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
  await page.screenshot({ path: path.join(output, 'spoken-closed-desktop.png'), fullPage: true });
  await expectStep('spoken', 'réaffiche', { active: true, feedback: 'Contenu affiché.' });
  await page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
  // Typed while the voice listens: the same filter.
  await expectStep('typed', 'next', { selected: 'Tâches clés', feedback: 'Contenu suivant : Tâches clés' });
  assert.equal(submissions.length, turnsBefore, 'no spoken or typed command became a model turn');
  // Recognition goes on after the commands: an ordinary question is still a turn.
  heard = 'Agrandis la photo et explique-la';
  await page.evaluate(() => window.say());
  await page.waitForFunction(count => document.querySelectorAll('#conversationTranscript .assistant').length === count, 3);
  assert.equal(submissions.at(-1), 'Agrandis la photo et explique-la');
  assert.equal((await state()).expanded, false, 'a request is never acted on as a command');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll on a phone');
  assert.equal(await region.isVisible(), true);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'steps.json'), JSON.stringify(steps, null, 2));
  console.log(JSON.stringify({ browser: 'Chromium', commands: steps.length, modelRequests: submissions, errors, output, liveModelCalls: 0 }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
