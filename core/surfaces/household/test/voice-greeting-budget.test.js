const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Conversation } = require('../public/browser-conversation');
const { Player } = require('../../../../integrations/voix/app/web/voice-audio');

const flush = () => new Promise(resolve => setImmediate(resolve));
const pending = () => new Promise(() => {});
const gate = () => Promise.withResolvers();

function stream() {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }),
    { headers: { 'Content-Type': 'application/x-ndjson' } });
  return { response, cancellations: () => cancelled };
}

function setup(t, io = {}, playback = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], intent = [], details = [];
  const audio = {
    listen() { calls.push('listen'); }, close() { calls.push('close'); },
    async play() { calls.push('play'); }, async settle() { calls.push('settle'); }, ...playback
  };
  const conversation = new Conversation({
    recoverCapture: true, openAudio: async () => audio, createSession: async () => ({ sessionId: 'synthetic' }),
    warm: () => calls.push('warm'), microphoneIntent: value => intent.push(value),
    greet: async () => new Uint8Array([1]), ...io
  }, (state, detail) => details.push([state, detail]));
  t.after(() => conversation.stop());
  return { conversation, calls, intent, details, start: () => conversation.start({ language: 'fr' }) };
}

for (const stage of ['openAudio', 'createSession']) {
  test('an unresolved ' + stage + ' retains the 30-second startup watchdog', async t => {
    const h = setup(t, { [stage]: pending });
    void h.start(); await flush();
    t.mock.timers.tick(29999); assert.equal(h.conversation.state, 'starting');
    t.mock.timers.tick(1); await flush();
    assert.ok(h.details.some(([, detail]) => detail.includes('Le micro ne démarre pas')));
    assert.ok(!h.calls.includes('listen'));
  });
}

test('a healthy greeting plays and settles before listening', async t => {
  const h = setup(t);
  await h.start();
  assert.deepEqual(h.calls, ['warm', 'play', 'settle', 'listen']);
  t.mock.timers.tick(30000);
  assert.equal(h.conversation.state, 'listening');
});

test('an accepted NDJSON greeting with no bytes releases the real player and keeps capture', async t => {
  const media = stream(), session = gate();
  const h = setup(t, { createSession: () => session.promise, greet: () => media.response },
    { play: (response, signal) => new Player({}).play(response, signal) });
  const started = h.start(); await flush();
  t.mock.timers.tick(29000);
  session.resolve({ sessionId: 'synthetic' }); await flush();
  assert.equal(media.response.body.locked, true);
  t.mock.timers.tick(7999); await flush();
  assert.equal(h.conversation.state, 'speaking');
  t.mock.timers.tick(1); await flush();
  assert.equal(h.conversation.state, 'listening');
  await started;
  assert.equal(media.cancellations(), 1);
  assert.equal(media.response.body.locked, false);
  assert.deepEqual(h.calls, ['warm', 'listen']);
  assert.deepEqual(h.intent, [true]);
});

for (const late of [false, true]) {
  test('an unavailable avatar releases a ' + (late ? 'late' : 'ready') + ' response', async t => {
    const media = stream(), speech = gate(), avatar = gate();
    const h = setup(t, { greet: () => late ? speech.promise : media.response, readyToSpeak: () => avatar.promise });
    const started = h.start(); await flush();
    t.mock.timers.tick(8000); await flush();
    assert.equal(h.conversation.state, 'listening');
    await started;
    if (late) { speech.resolve(media.response); await flush(); }
    assert.equal(media.cancellations(), 1);
    avatar.resolve(); await flush();
    assert.deepEqual(h.calls, ['warm', 'listen']);
  });
}

test('pause and resume ignore an old greeting and keep the session', async t => {
  const media = stream(), speech = gate();
  let greetings = 0;
  const h = setup(t, { greet() { greetings++; return speech.promise; } });
  const first = h.start(); await flush();
  h.conversation.pause(); await h.start();
  speech.resolve(media.response); await first;
  assert.equal(media.cancellations(), 1);
  assert.equal(greetings, 1);
  assert.deepEqual(h.calls, ['warm', 'close', 'listen']);
});

test('autoplay refusal releases unplayed speech and opens listening', async t => {
  const media = stream();
  const h = setup(t, { greet: () => media.response },
    { play: async () => { throw new DOMException('synthetic refusal', 'NotAllowedError'); } });
  await h.start();
  assert.equal(media.cancellations(), 1);
  assert.deepEqual(h.calls, ['warm', 'listen']);
});

test('settling an already played greeting shares the same deadline', async t => {
  const played = gate(), h = setup(t, {}, { play: () => played.promise, settle: pending });
  const started = h.start(); await flush();
  t.mock.timers.tick(7000); played.resolve(); await flush();
  t.mock.timers.tick(1000); await flush();
  assert.equal(h.conversation.state, 'listening');
  await started;
});
