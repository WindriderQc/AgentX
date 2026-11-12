'use strict';

// Production dock + an actual, separately supplied GraphysX embed build.
// No upstream services, inference, camera or microphone are used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../../..');
const moduleFile = process.env.GRAPHYSX_FACE_MODULE_FILE;
const report = process.env.FACE_REPORT_DIR;
if (!moduleFile || !fs.statSync(moduleFile).isFile()) throw new Error('Supply GRAPHYSX_FACE_MODULE_FILE from a reviewed GraphysX build.');
if (!report || path.resolve(report).startsWith(root + path.sep)) throw new Error('Set FACE_REPORT_DIR outside the checkout.');
const app = express();
app.use('/assets/household', express.static(path.join(root, 'core/surfaces/household/public')));
app.get('/api/household/avatar/llmx-face.js', (_req, res) => res.type('application/javascript').sendFile(path.resolve(moduleFile)));
app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html><head>
<meta charset="utf-8"><link rel="stylesheet" href="/assets/household/avatar-dock.css">
<style>body{margin:0;background:#07121b;color:#dcebf1}.avatar-dock{display:grid}</style>
<script src="/assets/household/avatar-dock.js"></script></head><body></body></html>`));
let server, browser;
(async () => {
  fs.mkdirSync(report, { recursive: true });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.FACE_CHROME ? { executablePath: process.env.FACE_CHROME } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const observations = [];
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width: 800, height: 650 }, reducedMotion });
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
    await page.addInitScript(() => {
      // 4 fps: the old clamped assembly clock cannot finish in the test budget.
      const raf = requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => raf(() => setTimeout(() => callback(performance.now()), 250));
      document.addEventListener('llmx-face-ready', () => { window.faceReadyEvents = (window.faceReadyEvents || 0) + 1; }, true);
    });
    await page.goto(origin);
    await page.evaluate(() => { window.dock = AvatarDock.mount({ space: 'family' }); });
    await page.waitForFunction(() => document.querySelector('.avatar-dock')?.dataset.renderer === 'face', null, { timeout: 8000 });
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => ({
      events: window.faceReadyEvents, intro: document.querySelector('llmx-face').getAttribute('intro'),
      orbOpacity: getComputedStyle(document.querySelector('.avatar-dock-orb')).opacity,
      canvas: !!document.querySelector('llmx-face').shadowRoot.querySelector('canvas[data-engine]')
    }));
    assert.equal(state.events, 1); assert.equal(state.canvas, true); assert.equal(state.orbOpacity, '0');
    assert.deepEqual(errors, []); assert.ok(requests.every(url => url.startsWith(origin + '/')));
    await page.screenshot({ path: path.join(report, `portrait-${reducedMotion}.png`) });
    observations.push({ reducedMotion, ...state }); await page.close();
  }
  const unavailable = await browser.newPage();
  await unavailable.addInitScript(() => {
    const native = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return ['webgl', 'webgl2', 'experimental-webgl'].includes(kind) ? null : native.call(this, kind, ...args);
    };
  });
  await unavailable.goto(origin);
  await unavailable.evaluate(() => { window.dock = AvatarDock.mount({ space: 'personal' }); });
  assert.equal(await unavailable.evaluate(() => dock.ready), 'orb');
  assert.equal(await unavailable.locator('llmx-face').count(), 0, 'a native rendering error retains the fallback');
  fs.writeFileSync(path.join(report, 'readiness.json'), JSON.stringify({ observations, softwareWebGL: true, throttledFps: 4, nativeErrorFallback: true }, null, 2));
  console.log('Face readiness passed: actual GraphysX first-render event at 4 fps, reduced motion, hidden orb and native WebGL-error fallback.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});
