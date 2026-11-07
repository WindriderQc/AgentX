'use strict';
// CPU/loopback only: production catalogue, workspace, templates, frame policy,
// observation and focus. Domain HTTP responses are synthetic; no model or LAN.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const core = path.resolve(__dirname, '../..'), req = createRequire(core + '/package.json');
const express = req('express'), ejs = req('ejs');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const { createScreenServices } = require('../../surfaces/household/screen-services');
const { productPageConfig } = require('../../../shared/productPageConfig');
const report = process.env.SCREEN_FOCUS_REPORT_DIR || '/tmp/agentx-screen-focus-924';
if (path.resolve(report).startsWith(path.resolve(core, '..') + path.sep)) throw Error('Reports stay outside Git');
fs.mkdirSync(report, { recursive: true });
let server, browser, base, failReads = false, pendingRead, delayedRead;
const requests = [], errors = [];
const urls = () => ({ core: base, benchmark: base + '/benchmark', rag: base + '/rag' });
(async () => {
  const app = express(); app.set('view engine', 'ejs');
  app.use((request, response, next) => {
    requests.push({ method: request.method, path: request.path });
    response.set('X-Frame-Options', 'DENY');
    response.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; img-src 'self' data:");
    if (request.method !== 'GET') return response.status(405).end();
    next();
  });
  app.use('/assets/household', express.static(core + '/surfaces/household/public'));
  app.use('/js', express.static(core + '/public/js'));
  require('../../routes/cluster-screen-page')(app);
  const resolvePublicUrls = async () => urls(); resolvePublicUrls.resolveNavigation = async () => [];
  const benchmark = express.Router();
  benchmark.use(productPageConfig({ app, resolvePublicUrls, service: 'benchmark' }));
  require('../../../shared/consultationScreen').registerAssets(benchmark);
  benchmark.get('/profiler', require('../../../benchmark/routes/profiler-screen-page'), (_req, res) => res.send('Native profiler'));
  app.use('/benchmark', benchmark);
  app.get('/benchmark/api/profiler/dashboard', async (_req, res) => {
    if (pendingRead) { const wait = pendingRead; pendingRead = null; await wait; }
    if (failReads) return res.status(503).json({ status: 'error' });
    res.json({ status: 'success', data: { hosts: [{ displayName: '<img src=x onerror=alert(1)>', baseline: { testedAt: '2026-01-02T03:04:05.000Z' } }],
      funnel: { available: 2, profiled: 1, benchmarked: 1 }, staleProfiles: [{ modelName: 'Synthetic stale artifact' }] } });
  });
  app.get('/api/cluster/schedule/timeline', async (_req, res) => {
    if (delayedRead) { const wait = delayedRead; delayedRead = null; await wait; }
    if (failReads) return res.status(503).json({ status: 'error' });
    res.json({ status: 'success', data: { date: '2026-01-02', timezone: 'UTC', timeline: [{ name: 'Synthetic reservation',
      slots: [{ start: '2026-01-02T01:00:00.000Z', end: '2026-01-02T02:00:00.000Z' }] }] } });
  });
  app.get('/api/cluster/schedule/heavy-queue', (_req, res) => res.json({ status: 'success', data: {
    available: true, authority: 'core.heavy-work-queue', observedAt: '2026-01-02T03:04:05.000Z',
    jobs: [{ title: 'Synthetic request', state: 'reserved', presentation: { label: 'Planifié' }, reservation: { start: '2026-01-03T01:00:00.000Z' } }]
  } }));
  // The shipped Pipeline/Analytics markup supplies the fixed anchors. Their
  // application scripts are covered by existing journeys; this fixture never
  // mounts a native control handler or invents a numeric presentation receipt.
  for (const page of ['pipeline', 'analytics']) app.get('/' + page, async (_req, res) => {
    require('../../../shared/screenView').allowScreenFrame(res);
    const markup = await ejs.renderFile(core + `/views/pages/${page}.ejs`, { publicUrls: urls(), agentxProfile: 'full' });
    res.send(`<html><head><title>${page}</title><style>body{color:white;background:#102333}section{padding:24px}</style></head><body>${markup}
      <script>window.AgentXPresentedContent={contract:'agentx.presentation/v1',state:'ready'}</script></body></html>`);
  });
  app.get('/fixture', (_req, res) => {
    const catalog = createScreenServices({ app: { locals: { publicUrls: urls(), agentxProfile: 'full' } }, env: {} });
    res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nestor screens</title>
      <link rel="stylesheet" href="/assets/household/display-board.css"><link rel="stylesheet" href="/assets/household/page-presentation.css">
      <main id="app"><div class="conversation-layout"><section id="text"></section><section id="visual"></section></div></main>
      <script src="/js/screen-pages.js"></script><script src="/assets/household/page-presentation.js"></script>
      <script src="/assets/household/screen-page-focus.js"></script><script src="/assets/household/presentation-observation.js"></script>
      <script src="/assets/household/display-board.js"></script><script>
      AgentXScreenPages.configure(${JSON.stringify(catalog.entries)});
      window.board=DisplayBoard.createScreen({text:document.getElementById('text'),visual:document.getElementById('visual')});
      window.show=body=>board.add({kind:'page',body,title:body});
      </script>`);
  });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.SCREEN_FOCUS_BROWSER_EXECUTABLE && { executablePath: process.env.SCREEN_FOCUS_BROWSER_EXECUTABLE }) });
  const results = [];
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000); await page.goto(base + '/fixture');
    const observation = () => page.evaluate(() => board.context()[0]);
    for (const body of ['profiler section=models', 'cluster-schedule section=queue', 'pipeline section=attention', 'analytics section=comparison']) {
      let finishInitial;
      if (body.startsWith('profiler')) pendingRead = new Promise(resolve => { finishInitial = resolve; });
      assert.equal(await page.evaluate(body => show(body), body), true);
      if (finishInitial) {
        await page.waitForFunction(() => board.context()[0]?.status === 'loading');
        finishInitial();
      }
      await page.waitForFunction(() => board.context()[0]?.status === 'visible' && board.context()[0]?.focus?.status === 'applied');
      const frame = page.frameLocator('.display-block[data-selected="true"] iframe');
      assert.equal(await frame.locator('.agentx-section-focus').count(), 1);
      assert.equal((await observation()).page, body);
      const focusedHeading = await frame.locator('.agentx-section-focus').evaluate(node => {
        const heading = node.querySelector('h1,h2,h3') || node;
        const rect = heading.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: innerHeight };
      });
      assert.ok(focusedHeading.top >= 0 && focusedHeading.bottom <= focusedHeading.height, 'the focused heading is inside the frame after the read settles');
      if (/profiler|cluster-schedule/.test(body)) {
        assert.equal(await frame.locator('nav, form, a, [data-lane-action], [onclick]').count(), 0);
        assert.equal(await frame.locator('button').count(), 1, 'the sole control refreshes the read');
        assert.equal((await observation()).read, undefined, 'headings do not invent a numeric snapshot');
      }
    }
    assert.equal(await page.evaluate(() => show('profiler section=launch')), false);
    assert.equal(await page.evaluate(() => show('https://arbitrary.test/page')), false);
    await page.evaluate(() => show('profiler section=hosts'));
    await page.waitForFunction(() => board.context()[0]?.status === 'visible');
    let frame = page.frameLocator('.display-block[data-selected="true"] iframe');
    await frame.getByText('<img src=x onerror=alert(1)>', { exact: false }).waitFor();
    assert.equal(await frame.locator('img').count(), 0, 'read values render as text');
    assert.match(await frame.locator('main').innerText(), /2026-01-02T03:04:05.000Z/);
    const beforeFocus = requests.filter(row => row.path === '/benchmark/api/profiler/dashboard').length;
    const previous = await observation();
    await page.evaluate(() => show('profiler section=models'));
    await page.waitForFunction(() => board.context()[0]?.focus?.section === 'models' && board.context()[0]?.focus?.status === 'applied');
    assert.equal(await frame.locator('.agentx-section-focus').count(), 1);
    assert.equal(requests.filter(row => row.path === '/benchmark/api/profiler/dashboard').length, beforeFocus, 'section changes preserve the existing read and frame');
    assert.equal((await observation()).id, previous.id);
    assert.notEqual((await observation()).revision, previous.revision);
    const scroll = await frame.locator('body').evaluate(() => scrollY);
    await page.evaluate(() => { for (let n = 0; n < 5; n++) board.context(); });
    assert.equal(await frame.locator('body').evaluate(() => scrollY), scroll, 'observing the focus has no scroll effect');
    failReads = true; await frame.getByRole('button', { name: 'Actualiser la lecture' }).click();
    await page.waitForFunction(() => board.context()[0]?.status === 'unavailable');
    assert.doesNotMatch(await frame.locator('main').innerText(), /Synthetic stale artifact|2026-01-02T03:04:05.000Z/, 'failed refresh clears old values');
    failReads = false;
    let release;
    pendingRead = new Promise(resolve => { release = resolve; });
    await frame.getByRole('button', { name: 'Actualiser la lecture' }).click();
    await page.waitForFunction(() => board.context()[0]?.status === 'loading');
    release(); await page.waitForFunction(() => board.context()[0]?.status === 'visible');
    await page.screenshot({ path: path.join(report, `screen-${width}.png`) });
    // A same-path ordinary page after navigation cannot retain screen evidence.
    await page.evaluate(() => document.querySelector('.display-block[data-selected="true"] iframe').src = '/benchmark/profiler');
    await page.waitForFunction(() => ['unavailable', 'external'].includes(board.context()[0]?.status));
    assert.ok(['unavailable', 'external'].includes((await observation()).status));
    assert.equal((await observation()).focus, undefined);
    await page.evaluate(() => board.clear());
    assert.deepEqual(await page.evaluate(() => board.context()), []);
    results.push({ width, focus: 'passed', loadingFailureRecovery: 'passed' });
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(row => row.method !== 'GET' || /infer|dispatch|generate|campaign|measure|\/turn/.test(row.path)).length, 0);
  fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify({ results, errors, requests }, null, 2));
  console.log(JSON.stringify({ results, errors, requests: requests.length, inferenceOrDispatch: 0, report }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
