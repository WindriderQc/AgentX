'use strict';
// Synthetic PCM and fake browser tracks only. No microphone, service or private audio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const capture = require('../../../public/js/voice/voice-capture');
const { Endpoint, MAX_CAPTURE_BYTES } = capture;
const { Conversation, EchoGuard } = require('../public/browser-conversation');
const flush = () => new Promise(resolve => setImmediate(resolve));
const tone = (count, amplitude = .03) => Float32Array.from({ length: count }, (_, i) => amplitude * Math.sin(2 * Math.PI * i / 32));
const overflow = /This utterance is longer than the accepted size.*No partial message was sent/;

for (const rate of [16000, 44100, 48000]) test(`twenty minutes of synthetic silence never starts an utterance at ${rate} Hz`, () => {
  const endpoint = new Endpoint(rate), silence = new Float32Array(1024);
  for (let i = 0; i < Math.ceil(rate * 1200 / silence.length); i++) assert.equal(endpoint.push(silence), null);
  assert.equal(endpoint.speaking, false); assert.equal(endpoint.total, 0); assert.equal(endpoint.frames.length, 0);
  assert.ok(endpoint.preSamples <= rate * .35 + silence.length, 'only bounded preroll remains');
  assert.deepEqual(endpoint.drain(), []);
});

test('twenty minutes of synthetic signal below the default threshold also stays in bounded preroll', () => {
  const rate = 48000, endpoint = new Endpoint(rate), low = tone(1024, .014);
  for (let i = 0; i < Math.ceil(rate * 1200 / low.length); i++) assert.equal(endpoint.push(low), null);
  assert.equal(endpoint.speaking, false); assert.equal(endpoint.total, 0);
  assert.ok(endpoint.preSamples <= rate * .35 + low.length);
});

for (const threshold of [.002, .015, .15]) {
  test(`a softer ending supersedes the early clip at an onset threshold of ${threshold}`, () => {
    const endpoint = new Endpoint(1000, 100, 1000, threshold);
    endpoint.earlySilenceMs = 500;
    const frame = fraction => new Float32Array(100).fill(fraction * threshold);
    for (let i = 0; i < 6; i++) endpoint.push(frame(.8));
    assert.equal(endpoint.speaking, false, 'soft sound alone cannot start a turn');
    endpoint.push(frame(2));
    for (let i = 0; i < 5; i++) endpoint.push(frame(.1));
    const [prefix] = endpoint.drain();
    assert.equal(prefix.type, 'early');
    const soft = frame(.8);
    assert.equal(endpoint.push(soft), null);
    assert.deepEqual(endpoint.drain(), [{ type: 'resumed', id: prefix.id }]);
    for (let i = 0; i < 5; i++) assert.equal(endpoint.push(frame(.1)), null);
    const [ending] = endpoint.drain();
    assert.equal(ending.type, 'early');
    assert.notEqual(ending.id, prefix.id);
    assert.equal(ending.samples[prefix.samples.length], soft[0]);
    for (let i = 0; i < 4; i++) assert.equal(endpoint.push(frame(.1)), null);
    assert.ok(endpoint.push(frame(.1)) instanceof Float32Array);
    assert.equal(endpoint.completedEarlyId, ending.id);
  });
}

test('steady background below onset allows an active turn to finish', () => {
  const room = new Float32Array(100).fill(.012);
  for (const hadRoomTone of [true, false]) {
    const endpoint = new Endpoint(1000);
    if (hadRoomTone) endpoint.push(room);
    endpoint.push(new Float32Array(100).fill(.1));
    let completed;
    for (let i = 0; i < (hadRoomTone ? 10 : 15) && !completed; i++) completed = endpoint.push(room);
    assert.ok(completed instanceof Float32Array);
    assert.equal(endpoint.speaking, false);
  }
});

