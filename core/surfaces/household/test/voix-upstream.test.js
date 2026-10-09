'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoixUpstream } = require('../../../src/services/voice/voix-upstream');
const { registerTranscriptionProxy } = require('../../../src/services/voice/voix-transcription');
const { createSynthesisHandler } = require('../../../src/services/voice/voix-synthesis');
const { createScriptRelay } = require('../asset-relay');
const { BACKUP_NOTICE, upstreamNotice, composeNotice } = require('../public/voix-upstream-notice');

const PRIMARY = 'http://voice-primary.example.test';
const BACKUP = 'http://voice-backup.example.test';

function fakeFetch(health) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push(url);
    const result = typeof health === 'function' ? health(url, options) : health;
    if (result instanceof Error) throw result;
    return typeof result === 'number' ? new Response('', { status: result }) : result;
  };
  return { calls, impl };
}

function upstreamWith(health, { fallback = BACKUP, clock = { t: 0 }, probeTimeoutMs = 1500 } = {}) {
  const fetcher = fakeFetch(health);
  const upstream = createVoixUpstream({
    primaryUrl: () => PRIMARY, fallbackUrl: () => fallback,
    fetchImpl: fetcher.impl, now: () => clock.t, periodMs: 15_000, probeTimeoutMs
  });
  return { upstream, probes: fetcher.calls, clock };
}

test('without a backup the primary is used and never probed', async () => {
  const { upstream, probes } = upstreamWith(500, { fallback: '' });
  assert.deepEqual(await upstream.urlFor('/api/tts'), { url: `${PRIMARY}/api/tts`, upstream: 'primary' });
  assert.equal(probes.length, 0);
  assert.equal((await upstream.status()).fallbackConfigured, false);
});

