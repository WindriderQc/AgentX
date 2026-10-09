'use strict';

// Bookmark and cookie migration only. Human access belongs to the private LAN;
// this module has no sessions, credentials, authorization or biometric storage.
const RETIRED_PAGE = /^\/(?:unlock|access(?:\/|$))/i;
const RETIRED_API = /^\/api\/(?:access(?:\/|$)|psyx\/auth(?:\/|$))/i;
const LEGACY_COOKIES = ['agentx_adult', 'psyx_session'];

function safeDestination(value, env = process.env) {
  if (typeof value !== 'string' || value.length >= 2000 || /[\\\s]/.test(value)) return '/dad';
  const local = value.startsWith('/') && !value.startsWith('//');
  let url;
  try { url = new URL(value, local ? 'https://local.invalid' : undefined); }
  catch { return '/dad'; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '/dad';
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return '/dad'; }
  if (/[\\\s]/.test(pathname) || pathname.startsWith('//') || RETIRED_PAGE.test(pathname) || RETIRED_API.test(pathname)) return '/dad';
  if (local) return url.pathname + url.search + url.hash;
  const origins = ['CORE_PUBLIC_URL', 'BENCHMARK_PUBLIC_URL', 'RAG_PUBLIC_URL', 'DATAAPI_PUBLIC_URL']
    .flatMap(key => { try { return [new URL(env[key]).origin]; } catch { return []; } });
  return origins.includes(url.origin) ? url.href : '/dad';
}

function registerLegacyHumanAccess({ app, env = process.env }) {
  app.use((req, res, next) => {
    for (const name of LEGACY_COOKIES) {
      if (req.cookies?.[name] !== undefined) res.clearCookie(name, {
        httpOnly: true, sameSite: 'strict', path: '/',
        secure: req.secure || req.get('x-forwarded-proto') === 'https'
      });
    }
    // Personal pages and API responses must not become shared cache content.
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  app.get(['/unlock', '/access/code', '/access/face'], (req, res) =>
    res.redirect(302, safeDestination(req.query.next, env)));
}

module.exports = { registerLegacyHumanAccess, safeDestination };
