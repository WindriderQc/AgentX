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
const { bucketFacet, summaryCoverage, attributionCoverage } = require(path.join(core, 'src/services/inferenceSummaryMetrics'));
const { shapeTiming } = require(path.join(core, 'src/services/inferenceTimingSummary'));
const errors = [], requests = [];
let failSummary = false, empty = false, staleGPU = false, failLive = false;
let delayWindow = null;
let legacySummary = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function summary(key) {
  const to = new Date(), days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[key] || 1;
  const from = new Date(to.getTime() - days * 86400000);
  const models = ['local/brain-27b', 'local/guardian-4b', 'embedding/bge-m3', 'cloud/reasoner', 'local/worker'].map((model, i) => ({
    model, calls: [780, 310, 235, 100, 56][i], errors: i === 0 ? 3 : 0, cancellations: i === 0 ? 4 : 0,
    errorRate: i === 0 ? .38 : 0, cancellationRate: i === 0 ? .51 : 0,
    avgLatencyMs: [21800, 1200, 96, 8900, 18300][i], tokensOut: [440000, 40000, 0, 11000, 8407][i], tokensIn: [36000000, 1500000, 30000, 1000000, 557891][i],
    inferenceSeconds: [21800, 1200, 96, 8900, 18300][i] * [780, 310, 235, 100, 56][i] / 1000, tokensOutPerSecond: 5, isCloud: i === 3, estimatedCostUsd: i === 3 ? 1.42 : null
  }));
  const calls = empty ? 0 : 1481;
  const elapsedMs = empty ? 0 : Math.round(models.reduce((sum, model) => sum + model.inferenceSeconds, 0) * 1000);
  const bucketHours = key === '24h' ? 1 : 24;
  const step = bucketHours * 3600000, byBucket = [];
  const volume = [16, 10, 8, 6, 5, 15, 30, 66, 100, 128, 94, 86, 110, 78, 68, 82, 60, 70, 62, 58, 52, 64, 76, 90, 53];
  for (let at = Math.floor(+from / step) * step; at < +to; at += step) byBucket.push({ date: new Date(at).toISOString() });
  function allocate(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    let remaining = total;
    return weights.map((weight, i) => { const value = sum === 0 ? 0 : i === weights.length - 1 ? remaining : Math.floor(total * weight / sum); remaining -= value; return value; });
  }
  const counts = allocate(calls, byBucket.map((_, i) => volume[i % volume.length]));
  const outputs = allocate(empty ? 0 : 499407, counts.map((n, i) => n * (2 + i % 5)));
  const durations = allocate(elapsedMs, counts.map((n, i) => n * (8000 + (i % 7) * 2000)));
  byBucket.forEach((row, i) => Object.assign(row, {
    calls: counts[i], errors: empty ? 0 : (i === Math.min(9, byBucket.length - 1) ? 2 : 0) + (i === Math.min(16, byBucket.length - 1) ? 1 : 0),
    cancellations: !empty && i === Math.min(17, byBucket.length - 1) ? 4 : 0,
    nonSuccesses: empty ? 0 : (i === Math.min(9, byBucket.length - 1) ? 2 : 0) + (i === Math.min(16, byBucket.length - 1) ? 1 : 0) + (i === Math.min(17, byBucket.length - 1) ? 4 : 0),
    tokensOut: outputs[i], inferenceSeconds: durations[i] / 1000, avgLatencyMs: counts[i] > 0 ? durations[i] / counts[i] : null
  }));
  return {
    window: { key, from, to }, source: 'inferencelogs', scope: 'Recorded calls only', bucketHours, byBucket,
    totals: { calls, callsPerDay: calls / days, errors: empty ? 0 : 3, cancellations: empty ? 0 : 4, nonSuccesses: empty ? 0 : 7,
      errorRate: .2, fallbackRate: 0, fallbackCalls: 0, tokensIn: empty ? 0 : 39087891, tokensOut: empty ? 0 : 499407,
      inferenceHours: elapsedMs / 3600000, inferenceSeconds: elapsedMs / 1000, avgLatencyMs: calls > 0 ? Math.round(elapsedMs / calls) : null, tokensOutPerSecond: 24.09, classifiedCalls: 0 },
    byModel: empty ? [] : models, byConsumerContract: empty ? [] : [{ consumerContract: 'native-conversation-v1', calls: 1000, avgLatencyMs: 20000, errorRate: .3 }],
    byDayCaller: [], byCaller: [], byRuntime: [], byTaskType: [], byFallbackUsed: [], byFallbackReason: [], byDegraded: [], topErrors: [],
    ...(!legacySummary && { timing: shapeTiming({ calls, durationMs: elapsedMs, loadMs: elapsedMs * .01, promptEvalMs: elapsedMs * .2, evalMs: elapsedMs * .7, admissionCalls: calls, admissionMs: empty ? 0 : 30000, hostGateCalls: calls, hostGateMs: empty ? 0 : 10000 }, calls) }),
    ...(!legacySummary && { attribution: attributionCoverage(empty ? [] : [{ _id: 'proxy', calls: 400 }, { _id: 'embedding', calls: 81 }], calls) }),
    ...(!legacySummary && { failureAnalysis: { admissionRefusals: empty ? 0 : 3, unclassified: 0, byReason: empty ? [] : [
      { reason: 'workload_reserved', calls: 2 }, { reason: 'inference_recovery_required', calls: 1 },
    ] }, topErrors: empty ? [] : [
      { reason: 'workload_reserved', consumerContract: 'desktop-gateway-v1', model: 'local/brain-27b', calls: 2, avgLatencyMs: 25 },
      { reason: 'inference_recovery_required', consumerContract: 'native-conversation-v1', model: 'local/brain-27b', calls: 1, avgLatencyMs: 30 },
    ] }),
    coverage: summaryCoverage({ models: empty ? [] : models, listedModels: empty ? [] : models, calls, windowKey: key }),
    local: { calls: empty ? 0 : 1381, inferenceHours: empty ? 0 : models.filter(model => !model.isCloud).reduce((sum, model) => sum + model.inferenceSeconds, 0) / 3600 },
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
        footerJs: '<script type="module" src="/js/analytics-cost.js"></script><script type="module" src="/js/analytics-inference.js"></script><script src="/js/analytics-experience.js"></script><script src="/js/analytics-live-values.js"></script><script src="/js/analytics-overview.js"></script>'
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
  const browser = await chromium.launch({ headless: true, ...(process.env.AGENTX_CHROMIUM_EXECUTABLE && { executablePath: process.env.AGENTX_CHROMIUM_EXECUTABLE }) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/analytics`);
    await page.waitForFunction(() => document.getElementById('ao-calls').textContent === '1,481');
    await page.waitForFunction(() => document.getElementById('ao-active').textContent === '1');
    assert.equal(await page.locator('#ao-success').textContent(), '99.5%');
    assert.match(await page.locator('#ao-live-status').textContent(), /1 uncertain/);
    assert.equal(await page.locator('.ao-gpu').count(), 3);
    assert.equal(await page.locator('.ao-spark svg').count(), 3);
    assert.equal(await page.locator('.ao-meter-memory').count(), 3);
    assert.equal(await page.locator('#ao-outcome-ring').getAttribute('aria-label'), '1,474 successful, 3 errors, 4 canceled out of 1,481 recorded calls');
    assert.equal(await page.locator('#ao-mix-value').textContent(), '93.2%');
    const plotted = await page.evaluate(() => {
      const chart = Chart.getChart(document.getElementById('ao-trend-chart'));
      return { calls: chart.data.datasets[0].data.reduce((a, b) => a + b, 0), current: chart.data.datasets[0].data };
    });
    assert.equal(plotted.calls, 1481, 'plotted volume reconciles with the headline');
    assert.equal(await page.locator('#analytics-cockpit').getAttribute('open'), null);
    const workbenchPaths = ['/api/analytics/costs', '/api/analytics/usage', '/api/analytics/feedback', '/api/analytics/rag-stats', '/api/analytics/effectiveness', '/api/analytics/federated', '/api/rag/'];
    assert.deepEqual(requests.filter(p => workbenchPaths.some(prefix => p.startsWith(prefix))), [], 'the closed workbench loads nothing');
    assert.match(await page.locator('#ao-attribution').textContent(), /1,000 \/ 1,481.*481 missing.*400 proxy.*81 embedding/);
    const drilldown = new URL(await page.locator('#ao-attribution-logs').getAttribute('href'), 'http://test');
    assert.equal(drilldown.searchParams.get('consumerContractMissing'), 'true');
    assert.ok(Date.parse(drilldown.searchParams.get('from')) < Date.parse(drilldown.searchParams.get('to')));
    assert.match(await page.locator('#ao-updated').textContent(), /→.*\(.*\)/);
    await page.locator('#ao-timing > summary').click();
    assert.match(await page.locator('#ao-timing-content').textContent(), /Other time.*not proven waiting/);
    assert.match(await page.locator('#ao-timing-content').textContent(), /1,481.*calls measured/);
    await page.locator('#ao-timing > summary').click();
    await page.evaluate(() => document.fonts.ready);
    for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720], [820, 1000], [390, 844], [320, 800]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(60);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `horizontal overflow at ${width}`);
      const overlaps = await page.evaluate(() => [...document.querySelectorAll('.ao-kpi')].flatMap(card => {
        const number = card.querySelector(':scope > strong'), visual = card.querySelector('.ao-spark svg, .ao-outcome-ring');
        if (!number || !visual) return [];
        const range = document.createRange(); range.selectNodeContents(number);
        const a = range.getBoundingClientRect(), b = visual.getBoundingClientRect();
        return a.right > b.left + 1 && a.left < b.right && a.bottom > b.top && a.top < b.bottom ? [number.id] : [];
      }));
      assert.deepEqual(overlaps, [], `visual overlaps headline at ${width}`);
      if (width >= 1280) {
        const edge = await page.locator('.ao-bottom-grid').evaluate(el => el.getBoundingClientRect().bottom);
        assert.ok(edge < height, `essential dashboard below first screen: ${edge} > ${height}`);
      }
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(report, `overview-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-ao-overlay="latency"]').click();
    assert.equal(await page.locator('[data-ao-overlay="latency"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#ao-overlay-label').textContent(), 'Mean latency (s)');
    assert.deepEqual(await page.evaluate(() => Chart.getChart(document.getElementById('ao-trend-chart')).data.datasets[0].data), plotted.current, 'changing the overlay keeps the same calls');
    assert.equal(await page.evaluate(() => Chart.getChart(document.getElementById('ao-trend-chart')).options.scales.rate.ticks.callback(2)), '2s');
    await page.screenshot({ path: path.join(report, 'overview-latency-1440.png'), fullPage: true });
    await page.locator('[data-ao-overlay="errors"]').click();
    assert.equal(await page.evaluate(() => Chart.getChart(document.getElementById('ao-trend-chart')).options.scales.rate.ticks.callback(2)), '2%');
    await page.locator('#ao-error-focus').click();
    assert.equal(await page.locator('[data-ao-group="byErrors"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#ao-comparison').textContent(), /Workload reserved.*desktop-gateway-v1/s);
    assert.match(await page.locator('#ao-comparison').textContent(), /66\.7%/);
    assert.match(await page.locator('#ao-model-note').textContent(), /retries may repeat one request/);
    assert.equal(await page.locator('#ao-comparison-detail').getAttribute('data-analytics-target'), 'infErrorLink');
    for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [320, 800]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `error comparison overflow at ${width}`);
      if (width >= 1280) assert.ok(await page.locator('.ao-bottom-grid').evaluate(el => el.getBoundingClientRect().bottom) < height);
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(report, `overview-errors-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    legacySummary = true;
    await page.locator('#analytics-experience-refresh').click();
    await page.waitForFunction(() => document.getElementById('ao-comparison').textContent.includes('causes unavailable'));
    assert.match(await page.locator('#ao-error-focus').textContent(), /Explore recorded errors/);
    assert.match(await page.locator('#ao-timing-summary').textContent(), /unavailable from this Core version/);
    assert.match(await page.locator('#ao-attribution').textContent(), /unavailable from this Core version/);
    assert.equal(await page.locator('#ao-attribution-logs').isVisible(), false);
    legacySummary = false;
    // Opening the workbench loads it; the Playground lane follows the page-wide Period.
    await page.locator('#analytics-cockpit > summary').click();
    await page.waitForFunction(() => document.getElementById('chatLaneEmptyNote').textContent.includes('last 24 hours'));
    assert.equal(await page.locator('#periodSelect, #infWindow, #federatedWindowSelect').count(), 0, 'no competing period selectors');
    await page.locator('[data-ao-group="byConsumerContract"]').click();
    assert.match(await page.locator('#ao-comparison').textContent(), /native-conversation-v1/);
    // Last selection wins even when an earlier window responds later.
    delayWindow = '7d';
    await page.selectOption('#analyticsWindow', '7d');
    await page.selectOption('#analyticsWindow', '30d');
    await page.waitForFunction(() => document.querySelector('.analytics-overview').dataset.state === 'ready');
    await page.waitForTimeout(400);
    assert.equal(await page.inputValue('#analyticsWindow'), '30d');
    await page.waitForFunction(() => document.getElementById('chatLaneEmptyNote').textContent.includes('last 30 days'));
    assert.equal(await page.locator('#analyticsWindow option[value="90d"]').count(), 0, 'no window beyond log retention');
    failSummary = true;
    await page.locator('#analytics-experience-refresh').click();
    await page.waitForFunction(() => document.querySelector('.analytics-overview').dataset.state === 'error');
    assert.equal(await page.locator('#ao-calls').textContent(), '—');
    assert.match(await page.locator('#ao-timing-summary').textContent(), /unavailable for this window/);
    assert.match(await page.locator('#ao-attribution').textContent(), /unavailable for this window/);
    assert.equal(await page.locator('#ao-attribution-logs').isVisible(), false);
    assert.equal(await page.locator('#ao-success').textContent(), '—');
    assert.equal(await page.locator('.ao-spark svg').count(), 0, 'failed reads clear prior mini-charts');
    assert.equal(await page.locator('#ao-outcome-ring').evaluate(el => el.classList.contains('is-empty')), true);
    assert.equal(await page.locator('#ao-mix-value').textContent(), '—');
    assert.equal(await page.locator('#ao-error-focus').isVisible(), false);
    failSummary = false; empty = true;
    await page.locator('#analytics-experience-refresh').click();
    await page.waitForFunction(() => document.getElementById('ao-calls').textContent === '0');
    assert.equal(await page.locator('#ao-success').textContent(), '—');
    assert.equal(await page.locator('#ao-latency').textContent(), '—');
    assert.equal(await page.locator('.ao-spark svg').count(), 0);
    assert.equal(await page.locator('#ao-mix-ring').evaluate(el => el.classList.contains('is-empty')), true);
    assert.match(await page.locator('#ao-status').textContent(), /No recorded calls/);
    assert.equal(await page.locator('#ao-error-focus').isVisible(), false);
    await page.locator('[data-ao-group="byErrors"]').click();
    assert.match(await page.locator('#ao-comparison').textContent(), /No operational errors/);
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
    // openTo() moves focus on the next animation frame.
    await page.waitForFunction(() => document.activeElement === document.getElementById('analytics-platform-inference'), null, { timeout: 5000 });
    await page.locator('[data-analytics-target="chatLaneHeading"]').click();
    assert.equal(await page.locator('#chatLaneHeading').isVisible(), true, 'the shortcut reveals the collapsed Playground lane');
    await page.selectOption('#analyticsWindow', '7d');
    // The page-wide Period also reloads federated and Codex data; let every
    // request land before the demo check counts new ones.
    for (let seen = -1; seen !== requests.length;) { seen = requests.length; await wait(300); }
    assert.equal(await page.locator('#chatLaneHeading').isVisible(), true, 'explicitly expanded Playground lane stays open across period changes');
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
    console.log(JSON.stringify({ ok: true, report, viewports: 7, scenarios: ['initial', 'comparison', 'error causes and consumer shares', 'legacy cause availability', 'consumer attribution and window drilldown', 'phase and wait coverage', 'volume/latency overlay', 'visual evidence reset', 'window race', 'retention', 'failed read', 'empty', 'stale GPU', 'live failure', 'detail focus', 'demo profile', 'page-wide Period', 'lazy workbench', 'persistent Playground disclosure'], requests: requests.length }, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