test('a healthy probe is cached for its period, then refreshed in the background', async () => {
  let healthy = true;
  const { upstream, probes, clock } = upstreamWith(() => (healthy ? 200 : 503));
  assert.equal((await upstream.urlFor('/api/voices')).upstream, 'primary');
  clock.t = 14_000;
  assert.equal((await upstream.urlFor('/api/voices')).upstream, 'primary');
  assert.deepEqual(probes, [`${PRIMARY}/health`], 'one probe inside the period');
  healthy = false; clock.t = 16_000;
  assert.equal((await upstream.urlFor('/api/voices')).upstream, 'primary', 'stale result serves while refreshing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(probes.length, 2);
  assert.deepEqual(await upstream.urlFor('/api/voices'), { url: `${BACKUP}/api/voices`, upstream: 'fallback' });
  const status = await upstream.status();
  assert.equal(status.active, 'fallback');
  assert.equal(status.primaryHealthy, false);
});

test('a primary that never answers costs one probe timeout, not the request timeout', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const fetcher = fakeFetch(hang);
  const upstream = createVoixUpstream({ primaryUrl: () => PRIMARY, fallbackUrl: () => BACKUP,
    fetchImpl: fetcher.impl, probeTimeoutMs: 40 });
  const started = Date.now();
  const [first, second] = await Promise.all([upstream.urlFor('/api/tts'), upstream.urlFor('/v1/audio/transcriptions')]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(first.upstream, 'fallback');
  assert.equal(second.url, `${BACKUP}/v1/audio/transcriptions`);
  assert.equal(fetcher.calls.length, 1, 'concurrent requests share one probe');
});

test('a primary network error or 502/503/504 is retried once on the backup', async () => {
  for (const failure of [new TypeError('fetch failed'), 502, 503, 504]) {
    const { upstream } = upstreamWith(200);
    const attempts = [];
    const result = await upstream.send('/api/tts', async (url) => {
      attempts.push(url);
      if (url.startsWith(PRIMARY)) { if (failure instanceof Error) throw failure; return new Response('', { status: failure }); }
      return new Response('audio', { status: 200 });
    });
    assert.deepEqual(attempts, [`${PRIMARY}/api/tts`, `${BACKUP}/api/tts`]);
    assert.equal(result.upstream, 'fallback');
    assert.equal(result.response.status, 200);
    assert.equal((await upstream.urlFor('/api/tts')).upstream, 'fallback', 'the failure marks the primary down');
  }
});

test('4xx answers, backup failures and vetoed retries are not retried', async () => {
  const { upstream } = upstreamWith(200);
  const attempts = [];
  const notFound = await upstream.send('/api/voices', async (url) => { attempts.push(url); return new Response('', { status: 400 }); });
  assert.equal(notFound.upstream, 'primary');
  assert.equal(notFound.response.status, 400);
  assert.equal(attempts.length, 1);

  const vetoed = upstreamWith(200).upstream;
  await assert.rejects(vetoed.send('/api/tts', async () => { throw new Error('client gone'); }, { canRetry: () => false }), /client gone/);

  const down = upstreamWith(503).upstream;
  const tried = [];
  await assert.rejects(down.send('/api/tts', async (url) => { tried.push(url); throw new Error('backup down'); }), /backup down/);
  assert.deepEqual(tried, [`${BACKUP}/api/tts`], 'the backup is not retried on the unhealthy primary');
});

test('transcription answers name the upstream that transcribed', async () => {
  const routes = {};
  const router = { post: (path, _parser, handler) => { routes[path] = handler; } };
  const { upstream } = upstreamWith(200);
  registerTranscriptionProxy(router, {
    express: { raw: () => null }, normalizeMultipart: body => body, upstream, timeoutMs: () => 1000,
    fetchWithTimeout: async (url) => (url.startsWith(PRIMARY)
      ? new Response('', { status: 503 })
      : new Response('{"text":"bonjour"}', { status: 200, headers: { 'content-type': 'application/json' } })),
    fail: () => assert.fail('unexpected failure')
  });
  const res = { headers: {}, status(code) { this.code = code; return this; }, set(values) { Object.assign(this.headers, values); return this; },
    send(body) { this.body = body; return this; } };
  await routes['/transcribe']({ body: Buffer.from('RIFF'), get: () => 'audio/wav' }, res);
  assert.equal(res.code, 200);
  assert.equal(res.headers['X-Voix-Upstream'], 'fallback');
  assert.equal(res.body.toString(), '{"text":"bonjour"}');
});

test('synthesis answers carry X-Voix-Upstream', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response('RIFFaudio', { status: 200, headers: { 'content-type': 'audio/wav' } });
  const { upstream } = upstreamWith(200);
  const handler = createSynthesisHandler({ upstream, timeoutMs: () => 1000, cleanText: (v, max) => String(v || '').trim().slice(0, max),
    fail: () => assert.fail('unexpected failure') });
  const res = { headers: {}, status() { return this; }, set(name, value) {
    if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this;
  }, send(body) { this.body = body; return this; } };
  await handler({ body: { text: 'Bonjour', language: 'fr' }, path: '/synthesize' }, res);
  assert.equal(res.headers['X-Voix-Upstream'], 'primary');
  assert.equal(res.headers['Content-Type'], 'audio/wav');
});

test('the player relay reports the upstream that served it', async () => {
  const res = { headers: {}, type() { return this; }, set(name, value) { this.headers[name] = value; return this; }, send(body) { this.body = body; return this; } };
  const relay = createScriptRelay({ resolveUrl: () => `${PRIMARY}/assets/voice-audio.js`, unavailable: () => assert.fail('unavailable'),
    fetchUpstream: async () => ({ response: { ok: true, text: async () => 'window.VoixAudio = {};' }, upstream: 'fallback' }) });
  await relay({}, res);
  assert.equal(res.headers['X-Voix-Upstream'], 'fallback');
  assert.equal(res.body, 'window.VoixAudio = {};');
});

test('the conversation page mentions the slower backup only while it answers', () => {
  assert.equal(upstreamNotice('fallback'), BACKUP_NOTICE);
  assert.equal(upstreamNotice({ active: 'fallback' }), BACKUP_NOTICE);
  assert.equal(upstreamNotice('primary'), '');
  assert.equal(upstreamNotice(null), '');
  assert.match(BACKUP_NOTICE, /^Voix de secours \(serveur principal indisponible\) : réponses plus lentes\.$/);
  assert.equal(composeNotice('', 'primary'), '');
  assert.equal(composeNotice('Voix choisie indisponible : voix de secours.', 'fallback'),
    `Voix choisie indisponible : voix de secours. ${BACKUP_NOTICE}`);
});
