'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/nestor-ambient.js'), 'utf8');

function fixture({ cacheContext = true } = {}) {
  const canvases = [], frames = new Map();
  let id = 0;
  const background = { kind: 'unknown', light: 'night', intensity: 0, wind: 0 };
  const scene = { background, chips: [], moment: null };
  function context() {
    return { beginPath() {}, arc() {}, fill() {}, calls: [], globalAlpha: 1, globalCompositeOperation: 'source-over',
      createLinearGradient(...args) {
        const stops = [];
        this.calls.push({ op: 'gradient', args, stops });
        return { addColorStop: (...stop) => stops.push(stop) };
      },
      clearRect(...args) { this.calls.push({ op: 'clear', args }); },
      fillRect(...args) { this.calls.push({ op: 'fill', args, alpha: this.globalAlpha }); },
      drawImage(image, ...args) { this.calls.push({ op: 'image', image, args,
        alpha: this.globalAlpha, composite: this.globalCompositeOperation }); }
    };
  }
  function element(tag) {
    const listeners = new Map();
    const el = { tag, listeners, addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: event => listeners.delete(event), dataset: {}, style: {}, clientWidth: 1920, clientHeight: 1080,
      width: 300, height: 150, setAttribute() {}, append() {}, replaceChildren() {},
      remove() { this.removed = true; }, querySelector() { return null; } };
    if (tag === 'canvas') {
      el.ctx = canvases.length && !cacheContext ? null : context();
      el.getContext = () => el.ctx; canvases.push(el);
    }
    return el;
  }
  const host = { dataset: { view: 'plein' }, prepend(el) { el.parentElement = this; } };
  const doc = { body: element('body'), hidden: false, createElement: element,
    querySelector: selector => selector === '.avatar-dock' ? host : null,
    addEventListener() {}, removeEventListener() {} };
  const root = { document: doc, devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    NestorAmbientChoice: { chooseScreen: () => scene, passArc: () => [],
      artxScene: scene => scene, weatherLine: () => null },
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(key) { frames.delete(key); },
    setInterval() { return ++id; }, clearInterval() {},
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(source, { window: root });
  const mounted = root.NestorAmbient.mount({ fetchImpl: null });
  mounted.decide();
  return { mounted, root, background, scene, canvases, frames, doc,
    frame(time) { const [key, callback] = frames.entries().next().value; frames.delete(key); callback(time); } };
}

test('static sky raster is reused and copies alpha without a per-frame gradient or clear', () => {
  const f = fixture();
  f.frame(40); f.frame(80); f.frame(120);
  const [visible, cached] = f.canvases;
  assert.equal(cached.ctx.calls.filter(c => c.op === 'gradient').length, 1);
  assert.equal(cached.ctx.calls.find(c => c.op === 'fill').alpha, 0.9);
  assert.equal(visible.ctx.calls.filter(c => c.op === 'gradient' || c.op === 'clear').length, 0);
  const copies = visible.ctx.calls.filter(c => c.op === 'image');
  assert.equal(copies.length, 3);
  assert.ok(copies.every(c => c.image === cached && c.alpha === 1 && c.composite === 'copy'));
  assert.equal(visible.ctx.globalCompositeOperation, 'source-over', 'particles retain normal composition');
  f.mounted.dispose();
  assert.equal(cached.width, 0); assert.equal(cached.height, 0);
  assert.equal(f.frames.size, 0);
});

test('palette, resize and pixel ratio invalidate one bounded sky raster', () => {
  const f = fixture();
  f.frame(40);
  f.background.light = 'day'; f.frame(80);
  f.canvases[0].clientWidth = 1000; f.frame(120);
  f.root.devicePixelRatio = 2; f.frame(160);
  f.frame(200);
  const cached = f.canvases[1];
  assert.equal(f.canvases.length, 2);
  assert.equal(cached.ctx.calls.filter(c => c.op === 'gradient').length, 4);
  assert.equal(cached.width, 1500); assert.equal(cached.height, 1620);
  const palettes = cached.ctx.calls.filter(c => c.op === 'gradient').map(c => c.stops[0][1]);
  assert.deepEqual(palettes, ['#02060d', '#0d2638', '#0d2638', '#0d2638']);
  f.mounted.dispose();
});

test('missing offscreen context retains direct rendering rather than dropping the sky', () => {
  const f = fixture({ cacheContext: false });
  f.frame(40); f.frame(80);
  const ctx = f.canvases[0].ctx;
  assert.equal(ctx.calls.filter(c => c.op === 'clear').length, 2);
  assert.equal(ctx.calls.filter(c => c.op === 'gradient').length, 2);
  assert.equal(ctx.globalAlpha, 1);
  f.mounted.dispose();
});

test('a hidden document stops rendering and remains restartable', () => {
  const f = fixture(); f.frame(40); f.doc.hidden = true; f.frame(80);
  assert.equal(f.frames.size, 0);
  assert.equal(f.canvases[0].ctx.calls.filter(c => c.op === 'image').length, 1);
  f.doc.hidden = false; f.mounted.decide(); f.frame(120);
  assert.equal(f.canvases[1].ctx.calls.filter(c => c.op === 'gradient').length, 1);
  f.mounted.dispose();
});


test('zero-sized layouts do not copy an invalid image and recover on resize', () => {
  const f = fixture(); f.canvases[0].clientWidth = 0; f.frame(40);
  assert.equal(f.canvases[0].ctx.calls.length, 0);
  f.canvases[0].clientWidth = 1920; f.frame(80);
  assert.equal(f.canvases[0].ctx.calls.filter(c => c.op === 'image').length, 1);
  f.mounted.dispose();
});


test('restored offscreen context rebuilds the cached pixels', () => {
  const f = fixture(); f.frame(40);
  const cached = f.canvases[1]; cached.listeners.get('contextrestored')(); f.frame(80);
  assert.equal(cached.ctx.calls.filter(c => c.op === 'gradient').length, 2);
  f.mounted.dispose(); assert.equal(cached.listeners.size, 0);
});


test('ISS temporarily uses the night palette and restores the daytime background', () => {
  const f = fixture(); f.background.light = 'day'; f.frame(40);
  f.scene.moment = { kind: 'iss', pass: { start: 'pass' } }; f.frame(80);
  f.scene.moment = null; f.frame(120);
  const palettes = f.canvases[1].ctx.calls.filter(c => c.op === 'gradient').map(c => c.stops[0][1]);
  assert.deepEqual(palettes, ['#0d2638', '#02060d', '#0d2638']);
  f.mounted.dispose();
});
