'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('../public/guided-visit');
class Element extends EventTarget {
  children = [];
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  remove() { this.removed = true; }
}
function fixture(options = {}) {
  const bus = new EventTarget(), doc = new EventTarget(), host = new Element();
  doc.createElement = () => new Element(); doc.hidden = false;
  globalThis.addEventListener = bus.addEventListener.bind(bus);
  globalThis.removeEventListener = bus.removeEventListener.bind(bus);
  return { doc, host, bus, visit: mount({ host, documentRef: doc, ...options }) };
}

test('only opening a named visit keeps the conversation in the background; return and End restore normal visibility behavior', () => {
  const h = fixture();
  try {
    assert.equal(h.visit.active(), false);
    h.bus.dispatchEvent(new CustomEvent('nestor-guided-visit', { detail: { label: 'Home Assistant' } }));
    assert.equal(h.visit.active(), true); assert.equal(h.host.children[0].hidden, false);
    h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(h.visit.active(), true);
    h.doc.hidden = false; h.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(h.visit.active(), false);
    h.bus.dispatchEvent(new CustomEvent('nestor-guided-visit', { detail: { label: 'Grafana' } }));
    h.host.children[0].children[1].dispatchEvent(new Event('click')); assert.equal(h.visit.active(), false);
    h.visit.dispose(); assert.equal(h.host.children[0].removed, true);
    h.bus.dispatchEvent(new CustomEvent('nestor-guided-visit', { detail: { label: 'Grafana' } })); assert.equal(h.visit.active(), false);
  } finally { h.visit.dispose(); }
});

test('a background visit expires and invokes the microphone stop boundary once', async () => {
  let expired = 0;
  const h = fixture({ maxMs: 10, onExpire: () => expired++ });
  try {
    h.bus.dispatchEvent(new CustomEvent('nestor-guided-visit', { detail: { label: 'Home Assistant' } }));
    h.doc.hidden = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.visit.active(), false); assert.equal(expired, 1);
  } finally { h.visit.dispose(); }
});
