'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../public/persona-presentation');
const speech = require('../../../public/js/voice/speech-language');

async function browser({ savedLanguage, turnResponse } = {}) {
  const nodes = new Map(), listeners = {}, requests = [], stored = new Map();
  if (savedLanguage) stored.set('household.reading.language.v1', savedLanguage);
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, getAttribute() { return ''; },
      addEventListener(type, callback) { this.listeners[type] = callback; }, close() {} });
    return nodes.get(id);
  };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    if (url.endsWith('/sessions')) return Response.json({ data: { session: {
      sessionId: 'synthetic', packId: body.packId, scopeId: body.scopeId, modeId: body.modeId
    } } });
    if (url.endsWith('/turns/text')) return turnResponse ? turnResponse(body) : Response.json({ data: { reply: { text: 'Synthetic reply', language: 'en' } } });
    if (url.endsWith('/synthesize/stream')) return new Response('synthetic audio');
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = {
    document: { getElementById: element, querySelector: element,
      addEventListener(type, callback) { listeners[type] = callback; } },
    window: { PersonaPresentation: P, NestorSpeech: speech, HouseholdNavigation: { mount() {} },
      VoixAudio: { Speech: class { cancel() {} async speak(request) { await request(new AbortController().signal); } } } },
    navigator: { language: 'en-CA' }, location: { pathname: '/lecture' },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    fetch, FormData, AbortController, console, setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  await listeners.DOMContentLoaded();
  return { requests, element,
    ask: async () => { element('readerInput').value = 'Please read this word'; await element('readerForm').listeners.submit({ preventDefault() {} }); },
    choose: language => { element('readingLanguage').value = language; element('readingVoiceSave').onclick(); } };
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
