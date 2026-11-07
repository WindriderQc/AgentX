'use strict';

// Math Lab in Famille (#1270): the same math card as Super Dad, in Famille's
// "Pages and images" zone and in Nestor's full screen. A simple line with one
// slider, a derivative with a tangent and an area, parametric curves and a
// surface, all drawn by GraphysX's <llmx-stage> with the 2D view as fallback;
// the released slider kept under the family routes and restored after a reload;
// and Core's immediate cube answer, unchanged.
// Shipped page and reply channels, scripted replies only: no model,
// microphone or external HTTP request. The GraphysX module is the built embed
// (`npm run build:face` in GraphysX-Web), passed by path.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const { createReplyChannels } = require('../../surfaces/household/reply-channels');
const { mathTurnFor } = require('../../surfaces/household/math-scene');
const { presentationEvidence } = require('../../surfaces/household/screen-context');
const screenPages = require('../../public/js/screen-pages');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const output = process.env.MATH_LAB_OUTPUT_DIR, stageModule = process.env.MATH_LAB_STAGE_MODULE;
assert.ok(output, 'Keep browser evidence outside Git: set MATH_LAB_OUTPUT_DIR');
assert.ok(stageModule && fs.existsSync(stageModule), 'Set MATH_LAB_STAGE_MODULE to GraphysX-Web dist/embed/llmx-face.js');
fs.mkdirSync(output, { recursive: true });
// What the family model might write; Core's reply channels decide what reaches the screen.
const REPLIES = {
  droite: 'Une droite qui monte! Le curseur a la rend plus ou moins penchée. '
    + '<show kind="math" title="Une droite">y = a*x + 1\na = 2 in [-3, 3]\nx in [-5, 5]</show> Essaie de bouger a.',
  question: 'Regarde la droite : plus a est grand, plus elle monte vite.',
  pente: 'La dérivée dit à quel point la courbe monte. '
    + "<show kind=\"math\" title=\"La pente d'un bol\">f(x) = x^2\nf'(x)\ntangent f at p\narea f from 0 to b\np = 1 in [-2, 2]\nb = 1 in [0, 2]\nx in [-3, 3]</show>"
    + ' Bouge p : la petite ligne blanche suit le bol.',
  cercle: 'Un cercle qu’on dessine en tournant. '
    + '<show kind="math" title="Un cercle">c(t) = (r*cos(t), r*sin(t))\nr = 2 in [0.5, 3]</show> Change r pour l’agrandir.',
  colline: 'Une colline toute ronde. '
    + '<show kind="math" title="Une colline">z = h*exp(-(x^2 + y^2)/4)\nh = 2 in [0.5, 3]\nx in [-4, 4]\ny in [-4, 4]</show> Tourne la scène pour en faire le tour.'
};
const sessions = new Map(), turns = new Map(), saves = [], submissions = [], errors = [], cases = [];
let lastSessionId = null;
let browser, server;

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/assets/household', express.static(publicDir));
  app.use('/js', express.static(path.join(core, 'public/js')));
  app.use('/css', express.static(path.join(core, 'public/css')));
  app.get('/vendor/marked/18.0.11/marked.umd.js', (_req, res) => res.type('js').sendFile(path.join(core, 'node_modules/marked/lib/marked.umd.js')));
  app.get('/vendor/dompurify/3.4.17/purify.min.js', (_req, res) => res.type('js').sendFile(path.join(core, 'node_modules/dompurify/dist/purify.min.js')));
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/api/household/avatar/llmx-face.js', (_req, res) => res.type('js').sendFile(path.resolve(stageModule)));
  app.get('/fixture', (_req, res) => {
    let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('<!-- product-navigation -->', '<span id="runtimePill"></span>')
      .replace(/  <script src="\/assets\/household\/app.js[^\n]+/, '');
    html = html.replace('</body>', `<script>document.addEventListener('DOMContentLoaded',async()=>{
      window.NestorConversation.openAudio=async()=>({canInterrupt:false,listen(){},quiet(){},close(){},holdPlayback(){},resumePlayback(){},async play(){},async settle(){}});
      const api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const body=await response.json();if(!response.ok)throw Error(body.message||'fixture request failed');return body.data;};
      try{await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:'family',autoStart:false});window.fixtureReady=true;}
      catch(error){window.fixtureError=error.stack;}
    });</script></body>`);
    res.type('html').send(html);
  });
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'agentx', openclawConfigured: false, hermesConfigured: false } } }));
  app.get('/api/photos/frame/status', (_req, res) => res.json({ data: { enabled: false } }));
  app.post('/api/voice-personas/:scope/sessions', (req, res) => {
    assert.equal(req.params.scope, 'family');
    const session = { ...req.body, sessionId: randomUUID(), status: 'active', turnCount: 0 }; sessions.set(session.sessionId, session);
    res.status(201).json({ data: { session } });
  });
  app.post('/api/voice-personas/:scope/sessions/:id/turns/text', (req, res) => {
    assert.equal(req.params.scope, 'family');
    // Core's own reading of the browser's selected card, exactly as a live turn would build it.
    const selected = presentationEvidence(req.body.screen, screenPages.createCatalog([]));
    submissions.push({ text: req.body.text, screen: req.body.screen, selected, turnId: req.body.turnId, channel: req.body.channel });
    const session = sessions.get(req.params.id); session.turnCount++;
    res.type('application/x-ndjson');
    let value;
    // Famille (#131): a counting or addition question gets Core's cubes and Core's own answer, no model.
    const cubes = mathTurnFor(req.body.text, 'fr');
    if (cubes) {
      res.write(JSON.stringify({ type: 'scene', scene: cubes.scene }) + '\n');
      res.write(JSON.stringify({ type: 'delta', delta: cubes.reply }) + '\n');
      value = { say: cubes.reply, display: [] };
    } else {
      const key = Object.keys(REPLIES).find(word => req.body.text.toLowerCase().includes(word)) || 'question';
      const channels = createReplyChannels({ allowMath: true, onSay: delta => res.write(JSON.stringify({ type: 'delta', delta }) + '\n'),
        onShow: block => res.write(JSON.stringify({ type: 'show', block }) + '\n') });
      channels.push(REPLIES[key]);
      value = channels.end();
    }
    if (!turns.has(session.sessionId)) turns.set(session.sessionId, []);
    turns.get(session.sessionId).push({ clientTurnId: req.body.turnId, inputText: req.body.text, replyText: value.say, display: value.display, mathValues: {} });
    session.lastTurnAt = new Date().toISOString(); lastSessionId = session.sessionId;
    res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(), reply: { text: value.say }, routing: { backend: 'agentx' } } }) + '\n');
  });
  // Released slider positions, kept with their turn; Core's own checks are covered by its route test.
  app.post('/api/voice-personas/:scope/sessions/:id/math-values', (req, res) => {
    saves.push({ scope: req.params.scope, sessionId: req.params.id, ...req.body });
    const turn = (turns.get(req.params.id) || []).find(row => row.clientTurnId === req.body.turnId);
    if (!turn) return res.status(404).json({ message: 'This turn is not recorded' });
    turn.mathValues[req.body.blockId] = req.body.values;
    res.json({ data: { turnId: req.body.turnId, blockId: req.body.blockId, values: req.body.values } });
  });
  app.get('/api/voice-personas/:scope/sessions/recent', (_req, res) => res.json({ data: { sessions: [...sessions.values()]
    .filter(session => session.turnCount).sort((a, b) => b.lastTurnAt.localeCompare(a.lastTurnAt))
    .map(session => ({ ...session, lastTurn: { inputPreview: turns.get(session.sessionId).at(-1).inputText } })) } }));
  app.get('/api/voice-personas/:scope/sessions/:id/history', (req, res) => res.json({ data: {
    session: sessions.get(req.params.id), turns: turns.get(req.params.id) || [], history: [], policy: { maximumDisplayedTurns: 500 } } }));
  app.use('/api', (req, res) => res.json({ data: req.path.endsWith('/recap/latest') ? null : { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.text())) errors.push(message.text()); });
    await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    assert.equal(await page.evaluate(() => window.fixtureError), undefined);
    await page.waitForFunction(() => AvatarDock.current?.mode);
    await page.evaluate(() => AvatarDock.current.setMode('cache'));
    const ask = async text => {
      const before = submissions.length, messages = await page.locator('.conversation-message').count();
      const reply = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/turns/text'));
      await page.locator('#conversationMessage').fill(text);
      await page.locator('#conversationText').getByRole('button', { name: 'Send', exact: true }).click();
      await (await reply).finished();
      await page.waitForFunction(n => document.querySelectorAll('.conversation-message').length >= n, messages + 2);
      assert.equal(submissions.length, before + 1);
      return submissions.at(-1);
    };
    // Famille's zone keeps the newest card first.
    const zone = page.locator('#conversationVisual');
    const newestMath = zone.locator('.display-block[data-kind=math]').first();
    const fitsWidth = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    const settle3d = async card => { await card.locator('.math-plot[data-view="3d"]').waitFor({ timeout: 15000 });
      await card.locator('llmx-stage').scrollIntoViewIfNeeded(); await page.waitForTimeout(1800); };
    const slide = (card, name, value) => card.locator(`input[aria-label="Paramètre ${name}"]`).evaluate((input, v) => {
      input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);

    // 1. A simple line with one slider lands in Famille's "Pages and images" zone, drawn in 3D.
    const first = await ask('Montre-moi une droite');
    assert.equal(first.channel, 'text');
    const line = newestMath;
    await line.waitFor();
    assert.equal(await zone.locator('.display-board-heading').textContent(), 'Pages and images');
    assert.equal(await page.locator('#conversationBoard .display-block').count(), 0, 'the card never lands in the text zone');
    assert.equal(await line.locator('.display-block-title').textContent(), 'Une droite');
    await settle3d(line);
    assert.equal(await line.locator('.math-plot').getAttribute('data-stage'), 'applied');
    assert.deepEqual(await line.locator('.math-plot-function').allTextContents(), ['y = a · x + 1']);
    assert.deepEqual((await line.locator('llmx-stage').evaluate(stage => stage.scene)).parameters, [{ name: 'a', value: 2, min: -3, max: 3 }]);
    assert.equal(await line.locator('input[type=range]').count(), 1);
    assert.equal(await line.locator('a[href]').count(), 0, 'a math card is look-only, with no link');
    const box = await line.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, `the card stays inside the viewport (${label})`);
    assert.ok(await fitsWidth(), `no horizontal page scroll (${label})`);
    await line.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-famille-line-3d.png`) });

    // 2. The slider moves the line; its released position is kept under the family routes.
    await slide(line, 'a', -1.5);
    assert.deepEqual(await line.locator('llmx-stage').evaluate(stage => stage.parameters), { a: -1.5 });
    for (let wait = 0; wait < 20 && !saves.some(row => row.sessionId === lastSessionId); wait += 1) await page.waitForTimeout(100);
    const lineTurn = turns.get(lastSessionId)[0];
    assert.ok(lineTurn.clientTurnId, 'the typed turn carries its id');
    assert.deepEqual(saves.filter(row => row.sessionId === lastSessionId),
      [{ scope: 'family', sessionId: lastSessionId, turnId: lineTurn.clientTurnId, blockId: 'b1', values: { a: -1.5 } }]);
    await page.waitForTimeout(300);
    await line.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-famille-line-slider.png`) });
    // The next turn tells Core what is on screen; Core recomputes the points itself.
    const followUp = await ask('Pourquoi elle descend maintenant ?');
    assert.equal(followUp.screen[0].kind, 'math');
    assert.match(followUp.screen[0].text, /^y = a \* x \+ 1\na = -1\.5 in \[-3, 3\]/);
    assert.equal(followUp.selected.math.computedBy, 'core');
    assert.deepEqual(followUp.selected.math.functions[0].points.at(-1), [5, -6.5], 'y(5) = -1.5·5 + 1, computed by Core');

    // 3. The 2D view is the fallback, and back to 3D.
    await line.getByRole('button', { name: 'Vue 2D' }).click();
    assert.equal(await line.locator('.math-plot').getAttribute('data-view'), '2d');
    assert.ok((await line.locator('.math-plot-curve').first().getAttribute('d')).split('L').length > 100, 'the 2D line is sampled from the formula');
    await line.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-famille-line-2d.png`) });
    await line.getByRole('button', { name: 'Vue 3D' }).click();

    // 4. Further when asked: a derivative, a tangent on a slider and an area (v3).
    await ask('Montre la pente');
    const calculus = zone.locator('.display-block[data-kind=math]', { hasText: 'La pente d' }).first();
    await settle3d(calculus);
    const calculusScene = await calculus.locator('llmx-stage').evaluate(stage => stage.scene);
    assert.equal(calculusScene.schema, 'agentx.math-scene.v3');
    assert.deepEqual([calculusScene.derivatives, calculusScene.tangents, calculusScene.areas], [['f'], [{ of: 'f', at: 'p' }], [{ of: 'f', from: 0, to: 'b' }]]);
    assert.match(await calculus.locator('.math-plot-legend-tangent').textContent(), /en x = 1 : pente 2$/);
    await calculus.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-famille-calculus-3d.png`) });
    await slide(calculus, 'p', -1);
    assert.match(await calculus.locator('.math-plot-legend-tangent').textContent(), /en x = −1 : pente −2$/);

    // 5. A parametric curve and a surface (v4).
    await ask('Dessine un cercle');
    const circle = zone.locator('.display-block[data-kind=math]', { hasText: 'Un cercle' }).first();
    await settle3d(circle);
    assert.equal((await circle.locator('llmx-stage').evaluate(stage => stage.scene)).schema, 'agentx.math-scene.v4');
    await circle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-famille-curve-3d.png`) });
    await ask('Et une colline ?');
    const hill = zone.locator('.display-block[data-kind=math]', { hasText: 'Une colline' }).first();
    await settle3d(hill);
    const hillScene = await hill.locator('llmx-stage').evaluate(stage => stage.scene);
    assert.deepEqual([hillScene.schema, hillScene.kind], ['agentx.math-scene.v4', 'surfaces']);
    await hill.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-famille-surface-3d.png`) });
    assert.ok(await fitsWidth(), `no horizontal page scroll after the curve and surface (${label})`);

    // 6. Nestor's full screen presents the newest math card first.
    await page.evaluate(() => AvatarDock.current.setMode('scene'));
    await page.waitForFunction(() => document.body.dataset.avatarView === 'montre');
    const presented = zone.locator('.display-block[data-kind=math]').first();
    await presented.locator('llmx-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    assert.equal(await presented.isVisible(), true);
    const shownBox = await presented.boundingBox();
    assert.ok(shownBox.x >= 0 && shownBox.x + shownBox.width <= viewport.width + 1, `the full-screen card stays inside the viewport (${label})`);
    assert.equal(await page.locator('#conversationText').isVisible(), false, 'the full screen shows the content, not the composer');
    assert.ok(await fitsWidth(), `no horizontal page scroll in full screen (${label})`);
    await page.evaluate(() => { const stage = document.querySelector('.conversation-stage'); stage.scrollTop = 0; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, `${label}-famille-fullscreen.png`) });
    await page.evaluate(() => AvatarDock.current.setMode('cache'));
    await page.waitForFunction(() => document.body.dataset.avatarView !== 'montre');

    // 7. Core's cube answer is unchanged: the picture and Core's own words, no model.
    const cubesTurn = await ask('Combien font 8 + 5 ?');
    assert.equal(cubesTurn.text, 'Combien font 8 + 5 ?');
    await page.waitForFunction(() => document.querySelector('#conversationVisual .display-block[data-kind=scene] .display-block-stage-caption')?.textContent === '8 + 5 = 13', null, { timeout: 15000 });
    assert.equal((await page.locator('.conversation-message').last().textContent()).includes(mathTurnFor('Combien font 8 + 5 ?', 'fr').reply), true);
    await zone.locator('.display-block[data-kind=scene]').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(output, `${label}-famille-cubes.png`) });

    // 8. After a reload, reopening the conversation from Recent brings the line back where its slider was released.
    await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    await page.locator('#conversationHistoryToggle').click();
    const recent = page.locator('#conversationHistory .conversation-history-entry button').first();
    await recent.waitFor();
    assert.match(await recent.textContent(), /Family/);
    await recent.click();
    const restored = zone.locator('.display-block[data-kind=math]', { hasText: 'Une droite' });
    await restored.locator('.math-plot').waitFor({ timeout: 15000 });
    assert.equal(await restored.locator('input[aria-label="Paramètre a"]').inputValue(), '-1.5');
    assert.match(await restored.locator('.math-plot-values').textContent(), /a = -1\.5/);
    await restored.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(output, `${label}-famille-restored.png`) });
    cases.push({ label, viewport, cardWidth: box.width });
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, cases, liveModelCalls: 0, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, cases, liveModelCalls: 0, errors }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
