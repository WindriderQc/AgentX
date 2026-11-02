'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { Conversation, WakeWindow } = require('../public/browser-conversation');
const flush = () => new Promise(resolve => setImmediate(resolve));
const photo = number => {
  const id = number.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return { id, src: '/api/photos/frame/' + id + '/image' };
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness() {
  const listeners = new Map(), events = new Map();
  const add = (map, name, run) => { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(run); };
  const emit = (map, event) => { for (const run of map.get(event.type) || []) run(event); };
  let document;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.hidden = false; this.isConnected = true; }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelector(selector) { for (const child of this.children) { if (child.tag === selector) return child; const nested = child.querySelector(selector); if (nested) return nested; } }
    matches(selectors) { return selectors.split(',').some(selector => selector.trim() === this.tag); }
    focus() { document.activeElement = this; emit(events, { type: 'focusin', target: this }); }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  }
  document = {
    hidden: false, body: new Element('body'), createElement: tag => new Element(tag),
    addEventListener: (name, run) => add(events, name, run), removeEventListener: (name, run) => events.get(name)?.delete(run)
  };
  document.activeElement = document.body;
  const host = new Element('main'); document.body.append(host);
  const h = { clock: 0, visibilityChanges: [], requests: [], queue: [], decodes: [], delayImages: false, failImage: false, blocked: false, voiceBusy: false, allocated: 0 };
  const root = {
    document, CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    dispatchEvent(event) { if (event.type === 'nestor-idle-photos-visibility') h.visibilityChanges.push(!h.region.hidden); emit(listeners, event); return true; },
    NestorConversation: { WakeWindow }, setInterval: () => 1, clearInterval() {},
    addEventListener: (name, run) => add(listeners, name, run), removeEventListener: (name, run) => listeners.get(name)?.delete(run),
    MutationObserver: class { observe() {} disconnect() {} },
    Image: class {
      set src(value) {
        this.value = value;
        if (h.delayImages) h.decodes.push(this);
        else queueMicrotask(() => h.failImage ? this.onerror(Error('Synthetic image failure')) : this.onload());
      }
    }
  };
  const context = vm.createContext(root);
  for (const name of ['screen-commands.js', 'idle-photos.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', name), 'utf8'), context);
  h.frame = root.NestorIdlePhotos.mount({ host, api: async url => {
    h.requests.push(url);
    if (url.endsWith('/status')) return { enabled: true, idleSeconds: 30, intervalSeconds: 5 };
    return h.queue.length ? h.queue.shift() : photo(++h.allocated);
  }, now: () => h.clock, busy: ({ recognizing } = {}) => h.blocked || (h.voiceBusy && !recognizing) });
  h.region = document.body.children.find(node => node.tag === 'section');
  h.image = h.region.querySelector('img'); h.document = document;
  h.shown = () => h.image.src;
  h.count = () => h.requests.filter(url => !url.endsWith('/status')).length;
  h.key = (key, options = {}) => {
    const event = { type: 'keydown', key, target: document.activeElement, prevented: false,
      preventDefault() { this.prevented = true; }, ...options };
    emit(events, event); return event;
  };
  h.presence = (state, space = 'personal') => { h.voiceBusy = ['hearing', 'transcribing'].includes(state); emit(listeners, { type: 'persona-presence', detail: { state, space } }); };
  h.activity = () => emit(listeners, { type: 'persona-activity', detail: { space: 'personal' } });
  h.enter = async () => { document.activeElement = document.body; h.clock += 31000; h.frame.tick(); await flush(); };
  h.next = async () => { h.key('ArrowRight'); await flush(); };
  h.back = () => h.key('ArrowLeft');
  h.visibility = () => emit(events, { type: 'visibilitychange' });
  h.makeEditor = tag => { const editor = new Element(tag); document.body.append(editor); return editor; };
  return h;
}

test('first photo has no previous; keyboard, voice and automatic advance share exact history', async () => {
  const h = harness(); await flush(); await h.enter();
  assert.equal(h.shown(), photo(1).src);
  assert.equal(h.back().prevented, true); assert.equal(h.shown(), photo(1).src); assert.equal(h.count(), 1);
  await h.next(); assert.equal(h.shown(), photo(2).src);
  assert.equal(h.frame.localControl('recule').applied, true); assert.equal(h.shown(), photo(1).src);
  assert.equal(h.frame.localControl('avance').applied, true); assert.equal(h.shown(), photo(2).src); assert.equal(h.count(), 2);
  h.clock += 6000; h.frame.tick(); await flush(); assert.equal(h.shown(), photo(3).src);
  h.back(); assert.equal(h.shown(), photo(2).src);
  h.clock += 6000; h.frame.tick(); await flush(); assert.equal(h.shown(), photo(3).src); assert.equal(h.count(), 3);
  h.frame.dispose();
});

