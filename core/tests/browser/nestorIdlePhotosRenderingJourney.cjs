'use strict';

// Loopback CPU fixture: real photo/dock components and browser intersection
// delivery, with a counter instead of WebGL. No model, mic, camera or private photo.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const publicDir = path.resolve(__dirname, '../../surfaces/household/public');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const files = new Set(['avatar-dock.css', 'idle-photos.css', 'avatar-dock.js', 'idle-photos.js']);
const errors = [], results = [];
let browser, server;

const faceModule = `customElements.define('llmx-face', class extends HTMLElement {
  connectedCallback() {
    this.draws = 0; this.updates = 0; this.visible = false;
    this.observer = new IntersectionObserver(entries => { this.visible = entries.some(entry => entry.isIntersecting); });
    this.observer.observe(this);
    const tick = () => { if (this.visible && !document.hidden) this.draws++; this.frame = requestAnimationFrame(tick); };
    this.frame = requestAnimationFrame(tick);
    this.dispatchEvent(new CustomEvent('llmx-face-ready'));
  }
  set presence(value) { this.updates++; this.latest = value; }
  disconnectedCallback() { cancelAnimationFrame(this.frame); this.observer.disconnect(); }
});`;

(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/api/household/avatar/llmx-face.js') {
      res.setHeader('Content-Type', 'text/javascript'); return res.end(faceModule);
    }
    if (files.has(name.slice(1))) {
      res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
      return res.end(fs.readFileSync(path.join(publicDir, name.slice(1))));
    }
    if (name === '/api/photos/frame/' + id + '/image') {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#183f60"/></svg>');
    }
    if (name !== '/') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width">
      <link rel="stylesheet" href="/avatar-dock.css"><link rel="stylesheet" href="/idle-photos.css">
      <main id="app"><p id="transcript">Conversation preserved</p><nav id="toolbar"></nav></main>
      <script src="/avatar-dock.js"></script><script src="/idle-photos.js"></script><script>
        window.clockNow = 0; window.audioReads = 0; window.photoRequests = 0;
        window.dock = AvatarDock.mount({space:new URLSearchParams(location.search).get('space') || 'personal'});
        window.photos = NestorIdlePhotos.mount({host:document.getElementById('toolbar'), now:() => clockNow,
          api:async url => {
            if (url.endsWith('/status')) return {enabled:true,idleSeconds:30,intervalSeconds:5};
            photoRequests++; return {id:'${id}',src:'/api/photos/frame/${id}/image'};
          }});
        dispatchEvent(new CustomEvent('persona-presence', {detail:{state:'listening',
          sample:{input:() => { audioReads++; return .1; }}}}));
      </script>`);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  for (const viewport of [{width:1440,height:1000}, {width:390,height:844}]) {
    const context = await browser.newContext({viewport});
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + (viewport.width < 700 ? '?space=family' : ''));
    await page.getByRole('button', {name:'Photos en veille'}).waitFor();
    await page.waitForFunction(() => !!document.querySelector('llmx-face')?.draws);
    await page.evaluate(() => { window.originalFace = document.querySelector('llmx-face'); });
    const counters = () => page.evaluate(() => ({draws:originalFace.draws, updates:originalFace.updates, reads:audioReads}));
    const enter = async () => {
      await page.evaluate(() => { document.activeElement?.blur(); clockNow += 31000; photos.tick(); });
      await page.waitForFunction(() => photos.active());
      await page.waitForFunction(() => !originalFace.visible);
    };
    const resume = async () => {
      await page.waitForFunction(() => originalFace.visible);
      const before = await counters();
      await page.waitForFunction(before => originalFace.draws > before.draws && originalFace.updates > before.updates && audioReads > before.reads, before);
      assert.equal(await page.evaluate(() => originalFace === document.querySelector('llmx-face')), true, 'same renderer resumes');
    };
    for (const mode of ['scene', 'bulle', 'quart', 'moitie']) {
      await page.evaluate(mode => dock.setMode(mode), mode);
      await resume(); await enter();
      assert.equal(await page.locator('.avatar-dock').evaluate(node => getComputedStyle(node).display), 'none');
      assert.equal(await page.locator('.avatar-scene-bar').evaluate(node => getComputedStyle(node).display), 'none');
      // Let a final in-flight observer callback settle before measuring steady state.
      await page.waitForTimeout(100);
      const frozen = await counters(); await page.waitForTimeout(250);
      assert.deepEqual(await counters(), frozen, mode + ': no covered rendering, presence updates or audio sampling');
      await page.evaluate(() => { clockNow += 6000; photos.tick(); });
      await page.waitForTimeout(100);
      assert.deepEqual(await counters(), frozen, 'photo rotation keeps the face suspended');
      if (mode === 'quart') {
        await page.evaluate(() => dispatchEvent(new CustomEvent('persona-presence', {detail:{state:'thinking'}})));
        await page.waitForFunction(() => !photos.active());
        await page.evaluate(() => dispatchEvent(new CustomEvent('persona-presence', {detail:{state:'listening'}})));
      } else { await page.keyboard.press('Escape'); }
      await resume();
      assert.equal(await page.evaluate(() => dock.mode), mode, 'photo exit retains layout preference');
    }
    await page.evaluate(() => dock.setMode('cache'));
    await page.waitForFunction(() => !originalFace.visible);
    const hidden = await counters(); await page.waitForTimeout(200);
    assert.deepEqual(await counters(), hidden, 'hidden face skips visual updates');
    await page.evaluate(() => dock.setMode('scene')); await resume();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true, value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const background = await counters(); await page.waitForTimeout(200);
    assert.deepEqual(await counters(), background, 'background tab skips visual updates');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true, value:false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await resume(); await enter();
    await page.evaluate(() => photos.dispose()); await resume();
    assert.equal(await page.locator('#transcript').textContent(), 'Conversation preserved');
    await page.evaluate(() => dock.dispose());
    assert.equal(await page.locator('llmx-face').count(), 0);
    results.push({viewport,passed:true}); await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ok:true,results,errors,liveModelCalls:0,physicalMediaCalls:0,webgl:false}));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
});
