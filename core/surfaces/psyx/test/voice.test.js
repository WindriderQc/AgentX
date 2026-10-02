'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceClient, normalizeSynthesisRequest, sanitizeConfig, sanitizeDevices } = require('../src/voice');

const VOICE_CONFIG = { voice: { mode: 'voix', baseUrl: 'http://voix:8091', timeoutMs: 1000, longTimeoutMs: 1000 } };

function recordingFetch(requests, { status = 200, contentType = 'audio/wav', body = 'RIFF' } = {}) {
  return async (url, options = {}) => {
    requests.push({ path: new URL(url).pathname, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    return new Response(body, { status, headers: { 'Content-Type': contentType } });
  };
}

test('voice status exposes only the bounded PsyX contract', async () => {
  const responses = {
    '/health': { status: 'ok', version: '2.3.0-m36', running: false, secret: 'hidden' },
    '/config': {
      config: { brain: 'private', language: 'fr', tts_provider: 'kokoro' },
      static: {
        whisper_model: 'small', kokoro_voice: 'ff_siwis', llm_configured: true,
        tts_language_profiles: [{ language: 'en', locale: 'en-us', voice: 'af_heart' }, { language: 'fr', locale: 'fr-fr', voice: 'ff_siwis' }, { language: 'xx', voice: 'nope' }]
      }
    },
    '/devices': { devices: [{ index: 1, name: 'Mic', max_input_channels: 1, max_output_channels: 0, default_input: true }] }
  };
  const client = createVoiceClient(VOICE_CONFIG, async (url) => {
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(responses[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const status = await client.status();
  assert.equal(status.config.language, 'fr');
  assert.equal(status.config.ttsProvider, 'kokoro');
  assert.deepEqual(status.config.ttsLanguageProfiles, [
    { language: 'en', locale: 'en-us', voice: 'af_heart' },
    { language: 'fr', locale: 'fr-fr', voice: 'ff_siwis' }
  ]);
  assert.equal(status.devices[0].name, 'Mic');
  assert.doesNotMatch(JSON.stringify(status), /private|secret|llm_configured|nope/);
});

test('PsyX has no path that writes the shared VoiX configuration', async () => {
  const requests = [];
  const client = createVoiceClient(VOICE_CONFIG, recordingFetch(requests));
  assert.equal(typeof client.updateConfig, 'undefined');
  assert.deepEqual(Object.keys(client).sort(), ['catalog', 'config', 'enabled', 'player', 'status', 'stream', 'synthesize', 'transcribe']);
  await client.synthesize({ text: 'bonjour', ttsProvider: 'windows_sapi', language: 'fr' });
  assert.deepEqual(requests.map((item) => `${item.method} ${item.path}`), ['POST /api/tts']);
});

test('voice sanitizers omit internal service configuration', () => {
  assert.deepEqual(sanitizeConfig({ config: { brain: 'nestor', language: 'en', tts_provider: 'kokoro' }, static: { whisper_model: 'small' } }), {
    language: 'en', inputDevice: '', outputDevice: '', ttsProvider: 'kokoro', ttsVoice: '', ttsLanguageProfiles: [], whisperModel: 'small', running: false, applies: null
  });
  assert.deepEqual(sanitizeDevices({ devices: [{ index: 4, name: 'Speaker', max_input_channels: 0, max_output_channels: 2 }] }), [{
    index: 4, name: 'Speaker', input: false, output: true, defaultInput: false, defaultOutput: false
  }]);
});

test('synthesis carries the request-scoped engine, language and voice for Kokoro', async () => {
  const requests = [];
  const client = createVoiceClient(VOICE_CONFIG, recordingFetch(requests));
  const result = await client.synthesize({ text: '  Bonjour  ', ttsProvider: 'Kokoro', language: 'FR', voice: 'af_heart:0.6+ff_siwis:0.4' });
  assert.deepEqual(requests, [{
    path: '/api/tts', method: 'POST',
    body: { text: 'Bonjour', save: false, response_format: 'wav', tts_provider: 'kokoro', language: 'fr', voice: 'af_heart:0.6+ff_siwis:0.4' }
  }]);
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.buffer.toString(), 'RIFF');
  assert.deepEqual(result.applied, { ttsProvider: 'kokoro', language: 'fr', voice: 'af_heart:0.6+ff_siwis:0.4' });
});

test('Windows SAPI requests preserve their own language and installed voice', async () => {
  const requests = [];
  const client = createVoiceClient(VOICE_CONFIG, recordingFetch(requests));
  const result = await client.synthesize({ text: 'Hello', ttsProvider: 'windows_sapi', language: 'en', voice: 'Microsoft David' });
  assert.deepEqual(requests[0].body, { text: 'Hello', save: false, response_format: 'wav', tts_provider: 'windows_sapi', language: 'en', voice: 'Microsoft David' });
  assert.deepEqual(result.applied, { ttsProvider: 'windows_sapi', language: 'en', voice: 'Microsoft David' });
});

test('an omitted engine keeps the native VoiX request shape', async () => {
  const requests = [];
  const client = createVoiceClient(VOICE_CONFIG, recordingFetch(requests));
  await client.synthesize({ text: 'Hello', language: 'en', voice: 'af_heart' });
  await client.synthesize('Salut');
  assert.deepEqual(requests.map((item) => item.body), [
    { text: 'Hello', save: false, response_format: 'wav' },
    { text: 'Salut', save: false, response_format: 'wav' }
  ]);
  assert.deepEqual(normalizeSynthesisRequest({ text: 'x' }), { text: 'x', save: false, response_format: 'wav' });
});

test('invalid request preferences are rejected before reaching VoiX', async () => {
  const requests = [];
  const client = createVoiceClient(VOICE_CONFIG, recordingFetch(requests));
  const cases = [
    [{ text: 'x', ttsProvider: 'cloud' }, 'PSYX_VOICE_INVALID_CONFIG', /ttsProvider/],
    [{ text: 'x', ttsProvider: 'kokoro', language: 'de' }, 'PSYX_VOICE_INVALID_CONFIG', /language/],
    [{ text: 'x', ttsProvider: 'kokoro', voice: 'af_heart; rm -rf /' }, 'PSYX_VOICE_INVALID_CONFIG', /voice/],
    [{ text: 'x', ttsProvider: 'kokoro', voice: 'a'.repeat(121) }, 'PSYX_VOICE_INVALID_CONFIG', /voice/],
    [{ text: '   ', ttsProvider: 'kokoro' }, 'PSYX_VOICE_TEXT_REQUIRED', /text/],
    [{}, 'PSYX_VOICE_TEXT_REQUIRED', /text/]
  ];
  for (const [request, code, message] of cases) {
    await assert.rejects(() => client.synthesize(request), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, message);
      return true;
    });
  }
  await assert.rejects(() => client.synthesize({ text: 'x'.repeat(50001) }), (error) => error.code === 'PSYX_VOICE_TEXT_TOO_LARGE' && error.statusCode === 413);
  assert.equal(requests.length, 0);
});

test('a VoiX rejection of a request preference surfaces as a bounded error without silent fallback', async () => {
  const requests = [];
  const client = createVoiceClient(VOICE_CONFIG, recordingFetch(requests, {
    status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'per-request language and voice selection requires TTS_PROVIDER=kokoro' })
  }));
  await assert.rejects(() => client.synthesize({ text: 'Hello', ttsProvider: 'kokoro', language: 'en' }), (error) => {
    assert.equal(error.code, 'PSYX_VOICE_UPSTREAM_ERROR');
    assert.equal(error.statusCode, 400);
    assert.doesNotMatch(error.message, /TTS_PROVIDER/);
    return true;
  });
  assert.equal(requests.length, 1, 'no retry with a different engine');

  const offline = createVoiceClient(VOICE_CONFIG, async () => { throw new Error('ECONNREFUSED 192.0.2.12:8091'); });
  await assert.rejects(() => offline.synthesize({ text: 'Hello', ttsProvider: 'kokoro' }), (error) => {
    assert.equal(error.code, 'PSYX_VOICE_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.doesNotMatch(error.message, /192\.168/);
    return true;
  });

  const disabled = createVoiceClient({ voice: { mode: 'disabled' } }, async () => { throw new Error('must not be called'); });
  await assert.rejects(() => disabled.synthesize({ text: 'Hello', ttsProvider: 'kokoro' }), (error) => error.code === 'PSYX_VOICE_DISABLED');
});

test('two independently configured clients share VoiX without touching each other', async () => {
  const requests = [];
  const shared = recordingFetch(requests);
  const browserA = createVoiceClient(VOICE_CONFIG, shared);
  const browserB = createVoiceClient(VOICE_CONFIG, shared);
  await browserA.synthesize({ text: 'un', ttsProvider: 'kokoro', language: 'fr', voice: 'ff_siwis' });
  await browserB.synthesize({ text: 'two', ttsProvider: 'windows_sapi', language: 'en' });
  await browserA.synthesize({ text: 'deux', ttsProvider: 'kokoro', language: 'fr', voice: 'ff_siwis' });
  assert.deepEqual(requests.map((item) => [item.method, item.path, item.body.tts_provider, item.body.language || null, item.body.voice || null]), [
    ['POST', '/api/tts', 'kokoro', 'fr', 'ff_siwis'],
    ['POST', '/api/tts', 'windows_sapi', 'en', null],
    ['POST', '/api/tts', 'kokoro', 'fr', 'ff_siwis']
  ]);
  assert.equal(requests.some((item) => item.path === '/config' && item.method !== 'GET'), false);
});

test('hands-free WAV capture keeps its format and cancellation through the local transcription adapter', async () => {
  const abort = new AbortController(); let upstream;
  const client = createVoiceClient(VOICE_CONFIG, async (url, options) => {
    upstream = options;
    assert.ok(url.endsWith('/v1/audio/transcriptions'));
    assert.equal(options.body.get('file').name, 'recording.wav');
    assert.equal(options.body.get('file').type, 'audio/wav');
    assert.equal(options.body.get('language'), 'fr');
    return new Response(JSON.stringify({ text: 'Bonjour', language: 'fr' }));
  });
  const transcript = await client.transcribe(Buffer.from('synthetic PCM'), { contentType: 'audio/wav', language: 'fr', signal: abort.signal });
  assert.equal(transcript.text, 'Bonjour');
  assert.equal(upstream.signal.aborted, false);
  abort.abort(); assert.equal(upstream.signal.aborted, true);
});
