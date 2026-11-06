'use strict';

// Math Lab in Super Dad (#1270), phase 1: a math card in the "Pages and images"
// zone, its sliders, what the next turn reports to Core, and the cube picture
// beside a model answer. Shipped page and reply channels; scripted replies only.
// No model, microphone, GraphysX module or external HTTP request.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const core = path.resolve(__dirname, '../..'), publicDir = path.join(core, 'surfaces/household/public');
const { generatedPersonas, snapshot } = require('../../surfaces/household/persona-catalog');
const { createReplyChannels } = require('../../surfaces/household/reply-channels');
const { mathPictureFor } = require('../../surfaces/household/math-scene');
const { presentationEvidence } = require('../../surfaces/household/screen-context');
const screenPages = require('../../public/js/screen-pages');
const personas = generatedPersonas().map(row => snapshot({ ...row, _id: 'fixture', version: 1 }));
const output = process.env.MATH_LAB_OUTPUT_DIR;
assert.ok(output, 'Keep browser evidence outside Git: set MATH_LAB_OUTPUT_DIR');
fs.mkdirSync(output, { recursive: true });
const face = `customElements.define('llmx-face', class extends HTMLElement {
  connectedCallback(){this.style.cssText='display:block;background:#183646';setTimeout(()=>this.dispatchEvent(new Event('llmx-face-ready')),0);}
  set presence(value) { this.latestPresence=value; }
});`;
// What a model might write; Core's reply channels decide what reaches the screen.
const REPLIES = {
  onde: 'Voici une onde sinusoïdale. Le paramètre a règle sa hauteur, b sa fréquence. '
    + '<show kind="math" title="Une onde">y = a*sin(b*x)\na = 1 in [-3, 3]\nb = 1 in [0.5, 4]\nx in [-2*pi, 2*pi]</show> Bouge les curseurs pour voir.',
  parabole: 'Une parabole s’ouvre vers le haut quand a est positif. '
    + '<show kind="math" title="Parabole">y = a*x^2 + b*x + c\na = 1 in [-3, 3]\nb = 0 in [-5, 5]\nc = -2 in [-5, 5]\nx in [-5, 5]</show>',
  invalide: 'Je tente un tracé. <show kind="math" title="Essai">y = window.alert(x)</show>',
  cubes: 'Huit plus cinq font treize : le cinq complète la dizaine avec deux, et il reste trois.'
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
  app.get('/api/voix/player.js', (_req, res) => res.type('js').send(''));
  app.get('/api/household/avatar/llmx-face.js', (_req, res) => res.type('js').send(face));
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
    const key = Object.keys(REPLIES).find(word => req.body.text.toLowerCase().includes(word)) || 'cubes';
    res.type('application/x-ndjson');
    // Super Dad: the cube picture first, then the model's own words (persona-turn's order).
    const picture = mathPictureFor(req.body.text, { childSafe: false });
    if (picture) res.write(JSON.stringify({ type: 'scene', scene: picture.scene }) + '\n');
    const channels = createReplyChannels({ allowMath: true, onSay: delta => res.write(JSON.stringify({ type: 'delta', delta }) + '\n'),
      onShow: block => res.write(JSON.stringify({ type: 'show', block }) + '\n') });
    channels.push(REPLIES[key]);
    const value = channels.end();
    res.end(JSON.stringify({ type: 'done', data: { session, traceId: randomUUID(), reply: { text: value.say }, routing: { backend: 'agentx' } } }) + '\n');
  });
  app.use('/api', (req, res) => res.json({ data: req.path.endsWith('/recap/latest') ? null : { destinations: [], sessions: [], works: [], notes: [], active: 'primary', review: null } }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.fixtureReady || window.fixtureError);
    assert.equal(await page.evaluate(() => window.fixtureError), undefined);
    await page.waitForFunction(() => AvatarDock.current?.mode === 'scene');
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

    // 1. A math card lands in the zone, selected, drawn from its formula.
    await ask('Montre-moi une onde');
    const card = page.locator(selectedMath);
    await card.waitFor();
    assert.equal(await card.locator('.display-block-title').textContent(), 'Une onde');
    assert.equal(await card.locator('.math-plot').getAttribute('data-state'), 'visible');
    assert.equal(await card.locator('input[type=range]').count(), 2);
    const firstPath = await card.locator('.math-plot-curve').getAttribute('d');
    assert.ok(firstPath.split('L').length > 400, 'the curve is sampled from the formula');
    assert.match(await card.locator('.math-plot-formula').textContent(), /y = a · sin\(b · x\)a = 1, b = 1/);
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, `the card stays inside the viewport (${label})`);
    assert.ok(await fitsWidth(), `no horizontal page scroll (${label})`);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-wave.png`) });

    // 2. Moving a slider redraws the curve and changes what Nestor will read.
    await card.locator('input[aria-label="Paramètre a"]').evaluate(input => { input.value = '2.5'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await card.locator('input[aria-label="Paramètre b"]').evaluate(input => { input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.notEqual(await card.locator('.math-plot-curve').getAttribute('d'), firstPath);
    assert.match(await card.locator('.math-plot-values').textContent(), /a = 2\.5, b = 2/);
    await page.screenshot({ path: path.join(output, `${label}-wave-sliders.png`) });
    const followUp = await ask('Et maintenant, que vaut la hauteur ?');
    assert.equal(followUp.screen[0].kind, 'math');
    assert.match(followUp.screen[0].text, /a = 2\.5 in \[-3, 3\]\nb = 2 in \[0\.5, 4\]/);
    assert.equal(followUp.selected.observation, 'formula_and_parameters');
    assert.deepEqual(followUp.selected.math.parameters.map(row => [row.name, row.value]), [['a', 2.5], ['b', 2]]);
    assert.equal(followUp.selected.math.computedBy, 'core');

    // 3. A second card stacks above; the first stays in the zone.
    await ask('Et une parabole ?');
    await page.locator(selectedMath + ' >> text=Parabole').waitFor();
    assert.equal(await page.locator('.page-presentation .display-block[data-kind=math]').count(), 2);
    assert.equal(await page.locator(selectedMath + ' input[type=range]').count(), 3);
    await page.locator(selectedMath).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-parabola.png`) });

    // 4. A formula outside the grammar is shown as code, never drawn.
    await ask('Fais un tracé invalide');
    const refused = page.locator('.page-presentation .display-block[data-kind=code]').first();
    await refused.waitFor();
    assert.match(await refused.locator('.display-block-title').textContent(), /Formule non tracée/);
    assert.equal(await page.locator('.page-presentation .display-block[data-kind=code] .math-plot-curve').count(), 0);

    // 5. Super Dad: the cube picture beside the model's own explanation.
    await ask('Combien font 8 + 5 ?');
    const cubes = page.locator('.page-presentation .display-block[data-kind=scene]');
    await cubes.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.page-presentation .display-block[data-kind=scene] .display-block-stage-caption')?.textContent === '8 + 5 = 13');
    assert.match(await page.locator('.conversation-message').last().textContent(), /le cinq complète la dizaine/);
    await page.locator('.page-presentation').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${label}-cubes.png`) });
    assert.ok(await fitsWidth(), `no horizontal page scroll after all cards (${label})`);
    cases.push({ label, viewport, cardWidth: box.width });
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, cases, liveModelCalls: 0, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: cases.length, liveModelCalls: 0, errors }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
