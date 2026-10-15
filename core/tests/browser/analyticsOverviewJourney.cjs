'use strict';
// Synthetic CPU-only browser journey: no production database or model calls.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const root = path.resolve(__dirname, '../../..');
const core = path.join(root, 'core');
const report = process.env.AGENTX_ANALYTICS_BROWSER_REPORT || fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-analytics-'));
const { buildProductNavigation } = require(path.join(root, 'shared/productNavigation'));
const { bucketFacet, summaryCoverage } = require(path.join(core, 'src/services/inferenceSummaryMetrics'));
const errors = [], requests = [];
let failSummary = false, empty = false, staleGPU = false, failLive = false;
let delayWindow = null;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function summary(key) {
  const to = new Date(), days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[key] || 1;
  const from = new Date(to.getTime() - days * 86400000);
  const models = ['local/brain-27b', 'local/guardian-4b', 'embedding/bge-m3', 'cloud/reasoner', 'local/worker'].map((model, i) => ({
    model, calls: [780, 310, 235, 100, 56][i], errors: i === 0 ? 3 : 0, cancellations: i === 0 ? 4 : 0,
    errorRate: i === 0 ? .38 : 0, cancellationRate: i === 0 ? .51 : 0,
    avgLatencyMs: [21800, 1200, 96, 8900, 18300][i], tokensOut: 10000, tokensIn: 40000,
    inferenceSeconds: 100, tokensOutPerSecond: 5, isCloud: i === 3, estimatedCostUsd: i === 3 ? 1.42 : null
  }));
  const calls = empty ? 0 : 1481;
  const bucketHours = key === '24h' ? 1 : 24;
  const step = bucketHours * 3600000, byBucket = [];
  const volume = [16, 10, 8, 6, 5, 15, 30, 66, 100, 128, 94, 86, 110, 78, 68, 82, 60, 70, 62, 58, 52, 64, 76, 90, 53];
  for (let at = Math.floor(+from / step) * step, i = 0; at < +to; at += step, i++) byBucket.push({ date: new Date(at).toISOString(), calls: empty ? 0 : volume[i % volume.length], errors: i === 9 ? 2 : i === 16 ? 1 : 0 });
  return {
    window: { key, from, to }, source: 'inferencelogs', scope: 'Recorded calls only', bucketHours, byBucket,
    totals: { calls, callsPerDay: calls / days, errors: empty ? 0 : 3, cancellations: empty ? 0 : 4, nonSuccesses: empty ? 0 : 7,
      errorRate: .2, fallbackRate: 0, fallbackCalls: 0, tokensIn: empty ? 0 : 39087891, tokensOut: empty ? 0 : 499407,
      inferenceHours: empty ? 0 : 5.76, avgLatencyMs: empty ? 0 : 14000, tokensOutPerSecond: 24.09, classifiedCalls: 0 },
    byModel: empty ? [] : models, byConsumerContract: empty ? [] : [{ consumerContract: 'native-conversation-v1', calls: 1000, avgLatencyMs: 20000, errorRate: .3 }],
    byDayCaller: [], byCaller: [], byRuntime: [], byTaskType: [], byFallbackUsed: [], byFallbackReason: [], byDegraded: [], topErrors: [],
    coverage: summaryCoverage({ models: empty ? [] : models, listedModels: empty ? [] : models, calls, windowKey: key }),
    local: { calls: empty ? 0 : 1381, inferenceHours: 5.51 },
    cloud: { calls: empty ? 0 : 100, estimatedCostUsd: empty ? null : 1.42, unpricedModels: [] }
  };
}
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://test'), p = url.pathname;
    if (p.startsWith('/api/')) {
      assert.equal(req.method, 'GET', 'analytics must never mutate or invoke inference');
      requests.push(p + url.search);
      res.setHeader('Content-Type', 'application/json');
      const json = data => res.end(JSON.stringify({ ok: true, data }));
      if (p === '/api/analytics/inference/summary') {
        const key = url.searchParams.get('window');
        const data = summary(key);
        if (key === delayWindow) await wait(350);
        if (failSummary) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false })); }
        return json(data);
      }
      if (p === '/api/nerve-center/runtime-coordination/active') {
        if (failLive) { res.statusCode = 503; return json({}); }
        return json({ inferences: [{ active: true, model: 'local/brain-27b', expiresAt: new Date(Date.now() + 120000).toISOString() }, { active: true, quarantined: true, model: 'local/worker' }], workloads: [] });
      }
      if (p === '/api/nerve-center/inference/gpu-status') {
        if (failLive) { res.statusCode = 503; return json([]); }
        return json([
          { hostId: 'gpu-a', hostname: 'Compute A', residency: 'gpu', telemetry: { status: staleGPU ? 'stale' : 'fresh', ageMs: 12000, staleAfterMs: 90000, collectorHostId: 'a' }, gpus: [{ index: 0, busId: 'pci0', name: 'GPU A', utilization: 78, vramUsed: 19514, vramTotal: 24576, powerDraw: 210 }, { index: 1, busId: 'pci1', name: 'GPU B', utilization: 90, vramUsed: 21997, vramTotal: 24576, powerDraw: 240 }] },
          { hostId: 'gpu-b', hostname: 'Compute B', residency: 'gpu', telemetry: { status: 'fresh', ageMs: 18000, staleAfterMs: 90000, collectorHostId: 'b' }, gpus: [{ index: 0, name: 'GPU C', utilization: 1, vramUsed: 10833, vramTotal: 12288, powerDraw: 26 }] },
          { hostId: 'cpu', hostname: 'CPU endpoint', residency: 'cpu' }
        ]);
      }
      if (p === '/api/analytics/usage') return json({ totalConversations: 0, totalMessages: 0, breakdown: [] });
      if (p === '/api/analytics/costs') return json({ summary: {}, breakdown: [] });
      return json({ breakdown: [] });
    }
    if (p === '/analytics') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(await ejs.renderFile(path.join(core, 'views/layouts/main.ejs'), {
        title: 'AgentX • AI activity', service: 'core', activePage: 'analytics', pageView: '../pages/analytics',
        publicUrls: { core: '', rag: '/rag', benchmark: '/benchmark' }, agentxProfile: url.searchParams.get('profile') === 'demo' ? 'demo' : 'full', buildProductNavigation,
        headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/analytics-experience.css"><script src="/vendor/chart.js/4.4.4/chart.umd.js"></script>',
        footerJs: '<script type="module" src="/js/analytics-cost.js"></script><script type="module" src="/js/analytics-inference.js"></script><script src="/js/analytics-experience.js"></script><script src="/js/analytics-overview.js"></script>'
      }));
    }
    let file = path.join(core, 'public', p);
    if (p === '/vendor/chart.js/4.4.4/chart.umd.js') file = path.join(core, 'node_modules/chart.js/dist/chart.umd.js');
    if (p.startsWith('/vendor/fontawesome/6.4.0/')) file = path.join(core, 'node_modules/@fortawesome/fontawesome-free', p.slice('/vendor/fontawesome/6.4.0/'.length));
    if (p.startsWith('/vendor/fonts/space-grotesk/5.3.0/')) file = path.join(core, 'node_modules/@fontsource-variable/space-grotesk', p.slice('/vendor/fonts/space-grotesk/5.3.0/'.length));
    if (p.startsWith('/vendor/fonts/ibm-plex-mono/5.3.0/')) file = path.join(core, 'node_modules/@fontsource/ibm-plex-mono', p.slice('/vendor/fonts/ibm-plex-mono/5.3.0/'.length));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); return res.end(fs.readFileSync(file)); }
    res.statusCode = 404; res.end('missing');
  } catch (error) { res.statusCode = 500; res.end(error.stack); }
});
(async () => {
  fs.mkdirSync(report, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/analytics`);
    await page.waitForFunction(() => document.getElementById('ao-calls').textContent === '1,481');
    await page.waitForFunction(() => document.getElementById('ao-active').textContent === '1');
    assert.equal(await page.locator('#ao-success').textContent(), '99.5%');
    assert.match(await page.locator('#ao-live-status').textContent(), /1 uncertain/);
    assert.equal(await page.locator('.ao-gpu').count(), 3);
    assert.equal(await page.locator('#analytics-cockpit').getAttribute('open'), null);
    for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720], [820, 1000], [390, 844], [320, 800]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(60);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `horizontal overflow at ${width}`);
      if (width >= 1280) {
        const edge = await page.locator('.ao-bottom-grid').evaluate(el => el.getBoundingClientRect().bottom);
        assert.ok(edge < height, `essential dashboard below first screen: ${edge} > ${height}`);
      }
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(report, `overview-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.getElementById('chatLaneEmptyNote').textContent.includes('last 7 days'));
    await page.evaluate(() => { const period = document.getElementById('periodSelect'); period.value = '14'; period.dispatchEvent(new Event('change')); });
    await page.waitForFunction(() => document.getElementById('chatLaneEmptyNote').textContent.includes('last 14 days'));
    assert.equal(await page.inputValue('#analyticsWindow'), '24h', 'Playground period stays separate from platform activity');
    await page.locator('[data-ao-group="byConsumerContract"]').click();
    assert.match(await page.locator('#ao-comparison').textContent(), /native-conversation-v1/);
    // Last selection wins even when an earlier window responds later.
    delayWindow = '7d';
    await page.selectOption('#analyticsWindow', '7d');
    await page.selectOption('#analyticsWindow', '30d');
    await page.waitForFunction(() => document.querySelector('.analytics-overview').dataset.state === 'ready');
    await page.waitForTimeout(400);
    assert.equal(await page.inputValue('#analyticsWindow'), '30d');
    assert.equal(await page.inputValue('#infWindow'), '30d');
    assert.match(await page.locator('#chatLaneEmptyNote').textContent(), /last 14 days/);
    await page.selectOption('#analyticsWindow', '90d');
    await page.waitForFunction(() => document.getElementById('ao-coverage').textContent.includes('limits this 90-day window'));
    failSummary = true;
    await page.locator('#analytics-experience-refresh').click();
    await page.waitForFunction(() => document.querySelector('.analytics-overview').dataset.state === 'error');
    assert.equal(await page.locator('#ao-calls').textContent(), '—');
    assert.equal(await page.locator('#ao-success').textContent(), '—');
    failSummary = false; empty = true;
    await page.locator('#analytics-experience-refresh').click();
    await page.waitForFunction(() => document.getElementById('ao-calls').textContent === '0');
    assert.equal(await page.locator('#ao-success').textContent(), '—');
    assert.equal(await page.locator('#ao-latency').textContent(), '—');
    assert.match(await page.locator('#ao-status').textContent(), /No recorded calls/);
    staleGPU = true;
    await page.evaluate(() => document.dispatchEvent(new Event('analytics:refresh-live')));
    await page.waitForFunction(() => document.querySelector('.ao-gpu.is-unknown'));
    assert.doesNotMatch(await page.locator('#ao-gpus').textContent(), /78%/);
    failLive = true;
    await page.evaluate(() => document.dispatchEvent(new Event('analytics:refresh-live')));
    await page.waitForFunction(() => document.getElementById('ao-active').textContent === '—');
    assert.match(await page.locator('#ao-gpus').textContent(), /unavailable/);
    // Detail remains reachable with keyboard focus and the existing controls.
    await page.locator('.ao-kpi').first().click();
    assert.equal(await page.locator('#analytics-cockpit').evaluate(el => el.open), true);
    assert.equal(await page.locator('#analytics-platform-inference').evaluate(el => document.activeElement === el), true);
    const requestStart = requests.length;
    failSummary = false; empty = false;
    await page.goto(`http://127.0.0.1:${server.address().port}/analytics?profile=demo`);
    await page.waitForFunction(() => document.getElementById('ao-calls').textContent === '1,481');
    assert.equal(await page.locator('.ao-live').count(), 0);
    assert.equal(await page.locator('a[href^="/nerve-center"]').count(), 0);
    assert.equal(requests.slice(requestStart).some(p => p.startsWith('/api/nerve-center') || p.startsWith('/api/analytics/federated')), false, 'demo must not probe disabled operational capabilities');
    assert.deepEqual(errors, []);
    assert.ok(requests.some(p => p.includes('/summary?window=24h')));
    assert.ok(bucketFacet('24h', {})[0].$group._id.$dateToString.format.includes('%H'));
    console.log(JSON.stringify({ ok: true, report, viewports: 7, scenarios: ['initial', 'comparison', 'window race', 'retention', 'failed read', 'empty', 'stale GPU', 'live failure', 'detail focus', 'demo profile', 'independent Playground window'], requests: requests.length }, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
