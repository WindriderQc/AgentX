'use strict';

// Loopback CPU/browser qualification of the production painter. No model,
// home observer, live weather, image generation or family display is contacted.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require('playwright-core');
const { registerArtxLab } = require('../../surfaces/household/artx-lab');
const root = path.resolve(__dirname, '../../..');
const report = process.env.ARTX_REPORT_DIR;
if (!report || path.resolve(report) === root || path.resolve(report).startsWith(root + path.sep)) throw new Error('Set ARTX_REPORT_DIR outside the checkout.');
const app = express();
app.use((_req, res, next) => { res.locals.showNav = false; next(); });
registerArtxLab(app);
app.use('/assets/household', express.static(path.join(root, 'core/surfaces/household/public')));
let server, browser;
(async () => {
  fs.mkdirSync(report, { recursive: true });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  browser = await chromium.launch({ headless: true,
    ...(process.env.ARTX_CHROME ? { executablePath: process.env.ARTX_CHROME } : {}), args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requests.push(r.url()));
  await page.goto(`http://127.0.0.1:${server.address().port}/artx-lab`);
  await page.waitForFunction(() => window.artxLab?.snapshot);
  const submit = async () => {
    await page.evaluate(() => { window.artxLab = null; });
    await page.getByRole('button', { name: 'Afficher la scène' }).click();
    await page.waitForFunction(() => window.artxLab?.snapshot);
  };
  const checkZones = async () => {
    const mismatches = await page.evaluate(() => {
      const parent = document.querySelector('.lab-zones').getBoundingClientRect();
      return artxLab.plan.zones.filter(zone => {
        const box = document.querySelector('.' + zone.id + '-zone').getBoundingClientRect();
        return Math.abs(box.x - parent.x - zone.x * parent.width) > 1
          || Math.abs(box.y - parent.y - zone.y * parent.height) > 1
          || Math.abs(box.width - zone.w * parent.width) > 1
          || Math.abs(box.height - zone.h * parent.height) > 1;
      }).map(zone => zone.id);
    });
    assert.deepEqual(mismatches, [], 'laboratory outlines match the painter reservations');
  };
  await page.locator('[name=at]').fill('2026-06-21T10:00'); await submit();
  const day = await page.evaluate(() => artxLab);
  assert.equal(day.background.light, 'day');
  assert.equal(day.plan.objects.find(o => o.id === 'sun').rendered, true);
  assert.equal(day.plan.objects.some(o => o.type === 'planet'), false);
  await checkZones();
  const first = await page.locator('#stage canvas').evaluate(c => c.toDataURL());
  await submit();
  assert.equal(await page.locator('#stage canvas').evaluate(c => c.toDataURL()), first, 'fixed scene renders identical pixels');
  await page.screenshot({ path: path.join(report, 'artx-lab-day.png'), fullPage: true });
  await page.locator('[name=at]').fill('2026-11-20T20:00'); await submit();
  const night = await page.evaluate(() => artxLab);
  assert.equal(night.background.light, 'night');
  assert.ok(night.snapshot.sky.stars.length > 10);
  assert.ok(night.plan.labels.every(l => !night.plan.zones.some(z => l.x < z.x + z.w && l.x + l.w > z.x && l.y < z.y + z.h && l.y + l.h > z.y)));
  await page.screenshot({ path: path.join(report, 'artx-lab-night.png'), fullPage: true });
  await page.locator('[name=weather]').selectOption('rain');
  await page.locator('[name=age]').selectOption('240'); await submit();
  assert.equal((await page.evaluate(() => artxLab.background)).kind, 'unknown');
  await page.getByText('Météo expirée · effets retirés').waitFor();
  await page.locator('[name=pixelRatio]').selectOption('1.5');
  await page.locator('[name=aspect]').selectOption('16/10'); await submit();
  assert.ok(await page.locator('#stage canvas').evaluate(c => Math.abs(c.width / c.clientWidth - 1.5) < 0.01));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[name=aspect]').selectOption('9/16'); await submit();
  await checkZones();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(report, 'artx-lab-mobile.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[name=weather]').selectOption('snow');
  await page.locator('[name=age]').selectOption('0'); await submit();
  assert.ok(await page.locator('#stage canvas').evaluate(c => c.width > 0));
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => url.startsWith(`http://127.0.0.1:${server.address().port}/`)), 'no external requests');
  assert.ok(!requests.some(url => /\/api\/(?:family|llm|voix|photos)/.test(url)), 'no live application effects');
  fs.writeFileSync(path.join(report, 'lab-receipt.json'), JSON.stringify({ day, night, errors,
    deterministicPixels: true, viewports: ['1440×1100', '390×844'], reducedMotion: true, requests }, null, 2));
  console.log('ArtX lab journey passed: shared painter, deterministic pixels, day/night, stale weather, DPR, aspect ratios, mobile and reduced motion.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
