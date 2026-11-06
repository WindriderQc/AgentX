'use strict';

// Math Lab in Super Dad (#1270), phase 2: a comparison card drawn by GraphysX's
// <llmx-stage> (agentx.math-scene.v2) in the "Pages and images" zone, its
// sliders driving the 3D scene, the 2D view, and what the next turn reports to
// Core. Shipped page and reply channels, scripted replies only: no model,
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
  question: 'Regarde où les deux courbes se croisent.'
};
const sessions = new Map(), submissions = [], errors = [], cases = [];
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
  app.get('/vendor/dompurify/3.4.16/purify.min.js', (_req, res) => res.type('js').sendFile(path.join(core, 'node_modules/dompurify/dist/purify.min.js')));
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
    res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(), reply: { text: value.say }, routing: { backend: 'agentx' } } }) + '\n');
  });
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
    // Pixels of the 3D canvas: how many carry each function's colour (yellow f, cyan g).
    const stagePixels = selector => page.evaluate(sel => new Promise(resolve => requestAnimationFrame(() => {
      const source = document.querySelector(sel).shadowRoot.querySelector('canvas');
      const probe = document.createElement('canvas'); probe.width = 120; probe.height = 80;
      const context = probe.getContext('2d'); context.drawImage(source, 0, 0, probe.width, probe.height);
      const data = context.getImageData(0, 0, probe.width, probe.height).data;
      let yellow = 0, cyan = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 170 && g > 150 && b < 140) yellow += 1;
        if (r < 140 && g > 150 && b > 160) cyan += 1;
      }
      resolve({ yellow, cyan });
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
    await card.locator('input[aria-label="Paramètre a"]').evaluate(input => { input.value = '-1.5'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.deepEqual(await card.locator('llmx-stage').evaluate(stage => stage.parameters), { a: -1.5 });
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
    cases.push({ label, viewport, cardWidth: box.width, pixels: lit });
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, cases, liveModelCalls: 0, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, cases, liveModelCalls: 0, errors }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
