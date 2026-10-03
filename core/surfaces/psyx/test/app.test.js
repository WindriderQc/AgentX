'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

function config() {
  return {
    env: 'test', accessMode: 'token', accessToken: 'psyx-secret', sessionTtlMs: 3600000, loopbackBypass: false,
    maxBodyBytes: 262144, requestTimeoutMs: 1000, provider: 'ollama',
    voice: { mode: 'disabled', maxAudioBytes: 1024 * 1024 }
  };
}

function repositories(overrides = {}) {
  const empty = { userId: 'default', version: 2, revision: 0, activeThreads: [], notes: [], patterns: [], hypotheses: [], openLoops: [], experiments: [] };
  return {
    ping: async () => true,
    stateRepository: {
      read: async () => empty,
      addItem: async () => ({}), deleteItem: async () => ({}), addExperiment: async () => ({}), updateExperiment: async () => ({}), reset: async () => empty
    },
    conversationRepository: {
      listSessionMetadata: async () => [], listTranscripts: async () => [], listSessions: async () => [], getSession: async () => null,
      context: async () => [], saveCompletedTurn: async () => ({ id: '507f1f77bcf86cd799439011' }), rename: async () => null,
      archive: async () => null, restore: async () => null, permanentlyDelete: async () => false
    },
    close: async () => {},
    ...overrides
  };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('local speech forwards frames immediately and cancels synthesis when the listener leaves', async () => {
  let upstreamSignal, cancelled = false;
  const voice = { async stream(_body, signal) {
    upstreamSignal = signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('first\n')); }, cancel() { cancelled = true; } }),
      { headers: { 'Content-Type': 'application/x-ndjson', 'X-Voix-Provider': 'windows_sapi', 'X-Voix-Voice': 'Microsoft%20Claude' } });
  } };
  await withServer(createApp({ config: config(), database: repositories(), provider: {}, voice, logger: { error() {} } }), async base => {
    const abort = new AbortController();
    const response = await fetch(base + '/api/psyx/voice/synthesize/stream', { method: 'POST', signal: abort.signal,
      headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Bonjour' }) });
    assert.equal(response.headers.get('x-voix-voice'), 'Microsoft%20Claude');
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first\n');
    abort.abort();
    await new Promise(resolve => upstreamSignal.aborted ? resolve() : upstreamSignal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
  });
});

test('liveness is independent and readiness sanitizes dependency errors', async () => {
  const logs = [];
  const database = repositories({ ping: async () => { throw new Error('mongodb://user:secret@private-host'); } });
  const provider = { id: 'ollama', probe: async () => { throw new Error('http://private-ollama:11434 failed'); }, routing: async () => ({}), stream: async () => ({}) };
  const app = createApp({ config: config(), database, provider, logger: { error: (...args) => logs.push(args) } });
  await withServer(app, async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).data.status, 'alive');
    const ready = await fetch(`${base}/readyz`);
    const body = await ready.json();
    assert.equal(ready.status, 503);
    assert.equal(body.data.checks.database.code, 'unavailable');
    assert.equal(body.data.checks.provider.code, 'unavailable');
    assert.doesNotMatch(JSON.stringify(body), /private-host|private-ollama|secret/);
  });
  assert.equal(logs.length, 2);
});

