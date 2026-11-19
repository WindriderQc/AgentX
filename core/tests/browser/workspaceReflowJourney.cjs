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

const pages = { '/energy': 'energy', '/council': 'roundtable', '/performance': 'performance' };
for (const [route, view] of Object.entries(pages)) {
  app.get(route, (_req, res) => res.render('layouts/main', {
    title: 'AgentX',
    buildProductNavigation,
    service: 'core',
    activePage: route.slice(1),
    pageView: '../pages/' + view,
    headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/energy.css">'
  }));
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
      for (const route of Object.keys(pages)) {
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
        await activities.focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.activeElement.scrollLeft > 0);
      }
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
