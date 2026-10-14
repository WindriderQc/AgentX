'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceTimeline } = require('../../../public/js/voice/voice-timeline');
const { Conversation } = require('../../../public/js/voice/browser-conversation');
const { normalizeVoiceTimings, MAX_OFFSET_MS } = require('../../../src/services/voice/timeline');
const { createBrowserSessionControls } = require('../browser-session-controls');

const tick = () => new Promise(resolve => setImmediate(resolve));
const nextTimer = () => new Promise(resolve => setTimeout(resolve, 10));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

// A voice loop on a clock the test moves: every step of a turn costs known milliseconds.
function loop(overrides = {}) {
  const clock = { at: 1000 }, sent = [];
  let utterance, speech;
  const audio = { listen(callback, onSpeech) { utterance = callback; speech = onSpeech; }, quiet() {}, close() {}, async play() {} };
  const io = { now: () => clock.at, holdingDelayMs: null, wakeAckDelayMs: 0,
    async openAudio() { return audio; }, async createSession() { return { sessionId: 'family-1' }; },
    async transcribe() { clock.at += 600; return 'Bonjour Nestor'; },
    async turn(_session, _text, _signal, delta) { clock.at += 4000; delta('Voici la réponse. '); return { text: 'Voici la réponse.' }; },
    async synthesize(reply) { clock.at += 500; return reply.text; }, message() {},
    async timings(session, turnId, timings) { sent.push({ sessionId: session.sessionId, turnId, timings }); return { turnId }; },
    ...overrides };
  const conversation = new Conversation(io, () => {});
  return { conversation, audio, clock, sent, say: () => utterance(new Blob(['sample'])), beginSpeech: () => speech() };
}

test('a mark keeps its first offset from the end of speech; unknown marks are ignored', () => {
  const clock = { at: 50 };
  const timeline = new VoiceTimeline(() => clock.at);
  clock.at = 690.4; timeline.mark('sttDone');
  clock.at = 900; timeline.mark('sttDone'); timeline.mark('firstWord');
  assert.deepEqual(timeline.values(), { sttDone: 640, interrupted: false });
  assert.deepEqual(timeline.values(true), { sttDone: 640, interrupted: true });
});

test('a timeline is sent once, only for a turn that reached the model, and a failure is silent', async () => {
  const sent = [], send = async values => { sent.push(values); return {}; };
  const unsent = new VoiceTimeline(() => 0); unsent.mark('sttDone');
  await unsent.report(send);
  assert.deepEqual(sent, [], 'no model turn: nothing to attach it to');
  const timeline = new VoiceTimeline(() => 0); timeline.mark('requestSent');
  await timeline.report(send); await timeline.report(send);
  assert.equal(sent.length, 1);
  const failing = new VoiceTimeline(() => 0); failing.mark('requestSent');
  await failing.report(async () => { throw new Error('offline'); });
});

test('a turn Core has not recorded yet gets its timeline once more when the turn’s request ends', async () => {
  const ended = deferred(), sent = [];
  const timeline = new VoiceTimeline(() => 0); timeline.mark('requestSent');
  let interrupted = false;
  const reporting = timeline.report(async values => { sent.push(values); return sent.length === 1 ? { pending: true } : {}; }, () => interrupted, ended.promise);
  await tick();
  assert.equal(sent.length, 1, 'it waits for the request to end');
  interrupted = true; ended.resolve(); await reporting;
  assert.deepEqual(sent.map(values => values.interrupted), [false, true]);
  // Still pending the second time: never a loop.
  const stuck = new VoiceTimeline(() => 0); stuck.mark('requestSent'); let attempts = 0;
  await stuck.report(async () => { attempts++; return { pending: true }; });
  assert.equal(attempts, 2);
});

test('a voice turn reports its offsets from the end of speech when its first reply clause plays', async () => {
  const h = loop();
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].sessionId, 'family-1');
  assert.match(h.sent[0].turnId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(h.sent[0].timings, { sttDone: 600, requestSent: 600, firstDelta: 4600, firstAudio: 5100, interrupted: false, playbackOutcome: 'completed' });
  await h.say();
  assert.equal(h.sent.length, 2, 'one report per turn');
  assert.notEqual(h.sent[1].turnId, h.sent[0].turnId);
  h.conversation.stop();
});

