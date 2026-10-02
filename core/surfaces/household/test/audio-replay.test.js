'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioHistory, Endpoint, openAudio, Conversation } = require('../public/browser-conversation');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('rolling audio retains exactly the last twenty seconds including silence, independently of endpointing', t => {
  let now = 0;
  const history = new AudioHistory(1000, () => now);
  t.after(() => history.clear());
  for (let frame = 0; frame < 250; frame++) {
    now += 100; history.push(new Float32Array(100).fill(frame < 100 ? frame : 0));
  }
  const clip = history.freeze();
  assert.equal(clip.samples.length, 20000);
  assert.equal(clip.samples[0], 50);
  assert.equal(clip.samples[4999], 99);
  assert.equal(clip.samples[5000], 0);
  assert.equal(clip.stt, 'not-sent');
  history.push(new Float32Array(100).fill(42), now + 100);
  assert.equal(clip.samples.at(-1), 0, 'an opened excerpt is independent of new frames');
  assert.equal(history.buffer.length, 20000);
});

test('capture gaps cannot splice old audio into a new window and long frames remain bounded', t => {
  const history = new AudioHistory(1000);
  t.after(() => history.clear());
  history.push(new Float32Array(100).fill(1), 0);
  history.push(new Float32Array(100).fill(2), 1000);
  assert.equal(history.length, 100);
  history.breakCapture();
  assert.equal(history.freeze(), null);
  history.push(Float32Array.from({ length: 25000 }, (_, i) => i), 1100);
  const clip = history.freeze();
  assert.equal(clip.samples.length, 20000);
  assert.equal(clip.samples[0], 5000);
  assert.equal(clip.samples.at(-1), 24999);
});

test('one worklet-block allowance preserves a complete maximum utterance at actual browser sample rates', t => {
  for (const rate of [16000, 44100, 48000]) {
    const history = new AudioHistory(rate, () => 0, 1024), endpoint = new Endpoint(rate);
    t.after(() => history.clear());
    let result, frame = 0;
    while (!result) {
      const samples = new Float32Array(1024).fill(.1);
      history.push(samples, ++frame * 1024 / rate * 1000);
      result = endpoint.push(samples);
    }
    const clip = history.freeze('utterance', () => {}, result.length);
    assert.equal(clip.samples.length, result.length);
    assert.ok(result.length >= rate * 20 && result.length < rate * 20 + 1024);
    assert.equal(history.freeze('microphone', () => {}, rate * 20).samples.length, rate * 20);
  }
});

test('echo rejection metadata describes raw audio without storing arbitrary STT response fields', t => {
  const history = new AudioHistory(1000, () => 0);
  t.after(() => history.clear());
  history.push(new Float32Array(100).fill(.2), 100, true);
  history.push(new Float32Array(100).fill(.3), 200, false);
  const clip = history.freeze('utterance');
  assert.equal(clip.rejectedSamples, 100);
  assert.ok(clip.samples[0] > .19, 'rejected audio is retained rather than replaced by silence');
  history.transcription(clip.id, 'pending', '', { turnId: 'turn-one', bytes: 444 });
  history.transcription(clip.id, 'transcribed', 'Bonjour', { model: 'whisper', language: 'fr', sttMs: 12, arbitrary: 'discard', bytes: NaN });
  assert.deepEqual(clip.attempt, { turnId: 'turn-one', bytes: 444, model: 'whisper', language: 'fr', sttMs: 12 });
});

test('submitted excerpt aligns with the phrase length, source updates use its id, and replacement wipes the old audio', t => {
  const history = new AudioHistory(1000);
  t.after(() => history.clear());
  history.push(Float32Array.from({ length: 1000 }, (_, i) => i));
  const clip = history.freeze('utterance', () => {}, 300);
  assert.equal(clip.samples[0], 700);
  history.transcription('different-phrase', 'transcribed', 'Wrong result');
  assert.equal(clip.stt, 'pending');
  history.transcription(clip.id, 'empty');
  assert.equal(clip.stt, 'empty');
  history.freeze();
  assert.equal(clip.samples.every(n => n === 0), true);
  assert.notEqual(history.last().id, clip.id);
});

