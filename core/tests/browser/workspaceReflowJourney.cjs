'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const { buildProductNavigation } = require('../../../shared/productNavigation');

const core = path.resolve(__dirname, '../..');
const app = express();
app.set('views', path.join(core, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(core, 'public')));

const pages = {
  '/energy': ['energy', 'energy.css'],
  '/council': ['roundtable'],
  '/performance': ['performance'],
  '/memory-review': ['memory-review', 'memory-review.css'],
  '/planning': ['planning', 'planning.css', 'planning-components.css'],
  '/analytics': ['analytics', 'analytics-experience.css'],
  '/backup': ['backup', 'backup.css'],
  '/pipeline': ['pipeline', 'pipeline.css']
};
for (const [route, [view, ...styles]] of Object.entries(pages)) {
  app.get(route, (_req, res) => res.render('layouts/main', {
    title: 'AgentX',
    buildProductNavigation,
    publicUrls: { rag: '/rag' },
    service: 'core',
    activePage: route.slice(1),
    pageView: '../pages/' + view,
    headCss: ['styles.css', ...styles.map(style => 'css/' + style)]
      .map(style => `<link rel="stylesheet" href="/${style}">`).join(''),
    footerJs: view === 'memory-review' ? ['memory-review-copy', 'memory-review-keys', 'memory-review']
      .map(script => `<script src="/js/${script}.js"></script>`).join('') : ''
  }));
}
const memoryRun = {
  runId: 'responsive-fixture',
  status: 'completed',
  mode: 'propose',
  collectors: [
    { runtime: 'claude-code', host: 'fixture-development-workstation-with-a-long-hostname.example',
      agentOrProfile: 'Collector profile', eligibleObservations: 1234, rejectedObservations: 567,
      drift: ['Fixture advisory'] }
  ]
};
app.get(['/api/memory-review/config', '/api/alerts'], (_req, res) => res.json({ data: {} }));
app.get('/api/memory-review/insights', (_req, res) => res.sendStatus(503));
app.get('/api/memory-review/runs', (_req, res) => res.json({ data: { runs: [memoryRun] } }));
app.get('/api/memory-review/runs/responsive-fixture', (_req, res) => res.json({ data: memoryRun }));
const benchmarkAssets = express.Router();
require('../../../shared/csvCell').mountBrowserCsvCell(benchmarkAssets);
benchmarkAssets.use(express.static(path.resolve(core, '../benchmark/public')));
app.use('/benchmark', benchmarkAssets);
app.get('/efficiency-table', (_req, res) => res.send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Efficiency observations</title><link rel="stylesheet" href="/benchmark/css/efficiency-map.css">
  <main id="ranking"></main><script type="module">
    import { renderRankedTable } from '/benchmark/js/efficiency-map/ranked-table.js';
    const row = { host: 'http://fixture.local:11434', avgQuality: 8, avgTokPerSec: 40,
      avgTtft: 100, efficiencyScore: 55, paretoOptimal: false, throughputTestCount: 4 };
    renderRankedTable(document.getElementById('ranking'), [
      { ...row, model: 'Fixture A', testCount: 3 },
      { ...row, model: 'Fixture B', testCount: 9 }
    ]);
  </script></html>`));

async function assertWithinViewport(elements, label) {
  const fits = await elements.evaluateAll(nodes => nodes.length > 0 && nodes.every(node => {
    const bounds = node.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth + 1;
  }));
  assert.ok(fits, label);
}

async function assertKeyboardScroll(page, region) {
  assert.equal(await region.getAttribute('tabindex'), '0');
  await region.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement.scrollLeft > 0, null, { timeout: 2500 });
}

async function verifyResponsiveSurfaces(page, origin, width) {
  await page.goto(origin + '/memory-review');
  await assertWithinViewport(page.locator('.mr-run-tools input, #mrRunStatus'), 'Memory Review filters fit the viewport');
  const summary = page.locator('#mrCollectors details summary');
  await summary.waitFor();
  await assertWithinViewport(summary, 'Collapsed Memory Review collector fits with loaded data');
  await summary.click();
  await page.getByText('Fixture advisory').waitFor();
  await assertWithinViewport(page.locator('#mrCollectors .mr-collector-detail'), 'Open Memory Review collector fits');
  assert.ok(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Loaded collectors do not widen the page');
  if (width < 560) {
    await page.locator('.mr-shortcuts summary').click();
    await assertWithinViewport(page.locator('.mr-shortcuts > div'), 'Memory Review shortcuts fit when open');
  }

  await page.goto(origin + '/planning');
  await assertWithinViewport(page.locator('.planning-navigation [data-planning-view]'), 'Planning destinations are all visible');

  await page.goto(origin + '/analytics');
  await assertWithinViewport(page.locator('.wb-chart canvas, #costBreakdownChart'), 'Analytics canvases fit before data arrives');
  if (width === 320) await assertKeyboardScroll(page, page.getByRole('region', { name: 'Model activity table', exact: true }));

  await page.goto(origin + '/backup');
  const details = page.locator('.backup-inventory').first();
  await details.locator('summary').click();
  const mongo = details.getByRole('region', { name: 'MongoDB recovery artifacts' });
  assert.ok(await mongo.isVisible());
  if (width === 320) await assertKeyboardScroll(page, mongo);

  await page.goto(origin + '/pipeline');
  const queue = page.getByRole('region', { name: 'Task queue', exact: true });
  assert.ok(await queue.isVisible());
  if (width === 320) await assertKeyboardScroll(page, queue);

  await page.goto(origin + '/efficiency-table');
  const ranking = page.getByRole('region', { name: 'Ranked efficiency observations' });
  if (width === 320) await assertKeyboardScroll(page, ranking);
  const tests = ranking.getByRole('button', { name: 'Tests', exact: true });
  await tests.focus();
  await page.keyboard.press('Enter');
  assert.equal(await ranking.getByRole('columnheader', { name: 'Tests', exact: true }).getAttribute('aria-sort'), 'descending');
  assert.equal(await ranking.locator('tbody tr').first().locator('td').last().textContent(), '9');
  assert.ok(await tests.evaluate(button => button === document.activeElement), 'Sort keeps keyboard focus');
  if (width === 320) assert.ok(await ranking.evaluate(node => node.scrollLeft > 0), 'Sort keeps the far column in view');
  await page.keyboard.press('Space');
  assert.equal(await ranking.getByRole('columnheader', { name: 'Tests', exact: true }).getAttribute('aria-sort'), 'ascending');
  assert.equal(await ranking.locator('tbody tr').first().locator('td').last().textContent(), '3');
}

async function verify() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    const executablePath = process.env.WORKSPACE_CHROMIUM_EXECUTABLE;
    browser = await chromium.launch({ executablePath });
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      for (const route of ['/energy', '/council', '/performance']) {
        const response = await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
        assert.equal(response.status(), 200);
        assert.equal(await page.getByRole('main').count(), 1, route);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#skipToMainContent:focus').count(), 1, route);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('main#main-content:focus').count(), 1, route);
      }
      await page.goto(origin + '/energy');
      const layout = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        canvasRight: document.getElementById('energyChart').getBoundingClientRect().right,
      }));
      assert.equal(layout.document, layout.viewport, `Energy overflow at ${width}px`);
      assert.ok(layout.canvasRight <= layout.viewport, `Chart overflow at ${width}px`);
      if (width === 320) {
        const activities = page.getByRole('region', { name: 'Activités observées' });
        await assertKeyboardScroll(page, activities);
      }
      await verifyResponsiveSurfaces(page, origin, width);
      await page.close();
    }
    console.log('Workspace reflow and skip links passed at 320, 390 and 1440 px');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