test('a continuous non-speech tone reaches the exact production byte ceiling without needing a wake word', () => {
  const endpoint = new Endpoint(48000), signal = tone(1024);
  assert.equal(MAX_CAPTURE_BYTES, 33488896); assert.equal(endpoint.maxSamples, 16744448);
  for (let i = 0; i < endpoint.maxSamples / signal.length; i++) assert.equal(endpoint.push(signal), null);
  assert.equal(endpoint.speaking, true); assert.equal(endpoint.total, endpoint.maxSamples);
  assert.throws(() => endpoint.push(new Float32Array([.03])), overflow, 'one sample over the actual limit fails');
  assert.equal(endpoint.total, endpoint.maxSamples, 'the failing sample is not appended');
  endpoint.reset(); assert.equal(endpoint.total, 0); assert.equal(endpoint.speaking, false);
  assert.equal(endpoint.push(new Float32Array(1024)), null);
});

test('isolated synthetic impulses do not become an utterance, while a sufficient pause resets non-speech onset', () => {
  const endpoint = new Endpoint(1000), impulse = new Float32Array(20).fill(.1), quiet = new Float32Array(20);
  for (let i = 0; i < 1000; i++) {
    for (let j = 0; j < 3; j++) assert.equal(endpoint.push(impulse), null);
    for (let j = 0; j < 10; j++) assert.equal(endpoint.push(quiet), null);
  }
  assert.equal(endpoint.speaking, false); assert.equal(endpoint.total, 0);
  for (let j = 0; j < 10; j++) assert.equal(endpoint.push(impulse), null);
  assert.equal(endpoint.speaking, true);
  let result; for (let j = 0; j < 50; j++) result = endpoint.push(quiet);
  assert.ok(result.length > 0); assert.equal(endpoint.total, 0); assert.equal(endpoint.speaking, false);
});

test('an unrelated continuous tone is not rejected as speaker echo when the playback reference is silent', () => {
  const echo = new EchoGuard(48000), signal = tone(1024), silentReference = new Float32Array(1024);
  for (let i = 0; i < 30; i++) assert.equal(echo.isEcho(signal, silentReference), false);
});

function syntheticBrowser() {
  const tracks = [], contexts = [], nodes = [];
  const connection = () => ({ connect() {}, disconnect() {} });
  const window = {
    isSecureContext: true,
    crypto: require('node:crypto').webcrypto,
    AgentXVoiceCapture: {
      ...capture,
      // Accelerate only the transport lifecycle test. The production limit is tested above.
      Endpoint: class extends Endpoint { constructor(...args) { super(...args); this.maxSamples = 2000; } }
    },
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ echoCancellation: true }) };
      tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    AudioContext: class {
      constructor() { this.sampleRate = 1000; this.state = 'running'; this.destination = {}; contexts.push(this); }
      audioWorklet = { addModule: async () => {} };
      async resume() {} async close() { this.state = 'closed'; }
      createMediaStreamSource() { return connection(); }
    },
    AudioWorkletNode: class {
      constructor() { nodes.push(this); }
      port = { postMessage(data) { this.epoch = data.epoch; } };
      connect() {} disconnect() { this.disconnected = true; }
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../../public/js/voice/browser-conversation'), 'utf8'),
    { window, URL, AbortController, Blob, setTimeout, clearTimeout });
  let time = 0;
  return { api: window.NestorConversation, tracks, contexts, nodes,
    send(value = 0, count = 20) {
      const node = nodes.at(-1); time += count / 1000;
      node.port.onmessage?.({ data: { samples: new Float32Array(count).fill(value), epoch: node.port.epoch, time } });
    }
  };
}

