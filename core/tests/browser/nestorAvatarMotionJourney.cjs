'use strict';

// Loopback browser fixture. Synthetic pixels and fake media tracks only; no physical camera,
// microphone, private images, model, database or service. Optionally render the installed
// GraphysX bundle by providing AGENTX_FACE_FIXTURE (a local llmx-face.js file).
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const publicDir = path.resolve(__dirname, '../../surfaces/household/public');
const output = process.env.AVATAR_MOTION_OUTPUT_DIR;
let server, browser;
const errors = [], network = [];
const stub = `customElements.define('llmx-face', class extends HTMLElement {
  connectedCallback() { this.style.cssText='display:block;background:#183646';
    this.ready= setTimeout(()=>this.dispatchEvent(new CustomEvent('llmx-face-ready')),10); }
  set presence(value) { this.latestPresence=value; }
});`;
const fakeMedia = `
window.mediaCalls=[]; window.tracks=[]; window.playFail=false; window.drawFail=false;
window.mediaMode='success'; window.captures=0; window.points=[];
window.addEventListener('pointermove', e=> { if(!e.isTrusted) window.points.push([e.clientX,e.clientY]); });
window.deliver=()=> {
  const track=new EventTarget(); track.stopped=false;
  track.stop=()=>{track.stopped=true;}; window.tracks.push(track);
  return { getTracks:()=>[track], getVideoTracks:()=>[track] };
};
Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async constraints=> {
  window.mediaCalls.push(constraints);
  if(window.mediaMode==='denied') throw new DOMException('denied','NotAllowedError');
  if(window.mediaMode==='missing') throw new DOMException('missing','NotFoundError');
  if(window.mediaMode==='pending') return new Promise(resolve=>{window.resolveMedia=()=>resolve(window.deliver());});
  return window.deliver();
}}});
Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{configurable:true,set(value){this.fakeSource=value;},get(){return this.fakeSource;}});
Object.defineProperty(HTMLMediaElement.prototype,'readyState',{configurable:true,get(){return 4;}});
HTMLMediaElement.prototype.play=async function(){if(window.playFail)throw Error('play failed');};
HTMLMediaElement.prototype.pause=function(){};
const realContext=HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext=function(kind,...args){
  const ctx=realContext.call(this,kind,...args);
  if(kind==='2d' && this.width===80 && this.height===60) ctx.drawImage=()=>{
    if(window.drawFail)throw Error('draw failed');
    window.captures++;ctx.fillStyle='#282828';ctx.fillRect(0,0,80,60);
    if(window.captures%2 && window.motionSide!=='center'){
      ctx.fillStyle='#ddd';ctx.fillRect(window.motionSide==='right'?65:4,24,10,10);
    }
  };
  return ctx;
};`;

