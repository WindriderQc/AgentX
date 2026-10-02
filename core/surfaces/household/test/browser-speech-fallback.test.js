'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Conversation } = require('../public/browser-conversation');
const { createSpeechFallback, mountSpeechFallbackPanel, isUnavailable } = require('../public/browser-speech-fallback');
const { browserSpeechFallback } = require('../conversation-executor');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const unavailable = () => Object.assign(new Error('VoiX unavailable'), { status: 503 });

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function fakeRecognition() {
  const instances = [];
  class Recognition {
    constructor() { instances.push(this); this.started = false; this.aborted = false; }
    start() { this.started = true; }
    abort() { this.aborted = true; }
    say(text) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
  }
  return { Recognition, instances };
}

function setup({ allowed = true, storage = memoryStorage(), local = async () => { throw unavailable(); }, language = 'fr', listening = true } = {}) {
  const { Recognition, instances } = fakeRecognition();
  const states = [];
  const fallback = createSpeechFallback({ space: 'family', allowed, storage, Recognition, transcribeLocal: local,
    listening: () => listening, language: () => language, onChange: state => states.push(state), waitMs: 50 });
  return { fallback, instances, storage, states };
}

test('the fallback never starts a recognizer without consent, even when VoiX is unavailable', async () => {
  const { fallback, instances, storage } = setup();
  await assert.rejects(fallback.transcribe(new Blob(['a']), 'fr'), /VoiX unavailable/);
  await fallback.probe(async () => { throw unavailable(); });
  fallback.sync();
  assert.equal(instances.length, 0);
  assert.equal(storage.values.size, 0);
  assert.deepEqual({ ...fallback.state(), blocked: undefined }, { available: true, consented: false, localDown: true, needed: true, active: false, running: false, blocked: undefined });
});

test('a refused or malformed transcription is not a reason to leave the network', async () => {
  for (const status of [400, 401, 403, 413, 500]) {
    const { fallback } = setup({ local: async () => { throw Object.assign(new Error('nope'), { status }); } });
    await assert.rejects(fallback.transcribe(new Blob(['a']), 'fr'));
    assert.equal(fallback.state().needed, false, String(status));
  }
  assert.equal(isUnavailable(new TypeError('Failed to fetch')), true);
  assert.equal(isUnavailable(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
});

test('consent after a VoiX-unavailable failure is remembered per space and starts fr-CA recognition', async () => {
  const { fallback, instances, storage } = setup();
  await assert.rejects(fallback.transcribe(new Blob(['a']), 'fr'));
  assert.equal(fallback.consent(), true);
  assert.equal(storage.getItem('household.space.family.browserStt'), 'on');
  assert.equal(storage.getItem('household.space.personal.browserStt'), null);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].started, true);
  assert.equal(instances[0].lang, 'fr-CA');
  assert.equal(instances[0].continuous, true);
  assert.equal(fallback.state().running, true);
  fallback.revoke();
  assert.equal(instances[0].aborted, true);
  assert.equal(storage.getItem('household.space.family.browserStt'), null);
  assert.equal(fallback.state().running, false);
});

