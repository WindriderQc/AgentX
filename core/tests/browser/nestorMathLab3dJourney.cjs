'use strict';

// Math Lab in Super Dad (#1270), phases 2 and 3: a comparison card drawn by
// GraphysX's <llmx-stage> (agentx.math-scene.v2) in the "Pages and images"
// zone, its sliders driving the 3D scene, the 2D view, what the next turn
// reports to Core, and the released slider positions coming back after a
// reload; then (v3) a derivative with a tangent on a slider and a shaded area,
// and functions that use other functions.
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
const { presentationEvidence } = require('../../surfaces/household/screen-context');
const screenPages = require('../../public/js/screen-pages');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const output = process.env.MATH_LAB_OUTPUT_DIR, stageModule = process.env.MATH_LAB_STAGE_MODULE;
assert.ok(output, 'Keep browser evidence outside Git: set MATH_LAB_OUTPUT_DIR');
assert.ok(stageModule && fs.existsSync(stageModule), 'Set MATH_LAB_STAGE_MODULE to GraphysX-Web dist/embed/llmx-face.js');
fs.mkdirSync(output, { recursive: true });
// What a model might write; Core's reply channels decide what reaches the screen.
const REPLIES = {
  compare: 'Comparons une parabole et une droite. Elles se croisent là où x² = a·x + 1. '
    + '<show kind="math" title="Parabole et droite">f(x) = x^2\ng(x) = a*x + 1\na = 2 in [-3, 3]\nx in [-3, 3]</show> Bouge a pour faire tourner la droite.',
  ondes: 'Trois ondes, trois fréquences. '
    + '<show kind="math" title="Trois ondes">f(x) = sin(x)\ng(x) = sin(2x)\nh(x) = a*sin(3x)\na = 1 in [0, 2]\nx in [-pi, pi]</show>',
  question: 'Regarde où les deux courbes se croisent.',
  derivee: 'La dérivée dit la pente de la courbe en chaque point. '
    + "<show kind=\"math\" title=\"Dérivée, tangente et aire\">f(x) = x^3 - 3x\nf'(x)\ntangent f at p\narea f from 0 to b\np = 1 in [-2, 2]\nb = 1.5 in [0, 2]\nx in [-2.5, 2.5]</show>"
    + ' Déplace p : la tangente suit la courbe.',
  composee: 'Une fonction peut en utiliser une autre. '
    + "<show kind=\"math\" title=\"Fonctions composées\">f(x) = x^2\ng(x) = f(x - 1) + 1\nh(x) = f'(x)\nx in [-3, 3]</show>"
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
  app.use('/psyx/assets', express.static(path.join(core, 'surfaces/psyx/public')));
  // The page's two vendor scripts, from Core's own dependencies as src/app.js serves them.
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
      try{await mountConversation({app:document.getElementById('app'),api,esc:value=>String(value??''),space:'personal',autoStart:false});window.fixtureReady=true;}
      catch(error){window.fixtureError=error.stack;}
    });</script></body>`);
    res.type('html').send(html);
  });
  app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas, runtime: { defaultBackend: 'agentx', openclawConfigured: false, hermesConfigured: false } } }));
  app.get('/api/photos/frame/status', (_req, res) => res.json({ data: { enabled: false } }));
  app.post('/api/voice-personas/:scope/sessions', (req, res) => {
    const session = { ...req.body, sessionId: randomUUID(), status: 'active', turnCount: 0 }; sessions.set(session.sessionId, session);
    res.status(201).json({ data: { session } });
  });
  app.post('/api/voice-personas/:scope/sessions/:id/turns/text', (req, res) => {
    // Core's own reading of the browser's selected card, exactly as a live turn would build it.
    const selected = presentationEvidence(req.body.screen, screenPages);
    submissions.push({ text: req.body.text, screen: req.body.screen, selected });
    const session = sessions.get(req.params.id); session.turnCount++;
    const key = Object.keys(REPLIES).find(word => req.body.text.toLowerCase().includes(word)) || 'question';
    res.type('application/x-ndjson');
    const channels = createReplyChannels({ allowMath: true, onSay: delta => res.write(JSON.stringify({ type: 'delta', delta }) + '\n'),
      onShow: block => res.write(JSON.stringify({ type: 'show', block }) + '\n') });
    channels.push(REPLIES[key]);
    const value = channels.end();
    // Kept as Core keeps a turn: its id, its text and the blocks it showed.
    if (!turns.has(session.sessionId)) turns.set(session.sessionId, []);
    turns.get(session.sessionId).push({ clientTurnId: req.body.turnId, inputText: req.body.text, replyText: value.say, display: value.display, mathValues: {} });
    session.lastTurnAt = new Date().toISOString(); lastSessionId = session.sessionId;
    res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(), reply: { text: value.say }, routing: { backend: 'agentx' } } }) + '\n');
  });
  // Released slider positions, kept with their turn; Core's own checks are covered by its route test.
  app.post('/api/voice-personas/:scope/sessions/:id/math-values', (req, res) => {
    saves.push({ sessionId: req.params.id, ...req.body });
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
    await page.waitForFunction(() => AvatarDock.current?.mode === 'scene');
    // The avatar hidden: the math card still loads the GraphysX module for its own scene.
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
    const selectedMath = '.page-presentation .display-block[data-kind=math][data-selected=true]';
    const fitsWidth = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    // Pixels of the 3D canvas: how many carry each function's colour (yellow f, cyan g), and near-white (tangents, labels).
    const stagePixels = selector => page.evaluate(sel => new Promise(resolve => requestAnimationFrame(() => {
      const source = document.querySelector(sel).shadowRoot.querySelector('canvas');
      const probe = document.createElement('canvas'); probe.width = 120; probe.height = 80;
      const context = probe.getContext('2d'); context.drawImage(source, 0, 0, probe.width, probe.height);
      const data = context.getImageData(0, 0, probe.width, probe.height).data;
      let yellow = 0, cyan = 0, white = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 170 && g > 150 && b < 140) yellow += 1;
        if (r < 140 && g > 150 && b > 160) cyan += 1;
        if (r > 200 && g > 200 && b > 200) white += 1;
      }
      resolve({ yellow, cyan, white });
    })), selector);

    // 1. A comparison card lands in the zone, selected, drawn in 3D by GraphysX.
    await ask('Compare une parabole et une droite');
    const card = page.locator(selectedMath);
    await card.waitFor();
    assert.equal(await card.locator('.display-block-title').textContent(), 'Parabole et droite');
    await card.locator('.math-plot[data-view="3d"]').waitFor({ timeout: 15000 });
    assert.equal(await card.locator('.math-plot').getAttribute('data-stage'), 'applied');
    assert.deepEqual(await card.locator('.math-plot-function').allTextContents(), ['f(x) = x²', 'g(x) = a · x + 1']);
    const shown = await card.locator('llmx-stage').evaluate(stage => stage.scene);
    assert.deepEqual(shown.functions.map(fn => [fn.label, fn.expression, fn.color]), [['f(x)', 'x^2', '#ffe86b'], ['g(x)', 'a * x + 1', '#60d6e8']]);
    assert.deepEqual(shown.parameters, [{ name: 'a', value: 2, min: -3, max: 3 }]);
    assert.equal(await card.locator('.math-plot-chart').isHidden(), true, 'the 2D plot steps aside');
    // The molecules rise into place while the scene is on screen; it pauses off screen.
    await card.locator('llmx-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);
    const lit = await stagePixels(selectedMath + ' llmx-stage');
    assert.ok(lit.yellow > 4 && lit.cyan > 4, `both functions are drawn in 3D (${JSON.stringify(lit)})`);
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, `the card stays inside the viewport (${label})`);
    assert.ok(await fitsWidth(), `no horizontal page scroll (${label})`);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-compare-3d.png`) });
    await card.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-compare-3d-scene.png`) });

    // 2. The slider drives the 3D scene; what Nestor reads is recomputed by Core for both curves.
    await card.locator('input[aria-label="Paramètre a"]').evaluate(input => {
      input.value = '-1.5'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.deepEqual(await card.locator('llmx-stage').evaluate(stage => stage.parameters), { a: -1.5 });
    // Released, the position is kept with the turn that showed the card.
    for (let wait = 0; wait < 20 && !saves.some(row => row.sessionId === lastSessionId); wait += 1) await page.waitForTimeout(100);
    const compareTurn = turns.get(lastSessionId)[0];
    assert.deepEqual(saves.filter(row => row.sessionId === lastSessionId),
      [{ sessionId: lastSessionId, turnId: compareTurn.clientTurnId, blockId: 'b1', values: { a: -1.5 } }]);
    assert.match(await card.locator('.math-plot-values').textContent(), /a = -1\.5/);
    await page.waitForTimeout(300);
    await card.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-compare-3d-slider.png`) });
    const followUp = await ask('Où est-ce que ça se croise ?');
    assert.equal(followUp.screen[0].kind, 'math');
    assert.match(followUp.screen[0].text, /^f\(x\) = x\^2\ng\(x\) = a \* x \+ 1\na = -1\.5 in \[-3, 3\]/);
    assert.equal(followUp.selected.math.computedBy, 'core');
    assert.deepEqual(followUp.selected.math.functions.map(fn => fn.label), ['f(x)', 'g(x)']);
    assert.deepEqual(followUp.selected.math.functions[1].points.at(-1), [3, -3.5], 'g(3) = -1.5·3 + 1, computed by Core');

    // 3. Turning the scene by dragging (sideways on a phone), then the 2D view and back.
    const stageBox = await card.locator('llmx-stage').boundingBox();
    await page.mouse.move(stageBox.x + stageBox.width * 0.5, stageBox.y + stageBox.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width * 0.8, stageBox.y + stageBox.height * 0.4, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await card.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-compare-3d-turned.png`) });
    await card.getByRole('button', { name: 'Vue 2D' }).click();
    assert.equal(await card.locator('.math-plot').getAttribute('data-view'), '2d');
    assert.equal(await card.locator('.math-plot-curve').count(), 2);
    assert.deepEqual(await card.locator('.math-plot-curve').evaluateAll(paths => paths.map(p => p.getAttribute('stroke'))), ['#ffe86b', '#60d6e8']);
    assert.ok((await card.locator('.math-plot-curve').first().getAttribute('d')).split('L').length > 400, 'the 2D curve is sampled from the formula');
    await card.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-compare-2d.png`) });
    await card.getByRole('button', { name: 'Vue 3D' }).click();
    assert.equal(await card.locator('.math-plot').getAttribute('data-view'), '3d');

    // 4. Three functions in one card, stacked above the first.
    await ask('Montre trois ondes');
    await page.locator(selectedMath + ' >> text=Trois ondes').waitFor();
    const waves = page.locator(selectedMath);
    await waves.locator('.math-plot[data-view="3d"]').waitFor({ timeout: 15000 });
    assert.equal(await waves.locator('.math-plot-function').count(), 3);
    assert.equal(await page.locator('.page-presentation .display-block[data-kind=math]').count(), 2);
    await waves.locator('llmx-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);
    await waves.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-waves-3d.png`) });
    assert.ok(await fitsWidth(), `no horizontal page scroll after all cards (${label})`);

    // 5. After a reload, Resume brings the comparison back where its slider was released, in 3D.
    await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    // The avatar stays hidden: this viewer chose that before the reload.
    await page.waitForFunction(() => AvatarDock.current?.mode === 'cache');
    const resume = page.locator('#conversationResume button.primary');
    await resume.waitFor();
    await resume.click();
    const restored = page.locator('.page-presentation .display-block[data-kind=math]', { hasText: 'Parabole et droite' });
    await restored.locator('.math-plot[data-view="3d"]').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.page-presentation .display-block[data-kind=math]').count(), 2);
    assert.equal(await restored.locator('input[aria-label="Paramètre a"]').inputValue(), '-1.5');
    assert.match(await restored.locator('.math-plot-values').textContent(), /a = -1\.5/);
    assert.deepEqual((await restored.locator('llmx-stage').evaluate(stage => stage.scene)).parameters, [{ name: 'a', value: -1.5, min: -3, max: 3 }]);
    await restored.locator('llmx-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);
    await restored.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-compare-restored.png`) });

    // 6. Phase 3: the derivative, a tangent riding the p slider and a shaded area, drawn by GraphysX from v3.
    await ask('Montre la derivee et l’aire');
    const calculus = page.locator(selectedMath, { hasText: 'Dérivée, tangente et aire' });
    await calculus.locator('.math-plot[data-view="3d"]').waitFor({ timeout: 15000 });
    const calculusScene = await calculus.locator('llmx-stage').evaluate(stage => stage.scene);
    assert.equal(calculusScene.schema, 'agentx.math-scene.v3');
    assert.deepEqual([calculusScene.derivatives, calculusScene.tangents, calculusScene.areas], [['f'], [{ of: 'f', at: 'p' }], [{ of: 'f', from: 0, to: 'b' }]]);
    assert.deepEqual(await calculus.locator('.math-plot-function').allTextContents(), ['f(x) = x³ - 3 · x', "f'(x) = 3 · x² - 3",
      'Tangente à f(x) en x = 1 : pente 0', 'Aire sous f(x) de 0 à 1.5 : −2.109 (la partie sous l’axe compte en moins)']);
    await calculus.locator('llmx-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);
    const calculusPixels = await stagePixels(selectedMath + ' llmx-stage');
    assert.ok(calculusPixels.yellow > lit.yellow, `the derivative and the area add yellow to the scene (${JSON.stringify(calculusPixels)})`);
    assert.ok(calculusPixels.white > lit.white, `the white tangent is drawn (${JSON.stringify(calculusPixels)} vs ${JSON.stringify(lit)})`);
    await calculus.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-calculus-3d.png`) });
    await calculus.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-calculus-3d-scene.png`) });
    // Moving p: GraphysX finds the new slope itself; the legend (Core's grammar in the page) agrees.
    const receipt = calculus.locator('llmx-stage').evaluate(stage => new Promise(resolve => stage.addEventListener('llmx-parameters-applied',
      event => resolve(event.detail), { once: true })));
    await calculus.locator('input[aria-label="Paramètre p"]').evaluate(input => {
      input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const applied = await receipt;
    assert.deepEqual(applied.tangents, [{ of: 'f', x: 2, y: 2, slope: 9 }], 'GraphysX computes the same slope');
    assert.ok(Math.abs(applied.areas[0].value - -2.109375) < 1e-9, 'and the same area');
    assert.match(await calculus.locator('.math-plot-legend-tangent').textContent(), /en x = 2 : pente 9$/);
    await page.waitForTimeout(400);
    await calculus.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-calculus-3d-slider.png`) });
    for (let wait = 0; wait < 20 && !saves.some(row => row.values?.p === 2); wait += 1) await page.waitForTimeout(100);
    assert.deepEqual(saves.at(-1).values, { p: 2, b: 1.5 }, 'tangent and bound sliders are kept like any other');
    await calculus.getByRole('button', { name: 'Vue 2D' }).click();
    assert.ok((await calculus.locator('.math-plot-derivative').getAttribute('d')).length > 200, 'the 2D derivative is drawn');
    assert.match(await calculus.locator('.math-plot-area').getAttribute('d'), /Z$/, 'the 2D area is shaded');
    assert.equal(await calculus.locator('.math-plot-tangent').isVisible(), true);
    await calculus.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-calculus-2d.png`) });
    await calculus.getByRole('button', { name: 'Vue 3D' }).click();
    assert.ok(await fitsWidth(), `no horizontal page scroll with the calculus legend (${label})`);
    const slope = await ask('Quelle est la pente maintenant ?');
    assert.match(slope.screen[0].text, /^f\(x\) = x\^3 - 3 \* x\nf'\(x\)\ntangent f at p\narea f from 0 to b\np = 2 in \[-2, 2\]/);
    assert.deepEqual(slope.selected.math.tangents, [{ of: 'f', x: 2, y: 2, slope: 9 }], 'Core reads the slope from the formula');
    assert.deepEqual(slope.selected.math.areas, [{ of: 'f', from: 0, to: 1.5, value: -2.109375 }]);

    // 7. Functions using functions: g is f shifted, h is f's derivative.
    await ask('Montre une fonction composee');
    const composed = page.locator(selectedMath, { hasText: 'Fonctions composées' });
    await composed.locator('.math-plot[data-view="3d"]').waitFor({ timeout: 15000 });
    assert.equal((await composed.locator('llmx-stage').evaluate(stage => stage.scene)).schema, 'agentx.math-scene.v3');
    assert.deepEqual(await composed.locator('.math-plot-function').allTextContents(), ['f(x) = x²', 'g(x) = f(x - 1) + 1', 'h(x) = f\'(x)']);
    await composed.locator('llmx-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);
    await composed.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-composed-3d.png`) });
    await composed.locator('.math-plot-view').screenshot({ path: path.join(output, `${label}-composed-3d-scene.png`) });
    assert.ok(await fitsWidth(), `no horizontal page scroll after the phase 3 cards (${label})`);
    cases.push({ label, viewport, cardWidth: box.width, pixels: lit, calculusPixels });
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, cases, liveModelCalls: 0, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, cases, liveModelCalls: 0, errors }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
