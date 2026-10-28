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
const screenWords = require('../../surfaces/household/screen-command-phrases');
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
  // The owner's own words go through the real Core route, over an in-memory row.
  let wordsRow = null;
  const wordsModel = {
    findOne: () => ({ lean: async () => wordsRow }),
    findOneAndUpdate: (query, update) => ({ lean: async () => {
      if ((wordsRow?.revision || 0) !== (typeof query.revision === 'number' ? query.revision : 0)) return null;
      wordsRow = { ...update.$set }; return wordsRow;
    } })
  };
  const personasRouter = express.Router();
  screenWords.register(personasRouter, { service: screenWords.createScreenCommandPhrases({ Model: wordsModel }),
    envelope: (res, data) => res.json({ data }), fail: (res, status, message, code) => res.status(status).json({ message, code }) });
  app.use('/api/voice-personas', personasRouter);
  app.get('/api/voice-personas/private/screen-pages', (_req, res) => res.json({ data: { destinations: [{ id: 'dad-day', label: 'Ma journée', href: '/dad/day', mode: 'frame' }] } }));
  // A long same-origin page, so scrolling inside its frame can be observed.
  app.get('/dad/day', (_req, res) => res.send(`<!doctype html><title>Ma journée</title><style>body{font:16px system-ui;background:#102333;color:#e1eef8;padding:24px}</style>
    <h1>Ma journée</h1>${Array.from({ length: 60 }, (_, index) => `<p>Rendez-vous ${index + 1}</p>`).join('')}`));
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
      res.write(JSON.stringify({ type: 'show', block: { kind: 'page', title: 'Ma journée', body: 'dad-day' } }) + '\n');
      res.write(JSON.stringify({ type: 'show', block: { kind: 'list', title: 'Tâches clés', body: '- 0918 à revoir\n- 0921 en cours' } }) + '\n');
      res.write(JSON.stringify({ type: 'show', block: { kind: 'text', title: 'Note du jour', body: 'Deux tâches demandent une décision.' } }) + '\n');
    }
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
    if (how === 'spoken') await page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
    assert.equal(submissions.length, before, `${how} « ${text} » reached the model`);
    assert.equal(now.draft, '', 'the composer is empty after a command');
    steps.push({ how, text, ...now });
    return now;
  };

  // Content first: one ordinary request; the stand-in shows two blocks.
  await type('Montre-moi mes tâches clés');
  await page.waitForFunction(() => document.querySelectorAll('.page-presentation .display-block').length === 3);
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

  const listening = () => page.waitForFunction(() => document.querySelector('#conversationPresence').dataset.state === 'listening');
  await listening();
  const before = submissions.length;
  // Zoom words are the expand/shrink commands; "le texte" changes the text size.
  await expectStep('typed', 'zoom in', { expanded: true, feedback: 'Contenu agrandi.' });
  await expectStep('typed', 'zoom out', { expanded: false, feedback: 'Taille normale.' });
  await expectStep('typed', 'premier contenu', { selected: 'Note du jour', feedback: 'Premier contenu : Note du jour' });
  await expectStep('typed', 'dernier contenu', { selected: 'Ma journée', feedback: 'Dernier contenu : Ma journée' });
  await page.frameLocator('.page-presentation iframe').getByRole('heading', { name: 'Ma journée' }).waitFor();
  await expectStep('spoken', 'agrandis le texte', { feedback: 'Texte à 125 %.' });
  await listening();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.display-block:not([hidden]) .display-page-holder')).zoom), '1.25');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'bigger text does not widen the page');
  const frameTop = () => page.evaluate(() => document.querySelector('.display-block:not([hidden]) iframe').contentDocument.scrollingElement.scrollTop);
  await expectStep('spoken', 'descends', { feedback: 'Défilement vers le bas.' });
  await listening();
  await page.waitForFunction(() => document.querySelector('.display-block:not([hidden]) iframe').contentDocument.scrollingElement.scrollTop > 100);
  await page.screenshot({ path: path.join(output, 'text-zoom-scrolled-desktop.png'), fullPage: true });
  await expectStep('spoken', 'monte', { feedback: 'Défilement vers le haut.' });
  await listening();
  await page.waitForFunction(() => document.querySelector('.display-block:not([hidden]) iframe').contentDocument.scrollingElement.scrollTop === 0);
  assert.equal(await frameTop(), 0);
  await expectStep('typed', 'réduis le texte', { feedback: 'Texte à 100 %.' });
  // A typed command follows a key press, so the browser lets the tab open.
  const popup = page.waitForEvent('popup');
  await expectStep('typed', 'ouvre dans un onglet', { feedback: 'Page ouverte dans un onglet.' });
  const tab = await popup; await tab.waitForLoadState(); assert.match(tab.url(), /\/dad\/day/); await tab.close();
  // Spoken, there is usually no recent gesture: Nestor points at the link instead of pretending.
  // The test browser keeps the last click's activation, so its absence is simulated here.
  await page.evaluate(() => Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true }));
  await expectStep('spoken', 'ouvre dans un onglet', { feedback: 'Touchez « Ouvrir dans un onglet » : le navigateur bloque l’ouverture à la voix.' });
  await listening();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Ouvrir dans un onglet');
  await page.evaluate(() => delete navigator.userActivation);

  // See and edit the words: the owner's phrase is saved by Core and heard at once.
  await page.getByRole('button', { name: 'Commandes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Commandes d’écran' });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /zoom in/);
  await dialog.getByLabel('Phrase').fill('Agrandis');
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  assert.match(await dialog.locator('[data-status]').textContent(), /déjà reconnu/);
  await dialog.getByLabel('Phrase').fill('Plein pot');
  await dialog.getByLabel('Action').selectOption({ label: 'Agrandir la zone' });
  await dialog.getByRole('button', { name: 'Ajouter' }).click();
  await page.screenshot({ path: path.join(output, 'commands-editor-desktop.png') });
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(wordsRow.phrases, [{ phrase: 'Plein pot', action: 'expand' }]);
  await expectStep('spoken', 'Plein pot !', { expanded: true, feedback: 'Contenu agrandi.' });
  await listening();
  assert.equal(submissions.length, before, 'no new command reached the model');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Commandes' }).click();
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.screen-commands-dialog').getBoundingClientRect().width <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'commands-editor-mobile.png') });
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll on a phone');
  assert.equal(await region.isVisible(), true);
  // The idle frame is also mounted by the real conversation controller, not only a component fixture.
  const photoFrame = page.locator('.nestor-idle-photos');
  await page.clock.install();
  await page.evaluate(() => document.activeElement?.blur());
  await page.clock.fastForward(121000);
  await photoFrame.waitFor({ state: 'visible' });
  await photoFrame.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.locator('#conversationSettings').isVisible(), true);
  await page.locator('#conversationSettingsToggle').click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.clock.fastForward(121000);
  await photoFrame.waitFor({ state: 'visible' });
  await photoFrame.getByRole('button', { name: 'Flow', exact: true }).click();
  assert.equal(await page.locator('#conversationWorkflow').isVisible(), true);
  await page.evaluate(() => document.activeElement?.blur());
  await page.clock.fastForward(121000);
  await photoFrame.waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'idle-photos-integrated-mobile.png') });
  const photoTurns = submissions.length, photoRows = (await state()).rows;
  heard = 'Eille Nestor, ferme l’écran';
  await page.evaluate(() => window.say());
  await photoFrame.waitFor({ state: 'hidden' });
  await listening();
  assert.equal(submissions.length, photoTurns, 'voice return from photos creates no model request');
  assert.equal((await state()).rows, photoRows, 'voice return preserves the conversation');
  await page.evaluate(() => document.activeElement?.blur());
  await page.clock.fastForward(121000);
  await photoFrame.waitFor({ state: 'visible' });
  heard = 'Hey Nestor';
  await page.evaluate(() => window.say());
  await photoFrame.waitFor({ state: 'hidden' });
  await listening();
  assert.equal(submissions.length, photoTurns, 'Hey Nestor also returns locally with the existing open mic');
  await page.locator('#conversationSettingsToggle').click();
  await page.locator('#conversationWake').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#conversationWake').isChecked(), true);
  await page.locator('#conversationSettingsToggle').click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.clock.fastForward(121000);
  await photoFrame.waitFor({ state: 'visible' });
  heard = 'Conversation ambiante sans adresse';
  await page.evaluate(() => window.say());
  await listening();
  assert.equal(await photoFrame.isVisible(), true, 'ambient speech does not exit photos on wake standby');
  assert.equal(submissions.length, photoTurns);
  heard = 'Hey Nestor';
  await page.evaluate(() => window.say());
  await photoFrame.waitFor({ state: 'hidden' });
  await listening();
  assert.equal(submissions.length, photoTurns, 'Hey Nestor returns through the existing voice loop without a model turn');
  assert.equal((await state()).rows, photoRows);
  // Local OpenClaw is selected through the existing UI; photos do not need Hermes's companion.
  await page.locator('#conversationNew').click();
  if (!await page.locator('#conversationSettings').isVisible()) await page.locator('#conversationSettingsToggle').click();
  await page.locator('#conversationBackend').selectOption('openclaw');
  assert.equal(await page.locator('#conversationAgent').inputValue(), 'main');
  assert.equal(await page.locator('.presentation-companion-toggle').isVisible(), false);
  await page.locator('#conversationSettingsToggle').click();
  await page.locator('#conversationStart').click(); await listening();
  assert.equal([...sessions.values()].at(-1).backend, 'openclaw');
  assert.equal([...sessions.values()].at(-1).agentId, 'main');
  await page.evaluate(() => document.activeElement?.blur());
  await page.clock.fastForward(121000);
  await photoFrame.waitFor({ state: 'visible' });
  heard = 'Hey Nestor'; await page.evaluate(() => window.say());
  await photoFrame.waitFor({ state: 'hidden' }); await listening();
  assert.equal(submissions.length, photoTurns, 'local-backend photo wake creates no model request');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'steps.json'), JSON.stringify(steps, null, 2));
  console.log(JSON.stringify({ browser: 'Chromium', commands: steps.length, modelRequests: submissions, errors, output, liveModelCalls: 0 }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