test('manual navigation restarts the automatic interval', async () => {
  const h = harness(); await flush(); await h.enter(); await h.next();
  h.clock += 4000; h.back(); h.clock += 4000; h.frame.tick(); await flush();
  assert.equal(h.shown(), photo(1).src);
  h.clock += 1000; h.frame.tick(); await flush(); assert.equal(h.shown(), photo(2).src); assert.equal(h.count(), 2);
  h.frame.dispose();
});

test('rapid next repeats coalesce; previous cancels a request; out-of-order responses cannot replace history', async () => {
  const h = harness(); await flush(); await h.enter(); await h.next();
  const old = deferred(); h.queue.push(old.promise);
  for (let i = 0; i < 8; i++) h.key('ArrowRight');
  assert.equal(h.count(), 3); h.back(); assert.equal(h.shown(), photo(1).src);
  await h.next(); assert.equal(h.shown(), photo(2).src);
  const current = deferred(); h.queue.push(current.promise); await h.next();
  old.resolve(photo(30)); await flush(); assert.equal(h.shown(), photo(2).src);
  h.key('ArrowRight'); assert.equal(h.count(), 4, 'old finally does not clear the current request');
  current.resolve(photo(40)); await flush(); assert.equal(h.shown(), photo(40).src);
  h.back(); assert.equal(h.shown(), photo(2).src); h.back(); assert.equal(h.shown(), photo(1).src);
  h.frame.dispose();
});

test('previous at first photo cancels a pending next without dismissing photos', async () => {
  const h = harness(); await flush(); await h.enter();
  const request = deferred(); h.queue.push(request.promise); await h.next(); h.back();
  request.resolve(photo(9)); await flush(); assert.equal(h.shown(), photo(1).src); assert.equal(h.frame.active(), true);
  h.frame.dispose();
});

test('late image decoding cannot override a manual selection', async () => {
  const h = harness(); await flush(); await h.enter(); await h.next();
  h.delayImages = true; await h.next(); assert.equal(h.decodes.length, 1);
  h.back(); h.decodes[0].onload(); await flush(); assert.equal(h.shown(), photo(1).src);
  h.frame.dispose();
});

for (const failure of ['network', 'invalid', 'image', 'empty', 'same']) test(`${failure} next leaves current photo and backward history usable`, async () => {
  const h = harness(); await flush(); await h.enter(); await h.next();
  if (failure === 'network') { const request = deferred(); h.queue.push(request.promise); await h.next(); request.reject(Error('Synthetic offline')); }
  else {
    if (failure === 'invalid') h.queue.push({ ...photo(3), src: 'https://invalid.example/image' });
    if (failure === 'empty') h.queue.push(null);
    if (failure === 'same') h.queue.push(photo(2));
    h.failImage = failure === 'image'; await h.next();
  }
  await flush(); assert.equal(h.frame.active(), true); assert.equal(h.shown(), photo(2).src);
  h.back(); assert.equal(h.shown(), photo(1).src); await h.next(); assert.equal(h.shown(), photo(2).src);
  h.failImage = false; await h.next(); assert.notEqual(h.shown(), photo(2).src);
  h.frame.dispose();
});

test('leaving cancels an old request and permits a fresh session before it settles', async () => {
  const h = harness(); await flush(); await h.enter();
  const request = deferred(); h.queue.push(request.promise); await h.next();
  h.key('Escape'); assert.equal(h.frame.active(), false); assert.equal(h.shown(), '');
  await h.enter(); assert.equal(h.shown(), photo(2).src);
  request.resolve(photo(99)); await flush(); assert.equal(h.shown(), photo(2).src);
  h.back(); assert.equal(h.shown(), photo(2).src, 'history was reset on exit');
  h.frame.dispose();
});

test('typing, focus, visibility, disabling and disposal cancel pending activation', async () => {
  for (const cause of ['editor', 'visibility', 'disabled', 'disposed', 'activity']) {
    const h = harness(); await flush(); const request = deferred(); h.queue.push(request.promise); await h.enter();
    if (cause === 'editor') h.makeEditor('textarea').focus();
    if (cause === 'visibility') { h.document.hidden = true; h.visibility(); }
    if (cause === 'disabled') h.document.body.children[0].querySelector('button').onclick();
    if (cause === 'disposed') h.frame.dispose();
    if (cause === 'activity') h.activity();
    request.resolve(photo(8)); await flush(); assert.equal(h.frame.active(), false, cause);
    assert.equal(h.shown(), '', cause); h.frame.dispose();
  }
});

