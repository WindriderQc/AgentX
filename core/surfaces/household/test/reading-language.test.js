'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../public/persona-presentation');
const speech = require('../../../public/js/voice/speech-language');
const ladder = require('../../../public/js/voice/speech-ladder');

async function browser({ savedLanguage, turnResponse, handsFree = false } = {}) {
  const nodes = new Map(), listeners = {}, requests = [], stored = new Map();
  if (savedLanguage) stored.set('household.reading.language.v1', savedLanguage);
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, getAttribute() { return ''; },
      querySelectorAll() { return []; }, addEventListener(type, callback) { this.listeners[type] = callback; }, close() {} });
    return nodes.get(id);
  };
  const heard = [], played = []; let workshop;

  let utterance, onset;
  const audio = { canInterrupt: true, quiet() {}, close() {}, listen(callback, speech) { utterance = callback; onset = speech; }, async play(response) { played.push(response); } };
  const fetch = async (url, options = {}) => {
    const body = options.body instanceof FormData ? null : options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url.endsWith('/sessions')) return Response.json({ data: { session: {
      sessionId: 'synthetic', packId: body.packId, scopeId: body.scopeId, modeId: body.modeId
    } } });
    if (url.endsWith('/turns/text')) return turnResponse ? turnResponse(body) : Response.json({ data: { reply: { text: 'Synthetic reply', language: 'en' } } });
    if (url.endsWith('/transcribe')) return Response.json({ data: { text: heard.shift(), effectiveModel: 'synthetic' } });
    if (url.endsWith('/synthesize/stream')) return new Response('synthetic audio');
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = {
    document: { getElementById: element, querySelector: element,
      addEventListener(type, callback) { listeners[type] = callback; } },
    window: { AgentXVoiceWorkshop: { open(options) { workshop = options; } }, AgentXVoiceSettings: { read: () => ({ language: stored.get('household.reading.language.v1') === 'en' ? 'en' : 'fr' }) }, PersonaPresentation: P, NestorSpeech: speech, AgentXSpeechLadder: ladder, HouseholdNavigation: { mount() {} },
      VoixAudio: { Speech: class { cancel() {} async speak(request, { segments = [null] } = {}) { for (const segment of segments) await request(new AbortController().signal, segment); } } } },
    navigator: { language: 'en-CA' }, location: { pathname: '/lecture' },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    fetch, FormData, AbortController, console, setTimeout, clearTimeout
  };
  context.window.document = context.document;
  context.window.addEventListener = (type, listener) => { listeners[type] = listener; };
  context.window.AgentXVoice = { ...require('../../../public/js/voice/browser-conversation'), openAudio: async () => audio };
  vm.createContext(context);
  if (handsFree) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/learning-voice.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  await listeners.DOMContentLoaded();
  return { requests, element, played,
    enableVoice: () => element('readerMic').listeners.click(),
    pauseVoice: () => element('readerMic').listeners.click(),
    say: text => { heard.push(text); onset?.(); return utterance(new Blob(['synthetic'])); },
    ask: async () => { element('readerInput').value = 'Please read this word'; await element('readerForm').listeners.submit({ preventDefault() {} }); },
    choose: language => { element('readingVoiceSettings').onclick({ preventDefault() {} }); stored.set('household.reading.language.v1',language); workshop.onSaved(); } };
}

for (const [savedLanguage, expected] of [[undefined, 'fr'], ['auto', 'fr'], ['en', 'en']]) {
  test(`Lecture language is explicit across session, reply and speech (${savedLanguage || 'default'} -> ${expected})`, async () => {
    const h = await browser({ savedLanguage }); await h.ask();
    assert.deepEqual(h.requests.map(request => request.body.language), [expected, expected, expected]);
  });
}

test('changing a reading preference during inference affects the next turn, while the current reply and replay retain their language', async () => {
  let resolveTurn, entered, requests = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const h = await browser({ turnResponse: () => {
    if (requests++) return Response.json({ data: { reply: { text: 'Synthetic English reply' } } });
    entered(); return new Promise(resolve => { resolveTurn = resolve; });
  } });
  const pending = h.ask(); await waiting;
  h.choose('en');
  resolveTurn(Response.json({ data: { reply: { text: 'Réponse synthétique' } } }));
  await pending; await h.element('readerReplay').listeners.click();
  assert.equal(h.requests.find(request => request.url.endsWith('/turns/text')).body.language, 'fr');
  assert.deepEqual(h.requests.filter(request => request.url.endsWith('/synthesize/stream')).map(request => request.body.language), ['fr', 'fr']);
  await h.ask();
  assert.deepEqual(h.requests.filter(request => request.url.endsWith('/turns/text')).map(request => request.body.language), ['fr', 'en']);
  assert.equal(h.requests.at(-1).body.language, 'en');
});


test('Lecture reads the entire long response in ordered bounded segments', async () => {
  const full = ('Une phrase à lire. '.repeat(900)) + 'FIN COMPLETE';
  const h = await browser({ turnResponse: () => Response.json({ data: { reply: { text: full } } }) });
  await h.ask();
  const speech = h.requests.filter(request => request.url.endsWith('/synthesize/stream'));
  assert.ok(speech.length > 1);
  assert.ok(speech.every(request => request.body.text.length <= 4000));
  assert.equal(speech.map(request => request.body.text).join(''), full);
  assert.equal(h.element('readerReply').textContent, full);
});

test('the real Lecture adapter stays on its family pack through wake, short replies and Pause', async () => {
  const h = await browser({ handsFree: true });
  await h.enableVoice();
  assert.equal(h.element('readerMic').textContent, 'Pause');
  await h.say('On parle de Nestor.');
  assert.equal(h.requests.filter(row => row.url.endsWith('/turns/text')).length, 0);
  await h.say('Heille Nestor, bonjour');
  for (const word of ['oui', '7', 'merci']) await h.say(word);
  const sessions = h.requests.filter(row => row.url.endsWith('/sessions'));
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].body, { packId: 'kidx_reader', scopeId: 'family', modeId: '', personaId: 'nestor', language: 'fr' });
  assert.deepEqual(h.requests.filter(row => row.url.endsWith('/turns/text')).map(row => row.body.text), ['bonjour', 'oui', '7', 'merci']);
  assert.ok(h.requests.every(row => !row.url.includes('/private/')));
  assert.equal(h.played.length, 4);
  await h.pauseVoice(); assert.equal(h.element('readerMic').textContent, 'Enable voice');
});

test('typing while Lecture listens produces one request and one playback through the same loop', async () => {
  const h = await browser({ handsFree: true }); await h.enableVoice(); await h.ask();
  assert.equal(h.requests.filter(row => row.url.endsWith('/turns/text')).length, 1);
  assert.equal(h.requests.filter(row => row.url.endsWith('/synthesize/stream')).length, 1);
  assert.equal(h.played.length, 1);
  await h.pauseVoice();
});

test('a complete screen block survives a missing renderer and explicit replay reads its entire body', async () => {
  const full = 'Un paragraphe complet. '.repeat(300) + 'FIN DU DOCUMENT';
  const h = await browser({ turnResponse: () => Response.json({ data: {
    reply: { text: 'La réponse complète est à l’écran.' }, display: [{ id: 'b1', kind: 'text', body: full }],
  } }) });
  await h.ask();
  assert.ok(h.element('readerReply').textContent.includes(full));
  await h.element('readerReplay').listeners.click();
  const parts = h.requests.filter(row => row.url.endsWith('/synthesize/stream')).slice(1);
  assert.equal(parts.map(row => row.body.text).join(''), full);
});
