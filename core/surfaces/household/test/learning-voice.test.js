'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/learning-voice');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ turns, ...options } = {}) {
  let utterance, onset, resolvePlayback;
  const requested = [], spoken = [], audio = {
    canInterrupt: true, quiet() {}, close() {}, listen(callback, onSpeech) { utterance = callback; onset = onSpeech; },
    async play(reply, signal) { spoken.push(reply.text); if (options.holdPlayback) await new Promise(resolve => { resolvePlayback = resolve; signal.addEventListener('abort', resolve, { once: true }); }); },
  };
  const inputs = [];
  const controller = create({ openAudio: async () => audio, language: () => 'fr',
    async transcribe() { return { text: inputs.shift(), effectiveModel: 'synthetic' }; },
    async turn(text, signal) { requested.push({ text, signal }); return turns ? turns(text, signal) : { text: 'Réponse complète.', language: 'fr' }; },
    async synthesize(reply) { return reply; }, ...options });
  return { controller, requested, spoken, release: () => resolvePlayback?.(),
    async say(text) { inputs.push(text); onset?.(); return utterance(new Blob(['synthetic'], { type: 'audio/wav' })); } };
}

test('learning pages require an interjection, then accept short turns without another activation', async () => {
  const h = harness(); await h.controller.start();
  await h.say('On parle de Nestor.'); assert.equal(h.requested.length, 0);
  await h.say('Eille Nestor, bonjour');
  for (const word of ['oui', '7', 'merci']) await h.say(word);
  assert.deepEqual(h.requested.map(x => x.text), ['bonjour', 'oui', '7', 'merci']);
  assert.equal(h.controller.conversation.state, 'listening');
  h.controller.pause(); assert.equal(h.controller.conversation.audio, null);
});

test('Stop interrupts reading, keeps the current learning session and never creates a model turn', async () => {
  const h = harness({ holdPlayback: true }); await h.controller.start();
  const pending = h.say('Hey Nestor, explique'); await tick();
  assert.equal(h.controller.conversation.state, 'speaking');
  await h.say('Stop'); await pending;
  assert.equal(h.requested.length, 1);
  assert.equal(h.controller.conversation.state, 'listening');
  assert.ok(h.controller.conversation.session);
  h.controller.pause();
});

test('a new utterance waits for the original accepted request instead of duplicating it', async () => {
  let resolve, started;
  const ready = new Promise(r => { started = r; });
  const h = harness({ turns: text => text === 'première' ? new Promise(r => { resolve = r; started(); }) : { text: 'Deuxième.', language: 'fr' } });
  await h.controller.start();
  const first = h.say('Hey Nestor première'); await ready;
  const second = h.say('deuxième'); await tick();
  assert.equal(h.requested.length, 1);
  assert.equal(h.requested[0].signal.aborted, false);
  resolve({ text: 'Résultat conservé.', language: 'fr' });
  await Promise.all([first, second]);
  assert.deepEqual(h.requested.map(x => x.text), ['première', 'deuxième']);
  assert.ok(!h.spoken.includes('Résultat conservé.'));
  assert.equal(h.controller.conversation.state, 'listening');
  h.controller.pause();
});

test('changing the language affects the next turn; Pause closes capture and cancels outstanding work', async () => {
  const h = harness(); await h.controller.start();
  assert.equal(h.controller.setLanguage('en'), true);
  assert.equal(h.controller.conversation.selection.language, 'en');
  h.controller.pause(); assert.equal(h.controller.conversation.state, 'paused');
  assert.equal(h.controller.conversation.abort.signal.aborted, true);
});

test('sound off keeps conversation and complete replies but produces no speech or clips', async () => {
  const h = harness({ muted: () => true, turns: async () => ({ text: 'Réponse.', sound: { url: '/synthetic.wav' } }) });
  await h.controller.start(); await h.say('Hey Nestor bonjour');
  assert.deepEqual(h.spoken, []);
  assert.equal(h.controller.conversation.state, 'listening');
  h.controller.pause();
});

test('Stop during initial reading synthesis cancels that request and cannot start delayed playback', async () => {
  let release, signal;
  const h = harness({ synthesize: async (_reply, requestSignal) => {
    signal = requestSignal; return new Promise(resolve => { release = resolve; });
  } });
  await h.controller.start();
  const reading = h.controller.read({ text: 'Texte complet à relire.', language: 'fr' });
  await tick();
  assert.equal(h.controller.conversation.state, 'preparing');
  await h.say('Stop'); assert.equal(signal.aborted, true);
  release({ text: 'Texte complet à relire.' });
  assert.equal(await reading, false);
  assert.deepEqual(h.spoken, []);
  assert.equal(h.controller.conversation.state, 'listening');
  h.controller.pause();
});
