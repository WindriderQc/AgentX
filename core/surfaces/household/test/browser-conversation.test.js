'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Endpoint, EchoGuard, wav, Conversation, WakeWindow, isTranscriptHallucination, isSpokenEcho, holdingPhrase } = require('../public/browser-conversation');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nextTimer = () => new Promise((resolve) => setTimeout(resolve, 10));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };

function harness(overrides = {}) {
  const calls = [], messages = [], phases = [];
  let utterance, speech, listening = {};
  const audio = {
    listen(callback, onSpeech, options = {}) { calls.push('listen'); utterance = callback; speech = onSpeech; listening = options; },
    holdPlayback() { calls.push('holdPlayback'); }, resumePlayback() { calls.push('resumePlayback'); },
    quiet() { calls.push('quiet'); }, close() { calls.push('close'); },
    async play() { calls.push('play'); }
  };
  const io = {
    wakeAckDelayMs: 0, holdingDelayMs: null,
    async openAudio() { return audio; },
    async createSession(selection) { calls.push(selection); return { sessionId: 'private-1' }; },
    async transcribe() { return 'Bonjour'; },
    async turn(session) { calls.push(session.sessionId); return { text: 'Salut', language: 'fr' }; },
    async synthesize() { return new ArrayBuffer(10); },
    message(role, text) { messages.push({ role, text }); }, ...overrides
  };
  const conversation = new Conversation(io, (state) => phases.push(state));
  return { conversation, audio, calls, messages, phases, beginSpeech: () => speech(), say: capture => utterance(new Blob(['sample']), capture),
    pause: id => listening.onEarly?.(new Blob(['so far']), { id }), resume: id => listening.onEarlyCancel?.(id),
    // The sound over a reply has gone on: what was heard so far is recognized.
    probe: () => listening.onProbe?.(new Blob(['so far'])) };
}

for (const wakeWord of [false, true]) {
  for (const phrase of ['Stop, stop, stop.', 'Nestor silence', 'Arrête.', 'Silence Nestor.']) {
    test(`a spoken ${phrase} is silent without a pending reply, wake ${wakeWord}`, async () => {
      let turns = 0, syntheses = 0;
      const h = harness({ transcribe: async () => phrase,
        turn: async () => { turns++; return { text: 'Unwanted reply.' }; },
        synthesize: async () => { syntheses++; return new ArrayBuffer(10); } });
      await h.conversation.start({ wakeWord, language: 'fr' });
      await h.say();
      assert.equal(turns, 0); assert.equal(syntheses, 0);
      assert.deepEqual(h.messages, []);
      assert.equal(h.conversation.state, 'listening');
      assert.equal(h.conversation.session.sessionId, 'private-1');
      h.conversation.stop();
    });
  }
}

test('streamed enumeration markers never become isolated speech clauses', async () => {
  const spoken = [];
  const h = harness({
    turn: async (_session, _text, _signal, delta) => {
      for (const chunk of ['1. ', 'Prépare trois billets.\n', '2. ', 'Garde deux dollars. ']) { delta(chunk); await tick(); }
      return { text: '1. Prépare trois billets.\n2. Garde deux dollars.' };
    },
    synthesize: async reply => { spoken.push(reply.text); return new ArrayBuffer(10); }
  });
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.deepEqual(spoken, ['Prépare trois billets.', 'Garde deux dollars.']);
  h.conversation.stop();
});

