'use strict';

// The existing Forge runs on Core's origin, with its normal conversation routes
// and family-device cookie. No cross-site exception, credential or new service.
const { avatarModuleUrl, createScriptRelay } = require('./asset-relay');
const { allowWasm } = require('../diskx');

const PREFIX = '/api/household/llmx';
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const ASSET = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:jpg|jpeg|png|webp|gif|svg|hdr|bin|glb|gltf|json|obj|mtl|stl|ply|mp3|wav)$/;
const MIME = /^(?:image\/(?:jpeg|png|webp|gif|svg\+xml)|application\/(?:octet-stream|json)|model\/(?:gltf-binary|gltf\+json|stl)|audio\/(?:mpeg|wav|x-wav)|text\/plain)(?:;|$)/i;

function moduleUrl(env) { return new URL('llmx-room.js', avatarModuleUrl(env)).href; }
function assetUrl(relative, env) {
  if (!ASSET.test(relative) || relative.includes('..')) throw Object.assign(new Error('Unknown Forge asset'), { status: 400 });
  return new URL('/assets/' + relative, avatarModuleUrl(env)).href;
}

async function readAsset(response) {
  if (Number(response.headers.get('content-length')) > MAX_ASSET_BYTES) {
    await response.body?.cancel();
    throw new Error('Forge asset is too large');
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > MAX_ASSET_BYTES) throw new Error('Forge asset is too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function register({ app, env = process.env, fetchWithTimeout = require('../../src/services/voice/transport').fetchWithTimeout }) {
  const unavailable = (res, error) => res.status(error.status || 503).json({ ok: false, code: 'LLMX_UNAVAILABLE', message: 'La Forge est indisponible.' });
  app.get('/llmx', (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'profile') || (req.query.profile !== undefined && !['personal', 'family'].includes(req.query.profile))) {
      return res.status(400).send('Unknown LLMx profile');
    }
    try { moduleUrl(env); } catch (error) { return unavailable(res, error); }
    const policy = res.getHeader('Content-Security-Policy');
    if (policy) res.set('Content-Security-Policy', allowWasm(policy));
    return res.type('html').set('Cache-Control', 'no-store').send(`<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nestor · Forge</title>
<style>html,body{margin:0;height:100%;background:#03060c} [data-llmx-root]{position:fixed;inset:0;overflow:hidden}</style>
<div data-llmx-root><p role="status">Chargement de la Forge…</p></div><script type="module" src="/assets/household/llmx-entry.js"></script></html>`);
  });
  app.get(`${PREFIX}/room.js`, createScriptRelay({ resolveUrl: () => moduleUrl(env), fetchWithTimeout,
    requireScriptType: true, maxBytes: 6 * 1024 * 1024, unavailable }));
  app.get(/^\/api\/household\/llmx\/assets\/(.+)$/, async (req, res) => {
    try {
      const relative = req.params[0];
      if (Object.keys(req.query).length) return res.status(400).end();
      const url = assetUrl(relative, env);
      const upstream = await fetchWithTimeout(url, { redirect: 'error' }, 15_000);
      const type = upstream.headers.get('content-type') || '';
      if (!upstream.ok || !MIME.test(type)) {
        await upstream.body?.cancel();
        return res.status(502).end();
      }
      const body = await readAsset(upstream);
      return res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" }).send(body);
    } catch (error) { return unavailable(res, error); }
  });
}

module.exports = { register, moduleUrl, assetUrl, readAsset, MAX_ASSET_BYTES };
