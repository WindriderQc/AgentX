'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor() { this.children = []; this.dataset = {}; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  remove() {}
  querySelector(selector) { return this.children.find(node => '.' + node.className === selector); }
}
const row = (id, requestText, extra = {}) => ({ id, sessionId: 'session', turnId: `turn-${id}`, state: 'queued', revision: 1,
  pending: true, controllable: true, classification: 'native_work', receivedAt: '2026-01-02T14:25:30Z', requestText, ...extra });
function panel(api) {
  const host = new Element(), context = { document: { createElement: () => new Element() }, crypto: { randomUUID: () => 'device' },
    AbortSignal, AbortController, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/conversation-work'), 'utf8'), context);
  const work = context.NestorWork.create({ host, base: '/sessions', api, getLanguage: () => 'fr', getConversation: () => ({ state: 'paused' }) });
  return { host, work, get cards() { return host.children.filter(node => node.className === 'conversation-work-card'); } };
}
const actions = card => card.children.find(node => node.className === 'conversation-work-actions')?.children || [];
const text = card => card.children.map(node => node.textContent).join('\n');

test('three requests identify their own controls; cancellation disables both buttons and keeps its receipt', async () => {
  const rows = [row('first', 'Open the activity page.'), row('second', 'Read my next appointment.'), row('third', 'Read my next appointment.')];
  const posts = []; let finish;
  const h = panel(async (url, options) => {
    if (options?.method === 'POST') {
      posts.push({ url, body: JSON.parse(options.body) });
      await new Promise(resolve => { finish = resolve; });
      rows[1] = { ...rows[1], revision: 2, state: 'cancelled', pending: false, controllable: false };
      return { id: 'second', state: 'cancelled', revision: 2 };
    }
    return { items: structuredClone(rows), cursor: 3, hasMore: false };
  });
  try {
    h.work.follow('session'); await tick();
    const second = h.cards[1], buttons = actions(second);
    assert.match(text(second), /Read my next appointment/);
    assert.match(text(second), /En attente de démarrage/);
    assert.notEqual(buttons[1].attributes['aria-label'], actions(h.cards[2])[1].attributes['aria-label']);
    const cancelling = buttons[1].onclick();
    assert.ok(actions(second).every(button => button.disabled), 'both controls are disabled during one mutation');
    await actions(second)[0].onclick();
    assert.equal(posts.length, 1, 'double interaction cannot send a second command');
    finish(); await cancelling;
    assert.equal(posts[0].url, '/sessions/session/work/second/control');
    assert.deepEqual(posts[0].body, { action: 'cancel', revision: 1 });
    assert.match(text(second), /Demande annulée/); assert.equal(actions(second).length, 0);
    assert.match(text(h.cards[0]), /En attente/);
  } finally { h.work.dispose(); }
});

test('an unidentified request or a native execution cannot expose cancellation', async () => {
  const h = panel(async () => ({ items: [row('missing', null), row('started', 'A running request',
    { state: 'running', controllable: false, attempt: { id: 'native' } })], cursor: 2 }));
  try {
    h.work.follow('session'); await tick();
    assert.equal(actions(h.cards[0]).length, 0);
    assert.match(text(h.cards[0]), /Demande originale indisponible/);
    assert.equal(actions(h.cards[1]).length, 0);
    assert.match(text(h.cards[1]), /ne peuvent plus l’arrêter/);
  } finally { h.work.dispose(); }
});

test('a lost command response forces a fresh read and never resends the command', async () => {
  const urls = []; let posts = 0, resolveRead;
  const h = panel(async (url, options) => {
    urls.push(url);
    if (options?.method === 'POST') { posts++; throw Error('lost response'); }
    if (urls.length > 1) await new Promise(resolve => { resolveRead = resolve; });
    return { items: [row('one', 'A request')], cursor: 7 };
  });
  try {
    h.work.follow('session'); await tick();
    const card = h.cards[0], pending = actions(card)[1].onclick(); await tick();
    assert.equal(urls.at(-1), '/sessions/session/work?cursor=0');
    assert.ok(actions(card).every(button => button.disabled));
    assert.match(text(card), /Commande non confirmée/);
    resolveRead(); await pending;
    assert.ok(actions(card).every(button => !button.disabled)); assert.equal(posts, 1);
  } finally { h.work.dispose(); }
});

test('a poll started before a lost command cannot reenable controls from its old state', async () => {
  let reads = 0, oldRead, freshRead;
  const h = panel(async (_url, options) => {
    if (options?.method === 'POST') throw Error('lost response');
    reads++;
    if (reads === 2) await new Promise(resolve => { oldRead = resolve; });
    if (reads === 3) await new Promise(resolve => { freshRead = resolve; });
    return { items: [row('one', 'A request')], cursor: 7 };
  });
  try {
    h.work.follow('session'); await tick(); const card = h.cards[0];
    const oldPoll = h.work.poll(); await actions(card)[1].onclick();
    oldRead(); await oldPoll; await tick();
    assert.ok(actions(card).every(button => button.disabled));
    freshRead(); await tick(); assert.ok(actions(card).every(button => !button.disabled));
  } finally { h.work.dispose(); }
});

test('an outage retains the last request and disables commands until a successful refresh', async () => {
  let fail = false;
  const h = panel(async () => {
    if (fail) throw Error('offline'); return { items: [row('one', 'A saved request')], cursor: 3 };
  });
  try {
    h.work.follow('session'); await tick(); fail = true; await h.work.poll();
    const card = h.cards[0]; assert.match(text(card), /État indisponible/);
    assert.ok(actions(card).every(button => button.disabled));
    fail = false; await h.work.poll(); assert.ok(actions(card).every(button => !button.disabled));
  } finally { h.work.dispose(); }
});

test('a late control response cannot change the newly selected conversation', async () => {
  let finish;
  const h = panel(async (url, options) => {
    if (options?.method === 'POST') { await new Promise(resolve => { finish = resolve; }); return { state: 'cancelled', revision: 2 }; }
    return { items: [row(url.includes('/new/') ? 'new' : 'old', 'A request', { sessionId: url.includes('/new/') ? 'new' : 'session' })], cursor: 1 };
  });
  try {
    h.work.follow('session'); await tick(); const cancelling = actions(h.cards[0])[1].onclick();
    h.work.follow('new'); await tick(); finish(); await cancelling;
    assert.equal(h.cards[0].dataset.workId, 'new'); assert.match(text(h.cards[0]), /En attente/);
  } finally { h.work.dispose(); }
});