test('a measure keeps a reported duration beside the marks; anything else is ignored', () => {
  const timeline = new VoiceTimeline(() => 0);
  timeline.mark('requestSent');
  timeline.measure('sttServer', 449.6); timeline.measure('audioMs', 4200); timeline.measure('silenceMs', 1000);
  timeline.measure('sttServer', '450'); timeline.measure('audioMs', -1); timeline.measure('silenceMs', NaN); timeline.measure('uploadGuess', 3);
  assert.deepEqual(timeline.values(), { requestSent: 0, sttServer: 450, audioMs: 4200, silenceMs: 1000, interrupted: false });
});

test('a voice turn keeps playback requested, frame scheduled and non-silent signal scheduled separate', async () => {
  const h = loop();
  h.audio.play = async (_bytes, _signal, _review, _gain, callbacks) => {
    assert.deepEqual(h.sent, [], 'a playback request is not a scheduling receipt');
    h.clock.at += 100;
    callbacks.onScheduled();
    assert.deepEqual(h.sent, [], 'silent padding does not attest a signal');
    h.clock.at += 400;
    callbacks.onSignalScheduled();
  };
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.deepEqual(h.sent[0].timings, { sttDone: 600, requestSent: 600, firstDelta: 4600,
    firstAudio: 5100, firstFrameScheduled: 5200, firstSignalScheduled: 5600, interrupted: false });
  assert.deepEqual(normalizeVoiceTimings(h.sent[0].timings), h.sent[0].timings);
  h.conversation.stop();
});

test('a failed player retains the request time without inventing scheduled audio', async () => {
  const h = loop();
  h.audio.play = async () => { throw new Error('No output device'); };
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.equal(h.sent[0].timings.firstAudio, 5100);
  assert.equal(h.sent[0].timings.firstFrameScheduled, undefined);
  assert.equal(h.sent[0].timings.firstSignalScheduled, undefined);
  h.conversation.stop();
});

test('a voice turn reports what explains its transcription: silence waited, clip length and recognition time', async () => {
  let utterance;
  const h = loop({ async transcribe() { h.clock.at += 600; return { text: 'Bonjour Nestor', sttMs: 450 }; } });
  h.audio.listen = callback => { utterance = callback; };
  await h.conversation.start({ language: 'fr' });
  await utterance(new Blob(['sample']), { audioMs: 4200.4, silenceMs: 1000 });
  assert.deepEqual(h.sent[0].timings, { sttDone: 600, requestSent: 600, firstDelta: 4600, firstAudio: 5100,
    silenceMs: 1000, audioMs: 4200, sttServer: 450, interrupted: false, playbackOutcome: 'completed' });
  h.conversation.stop();
});

test('the holding phrase and a waiting notice are not the reply’s first audio', async () => {
  const slow = deferred(), played = [];
  const h = loop({ holdingDelayMs: 5,
    async turn(_session, _text, _signal, _delta, options) { options.onNotice('Un instant, je termine un test en cours.'); return slow.promise; } });
  h.audio.play = async bytes => { played.push(bytes); };
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await nextTimer(); await nextTimer();
  assert.equal(played.length, 2, 'the notice and the holding phrase were heard');
  assert.deepEqual(h.sent, [], 'neither is the reply');
  h.clock.at += 7000; slow.resolve({ text: 'Voici la réponse.' }); await exchange;
  const { timings } = h.sent[0];
  assert.equal(h.sent.length, 1);
  assert.ok(timings.holdingPhrase < timings.firstDelta, 'the phrase started before the unstreamed reply arrived');
  assert.ok(timings.firstAudio > timings.firstDelta);
  assert.equal(played.at(-1), 'Voici la réponse.');
  h.conversation.stop();
});

