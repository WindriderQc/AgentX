'use strict';

const path = require('node:path');
const { createAuth } = require('../services/accessSessionService');
const { registerFaceUnlock } = require('./faceUnlock');
const { registerParentalCodeRoutes } = require('./parentalCodeRoutes');
const { createParentalCode } = require('../services/parentalCodeService');

// The LAN HTTPS gateway overwrites this header on every browser request.
// Core and the other service ports stay on loopback/internal Docker networking;
// unmarked service traffic retains the existing trusted-network contract.
const isEntry = req => req.get('x-agentx-entry') === 'household';
const familyPages = new Set(['/panel', '/kids', '/kids/sounds', '/lecture']);
const landingPages = new Set(['/', '/portal', '/ecosystem']);
const shellAssets = new Set(['/css/local-fonts.css', '/css/product-shell.css', '/css/home.css',
  '/css/conversation-recap.css', '/js/conversation-recap.js',
  '/css/platform-chrome.css', '/css/shortcuts-modal.css', '/dist/shared-tokens.css', '/dist/shared-utils.js',
  '/js/product-navigation.js', '/js/home.js', '/js/utils/shared.js', '/js/utils/typed-confirmation.js',
  '/js/utils/polling-controller-global.js', '/js/utils/polling-controller.js', '/js/utils/shortcut-hints.js',
  '/js/utils/shortcuts-modal.js', '/js/utils/toast.js']);