test('the real capture adapter stops on overflow, preserves session, rearms wake and ignores stale worklet callbacks', async t => {
  const browser = syntheticBrowser(), phases = [], messages = [];
  let sessions = 0, recognitions = 0, turns = 0, heard = 'avance';
  const conversation = new Conversation({
    openAudio: (signal, onError) => browser.api.openAudio(signal, onError),
    createSession: async () => { sessions++; return { sessionId: 'synthetic-capture-session' }; },
    transcribe: async () => { recognitions++; return heard; }, message: (...args) => messages.push(args),
    turn: async () => { turns++; return { text: '' }; }, wakeAckDelayMs: 0, holdingDelayMs: null
  }, (state, detail) => phases.push([state, detail]));
  t.after(() => conversation.stop());
  await conversation.start({ wakeWord: true, language: 'fr' });
  const session = conversation.session, oldNode = browser.nodes[0], oldCallback = oldNode.port.onmessage, oldEpoch = oldNode.port.epoch;
  for (let i = 0; i < 101; i++) browser.send(.03);
  assert.equal(conversation.state, 'error'); assert.match(phases.at(-1)[1], overflow);
  assert.equal(browser.tracks[0].enabled, false); assert.equal(browser.tracks[0].stopped, true);
  assert.equal(browser.contexts[0].state, 'closed'); assert.equal(oldNode.disconnected, true); assert.equal(oldNode.port.epoch, null);
  assert.equal(conversation.wake.active(), false); assert.equal(conversation.session, session);
  assert.equal(recognitions, 0); assert.equal(turns, 0); assert.deepEqual(messages, []);
  await flush(); assert.equal(browser.tracks.length, 1, 'there is no automatic microphone restart');
  await conversation.start({ wakeWord: true, language: 'fr' });
  assert.equal(sessions, 1); assert.equal(conversation.session, session); assert.equal(browser.tracks.length, 2);
  assert.equal(conversation.state, 'listening'); assert.equal(conversation.wake.active(), false);
  oldCallback({ data: { samples: new Float32Array(1000).fill(.1), epoch: oldEpoch, time: 10 } });
  assert.equal(conversation.state, 'listening', 'a closed capture cannot affect the replacement');
  for (let i = 0; i < 10; i++) browser.send(.03);
  for (let i = 0; i < 50; i++) browser.send();
  await flush();
  assert.equal(recognitions, 1); assert.equal(turns, 0, 'rearming retains wake admission');
  heard = 'Hey Nestor, bonjour';
  for (let i = 0; i < 10; i++) browser.send(.03);
  for (let i = 0; i < 50; i++) browser.send();
  await flush();
  assert.equal(turns, 1); assert.equal(conversation.wake.active(), true);
  conversation.stop(true); assert.equal(conversation.session, session); assert.equal(conversation.wake.active(), false);
  assert.equal(browser.tracks[1].stopped, true);
});

test('a softly withdrawn reminder reaches Family once without saving the speculative request', async t => {
  const { harness } = require('./fixtures/persona-journey.cjs');
  const family = harness({ packId: 'kidx_nestor', backend: 'agentx' });
  const inbox = t.mock.method(require('../../../src/services/ideaInboxService'), 'captureIdea',
    async () => ({ review: 'parent' }));
  const browser = syntheticBrowser();
  const reminder = 'Rappelle-moi de sortir mes mitaines.';
  const withdrawn = reminder + ' Ah non, laisse faire.';
  const submitted = [];
  let prefix, ended;
  // Stand in for STT: the distinctive quieter PCM block represents the last words.
  const recognize = async blob => {
    const samples = new Int16Array(await blob.arrayBuffer(), 44);
    const text = samples.some(sample => sample > 0 && sample < 500) ? withdrawn : reminder;
    if (text === reminder) prefix.resolve(text);
    return { text };
  };
  const conversation = new Conversation({
    openAudio: (signal, onError) => browser.api.openAudio(signal, onError),
    createSession: async () => family.session,
    transcribeEarly: recognize, transcribe: recognize,
    turn: async (_session, text) => {
      submitted.push(text);
      await family.turn(text, 'voice');
      return { text: '' };
    },
    message() {}, transcriptionEnded: () => ended.resolve()
  });
  t.after(() => conversation.stop());
  await conversation.start({ language: 'fr' });
  for (const retract of [false, true]) {
    prefix = Promise.withResolvers();
    ended = Promise.withResolvers();
    browser.send(.04, 160);
    browser.send(0, 500);
    assert.equal(await prefix.promise, reminder);
    assert.equal(inbox.mock.callCount(), retract ? 1 : 0, 'early STT cannot write');
    if (retract) browser.send(.012, 100);
    browser.send(0, 1000);
    await ended.promise;
  }
  assert.deepEqual(submitted, [reminder, withdrawn]);
  assert.equal(family.sent.length, 2);
  assert.equal(inbox.mock.callCount(), 1);
  assert.equal(inbox.mock.calls[0].arguments[0].text, reminder);
  assert.match(family.sent[0].request, /saved in the parent review inbox/);
  assert.doesNotMatch(family.sent[1].request, /saved in the parent review inbox/);
});