test('excerpt expiry wipes samples and stops replay at 120 seconds, including delayed timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, expired = 0;
  const history = new AudioHistory(1000, () => now);
  t.after(() => history.clear());
  history.push(new Float32Array(100).fill(.2));
  const first = history.freeze('microphone', () => expired++);
  t.mock.timers.tick(119999);
  assert.equal(history.last(), first);
  t.mock.timers.tick(1);
  assert.equal(history.last(), null);
  assert.equal(expired, 1);
  assert.equal(first.samples.every(n => n === 0), true);
  const second = history.freeze('microphone', () => expired++);
  now = 120001;
  assert.equal(history.last(), null, 'wall clock expiry also handles a suspended browser');
  assert.equal(second.samples.every(n => n === 0), true);
  assert.equal(expired, 2);
});

function fakeBrowser(t) {
  const track = { enabled: false, label: 'Test mic', stop() { this.stopped = true; }, getSettings() { return { echoCancellation: true, noiseSuppression: false, autoGainControl: true }; } };
  const plays = [], nodes = [], contexts = [], analysers = [];
  let requests = 0;
  class Context {
    constructor() { this.sampleRate = 1000; this.currentTime = 0; this.state = 'running'; this.destination = {}; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createAnalyser() {
      const analyser = { fftSize: 512, frequencyBinCount: 256, amplitude: 0, bin: 0, connections: [], reads: [],
        connect(node) { this.connections.push(node); }, disconnect() { this.disconnected = true; },
        getFloatTimeDomainData(array) { this.reads.push(array); array.fill(this.amplitude); },
        getFloatFrequencyData(array) { this.reads.push(array); array.fill(-Infinity); array[this.bin] = 0; } };
      analysers.push(analyser); return analyser;
    }
    decodeAudioData(bytes) { return Promise.resolve(bytes); }
    createBufferSource() {
      const playing = { playbackRate: { value: 1 }, connections: [], connect(...connection) { this.connections.push(connection); }, disconnect() {}, start() { plays.push(this); }, stop() { this.stopped = true; this.onended?.(); } };
      return playing;
    }
  }
  class Worklet {
    constructor() { nodes.push(this); }
    port = { postMessage(data) { this.epoch = data.epoch; } };
    connect() {} disconnect() {}
  }
  const values = {
    // VoiX owns and tests the PCM player. Here exercise the capture adapter's
    // playback rate, destinations and cancellation contract with that player.
    VoixAudio: { Player: class {
      constructor(context, options) { this.context = context; this.options = options; }
      async play(bytes, signal, { rate }) {
        if (signal.aborted) return;
        const source = this.context.createBufferSource(); source.buffer = await this.context.decodeAudioData(bytes);
        source.playbackRate.value = rate;
        for (const target of this.options.destinations) source.connect(target.node || target, 0, target.input || 0);
        await new Promise(resolve => {
          const abort = () => source.stop();
          source.onended = () => { signal.removeEventListener('abort', abort); resolve(); };
          signal.addEventListener('abort', abort, { once: true }); source.start();
        });
      }
    } },
    AudioContext: Context, AudioWorkletNode: Worklet, isSecureContext: true,
    navigator: { mediaDevices: { async getUserMedia() { requests++; return { getTracks: () => [track], getAudioTracks: () => [track] }; } } }
  };
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
  }
  let time = 0;
  return { track, plays, contexts, analysers, requests: () => requests, nodes, send(value = 0, count = 100) {
    time += count / 1000;
    nodes[0].port.onmessage?.({ data: { samples: new Float32Array(count).fill(value), epoch: nodes[0].port.epoch, time } });
  } };
}

test('a short spoken interruption cuts on onset and reaches STT promptly, while impulses and ordinary pauses remain distinct', async t => {
  const h = fakeBrowser(t), controller = new AbortController();
  const audio = await openAudio(controller.signal);
  t.after(() => { controller.abort(); audio.close(); });
  let onsets = 0, phrases = 0;
  audio.listen(() => phrases++, () => onsets++, { interruptible: true });
  h.send(.1, 40); h.send(0, 120);
  assert.equal(onsets, 0, 'a short impulse must not cut speech');
  h.send(.1, 120);
  assert.equal(onsets, 1, 'a short voiced Stop must cut without a second word');
  h.send(0, 240); assert.equal(phrases, 0);
  h.send(0, 20); assert.equal(phrases, 1, 'submit the correction after a short trailing pause');
  audio.listen(() => phrases++, () => onsets++);
  h.send(.1, 180); h.send(0, 860);
  assert.equal(phrases, 1, 'ordinary dialogue retains room for a hesitation');
  h.send(0, 140); assert.equal(phrases, 2);
});

