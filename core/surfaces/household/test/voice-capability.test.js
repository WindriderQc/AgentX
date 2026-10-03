'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const http = require('node:http');
const { speechText } = require('../../../public/js/voice/speech-language');
const { fetchWithTimeout, createVoiceTransport, getVoiceUpstream } = require('../../../src/services/voice/transport');
const { normalizeSynthesisRequest } = require('../../../src/services/voice/request');
const { relaySynthesisStream } = require('../../../src/services/voice/stream');
const { registerTranscriptionProxy } = require('../../../src/services/voice/voix-transcription');
const { createSynthesisHandler } = require('../../../src/services/voice/voix-synthesis');
const { createVoiceClient } = require('../../psyx/src/voice');

const config = { voice: { mode: 'voix', baseUrl: 'http://voice.test', timeoutMs: 1000, longTimeoutMs: 1000 } };
const sample = '**Bonjour.** [Une piste](https://example.test)\n```js\nprivate_code();\n```\n| Nom | Valeur |\n| --- | --- |\n| clé | secret |\n<img src="private">\n911, 9-8-8, 1 866 APPELLE et 811.';

function sink() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.headers = {};
  res.set = (name, value) => { if (typeof name === 'object') Object.assign(res.headers, name); else res.headers[name] = value; return res; };
  res.status = () => res;
  res.send = buffer => { res.buffer = buffer; return res; };
  res.bytes = () => Buffer.concat(chunks);
  return res;
}

test('Core speech cleanup removes screen markup and preserves crisis resources and prose', () => {
  const text = speechText(sample);
  assert.match(text, /Bonjour\. Une piste/);
  assert.match(text, /911, 9-8-8, 1 866 APPELLE et 811\./);
  assert.doesNotMatch(text, /private|secret|https|Valeur|img|\|/);
  assert.equal(speechText(text), text);
  assert.equal(speechText('Avant.\n```js\nunfinished();'), 'Avant.');
  assert.equal(speechText('Deux mots : x | y.'), 'Deux mots : x | y.');
  assert.equal(speechText('2 < 3 et 5 > 4.'), '2 < 3 et 5 > 4.');
  assert.equal(speechText('Avant.\n~~~sh\nsecret\n~~~\nAprès.'), 'Avant.\n\nAprès.');
});

test('Household and PsyX send the same Core-cleaned text and installed Canadian voice', async t => {
  const calls = [];
  const fetchImpl = async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response('RIFF'); };
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = fetchImpl;
  const handler = createSynthesisHandler({ upstream: { send: async (_path, attempt) => ({ response: await attempt('http://voice.test/api/tts'), upstream: 'primary' }) },
    timeoutMs: () => 1000, cleanText: value => String(value || '').trim(), fail: () => assert.fail('unexpected failure') });
  await handler({ body: { text: sample, language: 'fr', voice: 'Microsoft Caroline', tts_provider: 'windows_sapi' }, path: '/synthesize' }, sink());
  await createVoiceClient(config, fetchImpl).synthesize({ text: sample, language: 'fr', voice: 'Microsoft Caroline', ttsProvider: 'windows_sapi' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, calls[1].text);
  for (const payload of calls) {
    assert.equal(payload.voice, 'Microsoft Caroline'); assert.equal(payload.save, false);
    assert.equal(payload.language, 'fr'); assert.equal(payload.tts_provider, 'windows_sapi');
    assert.doesNotMatch(payload.text, /private_code|secret|https/);
  }
});

test('a missing spoken body is rejected before calling an engine', () => {
  assert.throws(() => normalizeSynthesisRequest({ text: '```js\nprivate();\n```' }), { code: 'VOICE_TEXT_REQUIRED' });
  assert.throws(() => normalizeSynthesisRequest({ text: 'Bonjour', ttsProvider: 'windows_sapi', voice: 'x;bad' }), { code: 'VOICE_INVALID_CONFIG' });
});

