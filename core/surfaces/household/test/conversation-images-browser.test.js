'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.isConnected = true; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute() {}
  get childElementCount() { return this.children.length; }
  get lastElementChild() { return this.children.at(-1); }
  find(tag) { return this.tagName === tag ? this : this.children.map(child => child.find(tag)).find(Boolean); }
  text() { return [this.textContent, ...this.children.map(child => child.text())].join(' '); }
}
global.document = { createElement: tag => new Element(tag) };
require('../public/conversation-images');
require('../public/display-board');
const { create, resume } = globalThis.ConversationImages;
const id = '33333333-3333-4333-8333-333333333333';
const base = '/api/voice-personas/family/sessions/family-session';
const pending = { id, state: 'accepted', runtimeRestored: false, statusUrl: `${base}/images/${id}` };
const ready = { ...pending, state: 'completed', runtimeRestored: true,
  artifact: { url: pending.statusUrl + '/image', sha256: 'a'.repeat(64) } };
const block = operation => ({ key: 'image:' + id, kind: 'image', source: 'local', title: 'Robots', body: 'Two robots', operation });
const response = operation => ({ ok: true, json: async () => ({ ok: true, operation }) });
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('UI did not reach expected state'); }

test('a preparing drawing becomes an image only after verified completion; all polling is read-only', async () => {
  const reads = [];
  const holder = create(block(pending), { space: 'family', delay: 5, fetcher: async (url, options) => {
    reads.push({ url, options }); return response(reads.length === 1 ? { ...pending, state: 'generating' } : ready);
  } });
  assert.equal(holder.find('img'), undefined);
  await until(() => holder.find('img'));
  assert.equal(holder.find('img').src, ready.artifact.url);
  assert.match(holder.text(), /Ton image est prête/);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(read => read.url === pending.statusUrl && !read.options.method));
  assert.equal(holder.find('a').href, '/images?operation=' + id);
  holder._dispose();
});
test('completed without restoration, a forged artifact URL, or an unrelated operation never display an image', async () => {
  for (const operation of [{ ...ready, runtimeRestored: false }, { ...ready, artifact: { ...ready.artifact, url: 'https://external.test/private.png' } },
    { ...ready, id: '44444444-4444-4444-8444-444444444444' }]) {
    let read = false;
    const holder = create(block(pending), { space: 'family', fetcher: async () => { read = true; return response(operation); } });
    await until(() => read); await new Promise(resolve => setImmediate(resolve));
    assert.equal(holder.find('img'), undefined); holder._dispose();
  }
  let called = false;
  const wrongSpace = create(block({ ...pending, statusUrl: pending.statusUrl.replace('/family/', '/private/') }),
    { space: 'family', fetcher: async () => { called = true; } });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(called, false); wrongSpace._dispose();
});
test('terminal failure does not loop or create another drawing, and removed cards stop watching', async () => {
  let reads = 0;
  const holder = create(block(pending), { space: 'family', delay: 5, fetcher: async () => { reads += 1; return response({ ...pending, state: 'unknown' }); } });
  await until(() => reads === 1); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 1); assert.match(holder.text(), /Aucune nouvelle image/); holder._dispose();
  const disconnected = create(block(pending), { space: 'family', fetcher: async () => { assert.fail('A removed card must not poll'); } });
  disconnected.isConnected = false; await new Promise(resolve => setTimeout(resolve, 10)); disconnected._dispose();
});
test('resume recovers accepted operations missing from audit without POST, ignores foreign scopes, and respects navigation', async () => {
  const added = [], requests = [];
  const fetcher = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true,
    blocks: [block(pending), block({ ...pending, statusUrl: pending.statusUrl.replace('family-session', 'other-session') })] }) }; };
  await resume(base, item => added.push(item), { fetcher });
  assert.equal(added.length, 1); assert.equal(requests[0].url, base + '/images'); assert.equal(requests[0].options.method, undefined);
  await resume(base, () => assert.fail('Old session must not redraw after navigation'), { fetcher, current: () => false });
});
test('repeated stream and history receipts replace one card and dispose its old watcher', () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({ ...pending, state: 'unknown' });
  try {
    const container = new Element('section'), board = globalThis.DisplayBoard.create(container, { space: 'family' });
    board.add(block(pending)); board.add(block(pending));
    assert.equal(container.children[1].children.length, 1); assert.equal(board.has('image:' + id), true);
    board.clear(); assert.equal(board.has('image:' + id), false);
  } finally { globalThis.fetch = original; }
});