test('arrows do not intercept editors or modified shortcuts; focused frame controls retain navigation', async () => {
  const h = harness(); await flush(); await h.enter();
  h.region.querySelector('button').focus(); assert.equal(h.frame.active(), true); await h.next();
  assert.equal(h.shown(), photo(2).src);
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) assert.equal(h.key('ArrowRight', { [modifier]: true }).prevented, false);
  assert.equal(h.count(), 2);
  for (const tag of ['input', 'textarea', 'select', 'iframe', 'div']) {
    const editor = h.makeEditor(tag); editor.isContentEditable = tag === 'div'; editor.focus();
    assert.equal(h.key('ArrowLeft').prevented, false); assert.equal(h.frame.active(), false);
    await h.enter();
  }
  h.frame.dispose();
});

test('recognition freezes rotation, admits scoped commands and preserves wake admission', async () => {
  const h = harness(); await flush(); await h.enter(); await h.next();
  h.presence('hearing'); h.presence('transcribing'); h.clock += 6000; h.frame.tick();
  assert.equal(h.frame.active(), true); assert.equal(h.count(), 2);
  assert.equal(h.frame.localControl('recule', { followup: false }), null); assert.equal(h.shown(), photo(2).src);
  assert.equal(h.frame.localControl('Hey Nestor, recule', { followup: false }).applied, true);
  assert.equal(h.shown(), photo(1).src);
  assert.equal(h.frame.localControl('avance', { followup: true }).applied, true); assert.equal(h.shown(), photo(2).src);
  h.presence('listening');
  assert.equal(h.frame.localControl('avance la tâche de demain', { followup: true }), null); assert.equal(h.frame.active(), false);
  assert.equal(h.frame.localControl('recule'), null); assert.equal(h.frame.localControl('avance'), null);
  h.frame.dispose();
});

test('wake, closing, model work and other-space events keep their existing meanings', async () => {
  const h = harness(); await flush(); await h.enter();
  h.presence('thinking', 'family'); assert.equal(h.frame.active(), true);
  assert.equal(h.frame.localControl('Hey Nestor', { followup: false }).action, 'wake'); assert.equal(h.frame.active(), false);
  await h.enter(); assert.equal(h.frame.localControl('ferme', { followup: true }).action, 'close'); assert.equal(h.frame.active(), false);
  await h.enter(); assert.equal(h.frame.localControl('retour', { followup: true }).action, 'previous'); assert.equal(h.frame.active(), false);
  await h.enter(); h.presence('thinking'); assert.equal(h.frame.active(), false); h.frame.dispose();
});

test('hard busy work still blocks photo navigation during recognition', async () => {
  const h = harness(); await flush(); await h.enter(); h.presence('transcribing'); h.blocked = true;
  assert.equal(h.frame.localControl('avance', { followup: true }).applied, false);
  assert.equal(h.count(), 1); h.frame.tick(); assert.equal(h.frame.active(), false); h.frame.dispose();
});

test('the real voice loop applies recule/avance locally and routes out-of-context speech normally', async () => {
  const h = harness(); await flush(); let say, heard = '', turns = 0;
  const audio = { listen(callback) { say = callback; }, quiet() {}, close() {}, async play() {} };
  const outcomes = [];
  const conversation = new Conversation({ wakeAckDelayMs: 0, holdingDelayMs: null,
    openAudio: async () => audio, createSession: async () => ({ sessionId: 'synthetic-session' }),
    transcribe: async () => heard, localControl: (text, options) => h.frame.localControl(text, options),
    transcriptionEnded: (_id, value) => outcomes.push(value.outcome),
    message() {}, turn: async () => { turns++; return { text: 'Synthetic answer' }; }, synthesize: async () => new ArrayBuffer(0)
  }, state => h.presence(state));
  await conversation.start({ language: 'fr', wakeWord: true }); await h.enter(); await h.next();
  heard = 'recule'; await say(new Blob(['synthetic'])); assert.equal(h.shown(), photo(2).src); assert.equal(turns, 0);
  heard = 'Hey Nestor, recule'; await say(new Blob(['synthetic'])); assert.equal(h.shown(), photo(1).src);
  heard = 'avance'; await say(new Blob(['synthetic'])); assert.equal(h.shown(), photo(2).src);
  assert.equal(turns, 0); assert.deepEqual(outcomes, ['not_addressed', 'local', 'local']);
  heard = 'avance le rendez-vous'; await say(new Blob(['synthetic'])); assert.equal(turns, 1); assert.equal(h.frame.active(), false);
  heard = 'recule'; await say(new Blob(['synthetic'])); assert.equal(turns, 2, 'outside frame the alias reaches the normal turn');
  conversation.stop(); h.frame.dispose();
});


test('ambient and false-wake speech cannot navigate a standby frame', async () => {
  const h = harness(); await flush(); await h.enter(); await h.next();
  const requests = h.count();
  for (const text of ['', 'avance', 'recule', 'la radio avance', 'hey voisin recule', 'Nestor avance le rendez-vous']) {
    h.presence('hearing'); h.presence('transcribing');
    assert.equal(h.frame.localControl(text, { followup: false }), null, text);
    assert.equal(h.shown(), photo(2).src); assert.equal(h.frame.active(), true);
    h.presence('listening');
  }
  assert.equal(h.count(), requests);
  assert.equal(h.frame.localControl('Eille Nestor, recule', { followup: false }).applied, true);
  assert.equal(h.shown(), photo(1).src); h.frame.dispose();
});