const read = req => req.method === 'GET' || req.method === 'HEAD';
function canonicalPath(req) {
  try { return decodeURIComponent(req.path).replace(/\/+$/, '').toLowerCase() || '/'; }
  catch { return ''; }
}
function familyRequest(req, pathname) {
  if (read(req) && (familyPages.has(pathname) || landingPages.has(pathname) || shellAssets.has(pathname))) return true;
  if (read(req) && /^\/(?:vendor\/(?:fonts\/|fontawesome\/6\.4\.0\/))/.test(pathname)) return true;
  if (read(req) && /^\/(?:assets\/household|psyx\/assets|access-assets)\//.test(pathname)) return true;
  // The family conversation runs Core's shared voice loop: its scripts and capture
  // worklet, by exact name, so no other Core page script opens through this path.
  if (read(req) && /^\/js\/voice\/[a-z0-9-]+\.js$/.test(pathname)) return true;
  if (read(req) && ['/favicon.ico', '/health', '/api/voice-personas/catalog', '/api/voice-personas/packs',
    '/api/voice-personas/sounds', '/api/family/profiles', '/api/family/room', '/api/family/chores', '/api/family/shopping',
    '/api/voix/player.js', '/api/voix/catalog', '/api/household/avatar/llmx-face.js'].includes(pathname)) return true;
  if (read(req) && /^\/api\/voice-personas\/packs\/[^/]+$/.test(pathname)) return true;
  if (req.method === 'POST' && ['/api/family/chores/check-in', '/api/family/shopping/add', '/api/family/math-receipts', '/api/voix/transcribe',
    '/api/voix/synthesize', '/api/voix/synthesize/stream'].includes(pathname)) return true;
  // These existing handlers bind a child/family pack on the server. Private
  // sessions, memory editors, native consumers and parent approval are excluded.
  if (req.method === 'POST' && /^\/api\/voice-personas\/(?:family\/)?sessions(?:\/[^/]+\/(?:turns\/text|interrupt|voice-timings))?$/.test(pathname)) return true;
  return read(req) && /^\/api\/voice-personas\/(?:(?:family\/)?sessions\/(?:recent|[^/]+\/(?:history|brain))|family\/visuals\/(?:file|generated))$/.test(pathname);
}
// Browser destinations the unlock page may return to: Core's own paths, and
// the service entries the gateway protects with the same session. Anything
// else falls back to the personal home.
function publicOrigins(env) {
  const origins = new Set();
  for (const key of ['CORE_PUBLIC_URL', 'BENCHMARK_PUBLIC_URL', 'RAG_PUBLIC_URL', 'DATAAPI_PUBLIC_URL']) {
    try {
      const url = new URL(String(env[key] || '').trim());
      if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
    } catch { /* unset or malformed: not a destination */ }
  }
  return origins;
}
function safeNext(value, origins = new Set()) {
  if (typeof value !== 'string' || /[\\\r\n]/.test(value) || value.length >= 2000) return '/dad';
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    if (origins.has(url.origin)) return url.href;
  } catch { /* neither a path nor an absolute URL */ }
  return '/dad';
}
// The gateway's forward-auth subrequest describes the browser request it is
// checking. Rebuild that page URL when it is a navigation to a protected
// service entry, so a locked browser can be sent to the unlock page and back.
function forwardedNavigation(req, origins) {
  const method = (req.get('x-forwarded-method') || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (!/\btext\/html\b/.test(req.get('accept') || '')) return null;
  const host = req.get('x-forwarded-host');
  const uri = req.get('x-forwarded-uri') || '/';
  if (!host || /[\\\r\n\s]/.test(host + uri) || !uri.startsWith('/') || uri.startsWith('//')) return null;
  try {
    const url = new URL(`${req.get('x-forwarded-proto') === 'http' ? 'http' : 'https'}://${host}${uri}`);
    return origins.has(url.origin) ? url.href : null;
  } catch { return null; }
}

function registerParentalAccess({ app, express, env = process.env, now, faceRecognizer, faceStore, codeStore }) {
  const minutes = Number(env.AGENTX_PARENTAL_SESSION_MINUTES || 30);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 480) throw new Error('Invalid parental session duration');
  // AGENTX_PARENTAL_CODE stays authoritative; without it, the code set from
  // the host is stored hashed. Bearer access remains with the configured code.
  const accessToken = env.AGENTX_PARENTAL_CODE || '';
  const code = createParentalCode({ envCode: accessToken, store: codeStore });
  const auth = createAuth({ accessToken, sessionTtlMs: minutes * 60000, now,
    codeConfigured: code.configured, verifyCode: code.verify,
    secureRequest: req => req.secure || (isEntry(req) && req.get('x-forwarded-proto') === 'https') });
  const origins = publicOrigins(env);
  let coreOrigin = null;
  try { coreOrigin = new URL(String(env.CORE_PUBLIC_URL || '').trim()).origin; } catch { /* no public origin: service 401s stay bare */ }
  const root = path.join(__dirname, '../../public/access');
  const status = req => ({ enforced: isEntry(req), unlocked: Boolean(auth.current(req)),
    configured: code.configured(), managedByConfig: code.managedByConfig, setupAllowed: !code.configured() && !isEntry(req),
    numericCodeLength: code.numericLength(), expiresAt: auth.current(req)?.expiresAt || null });
  const json = (res, data) => res.set('Cache-Control', 'private, no-store').json({ ok: true, status: 'success', data });
  app.use('/access-assets', express.static(root, { index: false, fallthrough: false, maxAge: 0 }));
  registerParentalCodeRoutes({ app, auth, code, isEntry, root });
  app.get('/unlock', (_req, res) => res.set('Cache-Control', 'no-store').sendFile('unlock.html', { root }));
  app.get('/api/access/session', (req, res) => json(res, status(req)));
  // The existing LAN gateway uses this status-only check before forwarding
  // Benchmark/RAG requests. Never inherit the unmarked internal-traffic bypass.
  // A locked browser navigating to a service page is sent to the unlock page
  // (the gateway copies this response to the browser); API calls stay 401.
  app.get('/api/access/authorize', (req, res, next) => {
    if (auth.current(req) || !coreOrigin) return next();
    const destination = forwardedNavigation(req, origins);
    if (!destination) return next();
    return res.set('Cache-Control', 'private, no-store')
      .redirect(302, `${coreOrigin}/unlock?next=${encodeURIComponent(destination)}`);
  }, auth.requireSession, (_req, res) =>
    res.set('Cache-Control', 'private, no-store').status(204).end());
  app.post('/api/access/unlock', (req, res) => {
    const result = auth.unlock(req, res, req.body?.code);
    if (!result.ok) return res.status(result.status).set('Cache-Control', 'no-store').json(result);
    return json(res, { unlocked: true, expiresAt: result.expiresAt, next: safeNext(req.body?.next, origins) });
  });
  app.post('/api/access/lock', (req, res) => { auth.lock(req, res); return json(res, { unlocked: false }); });
  const face = registerFaceUnlock({ app, auth, env, configured: code.configured, root, safeNext: next => safeNext(next, origins),
    recognizer: faceRecognizer, store: faceStore });
  app.use((req, res, next) => {
    if (!isEntry(req)) return next();
    const pathname = canonicalPath(req);
    res.set('Cache-Control', 'private, no-store');
    if (read(req) && familyPages.has(pathname)) {
      // Entering the family space hands this browser back to the children.
      auth.lock(req, res);
      return next();
    }
    if (familyRequest(req, pathname) || /^\/api\/psyx\/auth\/(?:status|unlock|lock)$/.test(pathname)) return next();
    const session = auth.current(req);
    if (session) { res.locals.adultUserId = session.userId; return next(); }
    if (read(req) && !pathname.startsWith('/api/') && pathname !== '/mcp') {
      return res.redirect(302, '/unlock?next=' + encodeURIComponent(safeNext(req.originalUrl)));
    }
    return res.status(401).json({ ok: false, status: 'error', code: 'ADULT_LOCKED',
      message: 'Entre le code parental pour ouvrir cet espace.' });
  });
  return { auth, face, code, isEntry, accessToken, sessionTtlMs: minutes * 60000 };
}

module.exports = { registerParentalAccess, familyRequest, isEntry, safeNext };
