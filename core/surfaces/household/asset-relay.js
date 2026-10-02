'use strict';

// Browser scripts owned by sibling LAN services (the VoiX player, the GraphysX
// <llmx-face> avatar) are relayed from Household's own origin, so the page CSP
// stays script-src 'self' and nothing needs CORS. Each relay keeps the last good
// copy for a few minutes: the avatar module is ~800 KB and every open page asks.

const CACHE_MS = 5 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;

function createScriptRelay({ resolveUrl, fetchWithTimeout, unavailable, now = () => Date.now(), timeoutMs = 10_000 }) {
  let cached = null;
  return async function relay(_req, res) {
    let url;
    try { url = resolveUrl(); } catch (error) { return unavailable(res, error); }
    if (cached && cached.url === url && now() - cached.at < CACHE_MS) return send(res, cached.body);
    try {
      const response = await fetchWithTimeout(url, {}, timeoutMs);
      if (!response.ok) return unavailable(res, Object.assign(new Error(`Upstream answered ${response.status}`), { status: 503 }));
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_BYTES) return unavailable(res, Object.assign(new Error('Relayed script is too large'), { status: 502 }));
      cached = { url, body, at: now() };
      return send(res, body);
    } catch (error) {
      // A stale copy beats a missing avatar or player while the upstream restarts.
      if (cached && cached.url === url) return send(res, cached.body);
      return unavailable(res, error);
    }
  };
}

function send(res, body) {
  return res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(body);
}

/** The GraphysX `<llmx-face>` module URL, e.g. https://graphysx.example/embed/llmx-face.js. */
function avatarModuleUrl(env = process.env) {
  const value = String(env.HOUSEHOLD_AVATAR_MODULE_URL || '').trim();
  if (!value) throw Object.assign(new Error('The avatar module is not configured for this instance'), { status: 404, code: 'AVATAR_NOT_CONFIGURED' });
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('HOUSEHOLD_AVATAR_MODULE_URL must be an http(s) URL without credentials'), { status: 503, code: 'AVATAR_NOT_CONFIGURED' });
  }
  return url.href;
}

module.exports = { createScriptRelay, avatarModuleUrl, CACHE_MS, MAX_BYTES };
