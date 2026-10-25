'use strict';

// Browser scripts owned by sibling LAN services (the VoiX player, the GraphysX
// <llmx-face> avatar) are relayed from Household's own origin, so the page CSP
// stays script-src 'self' and nothing needs CORS. Each relay keeps the last good
// copy for a few minutes: the avatar module is ~800 KB and every open page asks.

const CACHE_MS = 5 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024;

// fetchUpstream(url, timeoutMs) optionally replaces the single fetch, e.g. with
// VoiX's primary/backup choice; it resolves to { response, upstream }.
// maxBytes narrows or widens the cap for one relay. requireScriptType refuses an
// upstream answer whose Content-Type is not JavaScript: a static host's HTML
// fallback for a missing file must never reach a page as a script.
function createScriptRelay({ resolveUrl, fetchWithTimeout, unavailable, now = () => Date.now(), timeoutMs = 10_000, fetchUpstream,
  maxBytes = MAX_BYTES, requireScriptType = false }) {
  const load = fetchUpstream || (async (url, ms) => ({ response: await fetchWithTimeout(url, {}, ms) }));
  let cached = null;
  return async function relay(_req, res) {
    let url;
    try { url = resolveUrl(); } catch (error) { return unavailable(res, error); }
    if (cached && cached.url === url && now() - cached.at < CACHE_MS) return send(res, cached.body, cached.upstream);
    try {
      const { response, upstream } = await load(url, timeoutMs);
      if (!response.ok) return unavailable(res, Object.assign(new Error(`Upstream answered ${response.status}`), { status: 503 }));
      if (requireScriptType && !isScriptType(response.headers?.get?.('content-type'))) {
        return unavailable(res, Object.assign(new Error('Upstream did not answer with JavaScript'), { status: 502 }));
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > maxBytes) return unavailable(res, Object.assign(new Error('Relayed script is too large'), { status: 502 }));
      cached = { url, body, at: now(), upstream };
      return send(res, body, upstream);
    } catch (error) {
      // A stale copy beats a missing avatar or player while the upstream restarts.
      if (cached && cached.url === url) return send(res, cached.body, cached.upstream);
      return unavailable(res, error);
    }
  };
}

function isScriptType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return ['application/javascript', 'text/javascript', 'application/x-javascript', 'application/ecmascript', 'text/ecmascript'].includes(type);
}

function send(res, body, upstream) {
  if (upstream) res.set('X-Voix-Upstream', upstream);
  return res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(body);
}

/** An explicit http(s) module URL from env[name], without credentials; `code` names the refusal. */
function configuredModuleUrl(env, name, code, label) {
  const value = String(env[name] || '').trim();
  if (!value) throw Object.assign(new Error(`The ${label} is not configured for this instance`), { status: 404, code });
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error(`${name} must be an http(s) URL without credentials`), { status: 503, code });
  }
  return url.href;
}

/** The GraphysX `<llmx-face>` module URL, e.g. https://graphysx.example/embed/llmx-face.js. */
function avatarModuleUrl(env = process.env) {
  return configuredModuleUrl(env, 'HOUSEHOLD_AVATAR_MODULE_URL', 'AVATAR_NOT_CONFIGURED', 'avatar module');
}

module.exports = { createScriptRelay, configuredModuleUrl, avatarModuleUrl, CACHE_MS, MAX_BYTES };
