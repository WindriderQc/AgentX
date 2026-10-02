'use strict';

const crypto = require('crypto');

function timingSafeMatch(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress || '').trim();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function createAuth({ accessMode = 'token', accessToken, sessionTtlMs = 30 * 60 * 1000, loopbackBypass = false,
  cookieName = 'agentx_adult', namespace = 'ADULT', label = 'Adult access', secureRequest = req => req.secure === true, now = () => Date.now(),
  // The unlock code may differ from the bearer token: the parental code can be
  // a stored hash, while bearer access stays with the configured token.
  codeConfigured = () => Boolean(accessToken), verifyCode = code => timingSafeMatch(accessToken, code) }) {
  const sessions = new Map();
  const failures = new Map();

  function prune() {
    const at = now();
    for (const [token, session] of sessions) if (session.expiresAt <= at) sessions.delete(token);
    for (const [key, failure] of failures) if (failure.resetAt <= at) failures.delete(key);
  }

  function clientKey(req) {
    return String(req.socket?.remoteAddress || 'unknown');
  }

  function current(req) {
    if (accessMode === 'trusted-network') return { userId: 'default', trustedNetwork: true };
    if (loopbackBypass && isLoopback(req)) return { userId: 'default', loopback: true };
    const authorization = String(req.get?.('authorization') || '');
    if (authorization.startsWith('Bearer ') && timingSafeMatch(accessToken, authorization.slice(7).trim())) {
      return { userId: 'default', bearer: true };
    }
    prune();
    const token = req.cookies?.[cookieName];
    const session = token && sessions.get(token);
    return session && session.expiresAt > now() ? session : null;
  }

  function blocked(req) {
    prune();
    return failures.get(clientKey(req))?.count >= 8;
  }

  function recordFailure(req) {
    const key = clientKey(req);
    const failure = failures.get(key);
    if (!failure) failures.set(key, { count: 1, resetAt: now() + 5 * 60 * 1000 });
    else failure.count += 1;
  }

  // Opens a session for a caller another factor already verified (the code
  // below, or face recognition). Both share the failure counter above.
  function grant(req, res) {
    failures.delete(clientKey(req));
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { userId: 'default', expiresAt: now() + sessionTtlMs });
    res.cookie(cookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureRequest(req),
      path: '/',
      maxAge: sessionTtlMs
    });
    return { ok: true, expiresAt: sessions.get(token).expiresAt };
  }

  function unlock(req, res, code) {
    if (accessMode === 'trusted-network') return { ok: true };
    if (!codeConfigured()) return { ok: false, status: 503, code: `${namespace}_ACCESS_NOT_CONFIGURED`, message: `${label} is not configured.` };
    if (blocked(req)) return { ok: false, status: 429, code: `${namespace}_UNLOCK_RATE_LIMIT`, message: 'Trop de tentatives. Réessaie dans quelques minutes.' };
    if (!verifyCode(code)) {
      recordFailure(req);
      return { ok: false, status: 403, code: `${namespace}_UNLOCK_FAILED`, message: 'Code invalide.' };
    }
    return grant(req, res);
  }

  function lock(req, res) {
    const token = req.cookies?.[cookieName];
    if (token) sessions.delete(token);
    res.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', path: '/' });
  }

  // After a code change, only the browser that made it stays unlocked.
  function revokeOthers(req) {
    const keep = req.cookies?.[cookieName];
    for (const token of sessions.keys()) if (token !== keep) sessions.delete(token);
  }

  function requireSession(req, res, next) {
    const session = current(req);
    if (!session) return res.status(401).json({ ok: false, status: 'error', code: `${namespace}_LOCKED`, message: 'Entre le code parental pour ouvrir cet espace.' });
    res.locals.adultUserId = session.userId;
    return next();
  }

  return { current, unlock, grant, blocked, recordFailure, lock, revokeOthers, requireSession, isLoopback };
}

module.exports = { createAuth, isLoopback, timingSafeMatch };