test('protected status supports bearer automation without creating a cookie', async () => {
  const provider = { id: 'ollama', probe: async () => ({}), routing: async () => ({}), stream: async () => ({}) };
  await withServer(createApp({ config: config(), database: repositories(), provider, logger: { error() {} } }), async (base) => {
    assert.equal((await fetch(`${base}/api/psyx/status`)).status, 401);
    const response = await fetch(`${base}/api/psyx/status`, { headers: { Authorization: 'Bearer psyx-secret' } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.extension, 'psyx');
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

test('trusted-network mode serves protected APIs without a code and cannot be browser-locked', async () => {
  const provider = { id: 'ollama', probe: async () => ({}), routing: async () => ({}), stream: async () => ({}) };
  const trustedConfig = { ...config(), accessMode: 'trusted-network', accessToken: '' };
  await withServer(createApp({ config: trustedConfig, database: repositories(), provider, logger: { error() {} } }), async (base) => {
    const auth = await (await fetch(`${base}/api/psyx/auth/status`)).json();
    assert.equal(auth.data.unlocked, true);
    assert.equal(auth.data.accessMode, 'trusted-network');

    const status = await fetch(`${base}/api/psyx/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).data.privacy.protected, false);

    const locked = await (await fetch(`${base}/api/psyx/auth/lock`, { method: 'POST' })).json();
    assert.equal(locked.data.unlocked, true);
    assert.equal((await fetch(`${base}/api/psyx/status`)).status, 200);
  });
});

test('chat ignores browser transcript authority and persists only provider completion', async () => {
  let providerRequest;
  let saved;
  const database = repositories();
  database.conversationRepository.context = async () => [{ role: 'user', content: 'trusted prior' }];
  database.conversationRepository.saveCompletedTurn = async (value) => { saved = value; return { id: '507f1f77bcf86cd799439011' }; };
  const provider = {
    id: 'ollama', probe: async () => ({}), routing: async () => ({}),
    async stream(request, sink) { providerRequest = request; sink.onToken('safe answer'); return { content: 'safe answer', model: 'exact:model', routing: {} }; }
  };
  await withServer(createApp({ config: config(), database, provider, logger: { error() {} } }), async (base) => {
    const response = await fetch(`${base}/api/psyx/chat/stream`, {
      method: 'POST',
      headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: '507f1f77bcf86cd799439011', message: 'current', messages: [{ role: 'system', content: 'browser override' }],
        options: { model: 'other', num_ctx: 999999 }, psyx: { mode: 'talk', depth: 'normal' }
      })
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /event: done/);
  });
  assert.deepEqual(providerRequest.messages, [{ role: 'user', content: 'trusted prior' }]);
  assert.doesNotMatch(providerRequest.system, /browser override/);
  assert.deepEqual(providerRequest.options, { temperature: 0.7 });
  assert.equal(saved.assistantMessage, 'safe answer');
});

test('failed or incomplete inference never persists a turn', async () => {
  let saves = 0;
  const database = repositories();
  database.conversationRepository.saveCompletedTurn = async () => { saves += 1; };
  const provider = {
    id: 'ollama', probe: async () => ({}), routing: async () => ({}),
    async stream(_request, sink) { sink.onToken('unverified partial'); throw Object.assign(new Error('stream incomplete'), { code: 'STREAM_INCOMPLETE' }); }
  };
  await withServer(createApp({ config: config(), database, provider, logger: { error() {} } }), async (base) => {
    const response = await fetch(`${base}/api/psyx/chat/stream`, {
      method: 'POST', headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'current', psyx: { mode: 'talk', depth: 'normal' } })
    });
    assert.match(await response.text(), /event: error/);
  });
  assert.equal(saves, 0);
});

test('voice stays protected, permits this origin, and relays audio without persistence', async () => {
  const calls = [];
  const voice = {
    status: async () => ({ enabled: true, reachable: true }),
    config: async () => ({ language: 'fr', ttsProvider: 'kokoro' }),
    transcribe: async (buffer, options) => { calls.push({ kind: 'stt', size: buffer.length, options }); return { text: 'bonjour', language: 'fr' }; },
    synthesize: async (request) => {
      calls.push({ kind: 'tts', request });
      return {
        buffer: Buffer.from('RIFF'), contentType: 'audio/wav',
        applied: { ttsProvider: request.ttsProvider || null, language: request.language || null, voice: request.voice || null }
      };
    }
  };
  await withServer(createApp({ config: { ...config(), voice: { mode: 'voix', maxAudioBytes: 1024 * 1024 } }, database: repositories(), provider: { id: 'ollama', probe: async () => ({}), routing: async () => ({}), stream: async () => ({}) }, voice, logger: { error() {} } }), async (base) => {
    const page = await fetch(`${base}/psyx`);
    assert.match(page.headers.get('permissions-policy'), /microphone=\(self\)/);
    const html = await page.text();
    assert.match(html, /voice-preferences\.js/);
    // app.js calls functions declared by the voice, state, review, care and follow-up scripts, so they load first.
    assert.match(html, /voice-session\.js[^]*voice-controls\.js[^]*state-panel\.js[^]*review\.js[^]*care\.js[^]*follow-up\.js[^]*assets\/app\.js/);
    // setBusy in app.js re-syncs the voice session controls, so both scripts carry the same asset version.
    assert.equal(html.match(/voice-session\.js\?v=([\d.]+)/)[1], html.match(/assets\/app\.js\?v=([\d.]+)/)[1]);
    assert.equal((await fetch(`${base}/api/psyx/voice/status`)).status, 401);
    for (const asset of ['voice-preferences.js', 'voice-controls.js', 'state-panel.js', 'review.js', 'care.js', 'follow-up.js']) {
      assert.equal((await fetch(`${base}/psyx/assets/${asset}`)).status, 200);
    }

    const headers = { Authorization: 'Bearer psyx-secret' };
    const capabilities = await (await fetch(`${base}/api/psyx/status`, { headers })).json();
    assert.equal(capabilities.data.voice.requestScopedPreferences, true);
    assert.deepEqual(capabilities.data.voice.ttsProviders, ['kokoro', 'windows_sapi']);
    const status = await (await fetch(`${base}/api/psyx/voice/status`, { headers })).json();
    assert.equal(status.data.reachable, true);

    // The old global write path is gone: the UI can no longer change shared VoiX settings.
    const patch = await fetch(`${base}/api/psyx/voice/config`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en', ttsProvider: 'windows_sapi' })
    });
    assert.equal(patch.status, 404);

    const transcript = await (await fetch(`${base}/api/psyx/voice/transcribe`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'audio/webm', 'X-PsyX-Language': 'fr' }, body: Buffer.from('audio')
    })).json();
    assert.equal(transcript.data.text, 'bonjour');
    const speech = await fetch(`${base}/api/psyx/voice/synthesize`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'salut', ttsProvider: 'kokoro', language: 'fr', voice: 'ff_siwis' })
    });
    assert.equal(speech.headers.get('content-type'), 'audio/wav');
    assert.equal(speech.headers.get('x-psyx-tts-provider'), 'kokoro');
    assert.equal(speech.headers.get('x-psyx-tts-language'), 'fr');
    assert.equal(speech.headers.get('x-psyx-tts-voice'), 'ff_siwis');
    assert.equal(await speech.text(), 'RIFF');
    const native = await fetch(`${base}/api/psyx/voice/synthesize`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'salut' })
    });
    assert.equal(native.status, 200);
    assert.equal(native.headers.get('x-psyx-tts-provider'), null);
  });
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.deepEqual(calls, [
    { kind: 'stt', size: 5, options: { contentType: 'audio/webm', language: 'fr', signal: calls[0].options.signal } },
    { kind: 'tts', request: { text: 'salut', ttsProvider: 'kokoro', language: 'fr', voice: 'ff_siwis' } },
    { kind: 'tts', request: { text: 'salut', ttsProvider: undefined, language: undefined, voice: undefined } }
  ]);
});

test('two browsers with different voice preferences never overwrite each other or VoiX defaults', async () => {
  const { createVoiceClient } = require('../src/voice');
  const http = require('node:http');
  const voixConfig = { config: { language: 'fr', tts_provider: 'kokoro' }, static: { whisper_model: 'small', kokoro_voice: 'ff_siwis', tts_language_profiles: [{ language: 'fr', locale: 'fr-fr', voice: 'ff_siwis' }, { language: 'en', locale: 'en-us', voice: 'af_heart' }] } };
  const voix = { configWrites: 0, tts: [] };
  const fakeVoix = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', version: '2.3.0-test' }));
      if (req.method === 'GET' && req.url === '/devices') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ devices: [] }));
      if (req.method === 'GET' && req.url === '/config') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(voixConfig));
      if (req.method === 'POST' && req.url === '/config') { voix.configWrites += 1; return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(voixConfig)); }
      if (req.method === 'POST' && req.url === '/api/tts') { voix.tts.push(JSON.parse(raw)); return res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(Buffer.from('RIFF')); }
      return res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => fakeVoix.listen(0, '127.0.0.1', resolve));
  const voiceConfig = { mode: 'voix', baseUrl: `http://127.0.0.1:${fakeVoix.address().port}`, timeoutMs: 2000, longTimeoutMs: 2000, maxAudioBytes: 1024 * 1024 };
  const app = createApp({
    config: { ...config(), voice: voiceConfig }, database: repositories(),
    provider: { id: 'ollama', probe: async () => ({}), routing: async () => ({}), stream: async () => ({}) },
    voice: createVoiceClient({ voice: voiceConfig }), logger: { error() {} }
  });
  try {
    await withServer(app, async (base) => {
      const headers = { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' };
      const speak = (body) => fetch(`${base}/api/psyx/voice/synthesize`, { method: 'POST', headers, body: JSON.stringify(body) });
      const browserA = { ttsProvider: 'kokoro', language: 'fr', voice: 'ff_siwis' };
      const browserB = { ttsProvider: 'windows_sapi', language: 'en', voice: 'Microsoft David' };
      const first = await speak({ text: 'bonjour', ...browserA });
      const second = await speak({ text: 'hello', ...browserB });
      const third = await speak({ text: 'encore', ...browserA });
      assert.deepEqual([first.status, second.status, third.status], [200, 200, 200]);
      assert.equal(second.headers.get('x-psyx-tts-provider'), 'windows_sapi');
      assert.equal(second.headers.get('x-psyx-tts-language'), 'en');
      const status = await (await fetch(`${base}/api/psyx/voice/status`, { headers })).json();
      assert.equal(status.data.config.ttsProvider, 'kokoro');
      assert.equal(status.data.config.ttsLanguageProfiles[1].voice, 'af_heart');
    });
  } finally {
    await new Promise((resolve) => fakeVoix.close(resolve));
  }
  assert.equal(voix.configWrites, 0);
  assert.deepEqual(voix.tts, [
    { text: 'bonjour', save: false, response_format: 'wav', tts_provider: 'kokoro', language: 'fr', voice: 'ff_siwis' },
    { text: 'hello', save: false, response_format: 'wav', tts_provider: 'windows_sapi', language: 'en', voice: 'Microsoft David' },
    { text: 'encore', save: false, response_format: 'wav', tts_provider: 'kokoro', language: 'fr', voice: 'ff_siwis' }
  ]);
});

test('namespaced chat and routing endpoints support the LAN HTTPS proxy', async () => {
  const provider = {
    id: 'ollama', probe: async () => ({}), routing: async () => ({ taskModels: {} }),
    async stream(_request, sink) { sink.onToken('answer'); return { content: 'answer', model: 'exact:model', routing: {} }; }
  };
  await withServer(createApp({ config: config(), database: repositories(), provider, logger: { error() {} } }), async (base) => {
    const headers = { Authorization: 'Bearer psyx-secret' };
    assert.equal((await fetch(`${base}/api/psyx/routing`, { headers })).status, 200);
    const response = await fetch(`${base}/api/psyx/chat/stream`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hello' })
    });
    assert.match(await response.text(), /event: done/);
  });
});

test('configuration reports gateway access without disclosing the code and keeps frontier disabled', async () => {
  const accessAuth = {
    isLoopback: () => true, configured: () => true,
    requireSession: (_req, res, next) => { res.locals.psyxUserId = 'gateway-owner'; next(); }
  };
  await withServer(createApp({ config: { ...config(), accessToken: '' }, database: repositories(), provider: {}, accessAuth }), async base => {
    const status = (await (await fetch(`${base}/api/psyx/status`)).json()).data;
    assert.equal(status.privacy.configured, true);
    assert.equal(status.privacy.protected, true);
    assert.deepEqual(status.frontier, { supported: false, enabled: false, location: 'local' });
    assert.equal(status.voice.enabled, false);
    assert.doesNotMatch(JSON.stringify(status), /psyx-secret/);
  });
});

test('memory corrections use authenticated ownership, stay protected, and serve both new views', async () => {
  const calls = [];
  const database = repositories();
  database.stateRepository.updateItem = async (...args) => { calls.push(args); return { state: {} }; };
  await withServer(createApp({ config: config(), database, provider: {} }), async base => {
    const url = `${base}/api/psyx/state/items/patterns/item`;
    assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const changes = { text: 'Synthetic correction', expectedRevision: 2, userId: 'another-owner' };
    assert.equal((await fetch(url, { method: 'PATCH', headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' }, body: JSON.stringify(changes) })).status, 200);
    assert.equal(calls[0][0], 'default');
    assert.equal(calls[0][1], 'patterns');
    for (const asset of ['formulation.js', 'setup.js']) assert.equal((await fetch(`${base}/psyx/assets/${asset}`)).status, 200);
    const html = await (await fetch(`${base}/psyx`)).text();
    assert.match(html, /Comment psyX te comprend/);
    assert.match(html, /Configuration de psyX/);
  });
});

test('closing private speech recognition cancels VoiX before any late transcript is returned', async () => {
  let signal;
  const voice = { transcribe: async (_bytes, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } };
  await withServer(createApp({ config: config(), database: repositories(), provider: {}, voice, logger: { error() {} } }), async base => {
    const abort = new AbortController();
    const pending = fetch(base + '/api/psyx/voice/transcribe', { method: 'POST', signal: abort.signal,
      headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'audio/wav' }, body: 'synthetic WAV' });
    while (!signal) await new Promise(resolve => setImmediate(resolve));
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); await aborted;
    assert.equal(signal.aborted, true);
  });
});

test('a failed speech engine is reported before private stream audio headers', async () => {
  const voice = { stream: async () => new Response('{"type":"error","message":"private engine details"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } }) };
  await withServer(createApp({ config: config(), database: repositories(), provider: {}, voice, logger: { error() {} } }), async base => {
    const response = await fetch(base + '/api/psyx/voice/synthesize/stream', { method: 'POST',
      headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Bonjour' }) });
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.doesNotMatch(await response.text(), /private engine details/);
  });
});

test('closing buffered private synthesis cancels VoiX as well', async () => {
  let signal;
  const voice = { synthesize: async (_request, requestSignal) => {
    signal = requestSignal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  await withServer(createApp({ config: config(), database: repositories(), provider: {}, voice, logger: { error() {} } }), async base => {
    const abort = new AbortController();
    const pending = fetch(base + '/api/psyx/voice/synthesize', { method: 'POST', signal: abort.signal,
      headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Bonjour' }) }).catch(error => error);
    while (!signal) await new Promise(resolve => setImmediate(resolve));
    const stopped = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    abort.abort(); await stopped; await pending;
    assert.equal(signal.aborted, true);
  });
});
