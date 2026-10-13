'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Core work refreshes while a result is still being read aloud', async () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    remove() {}
    querySelector() { return null; }
  }
  let finish;
  const playback = new Promise(resolve => { finish = resolve; });
  let snapshots = 0, polls = 0, presentations = 0;
  const receipts = [];
  const context = { document: { createElement: () => new Element() }, crypto: { randomUUID: () => 'device' },
    AbortSignal, setInterval: () => ({ unref() {} }), clearInterval() {} };
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
      if (!options) { polls++; return { items: [structuredClone(item)], cursor: polls, hasMore: false }; }
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