test('an acoustic stop control with empty text cannot start a user turn or speech', async () => {
  let turns = 0, syntheses = 0;
  const h = harness({ transcribe: async () => ({ text: '', control: 'stop', model: 'vosk-command' }),
    turn: async () => { turns++; return { text: 'Unwanted.' }; },
    synthesize: async () => { syntheses++; return new ArrayBuffer(10); } });
  await h.conversation.start({ wakeWord: true }); await h.say();
  assert.equal(turns, 0); assert.equal(syntheses, 0);
  assert.deepEqual(h.messages, []);
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('an acoustic stop settles pending inference without resuming its arriving answer', async () => {
  const reply = deferred(), ack = deferred(); let transcriptions = 0, turns = 0, spoken = 0;
  const h = harness({ transcribe: async () => ++transcriptions === 1 ? 'Bonjour' : { text: '', control: 'stop' },
    turn: async () => { turns++; return reply.promise; }, interrupt: () => ack.promise,
    synthesize: async () => { spoken++; return new ArrayBuffer(10); } });
  h.audio.canInterrupt = true;
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech(); const control = h.say(); await tick();
  reply.resolve({ text: 'Late answer.' }); await tick();
  assert.equal(h.conversation.state, 'waiting');
  assert.equal(turns, 1); assert.equal(spoken, 0);
  ack.resolve({}); await Promise.all([control, first]);
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.conversation.session.sessionId, 'private-1');
  h.conversation.stop();
});

test('ordinary short corrections and English speech keep their original transcript', async () => {
  const submitted = [];
  for (const text of ['Orion.', "Let's go.", 'Numéro 6', 'Stop, explique le budget.']) {
    const h = harness({ transcribe: async () => ({ text, control: null }),
      turn: async (_session, value) => { submitted.push(value); return { text: 'Compris.' }; } });
    await h.conversation.start({}); await h.say(); h.conversation.stop();
  }
  assert.deepEqual(submitted, ['Orion.', "Let's go.", 'Numéro 6', 'Stop, explique le budget.']);
});

for (const kind of ['empty', 'hallucinated', 'digit', 'failed', 'echo']) {
  test(`a ${kind} noise candidate during playback resumes the same response without cancelling history`, async () => {
    const playing = deferred(); let transcriptions = 0, turns = 0, syntheses = 0;
    const h = harness({ transcribe: async () => {
      if (++transcriptions === 1) return 'Bonjour';
      if (kind === 'failed') throw new Error('STT unavailable');
      if (kind === 'echo') return 'Réponse à terminer';
      return kind === 'empty' ? '' : kind === 'digit' ? '6.' : 'Thanks for watching.';
    }, turn: async () => { turns++; return { text: 'Une réponse à terminer.' }; },
    synthesize: async () => { syntheses++; return new ArrayBuffer(10); },
    interrupt: () => assert.fail('noise must not cancel playback or native history') });
    h.audio.canInterrupt = true; h.audio.play = () => playing.promise;
    await h.conversation.start({}); const first = h.say(); await tick();
    h.beginSpeech(); await h.probe();
    await h.say();
    assert.ok(!h.calls.includes('holdPlayback'), 'a sound without words never pauses the reply');
    assert.equal(h.conversation.state, 'speaking');
    assert.equal(turns, 1); assert.equal(syntheses, 1);
    playing.resolve(); await first;
    assert.equal(h.conversation.state, 'listening');
    assert.equal(h.conversation.session.sessionId, 'private-1');
    assert.equal(h.messages.filter(row => row.role === 'assistant').length, 1);
    h.conversation.stop();
  });
}

test('transcribed speech during inference interrupts the exact pending turn and resumes the same session', async () => {
  const firstReply = deferred(), interrupted = deferred();
  const turns = [], interrupts = [];
  const h = harness({
    async turn(session, text, signal, delta, metadata) {
      turns.push({ session: session.sessionId, id: metadata.turnId });
      if (turns.length === 1) return firstReply.promise;
      return { text: 'Je prends ta correction.', language: 'fr' };
    },
    async interrupt(session, id) { interrupts.push({ session: session.sessionId, id }); await interrupted.promise; }
  });
  h.audio.canInterrupt = true;
  await h.conversation.start({ language: 'fr', interruption: true });
  const first = h.say(); await tick();
  assert.equal(h.conversation.state, 'thinking');
  h.beginSpeech(); await tick();
  assert.equal(interrupts.length, 0, 'an energy onset alone must not cancel inference');
  assert.equal(h.calls.includes('play'), false);
  const next = h.say(); await tick(); assert.equal(turns.length, 1);
  assert.equal(interrupts[0].id, turns[0].id);
  interrupted.resolve(); firstReply.resolve({ text: 'Old answer', language: 'fr' });
  await Promise.all([first, next]);
  assert.equal(turns.length, 2); assert.equal(turns[0].session, turns[1].session);
  assert.equal(h.messages.some(message => message.text === 'Old answer'), false);
  assert.equal(h.conversation.state, 'listening'); h.conversation.stop();
});

for (const capture of ['empty', 'failed']) {
  test(`a ${capture} transcription during inference preserves and plays the arriving answer`, async () => {
    const reply = deferred(), transcription = deferred();
    let count = 0, delta, turns = 0;
    const h = harness({
      async transcribe() {
        if (++count === 1) return 'Bonjour';
        await transcription.promise;
        if (capture === 'failed') throw new Error('STT unavailable');
        return '   ';
      },
      turn(_session, _text, _signal, onDelta) { turns++; delta = onDelta; return reply.promise; },
      interrupt: () => assert.fail('noise must not cancel the pending answer')
    });
    h.audio.canInterrupt = true;
    await h.conversation.start({ language: 'fr' });
    const first = h.say(); await tick();
    h.beginSpeech(); const noise = h.say(); await tick();
    delta('Voici une réponse complète qui doit être entendue.');
    reply.resolve({ text: 'Voici une réponse complète qui doit être entendue.', language: 'fr' });
    await tick();
    assert.equal(h.calls.includes('play'), false, 'hold speech while checking the captured sound');
    transcription.resolve();
    await Promise.all([first, noise]);
    assert.equal(turns, 1);
    assert.equal(h.messages.filter(row => row.role === 'assistant').length, 1);
    assert.equal(h.calls.filter(call => call === 'play').length, 1);
    assert.equal(h.conversation.state, 'listening');
    assert.equal(h.conversation.session.sessionId, 'private-1');
    h.conversation.stop();
  });
}

test('a real correction suppresses an answer that finishes during transcription', async () => {
  const reply = deferred(), transcription = deferred();
  let count = 0, turns = 0, cancelled = 0;
  const h = harness({
    async transcribe() { return ++count === 1 ? 'Bonjour' : transcription.promise; },
    turn() { return ++turns === 1 ? reply.promise : Promise.resolve({ text: 'Ta correction est reçue.' }); },
    async interrupt() { cancelled++; }
  });
  h.audio.canInterrupt = true;
  await h.conversation.start({ language: 'fr' });
  const first = h.say(); await tick();
  h.beginSpeech(); const next = h.say();
  reply.resolve({ text: 'Old answer' }); await tick();
  assert.equal(h.calls.includes('play'), false);
  transcription.resolve('Je corrige ma question.');
  await Promise.all([first, next]);
  assert.equal(cancelled, 1); assert.equal(turns, 2);
  assert.deepEqual(h.messages.filter(row => row.role === 'assistant'), [{ role: 'assistant', text: 'Ta correction est reçue.' }]);
  assert.equal(h.conversation.state, 'listening'); h.conversation.stop();
});

test('ending during an unconfirmed onset releases the held answer without playing it', async () => {
  const reply = deferred();
  const h = harness({ turn: () => reply.promise, interrupt: () => assert.fail('not a confirmed interruption') });
  h.audio.canInterrupt = true;
  await h.conversation.start({ language: 'fr' });
  const first = h.say(); await tick(); h.beginSpeech();
  reply.resolve({ text: 'Old answer' }); await tick();
  h.conversation.stop(); await first;
  assert.equal(h.calls.includes('play'), false);
  assert.equal(h.conversation.state, 'idle');
});

test('wake accepts only an addressed prefix, bounded follow-ups, and explicit sleep', () => {
  let now = 1000;
  const wake = new WakeWindow(() => now);
  assert.equal(wake.accept('On parle de Nestor dans la cuisine.').text, '');
  assert.equal(wake.accept('Hey Nestor, pourquoi le ciel est bleu ?').text, 'pourquoi le ciel est bleu ?');
  assert.equal(wake.accept('Et les nuages ?').text, 'Et les nuages ?');
  now += 30001;
  assert.equal(wake.accept('Une discussion ambiante.').text, '');
  assert.equal(wake.accept('Eille Nestor !').activated, true);
  // What speech-to-text actually writes for « Eille Nestor ».
  for (const heard of ['Hé Nestor, bonjour', 'Et Nestor, bonjour', 'Elle Nestor, bonjour', 'Aye, Nestor bonjour', 'Hey Nester bonjour', 'Hey, Nesta, bonjour', 'Hé Nesto bonjour', 'Einestor bonjour', 'Eille,Nestor bonjour', 'Heille Nestor bonjour']) {
    now += 31000;
    assert.deepEqual(wake.accept(heard), { text: 'bonjour', activated: true }, heard);
  }
  now += 31000;
  assert.equal(wake.accept('Elle parle de Nestor.').activated, false);
  assert.equal(wake.accept('Et puis Nestor est parti.').activated, false);
  assert.equal(wake.accept('Merci Nestor.').text, '');
  assert.equal(wake.active(), false);
});

test('wake standby never sends ambient speech to the agent or transcript', async () => {
  let phrase = 'La télévision parle dans la pièce.', modelCalls = 0;
  const h = harness({ transcribe: async () => phrase, turn: async () => { modelCalls++; return { text: 'Bonjour.' }; } });
  await h.conversation.start({ wakeWord: true, language: 'fr' });
  await h.say();
  assert.equal(modelCalls, 0); assert.deepEqual(h.messages, []);
  phrase = 'Hey Nestor'; await h.say(); await nextTimer();
  assert.equal(modelCalls, 0); assert.deepEqual(h.messages, []);
  assert.ok(h.calls.includes('play'), 'a bare wake gets a spoken acknowledgement without fabricating an agent turn');
  phrase = 'Comment vas-tu ?'; h.beginSpeech(); await h.say();
  assert.equal(modelCalls, 1); assert.equal(h.messages[0].text, phrase);
  phrase = 'Merci Nestor'; h.beginSpeech(); await h.say();
  assert.equal(modelCalls, 1);
  phrase = 'Encore une discussion ambiante'; h.beginSpeech(); await h.say();
  assert.equal(modelCalls, 1);
  h.conversation.stop();
});

test('a wake and command in one phrase skips acknowledgement and starts the turn immediately', async () => {
  let acknowledgements = 0, turns = 0;
  const h = harness({ transcribe: async () => 'Eille Nestor dis bonjour',
    wakeReply: () => { acknowledgements++; return { text: 'Oui ?' }; },
    turn: async (_session, text) => { turns++; assert.equal(text, 'dis bonjour'); return { text: 'Bonjour !' }; } });
  await h.conversation.start({ wakeWord: true, language: 'fr' });
  h.beginSpeech(); await h.say(); await nextTimer();
  assert.equal(turns, 1);
  assert.equal(acknowledgements, 0);
  assert.deepEqual(h.messages[0], { role: 'user', text: 'dis bonjour' });
  h.conversation.stop();
});

test('speech after a bare wake interrupts the acknowledgement before it masks the command', async () => {
  const voice = deferred();
  let phrase = 'Hey Nestor', turns = 0;
  const h = harness({ transcribe: async () => phrase, wakeReply: () => ({ text: 'Oui ?' }),
    synthesize: reply => reply.text === 'Oui ?' ? voice.promise : Promise.resolve(new ArrayBuffer(10)),
    turn: async (_session, text) => { turns++; assert.equal(text, 'dis bonjour'); return { text: 'Bonjour !' }; } });
  await h.conversation.start({ wakeWord: true, language: 'fr' });
  h.beginSpeech(); await h.say(); await nextTimer();
  assert.equal(h.conversation.state, 'listening', 'the microphone remains live during acknowledgement synthesis');
  phrase = 'dis bonjour'; h.beginSpeech(); await h.say();
  voice.resolve(new ArrayBuffer(10)); await tick();
  assert.equal(turns, 1);
  assert.equal(h.calls.filter(call => call === 'play').length, 1, 'only the answer is spoken');
  h.conversation.stop();
});

test('a command spoken over the wake acknowledgement stops that playback', async () => {
  let phrase = 'Hey Nestor', plays = 0, turns = 0;
  const h = harness({ transcribe: async () => phrase,
    turn: async (_session, text) => { turns++; assert.equal(text, 'dis bonjour'); return { text: 'Bonjour !' }; } });
  h.audio.play = (_bytes, signal) => {
    plays++;
    return plays === 1 ? new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) : Promise.resolve();
  };
  await h.conversation.start({ wakeWord: true, language: 'fr' });
  h.beginSpeech(); await h.say(); await nextTimer();
  assert.equal(h.conversation.state, 'speaking');
  phrase = 'dis bonjour'; h.beginSpeech(); await h.say();
  assert.equal(turns, 1);
  assert.equal(plays, 2, 'the command answer plays after the cancelled acknowledgement');
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('wake follow-up starts after playback and expires before the next ambient phrase', async () => {
  let now = 1000, phrase = 'Hey Nestor, bonjour.', turns = 0;
  const h = harness({ now: () => now, transcribe: async () => phrase,
    turn: async () => { turns++; now += 50000; return { text: 'Bonjour.' }; } });
  h.audio.play = async () => { now += 10000; };
  await h.conversation.start({ wakeWord: true });
  h.beginSpeech(); await h.say();
  assert.equal(turns, 1);
  now += 29999;
  assert.equal(h.conversation.wake.active(), true, 'the full window follows the completed reply');
  now += 2;
  phrase = 'La télévision parle encore.'; h.beginSpeech(); await h.say();
  assert.equal(turns, 1); assert.equal(h.messages.length, 2);
  h.conversation.stop();
  await h.conversation.start({ wakeWord: false });
  h.beginSpeech(); await h.say();
  assert.equal(turns, 2, 'open listening accepts speech without the name');
  h.conversation.stop();
});

test('enabling wake during open listening immediately filters ambient speech without replacing the session', async () => {
  let phrase = 'Une conversation autour de moi.', turns = 0;
  const h = harness({ transcribe: async () => phrase, turn: async () => { turns++; return { text: 'Bonjour.' }; } });
  await h.conversation.start({ wakeWord: false });
  const session = h.conversation.session;
  assert.equal(h.conversation.setWakeWord(true), true);
  h.beginSpeech(); await h.say();
  assert.equal(turns, 0); assert.equal(h.conversation.state, 'listening');
  phrase = 'Hey Nestor, bonjour.'; h.beginSpeech(); await h.say();
  assert.equal(turns, 1);
  assert.equal(h.conversation.setWakeWord(true), true, 'checking wake re-arms immediately rather than keeping a previous follow-up window');
  phrase = 'Encore une conversation ambiante.'; h.beginSpeech(); await h.say();
  assert.equal(turns, 1);
  h.conversation.setWakeWord(false); h.beginSpeech(); await h.say();
  assert.equal(turns, 2); assert.equal(h.conversation.session, session);
  h.conversation.stop();
});

test('endpoint ignores silence and clicks, preserves lead-in and ends after a pause', async () => {
  const endpoint = new Endpoint(1000, 160, 1000);
  for (let i = 0; i < 300; i++) assert.equal(endpoint.push(new Float32Array(100)), null);
  assert.ok(endpoint.preSamples <= 350);
  endpoint.push(new Float32Array(100).fill(0.5));
  endpoint.push(new Float32Array(100));
  assert.equal(endpoint.speaking, false);
  endpoint.push(new Float32Array(100).fill(0.1));
  endpoint.push(new Float32Array(100).fill(0.1));
  assert.equal(endpoint.speaking, true);
  for (let i = 0; i < 9; i++) assert.equal(endpoint.push(new Float32Array(100)), null);
  const samples = endpoint.push(new Float32Array(100));
  assert.equal(samples.length, 1300);
  assert.equal(endpoint.speaking, false);
  const bytes = new DataView(await wav(samples, 1000).arrayBuffer());
  assert.equal(bytes.getUint32(24, true), 1000);
  assert.equal(bytes.getUint32(40, true), samples.length * 2);
});

test('a spoken hesitation does not end the turn; one second of silence does', () => {
  const endpoint = new Endpoint(1000);
  const speak = ms => { for (let i = 0; i < ms / 100; i++) assert.equal(endpoint.push(new Float32Array(100).fill(0.1)), null); };
  speak(500);
  for (let i = 0; i < 8; i++) assert.equal(endpoint.push(new Float32Array(100)), null, 'an 800 ms hesitation keeps listening');
  speak(500);
  for (let i = 0; i < 9; i++) assert.equal(endpoint.push(new Float32Array(100)), null);
  assert.ok(endpoint.push(new Float32Array(100)).length > 0, 'one second of silence ends the turn');
});

test('a half-second pause offers what was said so far, and says whether it ended the turn', () => {
  const endpoint = new Endpoint(1000);
  endpoint.earlySilenceMs = 500;
  const voice = ms => { for (let i = 0; i < ms / 100; i++) assert.equal(endpoint.push(new Float32Array(100).fill(0.1)), null); };
  const quiet = ms => { let last = null; for (let i = 0; i < ms / 100; i++) last = endpoint.push(new Float32Array(100)); return last; };
  voice(500);
  assert.equal(quiet(400), null);
  assert.deepEqual(endpoint.drain(), [], 'nothing before half a second of silence');
  quiet(100);
  const [first] = endpoint.drain();
  assert.equal(first.type, 'early'); assert.equal(first.samples.length, 1000);
  quiet(300);
  assert.deepEqual(endpoint.drain(), [], 'one offer per pause');
  voice(300); // the person goes on: that offer no longer stands
  assert.deepEqual(endpoint.drain(), [{ type: 'resumed', id: first.id }]);
  quiet(500);
  const [second] = endpoint.drain();
  assert.equal(second.type, 'early'); assert.notEqual(second.id, first.id);
  assert.equal(second.samples.length, 2100);
  const utterance = quiet(500);
  assert.equal(utterance.length, 2600);
  assert.equal(endpoint.completedEarlyId, second.id, 'the pause that ended the turn names its offer');
  assert.deepEqual(Array.from(utterance.subarray(0, 2100)), Array.from(second.samples), 'the turn is that offer plus silence');
});

test('no early offer without the setting, in an interruption, or when sound runs to the cap', () => {
  const plain = new Endpoint(1000);
  for (let i = 0; i < 5; i++) plain.push(new Float32Array(100).fill(0.1));
  for (let i = 0; i < 9; i++) plain.push(new Float32Array(100));
  assert.deepEqual(plain.drain(), []);
  assert.ok(plain.push(new Float32Array(100)).length > 0);
  assert.equal(plain.completedEarlyId, null);
  const interruption = new Endpoint(1000, 100, 250);
  interruption.earlySilenceMs = 500;
  for (let i = 0; i < 5; i++) interruption.push(new Float32Array(100).fill(0.1));
  for (let i = 0; i < 2; i++) interruption.push(new Float32Array(100));
  assert.ok(interruption.push(new Float32Array(100)).length > 0);
  assert.deepEqual(interruption.drain(), []);
});

test('a long utterance ends at the pause and retains its words across twenty seconds', () => {
  const endpoint = new Endpoint(1000);
  for (let i = 0; i < 450; i++) assert.equal(endpoint.push(new Float32Array(100).fill(i < 200 ? 0.1 : 0.2)), null);
  assert.equal(endpoint.speaking, true);
  for (let i = 0; i < 9; i++) assert.equal(endpoint.push(new Float32Array(100)), null);
  const result = endpoint.push(new Float32Array(100));
  assert.equal(result.length, 46000);
  assert.ok(result[0] > 0.09 && result[19999] > 0.09);
  assert.ok(result[20000] > 0.19 && result[44999] > 0.19);
});

test('the upload ceiling fails explicitly instead of submitting a partial turn', () => {
  const { MAX_CAPTURE_BYTES } = require('../public/browser-conversation');
  assert.ok(MAX_CAPTURE_BYTES + 65536 <= 32 * 1024 * 1024);
  const endpoint = new Endpoint(1000);
  endpoint.maxSamples = 1000;
  for (let i = 0; i < 10; i++) assert.equal(endpoint.push(new Float32Array(100).fill(0.1)), null);
  assert.throws(() => endpoint.push(new Float32Array(100).fill(0.1)), /Aucun message partiel/);
  assert.equal(endpoint.total, 1000);
});

test('a recognized URL remains legitimate conversation content, including when it stands alone', async () => {
  const heard = [];
  for (const text of ['www.youtube.com', 'https://www.youtube.com.', 'YouTube.com', 'Ouvre www.youtube.com pour moi.']) {
    const h = harness({ transcribe: async () => ({ text, detectedLanguage: 'en' }),
      turn: async (_session, value) => { heard.push(value); return { text: 'Compris.' }; } });
    await h.conversation.start({ language: 'auto' }); await h.say(); h.conversation.stop();
  }
  assert.deepEqual(heard, ['www.youtube.com', 'https://www.youtube.com.', 'YouTube.com', 'Ouvre www.youtube.com pour moi.']);
});

test('automatic reply speech follows the answer despite an incorrect STT language, then stays stable', async () => {
  for (const [heard, chunks, expected] of [
    [{ text: 'Explique les nuages.', detectedLanguage: 'en' },
      ['Les nuages contiennent des gouttelettes d’eau. ', 'The title is just a label. ', 'Elles restent dans le ciel. '], 'fr'],
    [{ text: 'Can you help me?', detectedLanguage: 'fr' },
      ['Here is the answer you asked for. ', 'Voilà le titre en français. '], 'en']
  ]) {
    const spoken = [];
    const h = harness({ transcribe: async () => heard,
      turn: async (_session, _text, _signal, delta) => { for (const text of chunks) delta(text); return { text: chunks.join('') }; },
      synthesize: async reply => { spoken.push(reply.language); return new ArrayBuffer(4); } });
    await h.conversation.start({ language: 'auto' }); await h.say(); h.conversation.stop();
    assert.ok(spoken.length >= 2);
    assert.ok(spoken.every(language => language === expected));
  }
});

test('two automatic turns use one selected private session and wait for playback', async () => {
  const h = harness();
  const playing = deferred();
  h.audio.play = () => playing.promise;
  const selection = { personaId: 'companion', modeId: 'open', language: 'fr' };
  await h.conversation.start(selection);
  const first = h.say(); await tick();
  assert.equal(h.conversation.state, 'speaking');
  assert.equal(h.calls.filter((c) => c === 'listen').length, 1);
  playing.resolve(); await first;
  await h.say();
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.calls.filter((c) => c === 'private-1').length, 2);
  assert.deepEqual(h.calls.find((c) => typeof c === 'object'), selection);
  assert.equal(h.messages.length, 4);
});

test('stop during permission request closes a late microphone and creates no session', async () => {
  const opened = deferred(); const h = harness({ openAudio: () => opened.promise });
  const pending = h.conversation.start({});
  h.conversation.stop(); opened.resolve(h.audio); await pending;
  assert.deepEqual(h.calls, ['close']);
  assert.equal(h.conversation.state, 'idle');
});

test('late session creation cannot overwrite a newly started session', async () => {
  const first = deferred(); let count = 0;
  const h = harness({ createSession: () => ++count === 1 ? first.promise : Promise.resolve({ sessionId: 'new' }) });
  const old = h.conversation.start({}); await tick();
  h.conversation.stop(); await h.conversation.start({});
  first.resolve({ sessionId: 'old' }); await old;
  assert.equal(h.conversation.session.sessionId, 'new');
});

for (const phase of ['transcribe', 'turn', 'synthesize']) {
  test(`stop suppresses late ${phase} results and releases capture`, async () => {
    const pending = deferred(); const h = harness({ [phase]: () => pending.promise });
    await h.conversation.start({}); const exchange = h.say(); await tick();
    h.conversation.stop();
    const count = h.messages.length;
    pending.resolve(phase === 'transcribe' ? 'late' : phase === 'turn' ? { text: 'late' } : new ArrayBuffer(4));
    await exchange;
    assert.equal(h.conversation.state, 'idle');
    assert.equal(h.messages.length, count);
    assert.equal(h.calls.includes('play'), false);
    assert.equal(h.calls.filter((c) => c === 'listen').length, 1);
    assert.ok(h.calls.includes('close'));
  });
}

test('pausing keeps the conversation, even during inference; only an explicit end forgets it', async () => {
  const pending = deferred(); const h = harness({ turn: () => pending.promise });
  await h.conversation.start({}); h.conversation.stop(true);
  assert.equal(h.conversation.session.sessionId, 'private-1');
  // A subsequent visibilitychange must not discard an already paused session.
  h.conversation.stop(true);
  assert.equal(h.conversation.session.sessionId, 'private-1');
  await h.conversation.start({}); const exchange = h.say(); await tick();
  h.conversation.stop(true);
  assert.equal(h.conversation.session.sessionId, 'private-1', 'a screen lock mid-turn must not open an empty conversation');
  pending.resolve({ text: 'late' }); await exchange;
  assert.equal(h.conversation.state, 'paused');
  h.conversation.stop();
  assert.equal(h.conversation.session, null, 'an explicit end forgets the session');
});

test('transcription failure ends capture without a silent retry loop', async () => {
  const h = harness({ transcribe: async () => { throw new Error('STT offline'); } });
  await h.conversation.start({}); await h.say();
  assert.equal(h.conversation.state, 'error');
  assert.ok(h.calls.includes('close'));
  assert.equal(h.messages.length, 0);
});


test('streamed speech starts before inference ends and a paused partial turn is never spoken later', async () => {
  const pending = deferred(); let onDelta;
  const h = harness({ turn: async (_session, _text, _signal, delta) => { onDelta = delta; await pending.promise; return { text: 'Complete reply.' }; } });
  await h.conversation.start({ language: 'en' });
  const exchanging = h.say(); await tick();
  onDelta('Here is the first complete sentence, spoken before the next one. ');
  await tick();
  assert.ok(h.calls.includes('play'));
  assert.equal(h.conversation.turnPending, true);
  h.conversation.stop(true);
  assert.equal(h.conversation.session.sessionId, 'private-1');
  const plays = h.calls.filter(c => c === 'play').length;
  onDelta('A late sentence must never be spoken.'); pending.resolve(); await exchanging;
  assert.equal(h.calls.filter(c => c === 'play').length, plays);
  assert.equal(h.conversation.state, 'paused');
});

test('a short opening starts playback while inference is still pending, without duplicating the final reply', async () => {
  const generated = deferred(), spoken = [];
  let delta;
  const text = 'Salut ! On commence par une petite aventure ?';
  const h = harness({
    turn(_session, _text, _signal, onDelta) { delta = onDelta; return generated.promise; },
    async synthesize(reply) { spoken.push(reply); return new ArrayBuffer(4); }
  });
  await h.conversation.start({ language: 'fr-en' });
  const exchange = h.say(); await tick();
  delta('Salut ! '); await tick();
  assert.deepEqual(spoken, [{ text: 'Salut !', language: 'fr' }]);
  assert.ok(h.calls.includes('play'));
  assert.equal(h.conversation.turnPending, true);
  delta('On commence par une petite aventure ?');
  generated.resolve({ text, language: 'fr' }); await exchange;
  assert.equal(spoken.map(row => row.text).join(' '), text);
  assert.deepEqual(h.messages.at(-1), { role: 'assistant', text });
  h.conversation.stop();
});

for (const [input, opening, language] of [
  ['Bonjour, on peut discuter ?', "D’accord.", 'fr'],
  ['Hello, can we talk?', 'Sure.', 'en']
]) {
  test(`an ambiguous short opening inherits ${language} from the transcript in automatic language mode`, async () => {
    const generated = deferred(), spoken = [];
    let delta;
    const h = harness({
      transcribe: async () => input,
      turn(_session, _text, _signal, onDelta) { delta = onDelta; return generated.promise; },
      async synthesize(reply) { spoken.push(reply); return new ArrayBuffer(4); }
    });
    await h.conversation.start({ language: 'fr-en' });
    const exchange = h.say(); await tick();
    delta(opening + ' '); await tick();
    assert.deepEqual(spoken, [{ text: opening, language }]);
    assert.ok(h.calls.includes('play'));
    assert.equal(h.conversation.turnPending, true);
    generated.resolve({ text: opening }); await exchange;
    assert.equal(spoken.length, 1);
    h.conversation.stop();
  });
}

test('one model delta drains every ready clause with only one audio prefetch', async () => {
  const generated = deferred(), spoken = [], plays = [];
  let delta;
  const clauses = ['Oui !', 'Voici une première explication assez longue.', 'Voici une seconde explication assez longue.'];
  const h = harness({
    turn(_session, _text, _signal, onDelta) { delta = onDelta; return generated.promise; },
    async synthesize(reply) { spoken.push(reply.text); return reply.text; }
  });
  h.audio.play = (text, signal) => {
    const playing = deferred(); plays.push({ text, ...playing });
    signal.addEventListener('abort', playing.resolve, { once: true });
    return playing.promise;
  };
  await h.conversation.start({ language: 'fr' });
  const exchange = h.say(); await tick();
  delta(clauses.join(' ') + ' '); await tick();
  assert.deepEqual(spoken, clauses.slice(0, 2));
  assert.equal(plays.length, 1);
  plays[0].resolve(); await tick();
  assert.deepEqual(spoken, clauses);
  assert.equal(plays.length, 2);
  assert.equal(h.conversation.turnPending, true, 'ready clauses do not wait for another delta or completion');
  h.conversation.stop(); generated.resolve({ text: clauses.join(' ') }); await exchange;
  assert.equal(plays.length, 2, 'End still discards the prefetched clause');
});

test('a franglais reply keeps one voice: the turn language holds for every clause', async () => {
  const spoken = [];
  const chunks = ['Salut Alex. Je vais bien, merci. Tout est prêt. ', 'service-host inference-host inference-secondary 11434 8192. ',
    'The hosts are ready and the models are loaded. ', 'OK.'];
  const h = harness({
    async turn(_session, _text, _signal, delta) { for (const chunk of chunks) { delta(chunk); await tick(); } return {text:chunks.join(''),language:'fr'}; },
    async synthesize(reply) { spoken.push(reply); return new ArrayBuffer(10); }
  });
  await h.conversation.start({language:'fr-en'}); await h.say();
  assert.deepEqual(spoken.map(reply=>reply.language), ['fr','fr','fr','fr','fr']);
  assert.equal(spoken.map(reply=>reply.text).join(' '),chunks.join(''));
});

test('a chosen language is the voice of the whole turn, whatever was recognized or answered', async () => {
  const english = ['Sure, the hosts are ready. ', 'The models are loaded and they answer. ', 'OK.'];
  const french = 'Salut ! Tout est prêt pour toi.';
  for (const [selection, heard, turn, expected] of [
    // French chosen: an English-sounding request and an English streamed reply stay in the French voice.
    ['fr', { text: 'Can you check the hosts?', detectedLanguage: 'en' },
      async (_session, _text, _signal, delta) => { for (const chunk of english) { delta(chunk); await tick(); } return { text: english.join(''), language: 'en' }; }, 'fr'],
    // English chosen: an unstreamed French reply that names its own language does not switch the voice.
    ['en', 'Bonjour Nestor', async () => ({ text: french, language: 'fr' }), 'en'],
    // Automatic: the unstreamed reply still names the voice.
    ['fr-en', 'Bonjour Nestor', async () => ({ text: 'Sure.', language: 'en' }), 'en']
  ]) {
    const spoken = [];
    const h = harness({ transcribe: async () => heard, turn, async synthesize(reply) { spoken.push(reply.language); return new ArrayBuffer(4); } });
    await h.conversation.start({ language: selection }); await h.say();
    assert.ok(spoken.length >= 1);
    assert.deepEqual([...new Set(spoken)], [expected], `${selection}: ${spoken}`);
    h.conversation.stop();
  }
});

test('a remark from the brain is spoken in the chosen language, else in its own words’ language', async () => {
  for (const [selection, remark, expected] of [
    ['en', { text: 'Petite correction : une araignée a huit pattes.' }, 'en'],
    ['fr-en', { text: 'Petite correction : une araignée a huit pattes.' }, 'fr'],
    ['fr-en', { text: 'The answer is that they have eight legs.' }, 'en'],
    ['fr-en', { text: 'OK', language: 'en' }, 'en'],
    ['fr', { text: 'The answer is that they have eight legs.', language: 'en' }, 'fr']
  ]) {
    const spoken = [];
    const h = harness({ async synthesize(reply) { spoken.push(reply); return new ArrayBuffer(4); } });
    await h.conversation.start({ wakeWord: false, language: selection });
    assert.equal(await h.conversation.interject(remark), true);
    assert.deepEqual(spoken, [{ ...remark, language: expected }]);
    h.conversation.stop();
  }
});

for (const streaming of [false, true]) {
  test(`speech omits decorations and keeps the original transcript (streaming=${streaming})`, async () => {
    const text = '🦉 **Tout va bien côté AgentX.** Les 138 documents sont disponibles. 🦉';
    const spoken = [];
    const h = harness({
      async turn(_session, _text, _signal, delta) {
        if (streaming) for (const char of text) delta(char);
        return { text, language: 'fr' };
      },
      async synthesize(reply) { spoken.push(reply); return new ArrayBuffer(10); }
    });
    await h.conversation.start({ language: 'fr' }); await h.say();
    assert.equal(spoken.map(reply => reply.text).join(' '), 'Tout va bien côté AgentX. Les 138 documents sont disponibles.');
    assert.ok(spoken.every(reply => reply.language === 'fr'));
    assert.deepEqual(h.messages.at(-1), { role: 'assistant', text });
    assert.equal(h.conversation.state, 'listening');
    h.conversation.stop();
  });
}

test('native MEDIA paths are silent while a structured recording plays after speech', async t => {
  const steps = [], text = 'Voici le son. MEDIA:/home/example/.openclaw/media/tool-speech-synthesis/voice---11111111-1111-4111-8111-111111111111.mp3';
  const sound = { id: 'elephant', url: '/assets/household/sounds/elephant.ogg', gain: 1 };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, sound.url);
    return { ok: true, arrayBuffer: async () => 'elephant' };
  });
  const h = harness({
    turn: async (_session, _text, _signal, delta) => { delta(text); return { text, sound, language: 'fr' }; },
    synthesize: async reply => { steps.push(reply.text); return 'speech'; }
  });
  h.audio.play = async bytes => steps.push(bytes);
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.deepEqual(steps, ['Voici le son.', 'speech', 'elephant']);
  assert.deepEqual(h.messages.at(-1), { role: 'assistant', text });
  h.conversation.stop();
});

