'use strict';

// Production companion/workspace/GraphysX modules, isolated synthetic inference.
// No online instance, native model, scan, terminal action or audio playback.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('../../node_modules/express');
const { chromium } = require('playwright');
const { renderPage, checkQuery } = require('../../surfaces/diskx');
const { registerPresentationCompanion } = require('../../surfaces/household/presentation-companion');
const pages = require('../../public/js/screen-pages').createCatalog([
  { id: 'ecosystem', label: 'Écosystème', href: '/diskx?app=ecosystem', mode: 'frame' },
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline', mode: 'frame' }
]);
const graph = process.env.GRAPHYSX_CHECKOUT, output = process.env.COMPANION_REPORT_DIR;
if (!graph || !output || path.resolve(output).startsWith(path.resolve(__dirname, '../../..') + path.sep)) {
  throw new Error('Set GRAPHYSX_CHECKOUT to a built embed and COMPANION_REPORT_DIR outside Git.');
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const app = express(); app.use(express.json());
const session = { sessionId: 'synthetic-personal-session', backend: 'hermes', packId: 'personal_operator', scopeId: 'personal', status: 'active', agentId: 'main' };
const cases = {
  ecosystem: 'Explique mon écosystème.', list: 'Construisons la liste alpha et bêta.',
  keep: 'Restons sur cette liste, sans autre vue.', old: 'Ancienne question sur mon écosystème.',
  offline: 'Continue pendant que le suivi visuel est indisponible.'
};
let decisions = 0;
const companion = registerPresentationCompanion({ router: app, catalog: pages,
  conversations: { getSession: async query => query.sessionId === session.sessionId ? session : null },
  envelope: (res, data) => res.json({ ok: true, data }), fail: (res, status, message) => res.status(status).json({ message }),
  decide: async frame => {
    decisions++;
    if (frame.request === cases.old) await wait(1400);
    if (frame.request === cases.offline) throw new Error('Synthetic unavailable local runtime');
    if (frame.request === cases.keep) return { decision: 'keep' };
    return { decision: 'present', reason: 'Accompagner le sujet actuel.',
      evidence: { source: 'request', quote: frame.request },
      block: frame.request === cases.list ? { kind: 'list', title: 'Notre liste', body: '- alpha\n- bêta' }
        : { kind: 'page', title: 'Écosystème', body: 'ecosystem play=overview' } };
  }
});
app.use('/assets/household', express.static(path.resolve(__dirname, '../../surfaces/household/public')));
app.use('/assets/diskx', express.static(path.resolve(__dirname, '../../surfaces/diskx/public')));
app.use('/js', express.static(path.resolve(__dirname, '../../public/js')));
app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../../node_modules/marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.resolve(__dirname, '../../node_modules/dompurify/dist/purify.min.js')));
app.use('/assets', express.static(path.resolve(graph, 'dist/assets')));
app.get('/api/diskx/diskx.js', (_req, res) => res.sendFile(path.resolve(graph, 'dist/embed/diskx.js')));
app.get('/diskx', (req, res) => res.type('html').send(renderPage({ roots: ['/fixture'], attributes: checkQuery(req.query, ['/fixture']) })));
app.post('/fixture/turn', (req, res) => {
  const handle = companion.begin({ session, turnId: req.body.turnId, enabled: req.body.enabled,
    frame: { text: req.body.text, history: [], context: '' } });
  res.type('application/x-ndjson');
  const delta = 'La conversation principale reste disponible.';
  handle?.append(delta); res.write(JSON.stringify({ type: 'delta', delta }) + '\n');
  if (req.body.primary) {
    handle?.explicit(); res.write(JSON.stringify({ type: 'show', block: { kind: 'text', title: 'Choix de Hermes', body: 'Vue demandée explicitement.' } }) + '\n');
  }
  handle?.finish(); res.end(JSON.stringify({ type: 'done' }) + '\n');
});
app.get('/fixture/count', (_req, res) => res.json({ decisions }));
app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html lang="fr"><head>
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Accompagnement contextuel · test isolé</title>
<link rel="stylesheet" href="/assets/household/app.css"><link rel="stylesheet" href="/assets/household/display-board.css">
<link rel="stylesheet" href="/assets/household/conversation-experience.css"><link rel="stylesheet" href="/assets/household/page-presentation.css">
<style>body{margin:0;padding:16px;background:#07131d;color:#e8f4f6}#controls{display:flex;gap:12px;flex-wrap:wrap}#reply{padding:12px}.conversation-heading{font-size:1.5rem}.conversation-layout{display:grid;gap:16px}small{display:block}</style>
</head><body><main id="app"><section class="conversation-shell"><h1 class="conversation-heading">Hermes et son affichage contextuel</h1>
<div class="conversation-layout"><section class="conversation-stage"><div class="conversation-cockpit"><div class="conversation-live" id="controls"></div>
<div class="conversation-dialogue"><p id="reply" role="log">La conversation continue pendant que l’écran s’adapte.</p>
<section id="text"></section><section id="visual"></section></div></div></section></div></section></main>
<script src="/vendor/marked.js"></script><script src="/vendor/purify.js"></script><script src="/js/presentation-markdown.js"></script>
<script src="/js/screen-pages.js"></script><script src="/assets/household/presentation-observation.js"></script>
<script src="/assets/household/page-presentation.js"></script><script src="/assets/household/display-board.js"></script>
<script src="/assets/household/presentation-companion.js"></script><script>
AgentXScreenPages.configure(${JSON.stringify(pages.entries)});
window.session=${JSON.stringify(session)};
const api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json'}});if(!response.ok)throw new Error('Fixture unavailable');return (await response.json()).data;};
window.board=DisplayBoard.createScreen({text:document.querySelector('#text'),visual:document.querySelector('#visual')},{space:'personal'});
window.helper=NestorPresentationCompanion.create({host:document.querySelector('#controls'),board,api,base:'/private/sessions',getSession:()=>session,pollMs:50});
helper.configure('hermes');
window.start=async(text,primary=false)=>{const turnId=crypto.randomUUID(),enabled=helper.begin(session,turnId);window.mainFinished=false;
const response=await fetch('/fixture/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,turnId,enabled,primary})});helper.follow();
for(const line of (await response.text()).trim().split('\\n')){const event=JSON.parse(line);if(event.type==='delta')document.querySelector('#reply').textContent=event.delta;if(event.type==='show'){helper.explicit();board.add(event.block);}if(event.type==='done')window.mainFinished=true;}return turnId;};
</script></body></html>`));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  let browser; const checks = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.getByRole('checkbox', { name: 'Affichage contextuel' }).check();
    await page.evaluate(text => start(text), cases.ecosystem);
    assert.equal(await page.evaluate(() => mainFinished), true);
    assert.equal(decisions, 0, 'main reply settled before any companion call');
    await page.locator('iframe.display-block-page').waitFor();
    const frame = await page.locator('iframe.display-block-page').elementHandle().then(element => element.contentFrame());
    await frame.waitForURL('**/diskx?**');
    try {
      await frame.waitForFunction(() => window.AgentXPresentedContent?.observation?.sequence > 0, null, { timeout: 15000 });
    } catch (error) {
      fs.writeFileSync(path.join(output, 'render-failure.json'), JSON.stringify({ errors,
        state: await frame.evaluate(() => ({ defined: !!customElements.get('agentx-ecosystem'),
          observation: window.AgentXPresentedContent, status: document.querySelector('#diskx-status')?.textContent,
          view: document.querySelector('agentx-ecosystem')?.state?.() })) }, null, 2));
      await page.screenshot({ path: path.join(output, 'render-failure.png'), fullPage: true }); throw error;
    }
    checks.push('The main reply finishes independently and the real GraphysX ecosystem renders.');
    await page.screenshot({ path: path.join(output, 'ecosystem-desktop.png'), fullPage: true });
    await page.evaluate(text => start(text), cases.list);
    await page.waitForFunction(() => document.querySelector('.display-block:not([hidden])')?.textContent.includes('Notre liste'));
    assert.match(await page.locator('.display-block:not([hidden])').textContent(), /alpha.*bêta/s);
    assert.equal(await page.locator('.display-block:not([hidden]) li').count(), 2);
    checks.push('The current conversation can select a list through the shared display surface.');
    const beforeKeep = await page.locator('.display-block:not([hidden])').textContent();
    await page.evaluate(text => start(text), cases.keep); await wait(1100);
    assert.equal(await page.locator('.display-block:not([hidden])').textContent(), beforeKeep);
    checks.push('A keep decision leaves the useful current view intact.');
    await page.getByRole('button', { name: 'Épingler la vue', exact: true }).click();
    const beforePin = decisions; await page.evaluate(text => start(text), cases.ecosystem); await wait(1000);
    assert.equal(decisions, beforePin, 'pinning prevents new companion compute');
    assert.equal(await page.locator('.display-block:not([hidden])').textContent(), beforeKeep);
    await page.getByRole('button', { name: 'Vue épinglée', exact: true }).click();
    checks.push('Pinned content remains selected across new turns.');
    await page.evaluate(text => start(text, true), cases.ecosystem); await wait(1000);
    assert.match(await page.locator('.display-block:not([hidden])').textContent(), /Choix de Hermes/);
    checks.push('Explicit primary-agent display takes precedence.');
    await page.evaluate(text => start(text), cases.old); await wait(950);
    await page.evaluate(text => start(text), cases.keep); await wait(1700);
    assert.match(await page.locator('.display-block:not([hidden])').textContent(), /Choix de Hermes/);
    checks.push('A delayed answer to an older subject cannot replace the current view.');
    await page.evaluate(text => start(text), cases.offline);
    assert.equal(await page.evaluate(() => mainFinished), true);
    await page.getByRole('status').filter({ hasText: 'Suivi visuel indisponible' }).waitFor();
    checks.push('Companion failure leaves the principal conversation usable.');
    await page.evaluate(text => start(text), cases.list);
    await page.waitForFunction(() => document.querySelector('.display-block:not([hidden])')?.textContent.includes('Notre liste'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'list-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    checks.push('The selected list and user controls remain usable at mobile width.');
    await page.evaluate(text => start(text), cases.old); await wait(950);
    await page.getByRole('combobox', { name: 'Contenu affiché' }).selectOption({ label: 'Choix de Hermes' });
    await wait(1700);
    assert.match(await page.locator('.display-block:not([hidden])').textContent(), /Choix de Hermes/);
    checks.push('A manual selection wins over an already pending companion decision.');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', checks, decisions,
      qualification: 'Synthetic decisions and production browser modules; no model-quality or physical-device acceptance.' }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
  } finally { companion.close(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
