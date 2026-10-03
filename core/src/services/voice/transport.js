'use strict';

const { createVoixUpstream } = require('./voix-upstream');

// A deadline and the caller's cancellation cover both headers and body reads.
// A browser disconnect must never be replaced by a fresh backup request.
function fetchWithTimeout(url, options = {}, timeoutMs = 10000, fetchImpl = (...args) => fetch(...args)) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  return fetchImpl(url, { ...options, signal });
}

const sharedUpstreams = new Map();
function getVoiceUpstream({ baseUrl, fallbackUrl = '', fetchImpl } = {}) {
  if (!baseUrl && !fallbackUrl && !fetchImpl) {
    const key = 'instance';
    if (!sharedUpstreams.has(key)) sharedUpstreams.set(key, createVoixUpstream());
    return sharedUpstreams.get(key);
  }
  const options = { primaryUrl: () => baseUrl, fallbackUrl: () => fallbackUrl,
    ...(fetchImpl ? { fetchImpl } : {}) };
  // Injected clients are isolated test/extension dependencies, never cached.
  if (fetchImpl) return createVoixUpstream(options);
  const key = JSON.stringify([baseUrl, fallbackUrl]);
  if (!sharedUpstreams.has(key)) sharedUpstreams.set(key, createVoixUpstream(options));
  return sharedUpstreams.get(key);
}

const STATELESS = new Set(['/api/tts', '/api/tts/stream', '/api/voices', '/assets/voice-audio.js',
  '/v1/audio/transcriptions', '/v1/audio/transcriptions/controls']);

function createVoiceTransport({ baseUrl, fallbackUrl = '', timeoutMs = 10000, fetchImpl } = {}) {
  const instanceTarget = !fetchImpl && String(baseUrl || '').replace(/\/+$/, '') === String(process.env.VOIX_BASE_URL || '').replace(/\/+$/, '')
    && String(fallbackUrl || '').replace(/\/+$/, '') === String(process.env.VOIX_FALLBACK_URL || '').replace(/\/+$/, '');
  const upstream = getVoiceUpstream(instanceTarget ? {} : { baseUrl, fallbackUrl, fetchImpl });
  async function request(path, options = {}, deadlineMs = timeoutMs) {
    options.signal?.throwIfAborted();
    if (STATELESS.has(path)) {
      const result = await upstream.send(path,
        url => fetchWithTimeout(url, options, deadlineMs, fetchImpl),
        { canRetry: () => !options.signal?.aborted });
      return result.response;
    }
    // Sessions, configuration and native device state always belong to primary.
    return fetchWithTimeout(`${String(baseUrl).replace(/\/+$/, '')}${path}`, options, deadlineMs, fetchImpl);
  }
  return { request, upstream };
}

module.exports = { fetchWithTimeout, getVoiceUpstream, createVoiceTransport };