test('real capture adapter freezes silence before filtering, replays without capture, and closes cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = fakeBrowser(t), lifetime = new AbortController();
  const audio = await openAudio(lifetime.signal);
  t.after(() => audio.close());
  let utterances = 0;
  audio.listen(() => utterances++, () => {});
  for (let i = 0; i < 230; i++) browser.send();
  assert.equal(utterances, 0);
  assert.equal(audio.reviewStatus().recentSeconds, 20);
  assert.equal(audio.freezeReview('microphone'), true);
  audio.quiet();
  const info = audio.reviewStatus();
  assert.equal(info.seconds, 20);
  assert.equal(info.stt, 'not-sent');
  assert.equal(info.noiseSuppression, false);
  const playback = audio.playReview(new AbortController().signal);
  await tick();
  assert.equal(browser.track.enabled, false);
  assert.equal(browser.nodes[0].port.onmessage, null);
  assert.equal(browser.plays.length, 1);
  assert.equal(browser.plays[0].playbackRate.value, 1);
  assert.equal(browser.requests(), 1, 'replay never opens a second microphone');
  t.mock.timers.tick(120000);
  assert.equal(browser.plays[0].stopped, true, 'expiry stops sound as well as deleting the excerpt');
  await tick();
  t.mock.timers.tick(300); await playback;
  assert.equal(utterances, 0);
  assert.equal(browser.track.enabled, false, 'playback completion cannot resume listening');
  audio.listen(() => utterances++, () => {});
  browser.send(.2); browser.send(.2);
  for (let i = 0; i < 10; i++) browser.send();
  assert.equal(utterances, 1);
  const phrase = audio.reviewStatus();
  audio.recordTranscription(phrase.id, 'transcribed', 'Bonjour');
  assert.equal(audio.reviewStatus().text, 'Bonjour');
  lifetime.abort();
  assert.equal(browser.track.stopped, true);
  assert.equal(audio.reviewStatus().id, undefined);
  assert.equal(audio.reviewStatus().recentSeconds, 0);
});

test('capture adapter slows response playback without opening another microphone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = fakeBrowser(t), lifetime = new AbortController();
  const audio = await openAudio(lifetime.signal, () => {}, { playbackRate: () => .8 });
  t.after(() => audio.close());
  const speech = new AbortController();
  const pending = audio.play(new ArrayBuffer(0), speech.signal);
  await tick();
  assert.equal(browser.plays[0].playbackRate.value, .8);
  assert.equal(browser.requests(), 1);
  speech.abort(); await tick(); t.mock.timers.tick(300); await pending;
  assert.equal(browser.plays[0].stopped, true);
});

test('optional speech observation samples only speech output, preserving speaker and echo reference paths', async t => {
  const browser = fakeBrowser(t), lifetime = new AbortController();
  const audio = await openAudio(lifetime.signal, () => {}, { observeSpeech: true });
  t.after(() => audio.close());
  const analyser = browser.analysers[0], context = browser.contexts[0];
  const zero = { playing: false, amplitude: 0, brightness: 0 };
  analyser.amplitude = .25; analyser.bin = 128;
  assert.deepEqual(audio.readSpeechSample(), zero, 'No speech means no inferred activity, even with stale analyser samples');
  const abort = new AbortController(), playing = audio.play(new ArrayBuffer(0), abort.signal);
  await tick();
  assert.deepEqual(browser.plays[0].connections, [[analyser, 0, 0], [browser.nodes[0], 0, 1]]);
  assert.deepEqual(analyser.connections, [context.destination]);
  const sample = audio.readSpeechSample();
  assert.equal(sample.playing, true);
  assert.equal(sample.amplitude, .25);
  assert.equal(sample.brightness, 128 / 255);
  audio.readSpeechSample();
  assert.equal(analyser.reads[0], analyser.reads[2], 'Frame reads reuse the waveform buffer');
  assert.equal(analyser.reads[1], analyser.reads[3], 'Frame reads reuse the frequency buffer');
  analyser.amplitude = 0;
  assert.deepEqual(audio.readSpeechSample(), zero, 'Speech buffering and silence have no mouth activity');
  analyser.amplitude = .25; context.state = 'suspended';
  assert.deepEqual(audio.readSpeechSample(), zero);
  context.state = 'running'; abort.abort();
  assert.deepEqual(audio.readSpeechSample(), zero, 'Abort stops presence before async playback settles');
  await playing;
  for (const [review, gain] of [[true, null], [false, .7]]) {
    const stop = new AbortController(), recording = audio.play(new ArrayBuffer(0), stop.signal, review, gain);
    await tick();
    assert.deepEqual(audio.readSpeechSample(), zero, 'Review and recorded sound are not speech');
    assert.notEqual(browser.plays.at(-1).connections[0][0], analyser);
    stop.abort(); await recording;
  }
  audio.close();
  assert.equal(analyser.disconnected, true);
  assert.deepEqual(audio.readSpeechSample(), zero);
});

