'use strict';

// VoiX upstream client: Core's requests to the speech service.

const VOIX_TIMEOUT_MS = () => Math.max(1000, Number(process.env.VOIX_TIMEOUT_MS) || 10000);

const { fetchWithTimeout } = require('../../src/services/voice/transport');

function voixUrl(pathname) {
  const base = String(process.env.VOIX_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('VoiX is not configured for this instance'), { status: 503, code: 'VOIX_NOT_CONFIGURED' });
  return `${base}${pathname}`;
}

async function upstreamJson(pathname, options = {}, timeoutMs = VOIX_TIMEOUT_MS()) {
  return readUpstreamJson(await fetchWithTimeout(voixUrl(pathname), options, timeoutMs));
}

async function readUpstreamJson(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { response: text }; }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `VoiX returned HTTP ${response.status}`);
    error.status = response.status >= 500 ? 503 : response.status;
    error.code = 'VOIX_BAD_RESPONSE';
    throw error;
  }
  return body;
}

module.exports = { VOIX_TIMEOUT_MS, fetchWithTimeout, voixUrl, upstreamJson, readUpstreamJson };
