'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');
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
  controlBasis: { version: 2, workId: id, revision: extra.revision ?? 1, requestSha256: createHash('sha256').update(requestText || '').digest('hex') },
  controlReceipts: [], pending: true, controllable: true, classification: 'native_work', receivedAt: '2026-01-02T14:25:30Z', requestText, ...extra });
const receiptOf = (body, state) => ({ version: 2, requestId: body.requestId, workId: body.workId, action: body.action,
  requestSha256: body.requestSha256, baseRevision: body.revision, revision: body.revision + 1, state });
const storage = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; };
function panel(api, commandStorage = storage()) {
  const host = new Element(), context = { document: { createElement: () => new Element() }, crypto: { randomUUID }, sessionStorage: commandStorage,
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
      const commandReceipt = receiptOf(posts.at(-1).body, 'cancelled');
      rows[1] = row('second', rows[1].requestText, { revision: 2, state: 'cancelled', pending: false, controllable: false, controlReceipts: [commandReceipt] });
      return { id: 'second', state: 'cancelled', revision: 2, commandReceipt };
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
    assert.deepEqual(posts[0].body, { action: 'cancel', ...rows[1].controlBasis, revision: 1, requestId: posts[0].body.requestId });
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

test('a lost command response remains unknown until its exact receipt is read, never resending', async () => {
  const urls = []; let posts = 0, resolveRead, command, confirmed = false;
  const h = panel(async (url, options) => {
    urls.push(url);
    if (options?.method === 'POST') { posts++; command = JSON.parse(options.body); throw Error('lost response'); }
    if (urls.length === 3) await new Promise(resolve => { resolveRead = resolve; });
    return { items: [row('one', 'A request', confirmed ? { state: 'cancelled', revision: 2, controllable: false,
      controlReceipts: [receiptOf(command, 'cancelled')] } : {})], cursor: 7 };
  });
  try {
    h.work.follow('session'); await tick();
    const card = h.cards[0], pending = actions(card)[1].onclick(); await tick();
    assert.equal(urls.at(-1), '/sessions/session/work?cursor=0');
    assert.ok(actions(card).every(button => button.disabled));
    assert.match(text(card), /Commande non confirmée/);
    resolveRead(); await pending;
    assert.ok(actions(card).every(button => button.disabled), 'absence of receipt is not proof that the command failed');
    confirmed = true; await h.work.poll();
    assert.equal(actions(card).length, 0); assert.match(text(card), /Commande confirmée/); assert.equal(posts, 1);
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
    freshRead(); await tick(); assert.ok(actions(card).every(button => button.disabled));
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

test('reload restores the exact pending command until Core returns its receipt', async () => {
  const journal = storage(); let command, confirmed = false, posts = 0;
  const api = async (_url, options) => {
    if (options?.method === 'POST') { posts++; command = JSON.parse(options.body); throw Error('lost response'); }
    return { items: [row('one', 'A request', confirmed ? { state: 'paused', revision: 2,
      controlReceipts: [receiptOf(command, 'paused')] } : {})], cursor: 7 };
  };
  const old = panel(api, journal);
  old.work.follow('session'); await tick(); await actions(old.cards[0])[0].onclick(); old.work.dispose();
  const resumed = panel(api, journal);
  try {
    resumed.work.follow('session'); await tick();
    assert.ok(actions(resumed.cards[0]).every(button => button.disabled));
    assert.match(text(resumed.cards[0]), /Commande non confirmée/);
    confirmed = true; await resumed.work.poll();
    assert.ok(actions(resumed.cards[0]).every(button => !button.disabled));
    assert.match(text(resumed.cards[0]), /Commande confirmée/);
    assert.equal(posts, 1, 'neither reload nor reconciliation resends the original command');
    assert.deepEqual(JSON.parse(journal.getItem('agentx.work-controls:session')), []);
  } finally { resumed.work.dispose(); }
});

test('an unrelated receipt does not confirm a pending command at an unchanged revision', async () => {
  let command, posts = 0;
  const h = panel(async (_url, options) => {
    if (options?.method === 'POST') {
      posts++; command = JSON.parse(options.body);
      return { id: 'other-work', revision: 2, state: 'paused', commandReceipt: receiptOf(command, 'paused') };
    }
    return { items: [row('one', 'A request', { controlReceipts: command
      ? [receiptOf({ ...command, requestId: randomUUID() }, 'paused')] : [] })], cursor: 7 };
  });
  try {
    h.work.follow('session'); await tick(); await actions(h.cards[0])[0].onclick();
    assert.ok(actions(h.cards[0]).every(button => button.disabled));
    assert.match(text(h.cards[0]), /Commande non confirmée/);
    assert.equal(posts, 1);
  } finally { h.work.dispose(); }
});

test('a newer revision without the receipt still cannot confirm the command or authorize replay', async () => {
  let posts = 0;
  const h = panel(async (_url, options) => {
    if (options?.method === 'POST') { posts++; throw Error('lost response'); }
    return { items: [row('one', 'A request', posts ? { revision: 2 } : {})], cursor: 7 };
  });
  try {
    h.work.follow('session'); await tick(); await actions(h.cards[0])[0].onclick();
    assert.ok(actions(h.cards[0]).every(button => button.disabled));
    assert.doesNotMatch(text(h.cards[0]), /Commande confirmée/);
    assert.equal(posts, 1);
  } finally { h.work.dispose(); }
});

test('an explicit refusal permits a fresh command, while an unavailable journal sends nothing', async () => {
  let posts = 0;
  const api = async (_url, options) => {
    if (options?.method === 'POST') { posts++; throw Object.assign(Error('stale'), { status: 409 }); }
    return { items: [row('one', 'A request')], cursor: 7 };
  };
  const h = panel(api);
  try {
    h.work.follow('session'); await tick(); await actions(h.cards[0])[0].onclick();
    assert.ok(actions(h.cards[0]).every(button => !button.disabled)); assert.equal(posts, 1);
  } finally { h.work.dispose(); }
  const unavailable = panel(api, { getItem() {}, setItem() { throw Error('browser storage unavailable'); } });
  try {
    unavailable.work.follow('session'); await tick(); await actions(unavailable.cards[0])[0].onclick();
    assert.equal(posts, 1); assert.match(text(unavailable.cards[0]), /Aucune commande envoyée/);
  } finally { unavailable.work.dispose(); }
});
