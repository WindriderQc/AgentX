const test = require('node:test');
const assert = require('node:assert/strict');
const { createNarrator } = require('../public/ecosystem-voice');
const { createSpeechLadder } = require('../../../public/js/voice/speech-ladder');
const PersonaPresentation = require('../../household/public/persona-presentation');

function harness({ status = 200, catalogStatus = 200 } = {}) {
  const requests = [], spoken = [];
  let abort;
  const env = { PersonaPresentation, AgentXSpeechLadder: { createSpeechLadder },
    AgentXVoice: { speakWithBrowser() {} }, speechSynthesis: {},
    VoixAudio: { Speech: class {
      cancel() { abort?.abort(); }
      async speak(fetchAudio) { abort = new AbortController(); const result = await fetchAudio(abort.signal, null, null); spoken.push(result); }
    } },
    async fetch(url, options) {
      requests.push({ url, options });
      if (url.endsWith('/catalog')) return { ok: catalogStatus === 200, status: catalogStatus,
        json: async () => ({ data: { personas: [{ id: 'nestor', voice: { provider: 'voxcpm', source: 'instance', voices: { fr: 'configured-voice' } } }] } }) };
      return { ok: status === 200, status };
    }
  };
  return { narrator: createNarrator(env), requests, spoken, signal: () => abort?.signal };
}

test('the tour resolves the installed Nestor voice and sends only the displayed French narration', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0, 'no speech or catalog request on page load');
  await h.narrator('Voici le composant.', new AbortController().signal);
  assert.deepEqual(h.requests.map(row => row.url), ['/api/voice-personas/catalog', '/api/voix/synthesize/stream']);
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { text: 'Voici le composant.', language: 'fr', voice: 'configured-voice', tts_provider: 'voxcpm' });
  await h.narrator('Étape suivante.', new AbortController().signal);
  assert.equal(h.requests.filter(row => row.url.endsWith('/catalog')).length, 1);
});

test('speech outage falls back to the device, while access refusals remain terminal', async () => {
  const h = harness({ status: 503 });
  await h.narrator('Bonjour.', new AbortController().signal);
  assert.deepEqual(h.spoken[0], { browserSpeech: { text: 'Bonjour.', language: 'fr' } });
  await assert.rejects(harness({ status: 403 }).narrator('Bonjour.', new AbortController().signal), /refused/);
  await assert.rejects(harness({ catalogStatus: 403 }).narrator('Bonjour.', new AbortController().signal), /refusé/);
});

test('a replaced step aborts pending synthesis and an already cancelled phrase never starts', async () => {
  const h = harness(), controller = new AbortController();
  controller.abort(); await h.narrator('Ancienne étape.', controller.signal);
  assert.equal(h.requests.length, 0);
  let release;
  const env = { PersonaPresentation, AgentXSpeechLadder: { createSpeechLadder }, AgentXVoice: {},
    VoixAudio: { Speech: class {
      cancel() { release?.(); }
      speak() { return new Promise(resolve => { release = resolve; }); }
    } }
  };
  const signal = new AbortController(), speaking = createNarrator(env)('Étape.', signal.signal);
  signal.abort(); await speaking;
});
