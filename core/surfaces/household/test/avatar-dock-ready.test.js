'use strict';

// A face slower than the ready timeout must still replace the fallback orb (the phone case).
const test = require('node:test');
const assert = require('node:assert/strict');

class FakeElement {
  constructor(tag) {
    this.tagName = tag; this.dataset = {}; this.attributes = {}; this.children = []; this.listeners = {};
    this.parent = null; this.style = { setProperty() {} }; this.innerHTML = '';
    this.classList = { toggle() {}, remove() {} };
    this.parts = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { (this.listeners[type] || []).splice(0).forEach(fn => fn({ target: this })); }
  append(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  querySelector(selector) { return (this.parts[selector] ||= new FakeElement(selector)); }
  querySelectorAll() { return []; }
}

function setup() {
  const body = new FakeElement('body');
  const created = [];
  const doc = { body, createElement(tag) { const element = new FakeElement(tag); created.push(element); return element; } };
  globalThis.customElements = { get: name => name === 'llmx-face' };
  globalThis.addEventListener ||= () => {};
  globalThis.removeEventListener ||= () => {};
  const dock = require('../public/avatar-dock');
  globalThis.AvatarDock = dock;
  return { dock, doc, created };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('a face that becomes ready after the timeout replaces the orb instead of being discarded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { dock, doc, created } = setup();
  const handle = dock.mount({ space: 'family', documentRef: doc });
  try {
    await Promise.resolve(); await Promise.resolve();
    const face = created.find(element => element.tagName === 'llmx-face');
    assert.ok(face, 'the face element is mounted');
    const container = created.find(element => element.className === 'avatar-dock');

    t.mock.timers.tick(7000);
    assert.equal(await handle.ready, 'orb', 'speech is not held by a slow face');
    assert.ok(face.parent, 'the slow face stays mounted');
    assert.notEqual(container.dataset.renderer, 'face');

    face.dispatch('llmx-face-ready');
    assert.equal(container.dataset.renderer, 'face', 'the face takes over from the orb when it arrives');
  } finally { handle.dispose(); await flush(); delete globalThis.customElements; delete globalThis.AvatarDock; }
});

test('a face error still falls back to the orb', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { dock, doc, created } = setup();
  const handle = dock.mount({ space: 'personal', documentRef: doc });
  try {
    await Promise.resolve(); await Promise.resolve();
    const face = created.find(element => element.tagName === 'llmx-face');
    const container = created.find(element => element.className === 'avatar-dock');
    face.dispatch('llmx-face-error');
    assert.equal(await handle.ready, 'orb');
    assert.equal(face.parent, null, 'a broken face is removed');
    assert.equal(container.dataset.renderer, 'orb');
  } finally { handle.dispose(); delete globalThis.customElements; delete globalThis.AvatarDock; }
});