test('transport preserves caller cancellation and never retries it on backup', async () => {
  const abort = new AbortController(), calls = [];
  const transport = createVoiceTransport({ baseUrl: 'http://primary.test', fallbackUrl: 'http://backup.test', fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/health')) return new Response('{}');
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const pending = transport.request('/api/tts', { signal: abort.signal });
  while (calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(calls, ['http://primary.test/health', 'http://primary.test/api/tts']);
});

test('an already stopped request never probes or calls either voice host', async () => {
  let calls = 0;
  const transport = createVoiceTransport({ baseUrl: 'http://primary.test', fallbackUrl: 'http://backup.test', fetchImpl: async () => { calls++; } });
  await assert.rejects(transport.request('/api/tts', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('stateless audio uses backup while device and session state remains on primary', async () => {
  const calls = [];
  const transport = createVoiceTransport({ baseUrl: 'http://primary.test', fallbackUrl: 'http://backup.test', fetchImpl: async url => {
    calls.push(url); return new Response('{}', { status: url.endsWith('/health') ? 503 : 200 });
  } });
  await transport.request('/v1/audio/transcriptions');
  await transport.request('/config');
  await transport.request('/sessions/status');
  assert.deepEqual(calls, ['http://primary.test/health', 'http://backup.test/v1/audio/transcriptions', 'http://primary.test/config', 'http://primary.test/sessions/status']);
});

test('instance surfaces reuse the same health and backup selection', t => {
  const before = process.env.VOIX_BASE_URL;
  process.env.VOIX_BASE_URL = 'http://voice.test';
  t.after(() => { if (before === undefined) delete process.env.VOIX_BASE_URL; else process.env.VOIX_BASE_URL = before; });
  assert.equal(createVoiceTransport({ baseUrl: process.env.VOIX_BASE_URL, fallbackUrl: process.env.VOIX_FALLBACK_URL }).upstream, getVoiceUpstream());
});

test('the deadline cancels a response body stalled after HTTP headers', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.write('RIFF'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetchWithTimeout(`http://127.0.0.1:${server.address().port}`, {}, 500);
  await assert.rejects(response.arrayBuffer(), error => error.name === 'AbortError' || error.name === 'TimeoutError');
});

test('shared stream relay rejects engine errors before committing audio headers', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{"type":"error","message":"private engine failure"}\n')); }, cancel() { cancelled = true; } }));
  const res = sink();
  await assert.rejects(relaySynthesisStream(response, res), { code: 'VOICE_SYNTHESIS_FAILED', statusCode: 503 });
  assert.equal(cancelled, true); assert.deepEqual(res.headers, {}); assert.equal(res.bytes().length, 0);
});

test('shared stream relay preserves original frames and acknowledged voice', async () => {
  const bytes = '{"type":"meta","sample_rate":24000}\n{"type":"audio","pcm":"AAAA"}\n';
  const res = sink();
  await relaySynthesisStream(new Response(bytes, { headers: { 'content-type': 'application/x-ndjson', 'x-voix-voice': 'Microsoft%20Caroline' } }), res);
  assert.equal(res.bytes().toString(), bytes);
  assert.equal(res.headers['x-voix-voice'], 'Microsoft%20Caroline'); assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('disconnect before the first frame cancels a waiting reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const res = sink(); const pending = relaySynthesisStream(response, res);
  res.destroy();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('Household recognition cancels on disconnect, suppresses fallback and removes its close listener', async () => {
  let handler, signal, retry;
  registerTranscriptionProxy({ post: (_path, _parser, fn) => { handler = fn; } }, {
    express: { raw: () => null }, normalizeMultipart: body => body, timeoutMs: () => 1000,
    upstream: { send: async (_path, attempt, options) => { retry = options.canRetry; return { response: await attempt('http://voice.test'), upstream: 'primary' }; } },
    fetchWithTimeout: async (_url, options) => { signal = options.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
    fail: () => assert.fail('a departed caller receives no error response') });
  const res = new EventEmitter();
  const pending = handler({ body: Buffer.from('RIFF'), get: () => 'audio/wav' }, res);
  assert.equal(res.listenerCount('close'), 1); res.emit('close'); await pending;
  assert.equal(signal.aborted, true); assert.equal(retry(), false); assert.equal(res.listenerCount('close'), 0);
});