test('English sessions recognize en-US', async () => {
  const { fallback, instances } = setup({ language: 'en', storage: memoryStorage({ 'household.space.family.browserStt': 'on' }) });
  await fallback.probe(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(instances[0].lang, 'en-US');
});

test('the instance gate off hides the fallback and never consents', async () => {
  const { fallback, instances } = setup({ allowed: false, storage: memoryStorage({ 'household.space.family.browserStt': 'on' }) });
  await assert.rejects(fallback.transcribe(new Blob(['a']), 'fr'));
  await fallback.probe(async () => { throw unavailable(); });
  assert.equal(fallback.consent(), false);
  assert.equal(instances.length, 0);
  assert.equal(fallback.state().available, false);
  assert.equal(fallback.state().needed, false);
  assert.equal(fallback.state().active, false);

  const panel = fakePanel();
  mountSpeechFallbackPanel(fallback, panel);
  assert.equal(panel.settings.hidden, true);
  assert.equal(panel.notice.hidden, true);
  assert.equal(panel.indicator.hidden, true);
});

test('the notice carries the privacy warning and its button is the consent', async () => {
  const { fallback } = setup();
  const panel = fakePanel();
  let resumed = 0;
  const render = mountSpeechFallbackPanel(fallback, panel, { onConsent: () => resumed++ });
  assert.equal(panel.settings.hidden, false);
  assert.equal(panel.notice.hidden, true, 'no notice before VoiX fails');
  await assert.rejects(fallback.transcribe(new Blob(['a']), 'fr'));
  render();
  assert.equal(panel.notice.hidden, false);
  assert.match(panel.notice.text(), /quitte ce réseau local/);
  assert.match(panel.indicator.textContent, /l’audio peut quitter cet appareil/);
  panel.notice.find('Utiliser la reconnaissance du navigateur').onclick();
  render();
  assert.equal(resumed, 1);
  assert.equal(panel.notice.hidden, true);
  assert.equal(panel.indicator.hidden, false);
});

test('a consented browser keeps listening when VoiX drops mid-conversation', async () => {
  let localCalls = 0;
  const { fallback, instances } = setup({ storage: memoryStorage({ 'household.space.family.browserStt': 'on' }),
    local: async () => { localCalls++; throw unavailable(); } });
  const result = await fallback.transcribe(new Blob(['a']), 'fr');
  assert.equal(result.text, '');
  assert.equal(fallback.state().active, true);
  assert.equal(instances.length, 1);
  instances[0].say('Bonjour');
  assert.equal((await fallback.transcribe(new Blob(['b']), 'fr')).text, 'Bonjour');
  assert.equal(localCalls, 1, 'VoiX is not called again while the fallback is active');
});

function harness(fallback, overrides = {}) {
  const turns = [], messages = [];
  let utterance, speech;
  const audio = {
    listen(callback, onSpeech) { utterance = callback; speech = onSpeech; },
    quiet() {}, close() {}, async play() {}
  };
  const io = {
    wakeAckDelayMs: 0, holdingDelayMs: null,
    async openAudio() { return fallback.wrapAudio(audio); },
    async createSession() { return { sessionId: 'family-1' }; },
    transcribe: (blob, lang, signal) => fallback.transcribe(blob, lang, signal),
    async turn(_session, text) { turns.push(text); return { text: 'Salut', language: 'fr' }; },
    async synthesize() { return new ArrayBuffer(10); },
    message(role, text) { messages.push({ role, text }); }, ...overrides
  };
  const conversation = new Conversation(io, () => fallback.sync());
  return { conversation, turns, messages, beginSpeech: () => speech(), say: () => utterance(new Blob(['sample'])) };
}

test('recognizer text reaches the same turn path, including the wake-word filter', async () => {
  let conversation;
  const { Recognition, instances } = fakeRecognition();
  const fallback = createSpeechFallback({ space: 'family', allowed: true, Recognition, waitMs: 50,
    storage: memoryStorage({ 'household.space.family.browserStt': 'on' }),
    listening: () => ['listening', 'hearing', 'transcribing', 'thinking', 'speaking'].includes(conversation?.state),
    transcribeLocal: async () => { throw new Error('VoiX must not be called'); } });
  await fallback.probe(async () => { throw unavailable(); });
  const h = harness(fallback);
  conversation = h.conversation;
  await conversation.start({ wakeWord: true, language: 'fr' });
  assert.equal(conversation.state, 'listening');
  assert.equal(instances.length, 1);

  // Not addressed to Nestor: recognized, then dropped by the wake filter.
  h.beginSpeech(); instances[0].say('il fait beau dehors'); await h.say(); await tick();
  assert.deepEqual(h.turns, []);

  h.beginSpeech(); instances[0].say('Hey Nestor, quelle heure est-il'); await h.say(); await tick();
  assert.deepEqual(h.turns, ['quelle heure est-il']);
  assert.deepEqual(h.messages.slice(0, 2), [{ role: 'user', text: 'quelle heure est-il' }, { role: 'assistant', text: 'Salut' }]);

  // A subtitle hallucination stays silence on this path too.
  h.beginSpeech(); instances[0].say('Merci d’avoir regardé'); await h.say(); await tick();
  assert.equal(h.turns.length, 1);

  conversation.stop();
  assert.equal(instances.at(-1).aborted, true, 'stopping the conversation stops the recognizer');
});

test('results heard before the speech onset do not leak into the next phrase', async () => {
  let clock = 1000;
  const { Recognition, instances } = fakeRecognition();
  const fallback = createSpeechFallback({ allowed: true, Recognition, waitMs: 20, now: () => clock, listening: () => true,
    storage: memoryStorage({ 'household.space.personal.browserStt': 'on' }), transcribeLocal: async () => { throw unavailable(); } });
  await fallback.probe(async () => { throw unavailable(); });
  instances[0].say('écho de la réponse');
  clock = 5000; fallback.mark();
  assert.equal((await fallback.transcribe(new Blob(['a']), 'fr')).text, '');
  instances[0].say('nouvelle phrase');
  assert.equal((await fallback.transcribe(new Blob(['a']), 'fr')).text, 'nouvelle phrase');
});

test('the instance gate defaults off and can allow Super Dad only', () => {
  assert.deepEqual(browserSpeechFallback({}), { personal: false, family: false });
  assert.deepEqual(browserSpeechFallback({ HOUSEHOLD_BROWSER_STT_FALLBACK: 'false' }), { personal: false, family: false });
  assert.deepEqual(browserSpeechFallback({ HOUSEHOLD_BROWSER_STT_FALLBACK: 'personal' }), { personal: true, family: false });
  assert.deepEqual(browserSpeechFallback({ HOUSEHOLD_BROWSER_STT_FALLBACK: 'true' }), { personal: true, family: true });
  assert.deepEqual(browserSpeechFallback({ HOUSEHOLD_BROWSER_STT_FALLBACK: 'yes' }), { personal: false, family: false });
});

// Minimal DOM: enough for the panel's createElement/append/replaceChildren calls.
function fakeElement(document, tag) {
  const node = { tagName: tag, ownerDocument: document, children: [], hidden: false, textContent: '',
    append(...items) { node.children.push(...items); }, replaceChildren(...items) { node.children = items; },
    text() { return [node.textContent, ...node.children.map(child => typeof child === 'string' ? child : child.text())].join(' '); },
    find(label) {
      for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (child.textContent === label) return child;
        const found = child.find(label); if (found) return found;
      }
      return null;
    } };
  return node;
}
function fakePanel() {
  const document = { createElement: tag => fakeElement(document, tag) };
  return { notice: fakeElement(document, 'section'), settings: fakeElement(document, 'div'), indicator: fakeElement(document, 'p') };
}