test('a turn interrupted before any reply audio still reports, marked interrupted and without first audio', async () => {
  let turns = 0;
  const h = loop({
    turn(_session, _text, signal) {
      if (++turns > 1) return Promise.resolve({ text: 'Deuxième réponse.' });
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    },
    async transcribe() { h.clock.at += 600; return turns ? 'Attends, autre chose' : 'Bonjour Nestor'; },
    async interrupt() {} });
  h.audio.canInterrupt = true;
  await h.conversation.start({ language: 'fr', interruption: true });
  const first = h.say(); await tick(); await tick();
  h.beginSpeech(); await h.say(); await first;
  const interrupted = h.sent.find(row => row.timings.interrupted);
  assert.ok(interrupted, 'the interrupted turn is reported');
  assert.equal(interrupted.timings.firstAudio, undefined);
  assert.equal(interrupted.timings.requestSent, 600);
  assert.equal(h.sent.length, 2, 'and the turn that replaced it reports its own');
  h.conversation.stop();
});

test('speech that never becomes a model turn, a typed message and a surface without timings report nothing', async () => {
  const silent = loop({ async transcribe() { return ''; } });
  await silent.conversation.start({ language: 'fr' }); await silent.say();
  assert.deepEqual(silent.sent, []);
  const typed = loop();
  await typed.conversation.start({ language: 'fr' });
  assert.equal(await typed.conversation.typed('Bonjour par écrit'), true);
  assert.deepEqual(typed.sent, [], 'a typed turn has no end of speech');
  typed.conversation.stop();
  const unwired = loop({ timings: undefined });
  await unwired.conversation.start({ language: 'fr' }); await unwired.say();
  assert.equal(unwired.conversation.state, 'listening');
  unwired.conversation.stop();
});

test('Core keeps the known measures beside the marks and drops an unusable one without refusing the timeline', () => {
  assert.deepEqual(normalizeVoiceTimings({ sttDone: 640, silenceMs: 1000, audioMs: 4200.4, sttServer: 449.6, uploadGuess: 3 }),
    { sttDone: 640, silenceMs: 1000, audioMs: 4200, sttServer: 450, interrupted: false });
  assert.deepEqual(normalizeVoiceTimings({ sttDone: 640, sttServer: '450', audioMs: -1, silenceMs: MAX_OFFSET_MS + 1 }), { sttDone: 640, interrupted: false });
  assert.equal(normalizeVoiceTimings({ sttServer: 450, audioMs: 4200 }), null, 'measures alone are not a timeline');
});

test('Core keeps only known marks as bounded whole numbers', () => {
  assert.deepEqual(normalizeVoiceTimings({ sttDone: 640.4, requestSent: 650, firstDelta: 4200, holdingPhrase: 3000, firstAudio: 5100.6, interrupted: true,
    note: 'free text', turnId: 'x' }), { sttDone: 640, requestSent: 650, firstDelta: 4200, holdingPhrase: 3000, firstAudio: 5101, interrupted: true });
  assert.deepEqual(normalizeVoiceTimings({ requestSent: 0, interrupted: 'yes' }), { requestSent: 0, interrupted: false });
  for (const invalid of [null, 'text', [], {}, { note: 'only unknown' }, { sttDone: -1 }, { sttDone: '640' }, { sttDone: NaN },
    { sttDone: Infinity }, { firstAudio: MAX_OFFSET_MS + 1 }, { sttDone: 600, firstAudio: { $gt: 0 } }]) {
    assert.equal(normalizeVoiceTimings(invalid), null, JSON.stringify(invalid));
  }
});