test('speech observation remains absent unless requested', async t => {
  const browser = fakeBrowser(t);
  const audio = await openAudio(new AbortController().signal);
  t.after(() => audio.close());
  assert.equal(browser.analysers.length, 0);
  assert.deepEqual(audio.readSpeechSample(), { playing: false, amplitude: 0, brightness: 0 });
});

function reviewHarness() {
  const calls = [], messages = [];
  let callback, transcriptionFailure = false, hasAudio = true;
  const audio = {
    listen(fn) { callback = fn; calls.push('listen'); }, quiet() { calls.push('quiet'); },
    close() { hasAudio = false; calls.push('close'); },
    freezeReview() { return hasAudio; }, clearReview() { hasAudio = false; },
    reviewStatus() { return { id: hasAudio ? 'clip' : undefined }; },
    recordTranscription(_id, status) { calls.push(status); },
    async playReview() { calls.push('replay'); }
  };
  const conversation = new Conversation({
    openAudio: async () => audio, createSession: async () => ({ sessionId: 'one' }),
    transcribe: async () => { calls.push('STT'); if (transcriptionFailure) throw Error('offline'); return 'Hello'; },
    turn: async () => { calls.push('LLM'); return { text: '' }; },
    message: (...args) => messages.push(args)
  });
  return { conversation, audio, calls, messages, say: () => callback(new Blob()), failSTT: () => { transcriptionFailure = true; } };
}

test('manual review never invokes STT or the model and resuming waits for playback to settle', async () => {
  const h = reviewHarness();
  await h.conversation.start({});
  assert.equal(h.conversation.review(), true);
  assert.equal(h.conversation.state, 'reviewing');
  let finish;
  h.audio.playReview = () => new Promise(resolve => { finish = resolve; });
  const playing = h.conversation.replay();
  const resuming = h.conversation.start({});
  assert.equal(h.conversation.state, 'resuming');
  assert.equal(h.calls.filter(c => c === 'listen').length, 1);
  finish(); await Promise.all([playing, resuming]);
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.calls.includes('STT'), false);
  assert.equal(h.calls.includes('LLM'), false);
  h.conversation.stop();
});

test('a failed STT phrase stays locally reviewable with the microphone off and no model turn', async () => {
  const h = reviewHarness(); h.failSTT();
  await h.conversation.start({}); await h.say();
  assert.equal(h.conversation.state, 'reviewing');
  assert.equal(h.calls.at(-1), 'quiet');
  assert.equal(h.calls.includes('failed'), true);
  await h.conversation.replay();
  assert.equal(h.calls.includes('LLM'), false);
  assert.deepEqual(h.messages, []);
  h.conversation.stop();
  assert.equal(h.audio.reviewStatus().id, undefined);
});

test('review cannot interrupt pending inference; End during replay resume suppresses late listening', async () => {
  const h = reviewHarness();
  await h.conversation.start({});
  h.conversation.turnPending = true;
  assert.equal(h.conversation.review(), false);
  h.conversation.turnPending = false;
  h.conversation.review();
  let finish;
  h.audio.playReview = () => new Promise(resolve => { finish = resolve; });
  const playing = h.conversation.replay(), resuming = h.conversation.start({});
  h.conversation.stop(); finish(); await Promise.all([playing, resuming]);
  assert.equal(h.conversation.state, 'idle');
  assert.equal(h.calls.filter(c => c === 'listen').length, 1);
  assert.equal(h.conversation.session, null);
});

test('the microphone level follows the last listened block and drops to silence when quiet', async t => {
  const browser = fakeBrowser(t), lifetime = new AbortController();
  const audio = await openAudio(lifetime.signal);
  t.after(() => audio.close());
  assert.equal(audio.readInputLevel(), 0);
  audio.listen(() => {}, () => {});
  browser.send(.05);
  assert.ok(Math.abs(audio.readInputLevel() - .05) < 1e-6, 'RMS of a constant block is its value');
  browser.send(0);
  assert.equal(audio.readInputLevel(), 0);
  browser.send(.1);
  audio.quiet();
  assert.equal(audio.readInputLevel(), 0, 'a quiet microphone never reads as a voice');
  audio.close();
  assert.equal(audio.readInputLevel(), 0);
});