test('an emoji-only reply is displayed without sending an empty synthesis request', async () => {
  let syntheses = 0;
  const h = harness({ turn: async () => ({ text: '🦉 👍🏽', language: 'fr' }),
    synthesize: async () => { syntheses++; } });
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.equal(syntheses, 0); assert.equal(h.calls.includes('play'), false);
  assert.deepEqual(h.messages.at(-1), { role: 'assistant', text: '🦉 👍🏽' });
  assert.equal(h.conversation.state, 'listening'); h.conversation.stop();
});

test('token-sized deltas never split native media paths into spoken fragments', async () => {
  const intro = 'Voici un enregistrement de cet animal. ';
  for (const reference of [
    'MEDIA:/home/example/.openclaw/media/tool-speech-synthesis/voice---11111111-1111-4111-8111-111111111111.mp3',
    'MEDIA:"/home/example/' + 'long folder '.repeat(30) + '/voice---uuid.mp3"'
  ]) {
    const text = intro + reference + ' Bonne écoute.';
    const spoken = [];
    const h = harness({
      async turn(_session, _text, _signal, delta) {
        for (const char of text) { delta(char); await tick(); }
        return { text, language: 'fr' };
      },
      async synthesize(reply) { spoken.push(reply.text); return new ArrayBuffer(10); }
    });
    await h.conversation.start({ language: 'fr' }); await h.say();
    assert.equal(spoken.join(' '), intro + 'Bonne écoute.');
    assert.deepEqual(h.messages.at(-1), { role: 'assistant', text });
    h.conversation.stop();
  }
});

