'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const shared = require('../../../public/js/voice/browser-conversation');
const speech = require('../../../public/js/voice/speech-language');
const prefs = require('../public/voice-preferences');

function browser({ voice = {}, ...extras } = {}) {
  const elements = new Map(), listeners = {}, calls = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, disabled: false, open: false, dataset: {}, listeners: {},
      textContent: '', replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(type, callback) { this.listeners[type] = callback; } });
    return elements.get(id);
  };
  let utterance;
  const audio = { close: () => calls.push('close'), quiet: () => calls.push('quiet'),
    listen: callback => { utterance = callback; }, play: async response => { calls.push(['play', response.status]); } };
  const state = { accessEpoch: 1, unlocked: true, ready: true, busy: false,
    voice: { enabled: true, reachable: true, prefs: { ...prefs.DEFAULTS, ttsProvider: 'windows_sapi', ttsVoice: 'Microsoft Caroline' } } };
  const context = { state, $, voicePreferences: prefs, AbortController, console,
    localStorage: { getItem: () => null }, saveVoicePreferences() {},
    assertCurrentAccess: epoch => { if (epoch !== state.accessEpoch) throw Object.assign(new Error('locked'), { name: 'AbortError' }); },
    window: { NestorSpeech: speech, AgentXVoice: { ...shared, openAudio: async () => audio, ...voice }, addEventListener(type, fn) { listeners[type] = fn; } },
    document: { hidden: false, addEventListener(type, fn) { listeners[type] = fn; } },
    async fetch(url, options) { calls.push({ url, options });
      return url.endsWith('transcribe') ? new Response(JSON.stringify({ data: { text: 'Je suis débordé.' } })) : new Response('pcm'); },
    async sendMessage(text, options) { calls.push({ text, options }); return { text: '**Je t’écoute.** [Une piste](https://example.test)\n```js\nsecret();\n```', language: 'fr' }; },
    showGate() { state.unlocked = false; }, ...extras };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/voice-session.js'), 'utf8'), context);
  return { context, state, $, calls, listeners, audio, say: () => utterance(new Blob(['voice'], { type: 'audio/wav' })) };
}
// The options PsyX hands to Core's shared conversation loop.
function wiring(extras = {}) {
  const captured = {};
  const h = browser({ ...extras, voice: { Conversation: class extends shared.Conversation {
    constructor(io, changed) { super(io, changed); captured.io = io; }
  } } });
  return { ...h, captured };
}
const spoken = h => h.calls.filter(call => call.url?.endsWith('synthesize/stream')).map(call => JSON.parse(call.options.body));

test('private voice uses only PsyX routes, a scoped female voice and the canonical text turn', async () => {
  const h = browser(); h.context.wireVoiceSession();
  await h.$('voiceSessionOpen').listeners.click();
  assert.equal(h.$('voiceSessionDialog').dataset.phase, 'listening');
  await h.say();
  const requests = h.calls.filter(call => call.url);
  assert.deepEqual(requests.map(call => call.url), ['/api/psyx/voice/transcribe', '/api/psyx/voice/synthesize/stream']);
  const turn = h.calls.find(call => call.text);
  assert.equal(turn.options.source, 'voice'); assert.equal(turn.options.voiceSession, true);
  const synthesis = JSON.parse(requests[1].options.body);
  assert.equal(synthesis.voice, 'Microsoft Caroline'); assert.equal(synthesis.ttsProvider, 'windows_sapi');
  assert.equal(synthesis.text, 'Je t’écoute. Une piste');
  assert.equal(h.$('voiceSessionDialog').dataset.phase, 'listening');
  h.context.stopVoiceSession(); assert.equal(h.$('voiceSessionDialog').open, false);
  assert.ok(h.calls.includes('close'));
});

test('closing during recognition cancels its fetch and ignores the late private text', async () => {
  let resolveRecognition, capturedSignal, turns = 0;
  const h = browser({ fetch: async (_url, options) => {
    capturedSignal = options.signal;
    return new Promise(resolve => { resolveRecognition = resolve; });
  }, sendMessage: async () => { turns++; } });
  h.context.wireVoiceSession(); await h.$('voiceSessionStart').listeners.click();
  const pending = h.say(); await new Promise(resolve => setImmediate(resolve));
  h.context.stopVoiceSession();
  assert.equal(capturedSignal.aborted, true);
  resolveRecognition(new Response(JSON.stringify({ data: { text: 'Private late transcript' } })));
  await pending;
  assert.equal(turns, 0); assert.ok(h.calls.includes('close'));
});