test('repeated voice next coalesces and a stale failure cannot erase a newer selection', async () => {
  const h = harness(); await flush(); await h.enter(); await h.next();
  const old = deferred(); h.queue.push(old.promise);
  for (let i = 0; i < 8; i++) assert.equal(h.frame.localControl('avance', { followup: true }).applied, true);
  assert.equal(h.count(), 3);
  h.frame.localControl('recule', { followup: true }); assert.equal(h.shown(), photo(1).src);
  await h.next(); await h.next(); assert.equal(h.shown(), photo(3).src);
  old.reject(Error('Synthetic stale failure')); await flush();
  assert.equal(h.shown(), photo(3).src); assert.equal(h.frame.active(), true);
  assert.equal(h.region.attributes['aria-busy'], undefined);
  h.back(); assert.equal(h.shown(), photo(2).src); h.frame.dispose();
});

test('long idle time advances once; manual history navigation still restarts the timer', async () => {
  const h = harness(); await flush(); await h.enter();
  h.clock += 20 * 60 * 1000; h.frame.tick(); await flush();
  assert.equal(h.shown(), photo(2).src); assert.equal(h.count(), 2, 'missed rotations are not replayed in a burst');
  h.frame.localControl('recule', { followup: true });
  h.clock += 4999; h.frame.tick(); await flush(); assert.equal(h.shown(), photo(1).src);
  h.clock++; h.frame.tick(); await flush(); assert.equal(h.shown(), photo(2).src); assert.equal(h.count(), 2);
  h.frame.dispose();
});

test('Pause cancels a pending transcript; rearm preserves session, resets wake and starts a fresh photo history', async () => {
  const h = harness(); await flush(); let say, onError, pendingTranscript = null, heard = '', sessions = 0, turns = 0;
  const audio = { listen(callback) { say = callback; }, quiet() {}, close() {}, async play() {} };
  const c = new Conversation({ wakeAckDelayMs: 0, holdingDelayMs: null,
    openAudio: async (_signal, failed) => { onError = failed; return audio; },
    createSession: async () => { sessions++; return { sessionId: 'synthetic-paused-photo-session' }; },
    transcribe: async () => pendingTranscript ? pendingTranscript.promise : heard,
    localControl: (text, options) => h.frame.localControl(text, options), message() {},
    turn: async () => { turns++; return { text: '' }; }
  }, state => h.presence(state));
  try {
    await c.start({ language: 'fr', wakeWord: true }); const session = c.session;
    await h.enter(); await h.next();
    pendingTranscript = deferred(); const old = pendingTranscript;
    const exchange = say(new Blob(['synthetic delayed utterance'])); await flush();
    assert.equal(c.state, 'transcribing'); assert.equal(h.frame.active(), true);
    c.stop(true); old.resolve('Hey Nestor, recule'); await exchange;
    assert.equal(h.shown(), photo(2).src); assert.equal(c.session, session); assert.equal(c.wake.active(), false);
    pendingTranscript = null; await c.start({ language: 'fr', wakeWord: true });
    assert.equal(h.frame.active(), false); assert.equal(c.session, session); assert.equal(sessions, 1);
    await h.enter(); assert.equal(h.shown(), photo(3).src);
    heard = 'recule'; await say(new Blob(['synthetic unaddressed utterance']));
    assert.equal(h.shown(), photo(3).src); assert.equal(turns, 0);
    heard = 'Hey Nestor, avance'; await say(new Blob(['synthetic addressed utterance'])); await flush();
    assert.equal(h.shown(), photo(4).src); assert.equal(turns, 0);
    h.back(); assert.equal(h.shown(), photo(3).src, 'history from before Pause/rearm cannot reappear');
    onError(Error('Synthetic capture failure'));
    assert.equal(c.state, 'error'); assert.equal(h.frame.active(), false); assert.equal(c.session, session);
    assert.equal(c.wake.active(), false);
  } finally { c.stop(); h.frame.dispose(); }
});

// Visibility is a lifecycle signal, not a per-photo rendering update.
test('photo visibility notifies after entry and exit only', async () => {
  const h = harness(); await flush(); await h.enter();
  assert.deepEqual(h.visibilityChanges, [true]);
  await h.next(); h.back(); assert.deepEqual(h.visibilityChanges, [true]);
  h.activity(); assert.deepEqual(h.visibilityChanges, [true, false]);
  h.frame.dispose(); assert.deepEqual(h.visibilityChanges, [true, false]);
});