test('speech prepares only the next clause while playback is active, preserving order and cancellation', async () => {
  const generated = deferred(), plays = [], synthesized = [];
  const chunks = ['Voici une première phrase assez longue pour être lue. ',
    'La deuxième phrase peut se préparer pendant la première. ',
    'La troisième attend une place dans la lecture. '];
  let onDelta;
  const h = harness({
    async turn(_session, _text, _signal, delta) { onDelta = delta; await generated.promise; return { text: chunks.join('') }; },
    async synthesize(reply, signal) { synthesized.push({ text: reply.text, signal }); return reply.text; }
  });
  h.audio.play = (text, signal) => {
    const playing = deferred(); plays.push({ text, ...playing });
    signal.addEventListener('abort', playing.resolve, { once: true });
    return playing.promise;
  };
  await h.conversation.start({ language: 'fr' });
  const exchange = h.say(); await tick();
  for (const chunk of chunks) onDelta(chunk);
  await tick();
  assert.deepEqual(synthesized.map(row => row.text), chunks.slice(0, 2).map(text => text.trim()));
  assert.deepEqual(plays.map(row => row.text), chunks.slice(0, 1).map(text => text.trim()));
  assert.equal(h.conversation.state, 'speaking', 'Preparing ahead must not replace the speaking state');
  plays[0].resolve(); await tick();
  assert.deepEqual(synthesized.map(row => row.text), chunks.map(text => text.trim()));
  assert.deepEqual(plays.map(row => row.text), chunks.slice(0, 2).map(text => text.trim()));
  h.conversation.stop(); generated.resolve(); await exchange;
  assert.equal(synthesized.every(row => row.signal.aborted), true);
  assert.equal(plays.length, 2, 'A prepared third clause must not play after End');
});

test('a prefetched synthesis failure finishes current playback then reports the failure without later audio', async () => {
  const playing = deferred(); let syntheses = 0, plays = 0;
  const h = harness({
    async turn(_session, _text, _signal, delta) {
      delta('Voici la première phrase suffisamment longue. ');
      delta('Voici la deuxième phrase suffisamment longue. ');
      return { text: 'Réponse complète.' };
    },
    async synthesize() { if (++syntheses === 2) throw new Error('TTS unavailable'); return new ArrayBuffer(4); }
  });
  h.audio.play = () => { plays++; return playing.promise; };
  await h.conversation.start({ language: 'fr' });
  const exchange = h.say(); await tick();
  assert.equal(syntheses, 2); assert.equal(plays, 1);
  playing.resolve(); await exchange;
  assert.equal(h.conversation.state, 'error'); assert.equal(plays, 1);
  assert.ok(h.calls.includes('close'));
});

test('an audio device failure closes the microphone and rejects late async work', async () => {
  let broken;
  const h = harness({ openAudio: async (_signal, onError) => { broken = onError; return h.audio; } });
  await h.conversation.start({});
  broken(new Error('Microphone disconnected'));
  assert.equal(h.conversation.state, 'error');
  assert.ok(h.calls.includes('close'));
});

test('interruption onset preserves speech across brief unvoiced consonants', () => {
  const endpoint = new Endpoint(1000, 180);
  for (const volume of [.1,.1,.1,0,0,.1,.1,.1,0,.1,.1,.1]) endpoint.push(new Float32Array(20).fill(volume));
  assert.equal(endpoint.speaking, true);
  assert.ok(endpoint.total <= 350, 'the first phonemes remain in the pre-roll');
});

test('delayed/scaled output echo is rejected while independent speech remains audible', () => {
  const guard = new EchoGuard(2000), frameSize = 80, delay = 120;
  let seed = 31;
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 4294967296 - .5) * .4; };
  const output = Float32Array.from({ length: 2000 }, noise);
  let echoes = 0, human = 0;
  for (let at = 0; at < 1600; at += frameSize) {
    const ref = output.slice(at, at + frameSize);
    const mic = Float32Array.from({ length: frameSize }, (_, i) => at + i < delay ? 0 : output[at + i - delay] * .3);
    if (guard.isEcho(mic, ref) && at >= delay) echoes++;
  }
  assert.equal(echoes, 18);
  for (let at = 0; at < 1600; at += frameSize) {
    if (!guard.isEcho(Float32Array.from({ length: frameSize }, noise), output.slice(at, at + frameSize))) human++;
  }
  assert.equal(human, 20);
  assert.ok(guard.history.length <= guard.limit + frameSize);
});

