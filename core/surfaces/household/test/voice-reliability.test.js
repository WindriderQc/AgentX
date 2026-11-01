'use strict';
// All audio, permissions and transports are synthetic. No service or device access.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { Conversation } = require('../public/browser-conversation');
const capture = require('../../../public/js/voice/voice-capture');
const tick = () => new Promise(resolve => setImmediate(resolve));

function browser() {
  const tracks = [], nodes = [];
  const window = {
    isSecureContext: true, crypto: require('node:crypto').webcrypto,
    AgentXVoiceCapture: { ...capture, Endpoint: class extends capture.Endpoint {
      constructor(...args) { super(...args); this.maxSamples = 2000; }
    } },
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ echoCancellation: true }) };
      tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    AudioContext: class {
      sampleRate = 1000; state = 'running'; destination = {};
      audioWorklet = { addModule: async () => {} };
      async resume() {} async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    },
    AudioWorkletNode: class {
      constructor() { nodes.push(this); }
      port = { postMessage(data) { this.epoch = data.epoch; } }; connect() {} disconnect() {}
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../../public/js/voice/browser-conversation'), 'utf8'),
    { window, URL, AbortController, Blob, setTimeout, clearTimeout });
  let time = 0;
  return { api: window.NestorConversation, tracks, nodes, send(value = 0, count = 20) {
    const node = nodes.at(-1); time += count / 1000;
    node.port.onmessage?.({ data: { samples: new Float32Array(count).fill(value), epoch: node.port.epoch, time } });
  } };
}

test('an opted-in capture discards an over-budget sound, waits for real silence, and recovers on the same stream', async t => {
  const h = browser(), lifetime = new AbortController(), notices = [], errors = [], phrases = [];
  const audio = await h.api.openAudio(lifetime.signal, error => errors.push(error), { onCaptureRecovery: value => notices.push(value.state) });
  t.after(() => { lifetime.abort(); audio.close(); });
  audio.listen(blob => phrases.push(blob), () => {});
  for (let i = 0; i < 101; i++) h.send(.03);
  assert.deepEqual(errors, [], 'a capture limit must not permanently disable the opted-in kiosk');
  assert.deepEqual(notices, ['waiting-silence']); assert.equal(h.tracks[0].enabled, true);
  for (let i = 0; i < 1000; i++) h.send(.03);
  assert.deepEqual(notices, ['waiting-silence'], 'continuous sound cannot repeatedly grow fresh captures');
  assert.equal(phrases.length, 0);
  for (let i = 0; i < 49; i++) h.send(); assert.deepEqual(notices, ['waiting-silence']);
  h.send(); assert.deepEqual(notices, ['waiting-silence', 'ready']);
  for (let i = 0; i < 10; i++) h.send(.03);
  for (let i = 0; i < 50; i++) h.send();
  assert.equal(phrases.length, 1, 'only a fresh utterance after silence may be submitted');
  assert.equal(h.tracks.length, 1, 'recovery requests no new stream or permission');
  assert.equal(capture.MAX_CAPTURE_BYTES, 33488896, 'the actual production limit stays unchanged');
});

test('explicit Stop while waiting for silence prevents any automatic capture restart', async t => {
  const h = browser(), lifetime = new AbortController(), notices = [];
  const audio = await h.api.openAudio(lifetime.signal, () => {}, { onCaptureRecovery: value => notices.push(value.state) });
  t.after(() => audio.close()); audio.listen(() => assert.fail('no utterance'), () => {});
  for (let i = 0; i < 101; i++) h.send(.03);
  lifetime.abort();
  for (let i = 0; i < 100; i++) h.send();
  assert.deepEqual(notices, ['waiting-silence']); assert.equal(h.tracks[0].stopped, true); assert.equal(h.tracks.length, 1);
});

function harness(extra = {}) {
  let say, options, captureRecovery, heard = 'Hey Nestor, bonjour', failure = null, online = true;
  const counts = { opens: 0, sessions: 0, recognitions: 0, turns: 0, listens: 0, closes: 0 }, phases = [];
  const audio = { listen(callback) { say = callback; counts.listens++; }, quiet() {}, close() { counts.closes++; },
    reviewStatus: () => ({ id: 'synthetic-clip' }), recordTranscription() {}, clearReview() {}, async play() {} };
  const c = new Conversation({ recoverCapture: true, canResumeRecognition: () => online,
    wakeAckDelayMs: 0, holdingDelayMs: null,
    openAudio: async (_signal, _onError, value) => { counts.opens++; options = value; captureRecovery = value.onCaptureRecovery; return audio; },
    createSession: async () => { counts.sessions++; return { sessionId: 'synthetic-reliability-session' }; },
    transcribe: async () => { counts.recognitions++; if (failure) throw failure; return heard; },
    turn: async () => { counts.turns++; return { text: '' }; }, message() {}, ...extra
  }, (state, detail) => phases.push([state, detail]));
  return { c, counts, phases, audio, say: () => say(new Blob(['synthetic utterance'])),
    recovery: value => captureRecovery(value), options: () => options,
    fail(value) { failure = value; }, heard(value) { heard = value; }, online(value) { online = value; } };
}
const unavailable = () => Object.assign(Error('Synthetic speech service unavailable'), { status: 503 });

