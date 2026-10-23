'use strict';
// Real presentation/parser/Analytics components with synthetic CPU fixtures.
// No production requests, model, microphone, synthesis or image rendering.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const root = path.resolve(__dirname, '../../..'), core = path.join(root, 'core');
const report = process.env.AGENTX_PRESENTATION_BROWSER_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-presentation-'));
const { createReplyChannels, storedDisplay } = require('../../surfaces/household/reply-channels');
const { presentationReader } = require('../../src/services/presentationReadService');
const { presentationEvidence } = require('../../surfaces/household/screen-context');
const { buildProductNavigation } = require('../../../shared/productNavigation');
const catalog = require('../../public/js/screen-pages').createCatalog([
  { id: 'analytics', label: 'Activity', href: '/analytics', mode: 'frame' },
  { id: 'service', label: 'External service', href: 'https://service.invalid', mode: 'link' }
]);
let slow = false, fail = false, failLive = false, summaryRequests = 0;
const requests = [], errors = [];
const summary = key => {
  const to = new Date(), from = new Date(+to - (key === '24h' ? 1 : 7) * 86400000);
  const calls = key === '24h' ? 42 : 314;
  const data = { source: 'inferencelogs', scope: 'Recorded attempts', window: { key, from, to }, bucketHours: key === '24h' ? 1 : 24,
    totals: { calls, errors: 2, cancellations: 1, nonSuccesses: 3, tokensIn: 6000, tokensOut: 1200, callsPerDay: calls,
      inferenceSeconds: 42, inferenceHours: 42 / 3600, avgLatencyMs: 1000, errorRate: 2 / calls * 100, fallbackCalls: 0, fallbackRate: 0 },
    byModel: [{ model: 'example-local', calls, errors: 2, inferenceSeconds: 42, avgLatencyMs: 1000 }],
    byConsumerContract: [{ consumerContract: 'example-conversation', calls, errors: 2 }],
    byBucket: [{ date: from.toISOString(), calls, errors: 2, tokensOut: 1200, avgLatencyMs: 1000 }],
    local: { calls, inferenceHours: 42 / 3600 }, cloud: { calls: 0, estimatedCostUsd: null, unpricedModels: [] },
    coverage: { retentionDays: 30, modelCount: 1 }, failureAnalysis: { admissionRefusals: 2 },
    topErrors: [{ reason: 'workload_reserved', calls: 2, avgLatencyMs: 10 }] };
  data.presentation = presentationReader.publishAnalytics(data);
  return data;
};
function fixtureBlocks() {
  const parser = createReplyChannels({ allowPages: true, pageCatalog: catalog });
  parser.push('Je te montre la liste.\n<show kind="list" title="Outils de la session">### Recherche\n');
  for (let n = 1; n <= 32; n++) parser.push(`- \`example_tool_${n}\` : **outil ${n}**\n`);
  parser.push('</show>');
  return parser.end();
}
const fixture = fixtureBlocks();
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nestor · Présentation</title><link rel="stylesheet" href="/assets/household/display-board.css">
<link rel="stylesheet" href="/assets/household/page-presentation.css"><style>
:root{--line:#263d48;--panel:#10222c;--panel-2:#132b37;--cyan:#58d6d3;--soft:#a7bec9;--green:#8ce6bb;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:#081820;color:#edf7fb;font:16px system-ui}#app{padding:20px;max-width:1100px;margin:auto}
.conversation-shell{max-width:1100px;margin:auto}.conversation-layout{display:grid;gap:20px}.conversation-stage{min-width:0}
button,select,textarea{font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:inherit}button{cursor:pointer}
.conversation-text textarea{width:100%}.conversation-transcript{padding:12px;line-height:1.5}.avatar-dock{display:flex;align-items:center;justify-content:center;background:#17414d;color:var(--cyan);font-size:2em}
</style><main id="app"><section class="conversation-shell"><h1>Nestor</h1><div class="conversation-layout">
<section class="conversation-stage"><div class="conversation-cockpit"><div class="conversation-live"><div class="avatar-dock" aria-label="Avatar réactif">✦</div><span>Conversation disponible</span><button id="stop">Interrompre</button></div>
<div class="conversation-dialogue"><div class="conversation-transcript">Parlons de ce que tu vois. La voix et le texte partagent le même contenu.</div><form class="conversation-text"><textarea aria-label="Message" placeholder="Parle-moi de cette page…"></textarea><button>Envoyer</button></form></div>
<section id="visual" class="conversation-board conversation-visual" hidden></section><section id="text" class="conversation-board" hidden></section></div></section></div></section></main>
<script src="/vendor/marked.js"></script><script src="/vendor/purify.js"></script><script src="/js/presentation-markdown.js"></script>
<script src="/js/screen-pages.js"></script><script src="/assets/household/presentation-observation.js"></script>
<script src="/assets/household/page-presentation.js"></script><script src="/assets/household/display-board.js"></script>
<script>AgentXScreenPages.configure(${JSON.stringify(catalog.entries)});window.board=DisplayBoard.createScreen({text:document.getElementById('text'),visual:document.getElementById('visual')},{space:'personal',secrets:true});
document.querySelector('form').addEventListener('submit',event=>event.preventDefault());
window.read=async()=>{const r=await fetch('/selected-context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(board.context())});return r.json()};
</script></html>`;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture.invalid'), p = url.pathname;
    requests.push(req.method + ' ' + p);
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (p === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
    if (p === '/selected-context') {
      let body = ''; for await (const chunk of req) body += chunk;
      return json(presentationEvidence(JSON.parse(body), catalog));
    }
    if (p === '/api/analytics/inference/summary') {
      summaryRequests++;
      const data = summary(url.searchParams.get('window'));
      if (slow) await new Promise(resolve => setTimeout(resolve, 400));
      if (fail) { res.statusCode = 503; return json({ ok: false }); }
      return json({ ok: true, data });
    }
    if (p.startsWith('/api/')) {
      assert.equal(req.method, 'GET');
      if (p.includes('runtime-coordination')) {
        if (failLive) { res.statusCode = 503; return json({ ok: false }); }
        const data = { inferences: [{ active: true, model: 'example-live', expiresAt: new Date(Date.now() + 60000).toISOString(), prompt: 'PRIVATE_PROMPT' }], workloads: [] };
        return json({ ok: true, data, presentation: presentationReader.publishRuntime(data) });
      }
      if (p.includes('gpu-status')) {
        if (failLive) { res.statusCode = 503; return json({ ok: false }); }
        const data = [{ hostId: 'PRIVATE_HOST', telemetry: { status: 'fresh', collectorHostId: 'a', ageMs: 100, staleAfterMs: 90000 },
          gpus: [{ index: 0, name: 'Example GPU', utilization: 42, vramUsed: 1000, vramTotal: 12000 }] }];
        return json({ ok: true, data, presentation: presentationReader.publishGpus(data) });
      }
      return json({ ok: true, data: p.includes('gpu-status') ? [] : p.includes('runtime-coordination') ? { inferences: [], workloads: [] } : {} });
    }
    if (p === '/analytics') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(await ejs.renderFile(path.join(core, 'views/layouts/main.ejs'), {
        title: 'AI activity', service: 'core', activePage: 'analytics', pageView: '../pages/analytics',
        publicUrls: { core: '', rag: '/rag', benchmark: '/benchmark' }, agentxProfile: 'full', buildProductNavigation,
        headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/analytics-experience.css"><script src="/vendor/chart.js"></script>',
        footerJs: '<script type="module" src="/js/analytics-inference.js"></script><script src="/js/analytics-experience.js"></script><script src="/js/analytics-live-values.js"></script><script src="/js/analytics-overview.js"></script>'
      }));
    }
    let file = path.join(core, p.startsWith('/assets/household/') ? 'surfaces/household/public' : 'public', p.replace(/^\/assets\/household\//, ''));
    const vendors = { '/vendor/marked.js': 'marked/lib/marked.umd.js', '/vendor/purify.js': 'dompurify/dist/purify.min.js', '/vendor/chart.js': 'chart.js/dist/chart.umd.js' };
    if (vendors[p]) file = path.join(core, 'node_modules', vendors[p]);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('fixture asset missing'); }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  } catch (error) { res.statusCode = 500; res.end(error.stack); }
});
(async () => {
  fs.mkdirSync(report, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => board.add({ kind: 'page', body: 'analytics', title: 'Activité IA' }));
    await page.frameLocator('iframe').locator('#ao-calls').filter({ hasText: '42' }).waitFor({ timeout: 10000 }).catch(async error => {
      console.error(JSON.stringify({ requests, errors, frames: await Promise.all(page.frames().map(frame => frame.evaluate(() => ({
        title: document.title, body: document.body?.innerText.slice(0, 2000), scripts: [...document.scripts].map(s => s.src)
      })))) }));
      throw error;
    });
    let current = await page.evaluate(() => read());
    assert.equal(current.read.totals.calls, 42); assert.equal(current.read.filters.window, '24h');
    await page.frameLocator('iframe').locator('#ao-active').filter({ hasText: '1' }).waitFor();
    await page.frameLocator('iframe').locator('#ao-gpus strong').filter({ hasText: '42%' }).waitFor();
    current = await page.evaluate(() => read());
    assert.equal(current.liveRead.runtime.active, 1);
    assert.equal(current.liveRead.gpus.gpus[0].utilization, 42);
    assert.doesNotMatch(JSON.stringify(current), /PRIVATE_PROMPT|PRIVATE_HOST/);
    failLive = true;
    await page.frames()[1].evaluate(() => document.dispatchEvent(new Event('analytics:refresh-live')));
    await page.frameLocator('iframe').locator('#ao-live-status').filter({ hasText: 'unavailable' }).waitFor();
    await page.frameLocator('iframe').locator('#ao-gpus').filter({ hasText: 'unavailable' }).waitFor();
    current = await page.evaluate(() => read());
    assert.equal(current.liveRead.runtime.status, 'unavailable');
    assert.equal(current.liveRead.gpus.status, 'unavailable');
    assert.equal(current.read.totals.calls, 42, 'independent live failure preserves the historical view');
    failLive = false;
    await page.frames()[1].evaluate(() => document.dispatchEvent(new Event('analytics:refresh-live')));
    await page.frameLocator('iframe').locator('#ao-active').filter({ hasText: '1' }).waitFor();
    const old = current.read.revision;
    slow = true;
    await page.frameLocator('iframe').locator('#analyticsWindow').selectOption('7d');
    current = await page.evaluate(() => read()); assert.equal(current.status, 'loading'); assert.equal(current.read, undefined);
    await page.frameLocator('iframe').locator('#ao-calls').filter({ hasText: '314' }).waitFor();
    current = await page.evaluate(() => read()); assert.equal(current.read.totals.calls, 314); assert.notEqual(current.read.revision, old);
    await page.frameLocator('iframe').locator('[data-ao-group="byConsumerContract"]').click();
    assert.equal((await page.evaluate(() => read())).comparison, 'byConsumerContract');
    slow = false;
    await page.screenshot({ path: path.join(report, 'analytics-desktop.png'), fullPage: true });
    await page.evaluate(blocks => board.restore(blocks), storedDisplay(fixture.display));
    assert.equal(await page.locator('.display-block:not([hidden]) li').count(), 32);
    assert.equal(await page.locator('.display-block:not([hidden]) h3').textContent(), 'Recherche');
    assert.doesNotMatch(await page.locator('.display-block:not([hidden])').textContent(), /###|\*\*|`/);
    assert.equal((await page.evaluate(() => read())).kind, 'list');
    assert.equal(await page.locator('#visual').isVisible(), false); assert.equal(await page.locator('#text').isVisible(), false);
    await page.locator('.display-block:not([hidden]) button').filter({ hasText: 'Copy' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), fixture.display[0].body);
    const before = summaryRequests;
    await page.locator('.page-presentation select').selectOption('1');
    assert.equal((await page.evaluate(() => read())).kind, 'page');
    assert.equal(summaryRequests, before, 'selecting a retained page does not reload or replay it');
    await page.locator('[data-action="toggle"]').click();
    assert.equal((await page.evaluate(() => read())).status, 'none');
    await page.locator('[data-action="toggle"]').click();
    assert.equal(summaryRequests, before);
    await page.locator('.page-presentation select').selectOption('0');
    await page.locator('[data-action="expand"]').click();
    assert.equal(await page.locator('[data-action="expand"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-action="expand"]').press('Escape');
    assert.equal(await page.locator('[data-action="toggle"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-action="toggle"]').evaluate(el => el === document.activeElement), true);
    await page.locator('[data-action="toggle"]').click();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow at ${width}`);
      assert.equal(await page.locator('textarea').isVisible(), true);
      await page.screenshot({ path: path.join(report, `list-${width}.png`), fullPage: true });
    }
    await page.evaluate(() => board.add({ kind: 'text', title: '', body: '## Note\n<script>window.INJECTED=true</script>\n<img src="https://bad.invalid/private">\n[unsafe](javascript:alert(1))\n**Lisible**' }));
    assert.equal(await page.locator('.display-block:not([hidden]) img, .display-block:not([hidden]) script').count(), 0);
    assert.equal(await page.evaluate(() => window.INJECTED), undefined);
    assert.equal(await page.locator('.page-presentation select option').first().textContent(), 'Note');
    await page.evaluate(() => board.add({ kind: 'code', body: 'const value = "' + 'x'.repeat(400) + '";' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(() => board.add({ kind: 'table', body: '| Nom | Valeur |\n| --- | --- |\n| Exemple | ' + 'x'.repeat(400) + ' |' }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(() => board.add({ kind: 'page', body: 'service' }));
    assert.equal((await page.evaluate(() => read())).status, 'external');
    assert.match(await page.locator('.display-block:not([hidden])').textContent(), /ne voit pas/);
    await page.evaluate(() => board.add({ kind: 'image', source: 'web', status: 'missing', body: 'example' }));
    current = await page.evaluate(() => read()); assert.equal(current.status, 'unavailable'); assert.equal(current.observation, 'pixels_not_supplied');
    await page.evaluate(() => { board.clear(); });
    assert.equal((await page.evaluate(() => read())).status, 'none');
    await page.reload(); await page.evaluate(blocks => board.restore(blocks), storedDisplay(fixture.display));
    assert.equal(await page.locator('.display-block:not([hidden]) li').count(), 32);
    assert.equal(requests.filter(r => /turns\/text|\/inference\/execute|\/images/.test(r)).length, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify({ ok: true, errors, summaryRequests, checks: 'selected snapshot, filter invalidation, canonical block restore, Markdown, copy, history without reload, close, keyboard, mobile widths, external/missing image, no business replay' }, null, 2));
    console.log(JSON.stringify({ ok: true, report, summaryRequests }));
  } finally {
    if (errors.length) console.error(JSON.stringify({ browserErrors: errors }));
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