test('spoken interruption preserves a captured correction while Core drains longer than ten seconds', async t => {
  const ack = deferred(); let delta, turnCount = 0, speechStopped = 0, transcriptions = 0;
  const h = harness({
    async transcribe() { transcriptions++; return 'New spoken input'; },
    turn(_session, _text, signal, onDelta) {
      turnCount++;
      if (turnCount > 1) return Promise.resolve({ text: 'Second answer.' });
      delta = onDelta;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    },
    interrupt: () => ack.promise
  });
  h.audio.canInterrupt = true;
  h.audio.play = (_bytes, signal) => turnCount > 1 ? Promise.resolve() : new Promise(resolve => {
    signal.addEventListener('abort', () => { speechStopped++; resolve(); }, { once: true });
  });
  await h.conversation.start({ language: 'fr' });
  const first = h.say(); await tick();
  delta('Here is a sufficiently long first sentence. '); await tick();
  assert.equal(h.conversation.state, 'speaking');
  h.beginSpeech();
  assert.ok(!h.calls.includes('holdPlayback'), 'energy alone holds nothing');
  await h.probe();
  assert.equal(speechStopped, 0, 'words hold playback without irreversible cancellation');
  assert.ok(h.calls.includes('holdPlayback'));
  const second = h.say(); await tick();
  assert.equal(speechStopped, 1, 'confirmed speech cancels the previous playback');
  assert.equal(transcriptions, 3, 'recognized while it went on, then whole');
  assert.equal(turnCount, 1, 'no overlapping model call before server acknowledgement');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.timers.tick(11000);
  assert.equal(h.conversation.state, 'waiting');
  assert.equal(h.conversation.session.sessionId, 'private-1');
  assert.equal(h.calls.includes('close'), false);
  delta('This late content cannot be queued for speech.');
  ack.resolve(); await Promise.all([first, second]);
  assert.equal(turnCount, 2);
  assert.equal(h.conversation.session.sessionId, 'private-1');
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.calls.includes('close'), false);
  assert.deepEqual(h.messages.filter(m => m.role === 'assistant'), [{ role: 'assistant', text: 'Second answer.' }]);
  h.conversation.stop();
});

test('interruption after generation completes still marks the same session and cancels playback', async () => {
  let marked = 0, transcriptions = 0;
  const h = harness({ interrupt: async () => { marked++; },
    transcribe: async () => ++transcriptions === 1 ? 'Bonjour' : 'Stop' });
  h.audio.canInterrupt = true;
  h.audio.play = (_bytes, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  await h.conversation.start({}); const first = h.say(); await tick();
  assert.equal(h.conversation.turnPending, false);
  h.beginSpeech(); assert.equal(marked, 0);
  await Promise.all([h.say(), first]);
  assert.equal(marked, 1);
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.conversation.session.sessionId, 'private-1');
  h.conversation.stop();
});

for (const text of ['Stop, stop, stop.', 'Nestor, arrête de parler !', 'Arrête-toi.', 'Stop talking, Nestor.', { text: '', control: 'stop' }]) {
  test(`a confirmed stop-only interruption resumes listening without another model reply: ${text}`, async () => {
    let transcriptions = 0, turns = 0, stopped = 0; const reasons = [];
    const h = harness({ transcribe: async () => ++transcriptions === 1 ? 'Bonjour' : text,
      turn: async () => { turns++; return { text: 'Une longue réponse.' }; },
      interrupt: async (_session, _turnId, _signal, options) => { reasons.push(options); return {}; } });
    h.audio.canInterrupt = true;
    h.audio.play = (_bytes, signal) => new Promise(resolve => signal.addEventListener('abort', () => { stopped++; resolve(); }, { once: true }));
    await h.conversation.start({}); const first = h.say(); await tick();
    h.beginSpeech(); await h.probe();
    assert.equal(stopped, 0, 'hold sound before confirmation without discarding the reply');
    assert.ok(h.calls.includes('holdPlayback'));
    await h.say(); await first;
    assert.equal(stopped, 1, 'a confirmed Stop cancels the held playback');
    assert.equal(turns, 1, 'do not invoke the model just to acknowledge Stop');
    assert.deepEqual(reasons, [{ stop: true }], 'the surface learns this was a stop, not just new speech');
    assert.equal(h.conversation.state, 'listening');
    assert.equal(h.conversation.session.sessionId, 'private-1');
    h.conversation.stop();
  });
}

test('an interruption with a new question retains the entire request for the same native conversation', async () => {
  let transcriptions = 0; const submitted = [];
  const h = harness({ transcribe: async () => ++transcriptions === 1 ? 'Bonjour' : 'Stop, explique le budget.',
    turn: async (_session, text) => { submitted.push(text); return { text: 'Voici le budget.' }; },
    interrupt: async (_session, _turnId, _signal, options) => { assert.deepEqual(options, { stop: false }); return {}; } });
  h.audio.canInterrupt = true;
  h.audio.play = (_bytes, signal) => submitted.length > 1 ? Promise.resolve()
    : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech(); await h.say(); await first;
  assert.deepEqual(submitted, ['Bonjour', 'Stop, explique le budget.']);
  h.conversation.stop();
});

test('End during interruption suppresses the queued utterance and late acknowledgement', async () => {
  const ack = deferred(); let turns = 0;
  const h = harness({ turn: async () => { turns++; return { text: 'Reply' }; }, interrupt: () => ack.promise });
  h.audio.canInterrupt = true;
  h.audio.play = (_bytes, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech(); const second = h.say(); await tick();
  h.conversation.stop(); ack.resolve(); await Promise.all([first, second]);
  assert.equal(turns, 1);
  assert.equal(h.conversation.state, 'idle');
  assert.equal(h.conversation.session, null);
  assert.ok(h.calls.includes('close'));
});

test('failed interruption pauses instead of overlapping or silently losing history', async () => {
  const h = harness({ interrupt: async () => { throw new Error('Previous turn did not stop'); } });
  h.audio.canInterrupt = true;
  h.audio.play = (_bytes, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech(); await Promise.all([h.say(), first]);
  assert.equal(h.conversation.state, 'error');
  assert.ok(h.calls.includes('close'));
});

test('disabled interruption retains the existing playback-then-listening behavior', async () => {
  const h = harness({ interrupt: async () => assert.fail('must not interrupt') });
  h.audio.canInterrupt = true;
  await h.conversation.start({ interruption: false }); await h.say();
  assert.equal(h.calls.filter(c => c === 'listen').length, 2);
  h.conversation.stop();
});

// Recording lifecycle regressions retained from the Conversation rework.
const elephant = { id: 'elephant', url: '/assets/household/sounds/elephant-reviewed.ogg', gain: 2.7 };

test('the supplied recording plays after all speech and before listening resumes', async t => {
  const speech = deferred(), clip = deferred(), order = [];
  const h = harness({ turn: async () => ({ text: 'Écoute ce barrissement.', sound: elephant }) });
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    assert.equal(url, elephant.url); assert.equal(signal.aborted, false); order.push('fetch');
    return { ok: true, arrayBuffer: async () => 'recording' };
  });
  h.audio.play = async (bytes, _signal, _review, gain) => {
    if (bytes === 'recording') { order.push('clip'); assert.equal(gain, 2.7); await clip.promise; }
    else { order.push('speech'); await speech.promise; }
  };
  await h.conversation.start({ language: 'fr' });
  const pending = h.say(); await tick();
  assert.deepEqual(order, ['speech']);
  speech.resolve(); await tick();
  assert.deepEqual(order, ['speech', 'fetch', 'clip']);
  assert.equal(h.calls.filter(c => c === 'listen').length, 1);
  clip.resolve(); await pending;
  assert.equal(h.conversation.state, 'listening');
});

for (const action of ['stop', 'interrupt']) {
  test(`${action} cancels recording playback without restarting stale listening`, async t => {
    const h = harness({ turn: async () => ({ text: 'Écoute.', sound: elephant }), interrupt: async () => ({}) });
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => 'recording' }));
    let playingSignal;
    h.audio.play = async (bytes, signal) => {
      if (bytes === 'recording') {
        playingSignal = signal;
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      }
    };
    await h.conversation.start({});
    const pending = h.say(); await tick();
    assert.ok(playingSignal);
    h.conversation[action](); await pending;
    assert.equal(playingSignal.aborted, true);
    assert.equal(h.calls.filter(c => c === 'listen').length, 1);
    h.conversation.stop();
  });
}

test('stop during a recording fetch suppresses a late clip', async t => {
  const fetched = deferred();
  const h = harness({ turn: async () => ({ text: 'Écoute.', sound: elephant }) });
  t.mock.method(globalThis, 'fetch', () => fetched.promise);
  await h.conversation.start({}); const pending = h.say(); await tick();
  h.conversation.stop();
  fetched.resolve({ ok: true, arrayBuffer: async () => 'late recording' }); await pending;
  assert.equal(h.calls.filter(c => c === 'play').length, 1, 'only the preceding speech played');
  assert.equal(h.conversation.state, 'idle');
});

test('missing recording reports an error and leaves the reply visible', async t => {
  const h = harness({ turn: async () => ({ text: 'Écoute.', sound: elephant }) });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  await h.conversation.start({}); await h.say();
  assert.equal(h.conversation.state, 'error');
  assert.equal(h.messages.at(-1).text, 'Écoute.');
  assert.equal(h.calls.filter(c => c === 'play').length, 1);
});

test('a new session greets once when ready, before listening; a resumed session does not', async () => {
  const greetings = [];
  const h = harness({ async greet(session) { greetings.push(session.sessionId); return new ArrayBuffer(4); } });
  await h.conversation.start({});
  assert.deepEqual(greetings, ['private-1']);
  assert.deepEqual(h.calls.filter((c) => c === 'play' || c === 'listen'), ['play', 'listen']);
  assert.deepEqual(h.phases.slice(-2), ['speaking', 'listening']);
  h.conversation.stop(true);
  await h.conversation.start({});
  assert.deepEqual(greetings, ['private-1'], 'resuming the paused session must not greet again');
  h.conversation.stop();
});

test('the greeting waits for the avatar while voice synthesis can run in parallel', async () => {
  const face = deferred();
  let synthesized = false;
  const h = harness({ readyToSpeak: () => face.promise,
    async greet() { synthesized = true; return new ArrayBuffer(4); } });
  const started = h.conversation.start({}); await tick();
  assert.equal(synthesized, true);
  assert.equal(h.calls.includes('play'), false);
  face.resolve('face'); await started;
  assert.deepEqual(h.calls.filter(call => call === 'play' || call === 'listen'), ['play', 'listen']);
  h.conversation.stop();
});

test('a failed greeting still starts listening', async () => {
  const h = harness({ async greet() { throw new Error('voice unavailable'); } });
  await h.conversation.start({});
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.calls.includes('play'), false);
  h.conversation.stop();
});

test('stop during the greeting creates no listener', async () => {
  const playing = deferred();
  const h = harness({ async greet() { return new ArrayBuffer(4); } });
  h.audio.play = () => playing.promise;
  const started = h.conversation.start({}); await tick(); await tick();
  assert.equal(h.conversation.state, 'speaking');
  h.conversation.stop(); playing.resolve(); await started;
  assert.equal(h.calls.includes('listen'), false);
  assert.equal(h.conversation.state, 'idle');
});

