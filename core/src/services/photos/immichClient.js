'use strict';

// Minimal Immich HTTP client. Core holds the only Immich credential: callers
// reach photos through /api/photos and never see the key. The key file is read
// at each use so a rotated key needs no restart.

const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function photoError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function immichSettings(env = process.env) {
  const url = String(env.IMMICH_URL || '').trim().replace(/\/+$/, '');
  const keyFile = String(env.IMMICH_API_KEY_FILE || '').trim();
  return {
    enabled: Boolean(url && keyFile),
    url,
    keyFile,
    timeoutMs: clampInt(env.IMMICH_TIMEOUT_MS, 1000, 60_000, DEFAULT_TIMEOUT_MS),
    descriptionWriteEnabled: String(env.IMMICH_DESCRIPTION_WRITE_ENABLED || '').trim() === 'true',
  };
}

// The file holds either the bare key or JSON with a `key` field.
function readApiKey(keyFile, readFile = fs.readFileSync) {
  let text;
  try {
    text = String(readFile(keyFile, 'utf8')).trim();
  } catch {
    throw photoError(503, 'PHOTOS_KEY_UNAVAILABLE', 'The Immich key file cannot be read');
  }
  let key = text;
  if (text.startsWith('{')) {
    try { key = String(JSON.parse(text).key || '').trim(); } catch { key = ''; }
  }
  if (!key || /\s/.test(key)) throw photoError(503, 'PHOTOS_KEY_UNAVAILABLE', 'The Immich key file holds no usable key');
  return key;
}

async function readBounded(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw photoError(502, 'PHOTOS_UPSTREAM_TOO_LARGE', 'Immich answer is larger than Core accepts');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > limit) throw photoError(502, 'PHOTOS_UPSTREAM_TOO_LARGE', 'Immich answer is larger than Core accepts');
  return body;
}

function upstreamError(status) {
  if (status === 404 || status === 400) return photoError(404, 'PHOTOS_NOT_FOUND', 'Immich has no such item');
  if (status === 401 || status === 403) {
    return photoError(502, 'PHOTOS_UPSTREAM_FORBIDDEN', 'The Immich key lacks the permission for this request');
  }
  return photoError(502, 'PHOTOS_UPSTREAM_ERROR', `Immich answered HTTP ${status}`);
}

function createImmichClient({ env = process.env, fetchImpl = globalThis.fetch, readFile } = {}) {
  const settings = () => immichSettings(env);

  async function send(path, { method = 'GET', body, accept = 'application/json', limit = MAX_JSON_BYTES } = {}) {
    const current = settings();
    if (!current.enabled) throw photoError(503, 'PHOTOS_NOT_CONFIGURED', 'Photos are not configured on this instance');
    const key = readApiKey(current.keyFile, readFile);
    let response;
    try {
      response = await fetchImpl(`${current.url}/api${path}`, {
        method,
        headers: {
          'x-api-key': key,
          accept,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(current.timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw photoError(504, 'PHOTOS_UPSTREAM_TIMEOUT', 'Immich did not answer in time');
      }
      throw photoError(502, 'PHOTOS_UPSTREAM_UNREACHABLE', 'Immich is unreachable');
    }
    if (!response.ok) throw upstreamError(response.status);
    return { response, bytes: await readBounded(response, limit) };
  }

  return {
    settings,
    async json(path, options) {
      const { bytes } = await send(path, options);
      if (!bytes.length) return null;
      try { return JSON.parse(bytes.toString('utf8')); } catch {
        throw photoError(502, 'PHOTOS_UPSTREAM_ERROR', 'Immich answered with invalid JSON');
      }
    },
    async image(path) {
      const { response, bytes } = await send(path, { accept: 'image/*', limit: MAX_IMAGE_BYTES });
      const contentType = String(response.headers.get('content-type') || '');
      if (!/^image\/[a-z0-9.+-]+$/i.test(contentType.split(';')[0].trim())) {
        throw photoError(502, 'PHOTOS_UPSTREAM_ERROR', 'Immich did not answer with an image');
      }
      return { bytes, contentType: contentType.split(';')[0].trim() };
    },
  };
}

module.exports = { createImmichClient, immichSettings, readApiKey, photoError, MAX_IMAGE_BYTES };
