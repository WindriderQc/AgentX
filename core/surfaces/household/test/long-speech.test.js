'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitSpeechText } = require('../../../public/js/voice/speech-language');
const { Conversation } = require('../public/browser-conversation');
const { createSynthesisHandler } = require('../../../src/services/voice/voix-synthesis');

test('speech segmentation preserves the complete text and Unicode pairs', () => {
  for (const text of ['a'.repeat(12000), 'Le texte complet. '.repeat(700), 'a'.repeat(3999) + '💡fin', 'é'.repeat(8010)]) {
    const segments = splitSpeechText(text);
    assert.equal(segments.join(''), text);
    assert.ok(segments.every(part => part.length <= 4000));
    assert.ok(segments.every(part => !/[\uD800-\uDBFF]$/.test(part)));
  }
});

test('the synthesis proxy forwards beyond 4000 characters and refuses an oversized request without sending it', async t => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const sent = [], failures = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return new Response('audio'); };
  const handler = createSynthesisHandler({ timeoutMs: () => 1000,
    upstream: { send: async (_path, request) => ({ response: await request('http://speech.invalid'), upstream: 'primary' }) },
    cleanText: (text, maximum) => String(text || '').trim().slice(0, maximum),
    fail: (_res, status, message) => failures.push({ status, message }) });
  const res = { set() { return this; }, status() { return this; }, send() {} };
  const full = 'Texte complet. '.repeat(400) + 'FIN';
  await handler({ body: { text: full, language: 'fr' }, path: '/synthesize' }, res);
  assert.equal(sent[0].text, full);
  await handler({ body: { text: 'a'.repeat(50001), language: 'fr' }, path: '/synthesize' }, res);
  assert.equal(sent.length, 1);
  assert.equal(failures[0].status, 413);
});

test('a long saved result is read completely and scheduled only once for its delivery receipt', async () => {
  const submitted = [], played = [];
  let scheduled = 0;
  const conversation = new Conversation({ message() {},
    async synthesize(reply) { submitted.push(reply.text); return reply.text; } });
  conversation.epoch = 1; conversation.abort = new AbortController();
  conversation.session = { sessionId: 'session' }; conversation.selection = { language: 'fr' };
  conversation.audio = { quiet() {}, listen() {}, close() {}, async play(bytes, _signal, _stream, _rate, callbacks) {
    played.push(bytes); callbacks?.onScheduled?.(); } };
  conversation.state = 'listening';
  const text = 'Texte à lire entièrement. '.repeat(600) + 'FIN';
  assert.equal(await conversation.interject({ text }, { onScheduled: () => { scheduled++; } }), true);
  assert.equal(played.join(''), text);
  assert.equal(submitted.join(''), text);
  assert.equal(scheduled, 1);
  conversation.stop();
});

test('Stop during a long reading prevents all remaining synthesis segments', async () => {
  let conversation, syntheses = 0;
  conversation = new Conversation({ message() {}, async synthesize() { syntheses++; return 'audio'; } });
  conversation.epoch = 1; conversation.abort = new AbortController(); conversation.session = { sessionId: 'session' };
  conversation.selection = { language: 'fr' }; conversation.state = 'listening';
  conversation.audio = { quiet() {}, listen() {}, close() {}, async play() { conversation.interrupt(conversation.activeTurn, { stop: true }); } };
  assert.equal(await conversation.interject({ text: 'Lecture complète. '.repeat(600) }), false);
  assert.equal(syntheses, 1);
  assert.equal(conversation.session.sessionId, 'session');
  conversation.stop();
});