test('a waiting notice is spoken before the answer that follows it (#62)', async () => {
  const hostFree = deferred(); const spoken = [];
  const h = harness({
    async synthesize({ text }) { spoken.push(text); return new ArrayBuffer(10); },
    turn: async (_session, _text, _signal, _delta, metadata) => {
      metadata.onNotice('Un instant, je termine un test en cours sur mon ordinateur.');
      await hostFree.promise;
      return { text: 'Voici la réponse une fois l’ordinateur libéré.', language: 'fr' };
    }
  });
  await h.conversation.start({ language: 'fr' });
  const exchanging = h.say(); await tick(); await tick();
  assert.deepEqual(spoken, ['Un instant, je termine un test en cours sur mon ordinateur.']);
  assert.ok(h.calls.includes('play'), 'the notice plays while the turn is still waiting');
  hostFree.resolve(); await exchanging;
  assert.deepEqual(spoken, ['Un instant, je termine un test en cours sur mon ordinateur.',
    'Voici la réponse une fois l’ordinateur libéré.']);
  assert.equal(h.messages.filter(row => row.role === 'assistant').length, 1, 'the notice is spoken, not added to the transcript');
  h.conversation.stop();
});

test('speech-to-text phantom sentences and lone digits from noise never become a turn', async () => {
  for (const text of ['Thank you very much.', ' thank you. ', 'Thanks for watching!', 'Sous-titres réalisés par la communauté d’Amara.org', 'Merci d’avoir regardé.', '6.']) {
    assert.equal(isTranscriptHallucination(text), true, text);
  }
  for (const text of ['Merci Nestor', 'Thank you Nestor for the story', 'Combien font 3 + 4 ?', 'Numéro 6', 'Hey Nestor, 6.', '']) {
    assert.equal(isTranscriptHallucination(text), false, text);
  }
  let phrase = 'Thank you very much.', turns = 0;
  const h = harness({ transcribe: async () => phrase, turn: async () => { turns++; return { text: 'Bonjour.' }; } });
  await h.conversation.start({ wakeWord: false, language: 'fr' });
  h.beginSpeech(); await h.say();
  assert.equal(turns, 0, 'open listening ignores the phantom sentence');
  assert.deepEqual(h.messages, []);
  phrase = '6.'; h.beginSpeech(); await h.say();
  assert.equal(turns, 0, 'a lone digit cannot trigger a new model turn');
  assert.deepEqual(h.messages, []);
  phrase = 'Bonjour Nestor'; h.beginSpeech(); await h.say();
  assert.equal(turns, 1, 'and still hears the next real phrase');
  h.conversation.stop();
});

test('"Hey Nestor" is answered with the page’s own wake reply', async () => {
  const spoken = [];
  const h = harness({ transcribe: async () => 'Hey Nestor', wakeReply: () => ({ text: 'Dis-moi !', language: 'fr' }),
    synthesize: async reply => { spoken.push(reply.text); return new ArrayBuffer(10); } });
  await h.conversation.start({ wakeWord: true, language: 'fr' });
  h.beginSpeech(); await h.say(); await nextTimer();
  assert.deepEqual(spoken, ['Dis-moi !']);
  h.conversation.stop();
});

test('the brain speaks one remark only at a pause, then listens again (#169)', async () => {
  const h = harness();
  await h.conversation.start({ wakeWord: false, language: 'fr' });
  h.calls.length = 0;
  assert.equal(await h.conversation.interject({ text: 'Petite correction : huit pattes.', language: 'fr' }), true);
  assert.deepEqual(h.calls, ['quiet', 'play', 'listen']);
  assert.equal(h.conversation.state, 'listening');

  // Never over the person: while they are heard, or while a turn is pending, nothing is said.
  h.beginSpeech();
  assert.equal(h.conversation.state, 'hearing');
  assert.equal(await h.conversation.interject({ text: 'Pas maintenant.' }), false);
  const idle = harness();
  assert.equal(await idle.conversation.interject({ text: 'Pas démarré.' }), false, 'no voice session, nothing is spoken');
});

test('with the wake word, the brain does not wake a sleeping Nestor', async () => {
  const h = harness();
  await h.conversation.start({ wakeWord: true, language: 'fr' });
  h.conversation.wake.until = 0;
  assert.equal(await h.conversation.interject({ text: 'Au fait.' }), false);
  h.conversation.wake.extend();
  assert.equal(await h.conversation.interject({ text: 'Au fait.' }), true);
});

for (const control of [{ text: '', control: 'stop' }, 'Stop, stop, stop.']) {
  test(`background speech stops silently without interrupting a completed native turn: ${JSON.stringify(control)}`, async () => {
    const h = harness({ transcribe: async () => control,
      interrupt: async () => assert.fail('No model turn belongs to a background presentation'),
      interrupted: () => assert.fail('Do not mark an unrelated transcript turn'),
      turn: async () => assert.fail('Stop must not invoke a model') });
    h.audio.canInterrupt = true;
    h.audio.play = (_bytes, signal, _review, _gain, options) => new Promise(resolve => {
      options?.onScheduled?.(); signal.addEventListener('abort', resolve, { once: true });
    });
    await h.conversation.start({ interruption: true, language: 'fr' });
    let scheduled = 0;
    const presentation = h.conversation.interject({ text: 'Tu peux dire Stop pour arrêter cette lecture.' }, { onScheduled: () => { scheduled++; } });
    await tick();
    assert.equal(h.conversation.state, 'speaking');
    h.beginSpeech(); await h.say();
    assert.equal(await presentation, false, 'Interrupted speech cannot receive a completed presentation receipt');
    assert.equal(scheduled, 1);
    assert.equal(h.conversation.state, 'listening');
    assert.equal(h.conversation.activeTurn, null);
    assert.equal(h.conversation.session.sessionId, 'private-1');
    assert.deepEqual(h.messages, []);
    h.conversation.stop();
  });
}

