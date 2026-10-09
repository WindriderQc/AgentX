'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechLadder } = require('../../../public/js/voice/speech-ladder');
const { Conversation } = require('../../../public/js/voice/browser-conversation');
const P = require('../public/persona-presentation');

const choices = [{ provider: 'voxcpm', voice: 'example-clone' }, { provider: 'kokoro', voice: 'ff_siwis' }];
const live = () => new AbortController().signal;
// A speech service whose voices answer as listed: true (accepted), false (refused) or 'offline'.
function service(answers) {
  const requested = [];
  const request = async ({ text, language, choice }) => {
    requested.push(choice.voice);
    const answer = answers[choice.voice];
    if (answer === 'offline') throw new Error('network');
    return { ok: answer !== false, voice: choice.voice, text, language };
  };
  return { requested, request };
}

test('the first voice whose stream is accepted speaks; a refused voice steps down', async () => {
  const up = service({});
  const ladder = createSpeechLadder({ request: up.request });
  const first = await ladder.speak({ text: 'Bonjour.', language: 'fr', choices }, live());
  assert.equal(first.voice, 'example-clone'); assert.equal(ladder.rungOf(first), 0);
  assert.deepEqual(up.requested, ['example-clone']);

  const down = service({ 'example-clone': false });
  const stepped = createSpeechLadder({ request: down.request });
  const second = await stepped.speak({ text: 'Bonjour.', language: 'fr', choices }, live());
  assert.equal(second.voice, 'ff_siwis'); assert.equal(stepped.rungOf(second), 1);
  assert.deepEqual(down.requested, ['example-clone', 'ff_siwis']);
});

test('speech that failed while it played restarts on the voice below it, never on that voice again', async () => {
  const voices = service({});
  const ladder = createSpeechLadder({ request: voices.request, deviceVoice: () => true });
  const failed = await ladder.speak({ text: 'Bonjour.', language: 'fr', choices }, live());
  const retried = await ladder.speak({ text: 'Bonjour.', language: 'fr', choices, after: failed }, live());
  assert.equal(retried.voice, 'ff_siwis'); assert.equal(ladder.rungOf(retried), 1);
  assert.deepEqual(voices.requested, ['example-clone', 'ff_siwis']);
  // Below the last server voice there is only the device's own voice.
  const device = await ladder.speak({ text: 'Bonjour.', language: 'fr', choices, after: retried }, live());
  assert.deepEqual(device, { browserSpeech: { text: 'Bonjour.', language: 'fr' } });
  assert.equal(ladder.rungOf(device), 2);
  assert.deepEqual(voices.requested, ['example-clone', 'ff_siwis'], 'no voice is requested again');
  await assert.rejects(ladder.speak({ text: 'Bonjour.', language: 'fr', choices, after: device }, live()), /unavailable/);
  // Speech this ladder never issued is not trusted to name a rung: no server voice is tried.
  assert.deepEqual(await ladder.speak({ text: 'Bonjour.', language: 'fr', choices, after: {} }, live()), { browserSpeech: { text: 'Bonjour.', language: 'fr' } });
});

test('without any server voice the device voice speaks only where the surface allows it', async () => {
  for (const answers of [{ 'example-clone': false, ff_siwis: false }, { 'example-clone': 'offline' }]) {
    const allowed = createSpeechLadder({ request: service(answers).request, deviceVoice: () => true });
    assert.deepEqual(await allowed.speak({ text: 'Bonjour.', language: 'fr', choices }, live()), { browserSpeech: { text: 'Bonjour.', language: 'fr' } });
    const refused = createSpeechLadder({ request: service(answers).request, unavailable: 'La voix est indisponible.' });
    await assert.rejects(refused.speak({ text: 'Bonjour.', language: 'fr', choices }, live()), /La voix est indisponible\./);
  }
});

test('a cancelled request stops the ladder: no lower voice and no device voice', async () => {
  const abort = new AbortController(), requested = [];
  const ladder = createSpeechLadder({ deviceVoice: () => true, request: async ({ choice }) => {
    requested.push(choice.voice); abort.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } });
  await assert.rejects(ladder.speak({ text: 'Bonjour.', language: 'fr', choices }, abort.signal), { name: 'AbortError' });
  assert.deepEqual(requested, ['example-clone']);
});

test('the Household page wires the shared ladder and hands it the speech that failed', () => {
  const fs = require('node:fs'), path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(page, /AgentXSpeechLadder\.createSpeechLadder\(/);
  assert.match(page, /voiceLadder\.speak\(\{ text, language: lang, choices, after \}, signal\)/);
  assert.match(page, /signal, 'Conversation', reply\.after\)/);
  assert.ok(html.indexOf('/js/voice/speech-ladder.js') > 0 && html.indexOf('/js/voice/speech-ladder.js') < html.indexOf('conversation-page.js'),
    'the ladder loads before the page that wires it');
});

test('Household: a neural voice that stops mid-clause is replaced by the personality’s catalog voice for the rest of the turn', async () => {
  const persona = { name: 'Nestor', voice: { provider: 'voxcpm', source: 'instance', voices: { fr: 'example-clone' },
    fallback: { provider: 'kokoro', presentation: 'feminine', voices: { fr: 'catalog-fr' } } } };
  const requested = [], played = [], notices = [];
  const ladder = createSpeechLadder({ deviceVoice: () => true,
    request: async ({ text, choice }) => { requested.push(choice.voice + ' · ' + text); return { ok: true, voice: choice.voice, text }; } });
  let utterance;
  const audio = { listen(callback) { utterance = callback; }, quiet() {}, close() {},
    // The neural voice's accepted stream breaks while it plays; the catalog voice plays.
    async play(speech) { if (speech.voice === 'example-clone') throw new Error('Voice stream failed'); played.push(speech.voice + ' · ' + speech.text); } };
  const conversation = new Conversation({ holdingDelayMs: null,
    async openAudio() { return audio; }, async createSession() { return { sessionId: 'family-1' }; },
    async transcribe() { return 'Bonjour Nestor'; }, message() {},
    async turn(_session, _text, _signal, delta) { delta('Voici la première phrase de la réponse. '); delta('Voici la deuxième phrase de la réponse. '); return { text: 'Réponse.' }; },
    // The page's adapter: the personality's voices in order, and the voice notice.
    async synthesize(reply, signal) {
      const speech = await ladder.speak({ text: reply.text, language: reply.language, choices: P.speechChoices(persona, reply.language, {}), after: reply.after }, signal);
      notices.push(speech.browserSpeech ? 'device' : ladder.rungOf(speech) ? 'backup' : '');
      return speech;
    } }, () => {});
  await conversation.start({ language: 'fr' });
  await utterance(new Blob(['sample']));
  assert.deepEqual(played, ['catalog-fr · Voici la première phrase de la réponse.', 'catalog-fr · Voici la deuxième phrase de la réponse.']);
  // The failed voice is asked once; the clause it dropped and the next one use the voice below it.
  assert.deepEqual(requested, ['example-clone · Voici la première phrase de la réponse.',
    'catalog-fr · Voici la première phrase de la réponse.', 'catalog-fr · Voici la deuxième phrase de la réponse.']);
  assert.equal(notices.at(-1), 'backup');
  assert.equal(conversation.state, 'listening');
  conversation.stop();
});