test('capture recovery rearms wake, preserves session and exposes a French actionable state', async () => {
  const h = harness(); await h.c.start({ language: 'fr', wakeWord: true }); const session = h.c.session;
  h.c.wake.extend(); h.recovery({ state: 'waiting-silence' });
  assert.equal(h.c.state, 'recovering'); assert.equal(h.c.session, session); assert.equal(h.c.wake.active(), false);
  assert.match(h.phases.at(-1)[1], /silence/i);
  h.recovery({ state: 'ready' }); assert.equal(h.c.state, 'listening'); assert.equal(h.counts.opens, 1);
  assert.equal(h.counts.sessions, 1); h.c.stop(true); h.recovery({ state: 'ready' });
  assert.equal(h.c.state, 'paused'); assert.equal(h.counts.opens, 1);
});

test('a transient recognition failure resumes fresh listening without replaying audio or creating a session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr', wakeWord: true });
  const session = h.c.session; h.fail(unavailable()); await h.say();
  assert.equal(h.c.state, 'recovering'); assert.match(h.phases.at(-1)[1], /reconnaissance|connexion/i);
  t.mock.timers.tick(2000); await tick();
  assert.equal(h.c.state, 'listening'); assert.equal(h.c.session, session); assert.equal(h.c.wake.active(), false);
  assert.equal(h.counts.recognitions, 1); assert.equal(h.counts.turns, 0); assert.equal(h.counts.opens, 1);
  h.fail(null); await h.say(); assert.equal(h.counts.turns, 1); assert.equal(h.counts.sessions, 1);
});

test('offline recovery waits without collecting new audio and resumes after reconnect on the same stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr', wakeWord: true });
  h.online(false); h.fail(unavailable()); await h.say(); const listens = h.counts.listens;
  t.mock.timers.tick(30000); await tick();
  assert.equal(h.c.state, 'recovering'); assert.equal(h.counts.listens, listens); assert.equal(h.counts.recognitions, 1);
  h.online(true); h.c.retryRecognition();
  assert.equal(h.c.state, 'listening'); assert.equal(h.counts.opens, 1); assert.equal(h.counts.recognitions, 1);
});

test('Pause cancels a queued recognition recovery and cannot be undone by late reconnect callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr', wakeWord: true });
  h.fail(unavailable()); await h.say(); h.c.stop(true);
  const listens = h.counts.listens; t.mock.timers.tick(60000); await tick(); h.c.retryRecognition();
  assert.equal(h.c.state, 'paused'); assert.equal(h.counts.listens, listens); assert.equal(h.counts.opens, 1);
});

test('repeated service failures stop bounded automatic recovery and retain explicit replay/resume controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr' }); h.fail(unavailable());
  for (let i = 0; i < 2; i++) { await h.say(); t.mock.timers.tick(2000); await tick(); assert.equal(h.c.state, 'listening'); }
  await h.say(); assert.equal(h.c.state, 'reviewing'); assert.match(h.phases.at(-1)[1], /reconnaissance|micro/i);
  const listens = h.counts.listens; t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.listens, listens);
  assert.equal(h.counts.recognitions, 3); assert.equal(h.counts.turns, 0);
});

test('a permission refusal or a response failure is never automatically retried as a new request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ turn: async () => { h.counts.turns++; throw unavailable(); } });
  t.after(() => h.c.stop()); await h.c.start({ language: 'fr' }); const session = h.c.session;
  await h.say(); assert.equal(h.c.state, 'error'); assert.equal(h.c.session, session);
  t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.turns, 1); assert.equal(h.counts.opens, 1);
  await h.c.start({ language: 'fr' }); assert.equal(h.counts.sessions, 1); assert.equal(h.counts.turns, 1);
  h.fail(Object.assign(Error('Synthetic forbidden'), { status: 403 })); await h.say();
  assert.equal(h.c.state, 'reviewing'); const listens = h.counts.listens;
  t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.listens, listens);
});

test('typing during recovery cancels its timer rather than reopening the microphone during the response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(() => h.c.stop()); await h.c.start({ language: 'fr' });
  h.fail(unavailable()); await h.say(); assert.equal(h.c.canType(), true);
  assert.equal(await h.c.typed('Synthetic typed request'), true); const listens = h.counts.listens;
  t.mock.timers.tick(60000); await tick(); assert.equal(h.counts.turns, 1); assert.equal(h.counts.listens, listens);
});
