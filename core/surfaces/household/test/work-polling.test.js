'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));

function panel(api, timers = {}) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    remove() {}
    setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
    querySelector() { return null; }
  }
  const host = new Element(), snapshots = [], errors = [];
  const context = { document: { createElement: () => new Element() }, crypto: { randomUUID: () => 'device' },
    AbortSignal, AbortController, setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), clearInterval() {}, ...timers };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/conversation-work'), 'utf8'), context);
  const work = context.NestorWork.create({ host, base: '/sessions', api,
    getConversation: () => ({ state: 'paused' }),
    onSnapshot: (id, data) => snapshots.push({ id, data }), onPollError: id => errors.push(id) });
  return { work, host, get cards() { return host.children.filter(node => node.className === 'conversation-work-card'); }, snapshots, errors };
}

const snapshot = (cursor, text = 'Saved result') => ({ cursor, hasMore: false,
  items: [{ id: 'work', sessionId: 'session', state: 'completed', revision: 1,
    result: { version: 1, deliveryId: 'delivery', text, presentation: 'completed' } }] });

test('a stalled result read times out and the next poll recovers from the last cursor', async () => {
  const urls = [], receipts = [], deadlines = [];
  const h = panel(async (url, options) => {
    if (options?.method === 'POST') { receipts.push(JSON.parse(options.body).stage); return {}; }
    urls.push(url);
    if (urls.length === 2) return new Promise((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('connection lost')), { once: true });
    });
    return snapshot(urls.length === 1 ? 7 : 8);
  }, { setTimeout: (callback, ms) => { deadlines.push({ callback, ms }); return deadlines.length; }, clearTimeout() {} });
  try {
    h.work.follow('session'); await tick();
    const stalled = h.work.poll();
    assert.equal(deadlines.at(-1)?.ms, 10000, 'a result read has a bounded wait');
    deadlines.at(-1).callback(); await stalled;
    assert.deepEqual(h.errors, ['session']);
    assert.equal(h.cards.length, 1, 'the saved result stays on screen during the outage');
    await h.work.poll();
    assert.deepEqual(urls, ['/sessions/session/work?cursor=0', '/sessions/session/work?cursor=7', '/sessions/session/work?cursor=7']);
    assert.equal(h.snapshots.at(-1).data.cursor, 8);
    assert.deepEqual(receipts, ['displayed'], 'recovery neither claims speech nor redispatches the work');
  } finally { h.work.dispose(); }
});

test('switching conversations immediately reads the new results and ignores the old response', async () => {
  const reads = [];
  const h = panel((url, options) => options?.method === 'POST' ? Promise.resolve({}) : new Promise(resolve => {
    reads.push({ url, signal: options?.signal, resolve });
  }));
  try {
    h.work.follow('old'); h.work.follow('new');
    assert.equal(reads.length, 2, 'the old connection cannot block the new conversation');
    assert.equal(reads[0].signal.aborted, true);
    reads[0].resolve(snapshot(90, 'Old result')); await tick();
    assert.deepEqual(h.snapshots, []);
    assert.equal(h.cards.length, 0);
    await h.work.poll();
    assert.equal(reads.length, 2, 'an old response cannot release the new read and start a duplicate');
    reads[1].resolve(snapshot(3, 'New result')); await tick();
    assert.deepEqual(h.snapshots.map(row => row.id), ['new']);
    assert.equal(h.cards[0].children.find(node => node.className === 'conversation-work-answer').textContent, 'New result');
    const next = h.work.poll();
    assert.equal(reads[2].url, '/sessions/new/work?cursor=3');
    reads[2].resolve({ items: [], cursor: 3, hasMore: false }); await next;
    assert.deepEqual(h.errors, []);
  } finally { h.work.dispose(); }
});

test('leaving cancels the result read and a late response cannot restore the cards', async () => {
  let read;
  const h = panel((url, options) => new Promise(resolve => { read = { signal: options?.signal, resolve }; }));
  try {
    h.work.follow('session'); h.work.reset();
    assert.equal(read.signal?.aborted, true);
    read.resolve(snapshot(4)); await tick();
    assert.deepEqual(h.snapshots, []); assert.deepEqual(h.errors, []);
    assert.equal(h.cards.length, 0);
  } finally { h.work.dispose(); }
});

test('Core work refreshes while a result is still being read aloud', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    remove() {}
    setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
    querySelector() { return null; }
  }
  let finish;
  const playback = new Promise(resolve => { finish = resolve; });
  let snapshots = 0, polls = 0, presentations = 0;
  const receipts = [];
  const context = { document: { createElement: () => new Element() }, crypto: { randomUUID: () => 'device' },
    AgentXSpokenPresentation: require('../../../public/js/voice/spoken-presentation'),
    AbortSignal, AbortController, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/conversation-work'), 'utf8'), context);
  const item = { id: 'work', sessionId: 'session', turnId: 'turn', revision: 1, state: 'completed', pending: false,
    result: { version: 1, deliveryId: 'delivery', presentation: 'available', text: 'Complete saved result' } };
  const conversation = { session: { sessionId: 'session' }, state: 'listening', selection: { wakeWord: false },
    async interject(reply, options) {
      assert.equal(reply.text, item.result.text); presentations++;
      options.onScheduled(); await playback; return true;
    } };
  const work = context.NestorWork.create({ host: new Element(), base: '/sessions', getConversation: () => conversation,
    onSnapshot: () => { snapshots++; },
    async api(url, options) {
      if (options?.method !== 'POST') { polls++; return { items: [structuredClone(item)], cursor: polls, hasMore: false }; }
      const body = JSON.parse(options.body); receipts.push(body.stage);
      return { claimToken: 'claim' };
    } });
  work.follow('session'); await tick();
  assert.equal(presentations, 1);
  await work.poll();
  assert.equal(polls, 2);
  assert.equal(snapshots, 2, 'the second Core state arrives before speech ends');
  assert.equal(presentations, 1, 'polling does not duplicate the playback');
  assert.equal(receipts.includes('completed'), false);
  finish(); await tick();
  assert.equal(receipts.filter(stage => stage === 'completed').length, 1);
  work.dispose();
});
