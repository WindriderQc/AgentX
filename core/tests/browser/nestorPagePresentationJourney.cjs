'use strict';
// Real conversation markup and styles; all destinations stay on loopback.
// No application server, model, microphone, WebGL renderer or live service.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const core = path.resolve(__dirname, '../..'), req = createRequire(core + '/package.json');
const express = req('express'), { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const { createReplyChannels } = req('./surfaces/household/reply-channels');
const linkChannels = createReplyChannels();
for (const character of 'Source : [Le ciel de novembre](https://example.test/astronomy/night-sky-2026?source=reference).') linkChannels.push(character);
const linkReply = linkChannels.end();
assert.equal(linkReply.display[0].kind, 'link');
assert.equal(linkReply.say, 'Source : (à l’écran).');
const reportDir = process.env.PAGE_PRESENTATION_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(path.resolve(core, '..') + path.sep)) throw Error('Set PAGE_PRESENTATION_REPORT_DIR outside the checkout');
fs.mkdirSync(reportDir, { recursive: true });
const source = fs.readFileSync(core + '/surfaces/household/public/conversation-page.js', 'utf8').replace(/\r\n/g, '\n');
const template = source.match(/app.innerHTML = (`[\s\S]*?`);\n  const el/)[1];
const markup = new Function('family', 'personas', 'agents', 'runtime', 'esc', `return ${template}`)(false, [], [], {}, String);
const styles = ['app', 'avatar-dock', 'display-board', 'conversation-experience', 'workflow-cockpit', 'page-presentation'];
let server, browser;
(async () => {
  const app = express();
  app.use('/assets/household', express.static(core + '/surfaces/household/public'));
  app.use('/js', express.static(core + '/public/js'));
  app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Page et conversation</title>${styles.map(name => `<link rel="stylesheet" href="/assets/household/${name}.css">`).join('')}
    <style>nav{height:56px;border-bottom:1px solid #29404d;padding:12px 24px;box-sizing:border-box} .avatar-dock-orb{opacity:1!important}</style>
    <body class="household-product"><nav>AgentX · Personnel · Famille · Atelier</nav><main id="app">${markup}</main>
    <script src="/js/screen-pages.js"></script><script src="/assets/household/page-presentation.js"></script>
    <script src="/assets/household/presentation-observation.js"></script>
    <script src="/js/markdown-links.js"></script><script src="/assets/household/display-board.js"></script><script src="/assets/household/avatar-dock.js"></script>
    <script>
      AgentXScreenPages.configure([{id:'dad-day',label:'Ma journée',href:'/dad/day',mode:'frame'},{id:'dad-memories',label:'Mes souvenirs',href:'/dad/memories',mode:'frame'}]);
      customElements.define('llmx-face', class extends HTMLElement {});
      window.dock = AvatarDock.mount({space:'personal'});
      window.board = DisplayBoard.createScreen({text:document.getElementById('conversationBoard'),visual:document.getElementById('conversationVisual')});
      document.getElementById('conversationStatus').textContent = 'Je vous écoute';
      document.getElementById('conversationStart').hidden = false;
      document.getElementById('conversationStart').disabled = false;
      document.getElementById('conversationStart').textContent = 'Pause de la voix';
      document.getElementById('conversationTranscript').innerHTML = '<div class="conversation-message assistant">Voici votre journée. Je reste disponible pendant la consultation.</div><div class="conversation-message user">On regarde les rendez-vous ensemble.</div>';
      document.getElementById('conversationWorkflow').innerHTML = '<p>Diagnostic du moteur et de la voix</p>';
      // As the conversation does: draw the card, then tell the avatar something is shown.
      window.showPage = (body='dad-day', title='Ma journée') => { board.add({kind:'page',body,title});
        dispatchEvent(new CustomEvent('persona-activity', { detail: { space: 'personal', kind: 'show' } })); };
    </script></html>`));
  let loads = 0;
  app.get('/dad/day', (_req, res) => { loads++; res.send(`<title>Ma journée</title><style>body{font:16px system-ui;background:#102333;color:#e1eef8;padding:24px}h1{font-size:36px}article{padding:24px;border:1px solid #426375;border-radius:14px;margin:20px 0;background:#183447}input{padding:12px;font:inherit}</style><h1>Ma journée</h1><h2>Mes rendez-vous</h2><article>09:00 · Réunion de projet</article><article>14:30 · Rendez-vous</article><label>Note <input value="À préparer"></label>`); });
  app.get('/dad/memories', (_req, res) => res.send('<title>Mes souvenirs</title><h1>Mes souvenirs</h1>'));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PAGE_PRESENTATION_BROWSER_EXECUTABLE && { executablePath: process.env.PAGE_PRESENTATION_BROWSER_EXECUTABLE }) });
  const results = [], errors = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 900, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base + '/fixture');
    await page.evaluate(() => showPage());
    await page.frameLocator('iframe').getByRole('heading', { name: 'Mes rendez-vous' }).waitFor();
    await page.frameLocator('iframe').getByRole('textbox').fill('Conserver cette note');
    const initialLoads = loads;
    const rect = selector => page.evaluate(selector => { const r = document.querySelector(selector).getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height }; }, selector);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    // Nestor full screen presents the content alone, as in Famille.
    assert.equal(await page.evaluate(() => document.body.dataset.avatarView), 'montre');
    assert.equal(await page.locator('.page-presentation').isVisible(), true);
    assert.equal(await page.locator('.conversation-transcript').isVisible(), false);
    assert.equal(await page.locator('.page-presentation-actions').isVisible(), false);
    const fullScreen = { frame: await rect('iframe'), overflow: await overflow() };
    assert.equal(fullScreen.overflow, false);
    assert.ok(fullScreen.frame.width >= viewport.width * (viewport.width > 700 ? .6 : .8));
    await page.screenshot({ path: path.join(reportDir, `montre-${viewport.width}.png`) });
    // In the page itself, the zone sits at the top of the conversation, above the messages.
    await page.evaluate(() => dock.setMode('bulle'));
    const bounds = { frame: await rect('iframe'), zone: await rect('.page-presentation'), dialogue: await rect('.conversation-dialogue'),
      transcript: await rect('.conversation-transcript'), overflow: await overflow() };
    assert.equal(bounds.overflow, false);
    assert.ok(bounds.zone.y + bounds.zone.height <= bounds.transcript.y + 1);
    assert.ok(bounds.zone.x >= bounds.dialogue.x && bounds.zone.x + bounds.zone.width <= bounds.dialogue.x + bounds.dialogue.width + 1);
    assert.ok(bounds.frame.width >= bounds.dialogue.width * .8, JSON.stringify({ viewport, bounds }));
    await page.screenshot({ path: path.join(reportDir, `page-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Fermer le contenu' }).click();
    assert.equal(await page.locator('.page-presentation').evaluate(el => el.classList.contains('is-active')), false);
    assert.deepEqual(await page.evaluate(() => board.context()), [], 'a collapsed page is not visible turn context');
    await page.getByRole('button', { name: 'Afficher le contenu' }).click();
    assert.equal(await page.frameLocator('iframe').getByRole('textbox').inputValue(), 'Conserver cette note');
    assert.equal(loads, initialLoads, 'switching layouts preserves the live frame');
    await page.evaluate(() => showPage('dad-memories', 'Mes souvenirs'));
    // Every card stays in the zone; the selected one is what Nestor reads.
    assert.equal(await page.locator('.page-presentation .display-block:visible').count(), 2);
    assert.deepEqual(await page.evaluate(() => board.context().map(item => item.page)), ['dad-memories']);
    await page.locator('.page-presentation select').selectOption({ label: 'Ma journée' });
    assert.equal(await page.frameLocator('.display-block[data-selected="true"] iframe').getByRole('textbox').inputValue(), 'Conserver cette note');
    assert.deepEqual(await page.evaluate(() => board.context().map(item => item.page)), ['dad-day']);
    assert.equal(await page.locator('.page-presentation .display-block:visible').count(), 2);
    await page.evaluate(() => board.clear());
    assert.equal(await page.locator('.page-presentation').isVisible(), false);
    // Images, text and pages share the same personal content workspace.
    await page.evaluate(() => board.add({kind:'image',body:'Illustration',status:'missing'}));
    assert.equal(await page.locator('.page-presentation.is-active').count(), 1);
    assert.equal((await page.evaluate(() => board.context()))[0].status, 'unavailable');
    await page.evaluate(() => board.add({kind:'list',title:'Outils',body:'- Un\n- Deux'}));
    assert.equal(await page.locator('#conversationBoard').isVisible(), false);
    assert.equal(await page.locator('#conversationVisual').isVisible(), false);
    assert.equal((await page.evaluate(() => board.context()))[0].kind, 'list');
    assert.equal(await page.locator('.conversation-text').isVisible(), true);
    assert.equal(await page.locator('#conversationWorkflow').isVisible(), true);
    assert.equal(await page.locator('.conversation-toolbar').isVisible(), true);
    await page.evaluate(block => board.add(block), linkReply.display[0]);
    const reference = page.locator('.page-presentation .display-block[data-selected="true"] a').filter({ hasText: 'https://example.test/astronomy' });
    assert.equal(await reference.getAttribute('href'), linkReply.display[0].body);
    assert.equal(await page.locator('.page-presentation .display-block[data-selected="true"] code').count(), 0);
    await page.evaluate(() => board.add({ kind: 'link', body: '[Le ciel de novembre](https://example.test/astronomy/night-sky-2026?source=reference)' }));
    assert.equal(await page.locator('.page-presentation .display-block[data-selected="true"] a').filter({ hasText: 'Le ciel de novembre' }).getAttribute('href'), linkReply.display[0].body);
    assert.equal(await overflow(), false);
    await page.screenshot({ path: path.join(reportDir, `link-${viewport.width}.png`), fullPage: true });
    // The request pipeline folds under the conversation.
    await page.locator('#conversationPipeline > summary').click();
    assert.equal(await page.locator('#conversationWorkflow').isVisible(), false);
    await page.locator('#conversationPipeline > summary').click();
    assert.equal(await page.locator('#conversationWorkflow').isVisible(), true);
    await page.evaluate(() => { dock.setMode('quart'); showPage(); });
    assert.equal(await page.locator('.page-presentation.is-active').isVisible(), true);
    assert.equal(await overflow(), false);
    await page.getByRole('button', { name: 'Fermer le contenu' }).click();
    assert.equal(await page.evaluate(() => dock.mode), 'quart', 'the saved avatar mode is preserved');
    await page.evaluate(() => { showPage(); document.getElementById('app').replaceChildren(); });
    await page.waitForFunction(() => !document.querySelector('.page-presentation'));
    assert.equal(await page.evaluate(() => document.body.dataset.avatarMode), 'quart');
    results.push({ viewport, fullScreen, bounds });
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({ ok:true, modelCalls:0, results }, null, 2));
  console.log(JSON.stringify({ ok:true, modelCalls:0, viewports:results.length, reportDir }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
});
