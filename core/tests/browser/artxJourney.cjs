'use strict';
// Production canvas, idle controller and HTTP routes; synthetic data and no model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require('playwright-core');
const { createArtxService } = require('../../src/services/artxService');
const { registerFamilyRoutes } = require('../../surfaces/household/family-routes');
const root = path.resolve(__dirname, '../../..');
const report = process.env.ARTX_REPORT_DIR;
if (!report || path.resolve(report) === root || path.resolve(report).startsWith(root + path.sep)) {
  throw new Error('Set ARTX_REPORT_DIR outside the checkout.');
}
let clock = Date.parse('2026-11-05T01:00:00Z'), choices = 0;
const data = { weather: { kind: 'clear' }, sun: { elevationDeg: -20 },
  sky: { sun: { altDeg: -20, azDeg: 0 }, moon: { altDeg: -20, azDeg: 0, illumination: 0.1, name: 'croissant' },
    planets: [{ id: 'saturn', name: 'Saturne', azDeg: 125, altDeg: 30, mag: 1, sunSeparationDeg: 100 }], stars: [], figures: [] } };
const artx = createArtxService({ now: () => clock,
  ambient: { snapshot: async () => ({ ...structuredClone(data), at: new Date(clock).toISOString() }) },
  decide: async () => { choices++; return { mode: 'sky' }; } });
const app = express();
registerFamilyRoutes({ app, express, familyTasks: {}, standardJsonParser: express.json(), artx });
app.use('/assets', express.static(root + '/core/surfaces/household/public'));
app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html><head>
<style>body{margin:0;background:#02060d}.avatar-dock{position:fixed;inset:0}.nestor-ambient-sky{width:100%;height:100%}
.nestor-ambient-chips{position:fixed;bottom:10px;color:#d9eef5}</style></head><body>
<div class="avatar-dock" data-view="plein"></div>
<script src="/assets/nestor-sky-layout.js"></script><script src="/assets/nestor-sky-renderer.js"></script>
<script src="/assets/nestor-ambient-choice.js"></script><script src="/assets/nestor-artx.js"></script>
<script src="/assets/nestor-ambient.js"></script><script>
window.fixtureClock=${clock};window.labels=[];window.circles=[];
const nativeArc=CanvasRenderingContext2D.prototype.arc;
CanvasRenderingContext2D.prototype.arc=function(x,y,r){const m=this.getTransform();window.circles.push({x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f,r});return nativeArc.apply(this,arguments)};
const nativeText=CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText=function(text,x,y){window.labels.push({text,x,y});return nativeText.apply(this,arguments)};
window.ambient=NestorAmbient.mount({now:()=>fixtureClock});
</script></body></html>`));
let browser, server;
(async () => {
  fs.mkdirSync(report, { recursive: true });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  browser = await chromium.launch({ headless: true, timeout: 15000, ...(process.env.ARTX_CHROME ? { executablePath: process.env.ARTX_CHROME } : {}), args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => ambient.context().current && labels.some(label => label.text === 'Saturne'));
  const observation = await page.evaluate(() => ambient.context());
  const first = artx.observe(observation).current;
  const label = await page.evaluate(() => labels.filter(label => label.text === 'Saturne').at(-1));
  assert.equal(first.planets[0].rendered, true);
  assert.ok(await page.evaluate(point => circles.some(c => Math.abs(c.x / 1280 - point.x) < 0.001 && Math.abs(c.y / 720 - point.y) < 0.001), first.planets[0].screen));
  const caption = await page.evaluate(() => ambient.skyPlan().labels.find(l => l.id === 'saturn'));
  assert.ok(Math.abs(label.x - (caption.x * 1280 + caption.fontPx * 0.4)) < 0.01);
  assert.equal(choices, 0);
  clock += 120001;
  await page.evaluate(value => { fixtureClock = value; ambient.decide(); }, clock);
  await page.waitForFunction(() => ambient.context().current?.taskId, null, { timeout: 10000 });
  assert.equal(choices, 1);
  data.sky.moon = { altDeg: 40, azDeg: 180, illumination: 1, name: 'pleine lune' };
  const oldSource = await page.evaluate(() => ambient.context().current.snapshotId);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(old => ambient.context().current.snapshotId !== old, oldSource);
  const rotated = artx.observe(await page.evaluate(() => ambient.context())).current;
  const moved = await page.evaluate(() => labels.filter(label => label.text === 'Saturne').at(-1));
  assert.equal(rotated.panorama.centerAzimuthDeg, 180);
  assert.equal(moved.x, label.x, 'Moon occlusion does not move the sky or Saturn caption');
  assert.equal(rotated.moon.reason, 'face');
  assert.match(rotated.moon.label, /derrière moi/);
  await page.screenshot({ path: path.join(report, 'saturn-panorama.png') });
  await page.evaluate(() => {
    const photos = document.createElement('div'); photos.className = 'nestor-idle-photos'; document.body.append(photos);
  });
  assert.equal(artx.observe(await page.evaluate(() => ambient.context())).current.planets[0].rendered, false);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(report, 'receipt.json'), JSON.stringify({ choices, first, rotated, errors }, null, 2));
  console.log('ArtX browser journey passed: canvas position, idle selection, fixed Moon panorama and hidden display.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
