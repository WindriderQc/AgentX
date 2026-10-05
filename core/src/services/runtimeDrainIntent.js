'use strict';

// A drain request (#253): the launcher says a recreate is about to happen so
// resumable background work pauses before its next unit instead of holding the
// deploy guard indefinitely. It is advice read through runtime coordination,
// not a lease: nothing is refused because of it, and it lives in this process
// only, so it disappears with the recreate it announces.

const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const SCOPE = /^[a-z][a-z0-9-]{0,63}$/;

let intent = null;

function request({ scope, ttlMs, principal = 'operator' } = {}, now = new Date()) {
  if (!SCOPE.test(String(scope || ''))) throw Object.assign(new Error('A drain request names its scope'), { statusCode: 400 });
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttlMs) || MIN_TTL_MS));
  intent = { scope, principal: String(principal).slice(0, 120), requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString() };
  return intent;
}

function current(now = new Date()) {
  if (intent && new Date(intent.expiresAt).getTime() <= now.getTime()) intent = null;
  return intent;
}

function clear() {
  const cleared = Boolean(intent);
  intent = null;
  return { cleared };
}

module.exports = { MIN_TTL_MS, MAX_TTL_MS, request, current, clear };
