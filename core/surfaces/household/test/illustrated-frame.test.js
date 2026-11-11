'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

class ClassList {
  constructor() { this.names = new Set(); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  toggle(name) { if (this.names.has(name)) this.names.delete(name); else this.names.add(name); }
  contains(name) { return this.names.has(name); }
}
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.classList = new ClassList(); this.attributes = {}; this.listeners = {}; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { if (name === 'src') delete this.src; delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}
const body = new Element('body');
global.document = { createElement: tag => new Element(tag), body, hidden: false };
require('../public/illustrated-frame');
require('../public/conversation-images');
const { IllustratedFrame, ConversationImages } = globalThis;

const base = '/api/voice-personas/family/sessions/family-session';
const idA = '33333333-3333-4333-8333-333333333333', idB = '44444444-4444-4444-8444-444444444444';
const operation = (opId, state = 'accepted') => ({ id: opId, state, runtimeRestored: false, statusUrl: `${base}/images/${opId}` });
const done = opId => ({ ...operation(opId, 'completed'), runtimeRestored: true, artifact: { url: `${base}/images/${opId}/image`, sha256: 'a'.repeat(64) } });
const block = (op, presentation = 'illustration') => ({ kind: 'image', source: 'local', presentation, body: 'A cat in a tree', operation: op });
const reply = op => ({ ok: true, json: async () => ({ ok: true, operation: op }) });
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('frame did not reach the expected state'); }
const frame = () => body.children.find(child => child.className === 'illustrated-frame');

test('only a family illustration with its own status route is followed', () => {
  const fetcher = async () => assert.fail('no read expected');
  assert.equal(IllustratedFrame.show(block(operation(idA), null), { fetcher }), false);
  assert.equal(IllustratedFrame.show(block({ ...operation(idA), statusUrl: `${base.replace('family', 'private')}/images/${idA}` }), { fetcher }), false);
  assert.equal(IllustratedFrame.show(block({ ...operation(idA), id: idB }), { fetcher }), false);
});
test('a picture appears only once verified, fades over the previous one, and a failure keeps it', async () => {
  const reads = [];
  IllustratedFrame.show(block(operation(idA)), { delay: 1, fetcher: async (url, options) => {
    reads.push({ url, options }); return reply(reads.length === 1 ? operation(idA, 'generating') : done(idA));
  } });
  await until(() => frame()?.children.some(layer => layer.src));
  const first = frame().children.find(layer => layer.src), second = frame().children.find(layer => layer !== first);
  assert.equal(first.src, `${base}/images/${idA}/image`);
  assert.equal(frame().hidden, true, 'hidden until the picture has loaded');
  first.onload();
  assert.equal(frame().hidden, false); assert.ok(first.classList.contains('is-front'));
  assert.ok(reads.every(read => read.url === `${base}/images/${idA}` && !read.options.method), 'reads only');
  IllustratedFrame.show(block(done(idB)), { fetcher: async () => assert.fail('a ready picture needs no read') });
  assert.equal(second.src, `${base}/images/${idB}/image`);
  second.onload();
  assert.ok(second.classList.contains('is-front')); assert.ok(!first.classList.contains('is-front'));
  let polled = 0;
  IllustratedFrame.show(block(operation(idA)), { delay: 1, fetcher: async () => { polled++; return reply(operation(idA, 'cancelled')); } });
  await until(() => polled === 1); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(polled, 1, 'a finished attempt stops reading');
  assert.ok(second.classList.contains('is-front'), 'the previous picture stays');
  frame().listeners.click(); assert.ok(frame().classList.contains('is-large'));
  IllustratedFrame.clear();
  assert.equal(frame().hidden, true); assert.ok(frame().children.every(layer => !layer.src));
});
test('a hidden page pauses reads', async () => {
  document.hidden = true;
  let reads = 0;
  IllustratedFrame.show(block(operation(idA)), { delay: 1, fetcher: async () => { reads++; return reply(done(idA)); } });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(reads, 0);
  document.hidden = false;
  await until(() => reads === 1);
  IllustratedFrame.clear();
});
test('a reopened conversation does not replay illustrations as drawing cards', async () => {
  const added = [];
  const blocks = [{ ...block(operation(idA)) }, { ...block(operation(idB), null) }];
  await ConversationImages.resume(base, row => added.push(row), { fetcher: async () => ({ ok: true, json: async () => ({ ok: true, blocks }) }) });
  assert.deepEqual(added.map(row => row.operation.id), [idB]);
});