test('Core retains bounded recognition evidence without retaining upstream text, audio or arbitrary data', () => {
  const recognitionId = '19b98eab-7a12-4a31-8d40-8802ec82da11';
  const value = normalizeVoiceTimings({ requestSent: 2, recognition: {
    schema: 1, recognitionId, mode: 'early', submittedBytes: 64044, captureBytes: 96044,
    requestedLanguage: 'fr', decodedLanguage: 'fr', languageSource: 'requested',
    audioSeconds: 2, speechSeconds: 1.6, queueMs: 0, decodeMs: 120, segments: 1,
    device: 'cuda', computeType: 'int8_float16', normalizationChanged: false,
    text: 'not telemetry', rawText: 'not telemetry either', audio: 'not retained',
    model: '/private/model', confidence: 1, prompt: 'not retained',
    avgLogProbability: -0.6, maxNoSpeechProbability: 0.02, maxCompressionRatio: 1.1
  } });
  assert.deepEqual(value.recognition, {
    schema: 1, recognitionId, mode: 'early', submittedBytes: 64044, captureBytes: 96044,
    requestedLanguage: 'fr', decodedLanguage: 'fr', languageSource: 'requested',
    audioSeconds: 2, speechSeconds: 1.6, queueMs: 0, decodeMs: 120, segments: 1,
    device: 'cuda', computeType: 'int8_float16', normalizationChanged: false,
    avgLogProbability: -0.6, maxNoSpeechProbability: 0.02, maxCompressionRatio: 1.1
  });
  const rejected = normalizeVoiceTimings({ requestSent: 2, recognition: {
    schema: 1, recognitionId: '<script>', mode: 'guessed', submittedBytes: -1, captureBytes: Infinity,
    requestedLanguage: 'private text', decodedLanguage: 'fr-CA', languageSource: 'guessed',
    queueMs: '3', decodeMs: -1, segments: 0.5, avgLogProbability: 1,
    maxNoSpeechProbability: 2, maxCompressionRatio: NaN, device: 'custom',
    computeType: 'custom', normalizationChanged: 'true'
  } });
  assert.equal(rejected.recognition, undefined, 'a schema number alone is not evidence');
  for (const recognition of [null, [], 'text', { schema: 2, text: 'unknown' }, { schema: 1 }]) {
    assert.equal(normalizeVoiceTimings({ requestSent: 2, recognition }).recognition, undefined);
  }
});

test('recognition evidence remains correlated while Core waits for the canonical turn', async () => {
  const ended = deferred(), snapshots = [], timeline = new VoiceTimeline(() => 0);
  const recognitionId = '19b98eab-7a12-4a31-8d40-8802ec82da11';
  timeline.transcription({ text: 'Bonjour', recognitionId, recognition: { schema: 1, queueMs: 0, decodeMs: 200 } },
    { mode: 'complete', submittedBytes: 2044, captureBytes: 2044 });
  timeline.mark('requestSent');
  const reporting = timeline.report(async values => { snapshots.push(values); return snapshots.length === 1 ? { pending: true } : {}; }, () => false, ended.promise);
  await tick(); ended.resolve(); await reporting;
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].recognition.recognitionId, recognitionId);
  assert.deepEqual(snapshots[1].recognition, snapshots[0].recognition);
  assert.deepEqual(normalizeVoiceTimings(snapshots[1]), snapshots[1]);
});

// The voice-timings route over synthetic turns: one recorded, one still in flight.
function controls() {
  const routes = {}, updates = [];
  const recorded = '33333333-3333-4333-8333-333333333333', inFlight = '44444444-4444-4444-8444-444444444444';
  const activePersonaTurns = new Map([['session-1', { clientTurnId: inFlight, snapshot: { packId: 'kidx_nestor', scopeId: 'family' } }]]);
  const register = createBrowserSessionControls({ personas: { get() {}, post(path, handler) { routes[path] = handler; } }, activePersonaTurns,
    conversations: { async updateTurn(filter, update) {
      updates.push({ filter, update });
      return filter.clientTurnId === recorded ? { _id: 'audit-1', voiceTimings: update.$set.voiceTimings } : null;
    } },
    envelope: (res, data, status = 200) => res.reply(status, data), fail: (res, status, message, code) => res.reply(status, { message, code }),
    cleanText: value => String(value || ''), validClientTurnId: value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value),
    nestorClient: async () => ({}) });
  register('/family', 'kidx_nestor', 'family');
  register('/llmx', 'kidx_nestor', 'family', { get() {}, post(path, handler) { routes['llmx:' + path] = handler; } }, 'llmx');
  const post = (body, sessionId = 'session-1') => new Promise(resolve => routes['/family/sessions/:sessionId/voice-timings'](
    { params: { sessionId }, body }, { reply: (status, data) => resolve({ status, data }) }));
  return { post, updates, routes, recorded, inFlight };
}