test('locking before capture forbids private voice requests; hidden pages stop capture', async () => {
  const h = browser(); h.context.wireVoiceSession();
  await h.$('voiceSessionStart').listeners.click();
  h.context.document.hidden = true; h.listeners.visibilitychange();
  assert.ok(h.calls.includes('close'));
  h.state.unlocked = false;
  await assert.rejects(h.context.voiceSessionFetch('transcribe', {}, new AbortController().signal), /verrouillé/);
  assert.equal(h.calls.filter(call => call.url).length, 0);
});

test('female voice selection requires availability and Canadian locale evidence and preserves explicit preferences', () => {
  const voices = [{ id: 'ff_siwis', provider: 'kokoro', language: 'fr', gender: 'female', locale: 'fr-FR', available: true },
    { id: 'Microsoft Claude', provider: 'windows_sapi', language: 'fr', gender: 'male', locale: 'fr-CA', available: true },
    { id: 'Microsoft Caroline', provider: 'windows_sapi', language: 'fr', gender: 'female', locale: 'fr-CA', available: true }];
  assert.equal(prefs.preferredFemaleVoice({ voices }).id, 'Microsoft Caroline');
  assert.equal(prefs.preferredFemaleVoice({ voices, providers: [{ id: 'windows_sapi', available: false }] }).id, 'ff_siwis');
  assert.equal(prefs.preferredFemaleVoice({ voices: voices.map(voice => ({ ...voice, available: false })) }), null);
  const h = browser(); h.context.chooseInitialVoice({ voices });
  assert.equal(h.state.voice.prefs.ttsVoice, 'Microsoft Caroline');
  h.context.localStorage.getItem = () => '{"ttsVoice":"ff_siwis"}';
  h.state.voice.prefs.ttsVoice = 'ff_siwis'; h.context.chooseInitialVoice({ voices });
  assert.equal(h.state.voice.prefs.ttsVoice, 'ff_siwis');
});

test('a pending dictation permission request cannot open a competing hands-free microphone', async () => {
  const h = browser(); h.context.wireVoiceSession();
  h.state.voice.recordingPending = true;
  await h.$('voiceSessionOpen').listeners.click();
  assert.equal(h.$('voiceSessionDialog').open, false);
  h.state.voice.recordingPending = false;
  await h.$('voiceSessionOpen').listeners.click();
  assert.equal(h.$('voiceSessionDialog').open, true);
  h.context.stopVoiceSession();
});

test('a qualified spoken Stop is consumed by the shared loop without a private model turn', async () => {
  let turns = 0;
  const h = browser({ fetch: async () => new Response(JSON.stringify({ data: { control: 'stop', text: '', language: 'fr' } })),
    sendMessage: async () => { turns++; } });
  h.context.wireVoiceSession(); await h.$('voiceSessionStart').listeners.click(); await h.say();
  assert.equal(turns, 0);
  assert.equal(h.$('voiceSessionDialog').dataset.phase, 'listening');
  h.context.stopVoiceSession();
});

test('PsyX keeps its silence while it thinks: the shared holding phrase stays off', async () => {
  const h = wiring(); h.context.wireVoiceSession();
  await h.$('voiceSessionStart').listeners.click();
  assert.equal(h.captured.io.holdingDelayMs, null);
  await h.say();
  assert.deepEqual(spoken(h).map(request => request.text), ['Je t’écoute. Une piste'], 'only the confirmed reply is spoken');
  h.context.stopVoiceSession();
});

test('PsyX speaks a whole turn in the language chosen in its voice settings', async () => {
  for (const chosen of ['fr', 'en']) {
    const other = chosen === 'fr' ? 'en' : 'fr';
    const h = browser({
      fetch: async (url, options) => { h.calls.push({ url, options });
        return url.endsWith('transcribe') ? new Response(JSON.stringify({ data: { text: 'Can you help me with that today?', language: other } })) : new Response('pcm'); },
      // A reply in the other language, which names it, does not switch the chosen voice.
      sendMessage: async () => ({ text: 'Bien sûr. Je suis là avec toi. The next step is yours.', language: other }) });
    h.state.voice.prefs.language = chosen;
    h.context.wireVoiceSession(); await h.$('voiceSessionStart').listeners.click(); await h.say();
    assert.ok(spoken(h).length >= 1);
    assert.deepEqual([...new Set(spoken(h).map(request => request.language))], [chosen]);
    assert.ok(spoken(h).every(request => request.voice === 'Microsoft Caroline'));
    h.context.stopVoiceSession();
  }
});