test('a question over background speech cancels only its playback and runs the complete new request', async () => {
  const next = deferred(), submitted = [];
  const h = harness({ transcribe: async () => 'Stop, explique plutôt le calendrier.',
    interrupt: async () => assert.fail('No old model run to cancel'),
    turn: async (_session, text) => { submitted.push(text); return next.promise; } });
  h.audio.canInterrupt = true;
  let first = true;
  h.audio.play = (_bytes, signal) => !first ? Promise.resolve() : new Promise(resolve => {
    first = false; signal.addEventListener('abort', resolve, { once: true });
  });
  await h.conversation.start({ interruption: true });
  const presentation = h.conversation.interject({ text: 'Voici un ancien résultat.' }); await tick();
  h.beginSpeech(); const question = h.say(); await tick();
  assert.equal(await presentation, false);
  assert.deepEqual(submitted, ['Stop, explique plutôt le calendrier.']);
  assert.equal(h.conversation.state, 'thinking', 'The old presentation cannot restart listening over the new turn');
  next.resolve({ text: 'Le calendrier est prêt.' }); await question;
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('echo/noise during background speech resumes its playback and keeps the native session', async () => {
  const playback = deferred();
  const h = harness({ transcribe: async () => 'Voici le résultat conservé.', interrupt: async () => assert.fail('Echo is not an interruption') });
  h.audio.canInterrupt = true; h.audio.play = () => playback.promise;
  await h.conversation.start({ interruption: true });
  const presentation = h.conversation.interject({ text: 'Voici le résultat conservé.' }); await tick();
  h.beginSpeech(); await h.say();
  assert.equal(h.conversation.state, 'speaking');
  assert.equal(h.conversation.activeTurn.interrupted, false);
  playback.resolve(); assert.equal(await presentation, true);
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('Pause during background speech aborts it without restarting an obsolete microphone', async () => {
  const h = harness();
  h.audio.play = (_bytes, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  await h.conversation.start({});
  const presentation = h.conversation.interject({ text: 'Résultat en cours.' }); await tick();
  h.conversation.stop(true);
  assert.equal(await presentation, false);
  assert.equal(h.conversation.state, 'paused');
  assert.equal(h.conversation.session.sessionId, 'private-1');
});

test('the language Whisper recognized decides the turn voice, and French is the default', async () => {
  for (const [result, selection, expected] of [
    [{ text: 'OK', detectedLanguage: 'en' }, 'fr-en', 'en'],
    [{ text: 'OK' }, 'fr-en', 'fr'],
    [{ text: 'OK' }, 'en', 'en'],
    [{ text: 'OK', detectedLanguage: 'en' }, 'fr', 'fr'],
    ['Can you check the hosts?', 'fr-en', 'en'],
    ['Can you check the hosts?', 'auto', 'en']
  ]) {
    const spoken = [];
    const h = harness({ transcribe: async () => result, turn: async (_s, _t, _sig, delta) => { delta('Sure. '); return { text: 'Sure.' }; },
      async synthesize(reply) { spoken.push(reply.language); return new ArrayBuffer(4); } });
    await h.conversation.start({ language: selection }); await h.say();
    assert.deepEqual(spoken, [expected]);
    h.conversation.stop();
  }
});

test('a transcript made of the words the reply just spoke is echo; other words are the user', () => {
  const spoken = 'Voici le résumé de ta journée. Le build a passé, pis le serveur est correct.';
  assert.equal(isSpokenEcho('le build a passé pis le serveur', spoken), true);
  assert.equal(isSpokenEcho('Le résumé de ta journée.', spoken), true);
  assert.equal(isSpokenEcho('Attends, peux-tu répéter la météo?', spoken), false);
  assert.equal(isSpokenEcho('', spoken), false);
  assert.equal(isSpokenEcho('le build a passé', ''), false);
});

test('different words during playback still interrupt the reply', async () => {
  const playing = deferred(); let transcriptions = 0, interrupts = 0;
  const h = harness({ transcribe: async () => (++transcriptions === 1 ? 'Bonjour' : 'Attends, change de sujet'),
    turn: async () => ({ text: 'Une longue réponse que Gazz est en train de lire.' }),
    async interrupt() { interrupts++; } });
  h.audio.canInterrupt = true; h.audio.play = (bytes, signal) => { signal.addEventListener('abort', playing.resolve, { once: true }); return playing.promise; };
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech(); await h.say(); await first;
  assert.equal(interrupts, 1);
  h.conversation.stop();
});

test('a failure keeps the conversation so starting again continues it', async () => {
  const h = harness({ transcribe: async () => { throw new Error('STT offline'); } });
  await h.conversation.start({}); await h.say();
  assert.equal(h.conversation.state, 'error');
  assert.equal(h.conversation.session.sessionId, 'private-1');
});

test('a silent wait speaks one holding phrase in the turn language; a quick reply speaks none', async () => {
  const slow = deferred(), spoken = [];
  const h = harness({ holdingDelayMs: 5, transcribe: async () => 'Bonjour Nestor',
    turn: () => slow.promise, async synthesize(reply) { spoken.push(reply); return new ArrayBuffer(4); } });
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await nextTimer(); await nextTimer();
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].language, 'fr');
  assert.ok(['Un instant…', 'Je regarde ça…', 'Laisse-moi réfléchir une seconde…'].includes(spoken[0].text));
  slow.resolve({ text: 'Voici la réponse.' }); await exchange;
  assert.deepEqual(spoken.map(row => row.text).slice(1), ['Voici la réponse.']);
  h.conversation.stop();
  const quick = []; const q = harness({ holdingDelayMs: 50, turn: async () => ({ text: 'Tout de suite.' }),
    async synthesize(reply) { quick.push(reply.text); return new ArrayBuffer(4); } });
  await q.conversation.start({ language: 'fr' }); await q.say(); await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(quick, ['Tout de suite.']);
  q.conversation.stop();
  assert.equal(holdingPhrase('en', 0), 'One moment…');
});

test('the browser voice fallback speaks the text in the turn locale and stops on cancel', async () => {
  const { speakWithBrowser } = require('../public/browser-conversation');
  const spoken = []; let cancelled = 0;
  globalThis.SpeechSynthesisUtterance = function (text) { this.text = text; };
  globalThis.speechSynthesis = { getVoices: () => [{ lang: 'fr-CA', name: 'Example' }], cancel: () => { cancelled++; },
    speak: utterance => { spoken.push(utterance); setTimeout(() => utterance.onend?.(), 1); } };
  try {
    await speakWithBrowser({ text: 'Bonjour.', language: 'fr' }, new AbortController().signal);
    assert.equal(spoken[0].text, 'Bonjour.'); assert.equal(spoken[0].lang, 'fr-CA'); assert.equal(spoken[0].voice.name, 'Example');
    const abort = new AbortController();
    globalThis.speechSynthesis.speak = utterance => spoken.push(utterance);
    const pending = speakWithBrowser({ text: 'Une longue phrase.', language: 'fr' }, abort.signal);
    abort.abort(); await pending;
    assert.equal(cancelled, 1);
  } finally { delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance; }
});

test('a message typed while voice waits is a spoken turn on the same session, then listening resumes', async () => {
  const turns = [];
  const h = harness({ turn: async (session, text, signal, onDelta, options) => { turns.push({ session: session.sessionId, text, options }); return { text: 'Réponse écrite et dite.', language: 'fr' }; } });
  await h.conversation.start({ language: 'fr' });
  assert.equal(h.conversation.canType(), true);
  assert.equal(await h.conversation.typed('  Bonjour par écrit  '), true);
  assert.deepEqual(turns.map(t => [t.session, t.text]), [['private-1', 'Bonjour par écrit']]);
  assert.equal(turns[0].options.attachmentIds, undefined);
  assert.deepEqual(h.messages, [{ role: 'user', text: 'Bonjour par écrit' }, { role: 'assistant', text: 'Réponse écrite et dite.' }]);
  assert.ok(h.calls.includes('play'));
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('a typed message carries its attachments to the transcript and the turn', async () => {
  let options, shown;
  const h = harness({ turn: async (session, text, signal, onDelta, opts) => { options = opts; return { text: 'Vu.' }; },
    message(role, text, interrupted, sound, attachments) { if (role === 'user') shown = attachments; } });
  await h.conversation.start({ language: 'fr' });
  const attachments = [{ id: 'a'.repeat(24), name: 'photo.jpg' }];
  assert.equal(await h.conversation.typed('Regarde', { attachments }), true);
  assert.deepEqual(options.attachmentIds, ['a'.repeat(24)]);
  assert.deepEqual(shown, attachments);
  h.conversation.stop();
});

test('typing is refused before voice starts and while a turn is in flight', async () => {
  const reply = deferred();
  const h = harness({ turn: async () => reply.promise });
  assert.equal(h.conversation.canType(), false);
  assert.equal(await h.conversation.typed('Trop tôt'), false);
  await h.conversation.start({ language: 'fr' });
  const pending = h.conversation.typed('Premier');
  await tick();
  assert.equal(h.conversation.canType(), false);
  assert.equal(await h.conversation.typed('Deuxième'), false);
  reply.resolve({ text: 'Fini.' }); await pending;
  assert.equal(h.conversation.canType(), true);
  h.conversation.stop();
});

test('the holding phrase heard back is echo: it neither interrupts nor replaces the pending reply', async () => {
  const slow = deferred(), spoken = []; let transcriptions = 0, turns = 0;
  const h = harness({ holdingDelayMs: 5,
    transcribe: async () => ++transcriptions === 1 ? 'Bonjour Nestor' : spoken[0].text,
    turn: () => { turns++; return slow.promise; },
    async synthesize(reply) { spoken.push(reply); return new ArrayBuffer(4); },
    interrupt: () => assert.fail('the holding phrase must not cancel the turn') });
  h.audio.canInterrupt = true;
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await nextTimer(); await nextTimer();
  assert.equal(spoken.length, 1);
  assert.equal(h.conversation.state, 'thinking', 'the page shows Nestor thinking again once the phrase ends');
  h.beginSpeech(); await h.say();
  assert.equal(h.conversation.state, 'thinking');
  assert.equal(turns, 1);
  slow.resolve({ text: 'Voici la réponse.' }); await exchange;
  assert.deepEqual(spoken.map(row => row.text).slice(1), ['Voici la réponse.']);
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('the holding phrase waits a few seconds by default', () => {
  const { HOLDING_DELAY_MS } = require('../public/browser-conversation');
  assert.ok(HOLDING_DELAY_MS >= 2000 && HOLDING_DELAY_MS <= 5000);
});

test('reply text that arrives before the holding phrase plays drops it, so the answer is not delayed', async () => {
  const slow = deferred(), requests = [], played = [];
  const h = harness({ holdingDelayMs: 5, turn: () => slow.promise,
    synthesize(reply, signal) {
      requests.push({ text: reply.text, signal });
      // The holding phrase's voice is slow; the answer's is immediate.
      if (requests.length === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return Promise.resolve(reply.text);
    } });
  h.audio.play = async bytes => { played.push(bytes); };
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await nextTimer(); await nextTimer();
  assert.equal(requests.length, 1, 'the holding phrase was being prepared');
  assert.equal(h.conversation.activeTurn.spoken, undefined, 'a phrase that has not played cannot be heard back as echo');
  slow.resolve({ text: 'Voici la réponse.' }); await exchange;
  assert.equal(requests[0].signal.aborted, true, 'its synthesis is cancelled');
  assert.deepEqual(played, ['Voici la réponse.']);
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('a holding phrase whose voice is ready too late is not played', async () => {
  const slow = deferred(), holdingVoice = deferred(), played = [];
  let cancelled = 0;
  const h = harness({ holdingDelayMs: 5, holdingLateMs: 20, turn: () => slow.promise,
    synthesize: reply => (played.length || reply.text === 'Voici la réponse.' ? Promise.resolve(reply.text) : holdingVoice.promise) });
  h.audio.play = async bytes => { played.push(bytes); };
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await nextTimer(); await nextTimer();
  await new Promise(resolve => setTimeout(resolve, 40));
  holdingVoice.resolve({ body: { cancel: async () => { cancelled += 1; } } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(played, [], 'the late phrase is dropped');
  assert.equal(cancelled, 1, 'its accepted speech stream is closed');
  assert.equal(h.conversation.activeTurn.spoken, undefined, 'a phrase that did not play cannot be heard back as echo');
  slow.resolve({ text: 'Voici la réponse.' }); await exchange;
  assert.deepEqual(played, ['Voici la réponse.']);
  h.conversation.stop();
});

test('a holding phrase already playing finishes while the first clause is prepared to follow it', async () => {
  const slow = deferred(), holdingPlayback = deferred(), synthesized = [], played = [];
  let delta;
  const h = harness({ holdingDelayMs: 5,
    turn(_session, _text, _signal, onDelta) { delta = onDelta; return slow.promise; },
    async synthesize(reply) { synthesized.push(reply.text); return reply.text; } });
  h.audio.play = bytes => { played.push(bytes); return played.length === 1 ? holdingPlayback.promise : Promise.resolve(); };
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await nextTimer(); await nextTimer();
  assert.equal(played.length, 1, 'the holding phrase is playing');
  delta('Voici la réponse. '); await tick();
  assert.deepEqual(synthesized.slice(1), ['Voici la réponse.'], 'the first clause is synthesized during the phrase');
  assert.equal(played.length, 1, 'the phrase is not cut');
  holdingPlayback.resolve(); await tick(); await tick();
  assert.deepEqual(played.slice(1), ['Voici la réponse.']);
  slow.resolve({ text: 'Voici la réponse.' }); await exchange;
  assert.equal(played.length, 2);
  h.conversation.stop();
});

test('the end of the spoken text says the last clause before the turn completes, once', async () => {
  const closing = deferred(), spoken = [];
  const h = harness({
    async turn(_session, _text, _signal, delta, options) {
      delta('Voici la réponse.'); await tick();
      assert.deepEqual(spoken, [], 'a final period is not a clause boundary while text may follow');
      options.onSayEnd();
      await closing.promise; // pictures, tool receipts and the record still to come
      return { text: 'Voici la réponse.', language: 'fr' };
    },
    async synthesize(reply) { spoken.push(reply.text); return new ArrayBuffer(4); } });
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await tick(); await tick(); await tick();
  assert.deepEqual(spoken, ['Voici la réponse.']);
  assert.ok(h.calls.includes('play'), 'it plays while the turn is still closing');
  assert.equal(h.conversation.turnPending, true);
  closing.resolve(); await exchange;
  assert.deepEqual(spoken, ['Voici la réponse.'], 'completion does not repeat it');
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('an end-of-text signal with nothing streamed, or after a pause, speaks nothing early', async () => {
  const closing = deferred(), spoken = [];
  let end;
  const h = harness({
    async turn(_session, _text, _signal, delta, options) { end = () => { delta('Trop tard.'); options.onSayEnd(); }; options.onSayEnd(); await closing.promise; return { text: 'Réponse complète.' }; },
    async synthesize(reply) { spoken.push(reply.text); return new ArrayBuffer(4); } });
  await h.conversation.start({ language: 'fr' }); const exchange = h.say(); await tick(); await tick();
  assert.deepEqual(spoken, [], 'an unstreamed reply is spoken from the completed turn');
  h.conversation.stop(true); end(); closing.resolve(); await exchange;
  assert.deepEqual(spoken, [], 'a paused turn is never spoken later');
});

test('an accepted voice stream that fails while it plays is retried once, for that clause, with the next voice', async () => {
  const requests = [], played = [];
  const h = harness({
    async turn(_session, _text, _signal, delta) {
      delta('Voici la première phrase de la réponse. '); await tick(); await tick(); await tick();
      delta('Voici la deuxième phrase de la réponse. ');
      return { text: 'Réponse complète.' };
    },
    async synthesize(reply) { const speech = { text: reply.text, after: reply.after }; requests.push(speech); return speech; } });
  h.audio.play = async speech => { if (speech === requests[0]) throw new Error('Voice stream failed'); played.push(speech.text); };
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.deepEqual(requests.map(row => row.text), ['Voici la première phrase de la réponse.', 'Voici la première phrase de la réponse.', 'Voici la deuxième phrase de la réponse.']);
  assert.equal(requests[0].after, undefined);
  assert.equal(requests[1].after, requests[0], 'the retry names the speech that failed');
  assert.equal(requests[2].after, requests[0], 'later clauses of the turn skip the failed voice too');
  assert.deepEqual(played, ['Voici la première phrase de la réponse.', 'Voici la deuxième phrase de la réponse.']);
  assert.equal(h.conversation.state, 'listening');
  // The next turn starts from the chosen voice again.
  await h.say();
  assert.equal(requests.at(-1).after, undefined);
  h.conversation.stop();
});

test('a clause prepared ahead with the voice that then failed is prepared again before it is heard', async () => {
  const requests = [], played = [], first = 'Voici la première phrase de la réponse.', second = 'Voici la deuxième phrase de la réponse.';
  let breakStream;
  const h = harness({
    async turn(_session, _text, _signal, delta) { delta(first + ' '); delta(second + ' '); return { text: 'Réponse.' }; },
    async synthesize(reply) { const speech = { text: reply.text, after: reply.after }; requests.push(speech); return speech; } });
  h.audio.play = speech => speech === requests[0] ? new Promise((_, reject) => { breakStream = reject; }) : (played.push(speech), Promise.resolve());
  await h.conversation.start({ language: 'fr' }); const exchange = h.say(); await tick(); await tick();
  assert.deepEqual(requests.map(row => row.text), [first, second], 'the second clause is ready behind the first');
  breakStream(new Error('Voice stream failed')); await exchange;
  assert.deepEqual(requests.map(row => [row.text, row.after === requests[0]]), [[first, false], [second, false], [first, true], [second, true]]);
  assert.deepEqual(played, [requests[2], requests[3]], 'speech from the failed voice is never played');
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('a second voice failure in the same turn stops the voice: one clause is repeated, never a loop', async () => {
  let syntheses = 0, plays = 0;
  const h = harness({
    async turn(_session, _text, _signal, delta) { delta('Voici la première phrase de la réponse. '); delta('Voici la deuxième phrase de la réponse. '); return { text: 'Réponse.' }; },
    async synthesize() { syntheses++; return new ArrayBuffer(4); } });
  h.audio.play = async () => { plays++; throw new Error('Voice stream failed'); };
  await h.conversation.start({ language: 'fr' }); await h.say();
  assert.equal(plays, 2, 'the first clause is tried twice, then nothing more is played');
  assert.equal(syntheses, 3, 'first clause, its one retry, and the clause prepared ahead');
  assert.equal(h.conversation.state, 'error');
});

test('a clause stopped by an interruption or a pause is not retried', async () => {
  const requests = [];
  const h = harness({
    async turn(_session, _text, _signal, delta) { delta('Voici la première phrase de la réponse. '); return new Promise(() => {}); },
    async synthesize(reply) { requests.push(reply); return new ArrayBuffer(4); } });
  h.audio.play = (_bytes, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  await h.conversation.start({ language: 'fr' }); void h.say(); await tick(); await tick();
  assert.equal(requests.length, 1);
  h.conversation.stop(true); await tick(); await tick();
  assert.equal(requests.length, 1, 'cancelled playback is not a voice failure');
  assert.equal(h.conversation.state, 'paused');
});

test('a holding phrase whose voice fails never fails the answer', async () => {
  const slow = deferred(), played = [];
  const h = harness({ holdingDelayMs: 5, turn: () => slow.promise,
    async synthesize(reply) { if (played.length === 0 && reply.text !== 'Voici la réponse.') throw new Error('TTS unavailable'); return reply.text; } });
  h.audio.play = async bytes => { played.push(bytes); };
  await h.conversation.start({ language: 'fr' }); const exchange = h.say();
  await nextTimer(); await nextTimer();
  slow.resolve({ text: 'Voici la réponse.' }); await exchange;
  assert.deepEqual(played, ['Voici la réponse.']);
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('recognition started during the pause that ends the turn is the turn\'s transcription', async () => {
  const early = deferred(); let whole = 0; const heard = [];
  const h = harness({ transcribeEarly: () => early.promise, transcribe: async () => { whole++; return 'Unused'; },
    turn: async (_session, text) => { heard.push(text); return { text: 'Salut', language: 'fr' }; } });
  await h.conversation.start({ language: 'fr' });
  h.beginSpeech(); h.pause(7);
  const turn = h.say({ earlyId: 7, silenceMs: 1000, audioMs: 1500 });
  early.resolve({ text: 'Quel temps fait-il ?', sttMs: 300 });
  await turn;
  assert.deepEqual(heard, ['Quel temps fait-il ?']);
  assert.equal(whole, 0, 'the whole clip is not transcribed a second time');
  h.conversation.stop();
});

test('an early recognition is dropped when the person goes on, and a failed one never fails the turn', async () => {
  const signals = []; let whole = 0; const heard = [];
  const h = harness({
    transcribeEarly: (_blob, _language, signal) => { signals.push(signal); return signals.length === 3 ? Promise.reject(new Error('busy')) : new Promise(() => {}); },
    transcribe: async () => { whole++; return 'Phrase complète'; },
    turn: async (_session, text) => { heard.push(text); return { text: 'Salut', language: 'fr' }; } });
  await h.conversation.start({ language: 'fr' });
  h.beginSpeech(); h.pause(1); h.resume(1);
  assert.equal(signals[0].aborted, true, 'speech resumed: that request is cancelled');
  h.pause(2);
  await h.say({ earlyId: null }); // the turn ended without a standing offer (the sound cap)
  assert.equal(signals[1].aborted, true);
  assert.equal(whole, 1);
  h.beginSpeech(); h.pause(3);
  await h.say({ earlyId: 3 });
  assert.equal(whole, 2, 'the failed early request falls back to the whole clip');
  assert.deepEqual(heard, ['Phrase complète', 'Phrase complète']);
  h.conversation.stop();
  assert.equal(signals[2].aborted, false);
});

test('a surface without early recognition, or one that declines it, transcribes the whole clip as before', async () => {
  let whole = 0;
  const plain = harness({ transcribe: async () => { whole++; return 'Bonjour'; } });
  await plain.conversation.start({ language: 'fr' });
  plain.beginSpeech(); plain.pause(1);
  await plain.say({ earlyId: 1 });
  const declining = harness({ transcribeEarly: () => null, transcribe: async () => { whole++; return 'Bonjour'; } });
  await declining.conversation.start({ language: 'fr' });
  declining.beginSpeech(); declining.pause(1);
  await declining.say({ earlyId: 1 });
  assert.equal(whole, 2);
  plain.conversation.stop(); declining.conversation.stop();
});

test('a reply keeps playing over a sound without words, however long it lasts', async () => {
  const playing = deferred(); let transcriptions = 0;
  const h = harness({ transcribe: async () => (++transcriptions === 1 ? 'Bonjour' : ''),
    turn: async () => ({ text: 'Une réponse à terminer.' }),
    interrupt: () => assert.fail('a noise must not cancel the reply') });
  h.audio.canInterrupt = true; h.audio.play = () => playing.promise;
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech();
  assert.equal(h.conversation.state, 'speaking', 'the reply is still shown as speaking');
  await h.probe();
  await h.say();
  assert.ok(!h.calls.includes('holdPlayback'), 'nothing paused the reply');
  assert.equal(h.conversation.state, 'speaking');
  playing.resolve(); await first;
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('words heard over a reply hold it, and it resumes when the whole sound was not speech', async () => {
  const playing = deferred(); let transcriptions = 0;
  const h = harness({ transcribe: async () => ['Bonjour', 'Attends', ''][transcriptions++],
    turn: async () => ({ text: 'Une réponse à terminer.' }),
    interrupt: () => assert.fail('an utterance without words must not cancel the reply') });
  h.audio.canInterrupt = true; h.audio.play = () => playing.promise;
  await h.conversation.start({}); const first = h.say(); await tick();
  h.beginSpeech(); await h.probe();
  assert.ok(h.calls.includes('holdPlayback'), 'words hold the reply');
  assert.equal(h.conversation.state, 'hearing');
  await h.say();
  assert.ok(h.calls.includes('resumePlayback'));
  assert.equal(h.conversation.state, 'speaking');
  playing.resolve(); await first;
  assert.equal(h.conversation.state, 'listening');
  h.conversation.stop();
});

test('a reply waits a moment for a sound to be recognized, then starts even if the sound goes on', async () => {
  const reply = deferred(), playing = deferred(); let transcriptions = 0;
  const h = harness({ transcribe: async () => (++transcriptions === 1 ? 'Bonjour' : ''),
    turn: () => reply.promise, interrupt: () => assert.fail('a noise must not cancel the turn') });
  h.audio.canInterrupt = true; h.audio.play = () => { h.calls.push('play'); return playing.promise; };
  await h.conversation.start({}); const first = h.say(); await tick();
  assert.equal(h.conversation.state, 'thinking');
  h.beginSpeech();                       // a keyboard, a door: it goes on and never ends
  reply.resolve({ text: 'La réponse est prête.', language: 'fr' });
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(!h.calls.includes('play'), 'the sound may be a person: the reply does not start over it');
  await h.probe();                       // no words in what was heard so far
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(h.calls.includes('play'), 'the reply does not wait for the sound to end');
  assert.equal(h.conversation.state, 'speaking');
  playing.resolve(); await first;
  h.conversation.stop();
});

test('a sound that goes on is offered once for recognition, a short one never', () => {
  const voiced = () => new Float32Array(100).fill(0.1), silent = () => new Float32Array(100);
  const long = new Endpoint(1000, 100, 250); long.probeMs = 800;
  long.push(voiced());                                   // the onset
  for (let i = 0; i < 7; i++) long.push(voiced());
  assert.deepEqual(long.drain(), [], 'not yet: 700 ms after the onset');
  long.push(voiced());
  const events = long.drain();
  assert.deepEqual(events.map(event => event.type), ['probe']);
  assert.equal(events[0].samples.length, 900, 'the lead-in and what was heard since');
  for (let i = 0; i < 10; i++) long.push(voiced());
  assert.deepEqual(long.drain(), [], 'once per sound');
  const short = new Endpoint(1000, 100, 250); short.probeMs = 800;
  short.push(voiced()); short.push(voiced());
  let utterance; for (let i = 0; i < 3 && !utterance; i++) utterance = short.push(silent());
  assert.ok(utterance, 'a short sound ends by itself');
  assert.deepEqual(short.drain(), []);
});

test('the language can change while the conversation runs and applies to the next sentence', async () => {
  const heard = [];
  const h = harness({ transcribe: async (_blob, language) => { heard.push(language); return 'Bonjour.'; }, turn: async () => ({ text: 'Bonjour.' }) });
  await h.conversation.start({ wakeWord: false, language: 'auto' });
  const session = h.conversation.session;
  h.beginSpeech(); await h.say();
  assert.equal(h.conversation.setLanguage('fr'), true);
  h.beginSpeech(); await h.say();
  assert.equal(h.conversation.setLanguage('klingon'), false);
  h.conversation.setInterruption(false);
  assert.equal(h.conversation.selection.interruption, false);
  assert.deepEqual([heard[0], heard.at(-1)], ['auto', 'fr']);
  assert.equal(h.conversation.session, session, 'the conversation is not replaced');
  h.conversation.stop();
});

test('browser speech failure cannot become completed playback after its start event', async () => {
  const { speakWithBrowser } = require('../public/browser-conversation'); let scheduled = 0;
  globalThis.SpeechSynthesisUtterance = function (text) { this.text = text; };
  globalThis.speechSynthesis = { getVoices: () => [], cancel() {}, speak(utterance) {
    setTimeout(() => { utterance.onstart(); utterance.onerror({ error: 'synthesis-failed' }); }, 1);
  } };
  try {
    await assert.rejects(speakWithBrowser({ text: 'Résultat.', language: 'fr' }, new AbortController().signal,
      () => { scheduled++; }), /could not complete/);
    assert.equal(scheduled, 1);
  } finally { delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance; }
});
