'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const settle = () => new Promise(setImmediate);
function harness({ ready = true, supported = true, honorAbort = true, hidden = false } = {}) {
  const viewEvents = new Map(), documentEvents = new Map(), windowEvents = new Map();
  const intervals = new Map(), deadlines = new Map(), calls = [], rendered = [];
  let timer = 0, intersection, frameVisible = true, disconnected = false;
  const on = (events, name, fn) => { const list = events.get(name) || []; list.push(fn); events.set(name, list); };
  const off = (events, name, fn) => events.set(name, (events.get(name) || []).filter(item => item !== fn));
  const emit = (events, name, event = {}) => [...(events.get(name) || [])].forEach(fn => fn(event));
  const status = { hidden: true, textContent: '' };
  const view = { state: () => ({ presentation: ready ? { selection: null } : null }),
    addEventListener: (name, fn) => on(viewEvents, name, fn),
    ...(supported && { setLiveState(value) { rendered.push(value); return true; } }) };
  const document = { hidden, querySelector: () => view, getElementById: () => status,
    addEventListener: (name, fn) => on(documentEvents, name, fn),
    removeEventListener: (name, fn) => off(documentEvents, name, fn) };
  const window = { frameElement: { getClientRects: () => frameVisible ? [{}] : [] },
    addEventListener: (name, fn) => on(windowEvents, name, fn) };
  const context = vm.createContext({ window, document, AbortController, console,
    setInterval(fn) { const id = ++timer; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) { const id = ++timer; deadlines.set(id, fn); return id; },
    clearTimeout(id) { deadlines.delete(id); },
    IntersectionObserver: class {
      constructor(callback) { intersection = callback; }
      observe() { disconnected = false; }
      disconnect() { disconnected = true; }
    },
    fetch(url, options) {
      return new Promise((resolve, reject) => {
        calls.push({ url, options, resolve, reject });
        if (honorAbort) options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    } });
  const polling = fs.readFileSync(require.resolve('../../../public/js/utils/polling-controller.js'), 'utf8')
    .replace('export class PollingController', 'class PollingController');
  vm.runInContext(polling + '\nwindow.PollingController = PollingController;', context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/ecosystem-live-page.js'), 'utf8'), context);
  return { calls, rendered, status, intervals, deadlines,
    ready() { ready = true; emit(viewEvents, 'ecosystem-ready'); },
    firstFrame() { emit(viewEvents, 'ecosystem-first-frame'); },
    tick() { [...intervals.values()].forEach(fn => fn()); },
    timeout() { [...deadlines.values()].forEach(fn => fn()); },
    hide(value) { document.hidden = value; emit(documentEvents, 'visibilitychange'); },
    frame(value) { frameVisible = value; intersection([{ isIntersecting: value }]); },
    page(name) { emit(windowEvents, name); },
    event(name, detail = {}) { emit(viewEvents, 'ecosystem-' + name, { detail }); },
    get disconnected() { return disconnected; },
    answer(index, data = { nodes: [{ id: 'node-a' }, { id: 'node-b' }] }) {
      calls[index].resolve({ ok: true, json: async () => ({ status: 'success', data }) });
    }
  };
}

test('the whole map starts updating automatically when ready, without a selection or click', async () => {
  const page = harness({ ready: false });
  assert.equal(page.calls.length, 0);
  page.ready(); assert.equal(page.calls.length, 1);
  page.firstFrame(); assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, '/api/nerve-center/ecosystem/live');
  assert.equal(page.calls[0].options.cache, 'no-store');
  const payload = { contract: 'agentx.ecosystem-live/v1', nodes: [{ id: 'node-a' }, { id: 'node-b' }], read: { id: 'fixture' } };
  page.answer(0, payload); await settle();
  assert.equal(page.rendered[0], payload, 'the complete snapshot reaches the component, without a selected-node filter');
  page.event('closed');
});

test('the real polling controller never overlaps a slow request', async () => {
  const page = harness();
  page.tick(); page.tick(); assert.equal(page.calls.length, 1);
  page.answer(0); await settle();
  page.tick(); assert.equal(page.calls.length, 2);
  page.answer(1); await settle(); page.event('closed');
});

test('hidden documents abort the old request and resume automatically without installing its late result', async () => {
  const page = harness({ honorAbort: false });
  page.hide(true);
  assert.equal(page.calls[0].options.signal.aborted, true);
  assert.equal(page.intervals.size, 0);
  page.answer(0); await settle(); assert.equal(page.rendered.length, 0);
  page.hide(false); assert.equal(page.calls.length, 2);
  page.answer(1); await settle(); assert.equal(page.rendered.length, 1);
  page.event('closed');
});

test('an initially hidden document waits for visibility before its first request', async () => {
  const page = harness({ hidden: true });
  assert.equal(page.calls.length, 0);
  page.hide(false); assert.equal(page.calls.length, 1);
  page.answer(0); await settle(); page.event('closed');
});

test('a fast hide/show cannot overlap a cancelled request whose transport has not settled', async () => {
  const page = harness({ honorAbort: false });
  page.hide(true); page.hide(false); page.tick();
  assert.equal(page.calls.length, 1);
  page.answer(0); await settle();
  assert.equal(page.rendered.length, 0, 'visibility resumption does not legitimize the invalidated response');
  page.tick(); assert.equal(page.calls.length, 2);
  page.answer(1); await settle();
  assert.equal(page.rendered.length, 1); page.event('closed');
});

test('a deadline clears current evidence and permits a later independent refresh', async () => {
  const page = harness();
  page.timeout(); await settle();
  assert.equal(page.calls[0].options.signal.aborted, true);
  assert.deepEqual(page.rendered, [null]); assert.equal(page.deadlines.size, 0);
  page.tick(); assert.equal(page.calls.length, 2);
  page.answer(1); await settle(); assert.equal(page.rendered.length, 2);
  page.event('closed');
});

test('frame hiding, page navigation and closure fence responses before they reach the renderer', async () => {
  const page = harness({ honorAbort: false });
  page.frame(false); assert.equal(page.calls[0].options.signal.aborted, true);
  page.answer(0); await settle(); assert.equal(page.rendered.length, 0);
  page.tick(); await settle(); assert.equal(page.calls.length, 1);
  page.frame(true); assert.equal(page.calls.length, 2);
  page.page('pagehide'); assert.equal(page.calls[1].options.signal.aborted, true);
  assert.equal(page.disconnected, true); assert.equal(page.intervals.size, 0);
  page.answer(1); await settle(); assert.equal(page.rendered.length, 0);
  page.page('pageshow'); assert.equal(page.calls.length, 3);
  page.event('closed'); assert.equal(page.calls[2].options.signal.aborted, true);
  page.answer(2); await settle(); page.tick(); page.page('pageshow');
  assert.equal(page.calls.length, 3); assert.equal(page.rendered.length, 0);
  assert.equal(page.intervals.size, 0);
});

test('HTTP or payload refusal clears evidence while an invalid tour command leaves live refresh enabled', async () => {
  const page = harness();
  page.calls[0].resolve({ ok: false }); await settle();
  assert.deepEqual(page.rendered, [null]);
  page.event('error', { stage: 'play' }); page.tick(); assert.equal(page.calls.length, 2);
  page.calls[1].resolve({ ok: true, json: async () => ({ status: 'error' }) }); await settle();
  assert.deepEqual(page.rendered, [null, null]);
  page.tick(); assert.equal(page.calls.length, 3);
  page.event('error', { stage: 'mount' });
  assert.equal(page.calls[2].options.signal.aborted, true);
  await settle(); assert.equal(page.intervals.size, 0);
});

test('an older component reports its unsupported capability and starts no request', () => {
  const page = harness({ supported: false });
  assert.equal(page.calls.length, 0); assert.equal(page.status.hidden, false);
  assert.match(page.status.textContent, /indisponibles/);
  page.event('closed');
});
