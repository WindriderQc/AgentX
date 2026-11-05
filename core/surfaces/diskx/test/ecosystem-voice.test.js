const test = require('node:test');
const assert = require('node:assert/strict');
const { createNarrator, bindConversation } = require('../public/ecosystem-voice');
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

test('the guide uses the shared French female voice without reading or mutating Nestor preferences', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0, 'no speech or catalog request on page load');
  await h.narrator('Voici le composant.', new AbortController().signal);
  assert.deepEqual(h.requests.map(row => row.url), ['/api/voix/synthesize/stream']);
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { text: 'Voici le composant.', language: 'fr', voice: 'ff_siwis', tts_provider: 'kokoro' });
  await h.narrator('Étape suivante.', new AbortController().signal);
  assert.equal(h.requests.filter(row => row.url.endsWith('/catalog')).length, 0);
});

test('speech outage falls back to the device, while access refusals remain terminal', async () => {
  const h = harness({ status: 503 });
  await h.narrator('Bonjour.', new AbortController().signal);
  assert.deepEqual(h.spoken[0], { browserSpeech: { text: 'Bonjour.', language: 'fr' } });
  await assert.rejects(harness({ status: 403 }).narrator('Bonjour.', new AbortController().signal), /refused/);
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
  await Promise.resolve(); signal.abort(); await speaking;
});

test('embedded guides wait until visible and idle, and questions never resume them automatically', () => {
  const calls = [];
  const view = { tour: { conversation: busy => calls.push(['busy', busy]), play: () => calls.push(['play']) } };
  const guide = bindConversation(view, { embedded: true });
  assert.deepEqual(calls, [['busy', true]]);
  guide.update({ visible: true, busy: true });
  assert.equal(calls.some(row => row[0] === 'play'), false);
  guide.update({ visible: true, busy: false });
  assert.equal(calls.filter(row => row[0] === 'play').length, 1);
  guide.pause(); guide.update({ visible: true, busy: true }); guide.update({ visible: true, busy: false });
  assert.equal(calls.filter(row => row[0] === 'play').length, 1, 'answer completion leaves manual resume available');
  guide.update({ visible: false, busy: false });
  assert.deepEqual(calls.at(-1), ['busy', true]);
});

test('a browser autoplay lock opens no synthesis request and a later gesture can retry', async () => {
  const calls = [];
  let allowed = false;
  const env = { AgentXVoice: {}, AgentXSpeechLadder: { createSpeechLadder },
    AudioContext: class { state = allowed ? 'running' : 'suspended'; resume() { return allowed ? Promise.resolve() : new Promise(() => {}); } async close() {} },
    VoixAudio: { Speech: class { async speak() { calls.push('speech'); } cancel() {} } }
  };
  const narrator = createNarrator(env);
  await assert.rejects(narrator('Bonjour.', new AbortController().signal), { name: 'NotAllowedError' });
  assert.deepEqual(calls, []);
  allowed = true; await narrator('Bonjour.', new AbortController().signal);
  assert.deepEqual(calls, ['speech']);
});