(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <style>:root{--line:#526471;--text:#eefaff;--soft:#9db6c5}body{background:#07131d;color:#eee;font-family:system-ui}</style>
        <link rel="stylesheet" href="/avatar-dock.css"><main><h1>Famille</h1><button id="micro">Micro simulé</button></main>
        <script src="/avatar-motion.js"></script><script src="/avatar-dock.js"></script>
        <script>window.handle=AvatarDock.mount({space:new URLSearchParams(location.search).get('space')||'family'});</script>`);
    }
    if (name === '/api/household/avatar/llmx-face.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(process.env.AGENTX_FACE_FIXTURE ? fs.readFileSync(process.env.AGENTX_FACE_FIXTURE) : stub);
    }
    if (['/avatar-motion.js', '/avatar-dock.js', '/avatar-dock.css'].includes(name)) {
      res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript');
      return res.end(fs.readFileSync(path.join(publicDir, name.slice(1))));
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.AGENTX_BROWSER_EXECUTABLE && { executablePath: process.env.AGENTX_BROWSER_EXECUTABLE }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**/*', route => {
    const request = route.request(); network.push({ url: request.url(), method: request.method() });
    return new URL(request.url()).origin === origin ? route.continue() : route.abort();
  });
  await context.addInitScript(fakeMedia);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const status = () => page.locator('.avatar-camera [role=status]').textContent();
  const start = () => page.getByRole('button', { name: 'Activer le regard caméra', exact: true }).click();
  const stop = () => page.getByRole('button', { name: 'Arrêter la caméra', exact: true }).click();
  const active = () => page.waitForSelector('.avatar-camera[data-active=true]');
  const allStopped = () => page.evaluate(() => tracks.every(track => track.stopped));
  const capture = async name => {
    if (!output) return;
    fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, name + '.png') });
  };
  await page.goto(origin); await page.waitForSelector('.avatar-dock[data-renderer=face]');
  assert.equal(await page.evaluate(() => mediaCalls.length), 0, 'no camera on load');
  await capture('camera-off');
  await page.setViewportSize({ width: 360, height: 780 });
  const bounds = await page.locator('.avatar-camera').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360, 'camera consent fits a narrow screen');
  if (process.env.AGENTX_FACE_FIXTURE) await page.waitForTimeout(1000); // allow WebGL resize to present
  await capture('camera-off-mobile');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { mediaMode = 'denied'; }); await start();
  await page.waitForFunction(() => document.querySelector('.avatar-camera [role=status]').textContent.includes('refusée'));
  assert.match(await status(), /refusée/);
  assert.equal(await page.locator('.avatar-dock').getAttribute('data-renderer'), 'face');
  await page.evaluate(() => { mediaMode = 'missing'; }); await start();
  await page.waitForFunction(() => document.querySelector('.avatar-camera [role=status]').textContent.includes('indisponible'));
  await page.evaluate(() => { mediaMode = 'success'; motionSide = 'left'; }); await start(); await active();
  const first = await page.evaluate(() => mediaCalls.at(-1));
  assert.equal(first.audio, false); assert.equal(first.video.frameRate.max, 5);
  assert.equal(first.video.width.max, 320); assert.equal(first.video.height.max, 240);
  await page.waitForFunction(() => captures >= 12);
  const sample = await page.evaluate(() => ({ count: captures, point: points.at(-1), rect: document.querySelector('llmx-face').getBoundingClientRect().toJSON() }));
  assert.ok(sample.point[0] > sample.rect.x + sample.rect.width * 0.7, 'mirrored motion reaches face input');
  assert.ok(sample.count <= 16, 'capture rate stays bounded');
  await capture('look-right');
  await page.evaluate(() => { motionSide = 'right'; });
  await page.waitForFunction(() => points.at(-1)[0] < innerWidth * 0.3);
  await capture('look-left');
  await page.evaluate(() => { motionSide = 'center'; });
  await page.waitForFunction(() => Math.abs(points.at(-1)[0] - innerWidth / 2) < 3);
  await capture('quiet-center');
  // Conversation speech/interruption stays owned by the existing presence loop.
  for (const state of ['speaking', 'paused', 'listening']) {
    await page.evaluate(state => dispatchEvent(new CustomEvent('persona-presence', { detail: { state } })), state);
    await page.waitForTimeout(60);
    assert.equal(await page.locator('.avatar-camera').getAttribute('data-active'), 'true');
  }
  await stop(); assert.ok(await allStopped());
  const count = await page.evaluate(() => captures); await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => captures), count, 'no capture after stop');
  // Cancel a pending permission request, then release its late result.
  await page.evaluate(() => { mediaMode = 'pending'; }); await start(); await stop();
  await page.evaluate(() => resolveMedia()); await page.waitForTimeout(50); assert.ok(await allStopped());
  // A late grant after the document hides must be released, and must not auto-resume.
  await start();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); resolveMedia(); });
  await page.waitForTimeout(50); assert.ok(await allStopped());
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  await page.evaluate(() => { mediaMode = 'success'; }); await start(); await active();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.ok(await allStopped());
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(250); assert.equal(await page.locator('.avatar-camera').getAttribute('data-active'), 'false');
  // Photo idle mode interrupts capture without generating wake/activity events.
  await start(); await active();
  await page.evaluate(() => { const photo = document.createElement('section'); photo.className = 'nestor-idle-photos'; document.body.append(photo); });
  await page.waitForSelector('.avatar-camera[data-active=false]'); assert.ok(await allStopped());
  await page.evaluate(() => document.querySelector('.nestor-idle-photos').remove());
  await start(); await active(); await page.evaluate(() => handle.setMode('cache'));
  assert.ok(await allStopped()); await page.evaluate(() => handle.setMode('scene'));
  await start(); await active(); await page.evaluate(() => tracks.at(-1).dispatchEvent(new Event('ended')));
  assert.ok(await allStopped()); assert.match(await status(), /déconnectée/);
  await page.evaluate(() => { playFail = true; }); await start();
  await page.waitForSelector('.avatar-camera[data-active=false]'); assert.ok(await allStopped());
  await page.evaluate(() => { playFail = false; drawFail = true; }); await start();
  await page.waitForSelector('.avatar-camera[data-active=false]'); assert.ok(await allStopped());
  await page.evaluate(() => { drawFail = false; }); await start(); await active();
  await page.evaluate(() => dispatchEvent(new Event('pagehide'))); assert.ok(await allStopped());
  await start(); await active(); await page.evaluate(() => handle.dispose()); assert.ok(await allStopped());
  assert.equal(await page.locator('.avatar-camera').count(), 0);
  await page.goto(origin + '?space=personal'); await page.waitForSelector('.avatar-dock[data-renderer=face]');
  assert.equal(await page.locator('.avatar-camera').count(), 0, 'other avatar consumers unchanged');
  assert.equal(await page.evaluate(() => mediaCalls.length), 0);
  await page.goto(origin); await page.waitForSelector('.avatar-dock[data-renderer=face]');
  await start(); await active();
  await page.evaluate(() => document.querySelector('llmx-face').dispatchEvent(new CustomEvent('llmx-face-error')));
  assert.ok(await allStopped());
  assert.equal(await page.locator('.avatar-dock').getAttribute('data-renderer'), 'orb');
  const calls = await page.evaluate(() => mediaCalls.length); await start();
  assert.equal(await page.evaluate(() => mediaCalls.length), calls, 'orb fallback never opens a camera');
  await page.goto(origin); await page.waitForSelector('.avatar-dock[data-renderer=face]');
  await page.evaluate(() => Object.defineProperty(navigator, 'mediaDevices', { value: undefined }));
  await start(); assert.match(await status(), /absente ou indisponible/);
  assert.equal(await page.evaluate(() => mediaCalls.length), 0, 'missing media API is a harmless fallback');
  assert.deepEqual(errors, []);
  assert.ok(network.every(row => row.url.startsWith(origin) && row.method === 'GET'), 'no media/data uploads or outgoing requests');
  console.log(JSON.stringify({ result: 'passed', camera: 'synthetic only', captures: sample.count,
    scenarios: 'opt-in, mobile, refusal, absent, bounded gaze, calm idle, voice interruption, stop, late permission, hidden, photos, masked, disconnect, play/draw failure, pagehide, dispose, personal/orb/missing API fallback',
    network: 'same-origin static GET only', errors, screenshots: output || null }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});
