'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Conversation } = require('../../../public/js/voice/browser-conversation');
const { warmRecognition, registerRecognitionWarmProxy } = require('../../../src/services/voice/voix-transcription');

const tick = () => new Promise(resolve => setImmediate(resolve));

// A voice loop on a clock the test moves, counting the surface's warm requests.
function loop(overrides = {}) {
  const clock = { at: 100000 }, warmed = [];
  let utterance, speech;
  const audio = { listen(callback, onSpeech) { utterance = callback; speech = onSpeech; }, quiet() {}, close() {}, async play() {} };
  const io = { now: () => clock.at, holdingDelayMs: null, wakeAckDelayMs: 0,
    async openAudio() { return audio; }, async createSession() { return { sessionId: 'session-1' }; },
    async transcribe() { clock.at += 600; return 'Bonjour Nestor'; },
    async turn(_session, _text, _signal, delta) { clock.at += 1500; delta('Voici la réponse. '); return { text: 'Voici la réponse.' }; },
    async synthesize(reply) { return reply.text; }, message() {},
    async warm() { warmed.push(clock.at); },
    ...overrides };
  const conversation = new Conversation(io, () => {});
  return { conversation, clock, warmed, say: () => utterance(new Blob(['sample'])), beginSpeech: () => speech() };
}

test('recognition is woken when the conversation starts and when speech starts after a pause', async () => {
  const h = loop();
  await h.conversation.start({ language: 'fr' }); await tick();
  assert.equal(h.warmed.length, 1, 'at the start, while the greeting plays');
  h.beginSpeech(); await tick();
  assert.equal(h.warmed.length, 1, 'still warm: it was just woken');
  h.clock.at += 60000; h.beginSpeech(); await tick();
  assert.equal(h.warmed.length, 2, 'speech after a pause wakes it again');
  h.conversation.stop();
});

test('a transcription that just ran counts as warm', async () => {
  const h = loop();
  await h.conversation.start({ language: 'fr' }); await tick();
  h.clock.at += 60000; h.beginSpeech(); await tick();
  assert.equal(h.warmed.length, 2);
  h.clock.at += 40000; await h.say();
  // 44 s after the last warm request, but the utterance was transcribed a moment ago.
  h.clock.at += 20000; h.beginSpeech(); await tick();
  assert.equal(h.warmed.length, 2, 'recognition ran with the previous turn');
  h.clock.at += 50000; h.beginSpeech(); await tick();
  assert.equal(h.warmed.length, 3);
  h.conversation.stop();
});

test('a surface without a warm request, or one whose request fails, converses as before', async () => {
  const plain = loop({ warm: undefined });
  await plain.conversation.start({ language: 'fr' }); plain.beginSpeech(); await plain.say();
  assert.equal(plain.conversation.state, 'listening');
  plain.conversation.stop();
  const failing = loop({ async warm() { throw new Error('speech service away'); } });
  await failing.conversation.start({ language: 'fr' }); failing.beginSpeech(); await failing.say();
  assert.equal(failing.conversation.state, 'listening');
  failing.conversation.stop();
});

// The Core proxy: one best-effort request to the primary speech service.
const upstreamOf = attempt => ({ sent: [], async send(path, request, options) { this.sent.push({ path, retry: options.canRetry() }); return { response: await attempt(request), upstream: 'primary' }; } });
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('no body'); return body; } });

test('the proxy reports what the speech service did and never retries on a backup', async () => {
  const calls = [];
  const upstream = upstreamOf(request => request('http://speech.test/api/stt/warm'));
  const fetchWithTimeout = async (url, options, timeoutMs) => { calls.push({ url, method: options.method, timeoutMs }); return answer(200, { warmed: true, warmMs: 412.6 }); };
  assert.deepEqual(await warmRecognition({ upstream, fetchWithTimeout }), { warmed: true, warmMs: 413 });
  assert.deepEqual(upstream.sent, [{ path: '/api/stt/warm', retry: false }]);
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[0].timeoutMs <= 5000, 'a wake-up request never holds a caller for long');
  const recent = upstreamOf(async () => answer(200, { warmed: false }));
  assert.deepEqual(await warmRecognition({ upstream: recent, fetchWithTimeout }), { warmed: false });
});

test('an older, failing or unreachable speech service is not an error', async () => {
  const fetchWithTimeout = async () => answer(200, {});
  for (const attempt of [async () => answer(404, { detail: 'Not Found' }), async () => answer(500), async () => answer(200),
    async () => answer(200, { warmed: true, warmMs: 'soon' }), async () => { throw new Error('connection refused'); }]) {
    const result = await warmRecognition({ upstream: upstreamOf(attempt), fetchWithTimeout });
    assert.equal(typeof result.warmed, 'boolean');
    assert.equal(result.warmMs, undefined);
  }
  assert.deepEqual(await warmRecognition({ upstream: upstreamOf(async () => answer(200, { warmed: true, warmMs: 'soon' })), fetchWithTimeout }), { warmed: true });
  // The route answers 200 with that result, whatever happened upstream.
  let handler;
  registerRecognitionWarmProxy({ post(path, fn) { assert.equal(path, '/warm'); handler = fn; } },
    { upstream: upstreamOf(async () => { throw new Error('down'); }), fetchWithTimeout });
  let sent;
  await handler({}, { json(body) { sent = body; } });
  assert.deepEqual(sent, { warmed: false });
});