test('timings are stored on the recorded voice turn of that session and space, by client turn', async () => {
  const h = controls();
  const stored = await h.post({ turnId: h.recorded, timings: { sttDone: 640, requestSent: 650, firstAudio: 5100, extra: 'dropped' } });
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.data, { turnId: h.recorded, voiceTimings: { sttDone: 640, requestSent: 650, firstAudio: 5100, interrupted: false } });
  assert.deepEqual(h.updates[0], { filter: { sessionId: 'session-1', clientTurnId: h.recorded, packId: 'kidx_nestor', scopeId: 'family', channel: 'voice' },
    update: { $set: { voiceTimings: { sttDone: 640, requestSent: 650, firstAudio: 5100, interrupted: false } } } });
});

test('recognition identity follows the same session and turn filter as the voice timeline', async () => {
  const h = controls(), recognitionId = '19b98eab-7a12-4a31-8d40-8802ec82da11';
  const stored = await h.post({ turnId: h.recorded, timings: { sttDone: 2, recognition: {
    schema: 1, recognitionId, mode: 'early', decodeMs: 400, text: 'never copied'
  } } });
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.data.voiceTimings.recognition, { schema: 1, recognitionId, decodeMs: 400, mode: 'early' });
  assert.equal(h.updates[0].filter.clientTurnId, h.recorded);
  assert.equal(h.updates[0].filter.sessionId, 'session-1');
  assert.equal(h.updates[0].filter.scopeId, 'family');
  assert.equal(h.updates[0].update.$set.voiceTimings.recognition.text, undefined);
});

test('a turn still in flight answers pending; an unknown turn and invalid timings are refused', async () => {
  const h = controls();
  assert.deepEqual(await h.post({ turnId: h.inFlight, timings: { requestSent: 650 } }), { status: 202, data: { pending: true, turnId: h.inFlight } });
  assert.equal((await h.post({ turnId: h.inFlight, timings: { requestSent: 650 } }, 'another-session')).data.code, 'VOICE_TIMINGS_TURN_NOT_RECORDED');
  assert.equal((await h.post({ turnId: '55555555-5555-4555-8555-555555555555', timings: { requestSent: 650 } })).status, 404);
  for (const body of [{ turnId: 'short', timings: { requestSent: 650 } }, { turnId: h.recorded, timings: { requestSent: -5 } }, { turnId: h.recorded }, {}]) {
    const refused = await h.post(body);
    assert.equal(refused.status, 400); assert.equal(refused.data.code, 'VOICE_TIMINGS_INVALID');
  }
  assert.equal(h.updates.filter(row => row.filter.clientTurnId === h.recorded).length, 0, 'nothing is written for a refused request');
  assert.equal(h.routes['llmx:/llmx/sessions/:sessionId/voice-timings'], undefined, 'the LLMx consumer has no voice timings route');
});


test('terminal playback and interruption update an already received scheduling snapshot in order', async () => {
  const gate = deferred(), sent = [];
  const timeline = new VoiceTimeline(() => 100);
  timeline.mark('requestSent'); timeline.mark('firstSignalScheduled');
  const send = async values => { sent.push(values); if (sent.length === 1) await gate.promise; return {}; };
  const first = timeline.report(send); await tick();
  timeline.finish('completed'); const completed = timeline.report(send);
  assert.equal(sent.length, 1, 'terminal receipt cannot overtake the older write');
  gate.resolve(); await Promise.all([first, completed]);
  assert.equal(sent.length, 2); assert.equal(sent[0].playbackOutcome, undefined);
  assert.equal(sent[1].playbackOutcome, 'completed');
  await timeline.report(send, () => true);
  assert.equal(sent[2].interrupted, true);
  assert.deepEqual(normalizeVoiceTimings(sent[2]), sent[2]);
  await timeline.report(send, () => true); assert.equal(sent.length, 3, 'identical snapshots are not repeated');
  assert.equal(normalizeVoiceTimings({ requestSent: 0, playbackOutcome: 'invented' }).playbackOutcome, undefined);
});
