'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  COOKIE_NAME,
  accessTokenValid,
  dshStudioConfig,
  issueAccessToken,
  registerDshStudioOperations,
  validateDshStudioEnvironment,
} = require('../dsh/studio');

const repoRoot = path.resolve(__dirname, '../../../..');

const KEYS = [
  'CORE_PUBLIC_URL',
  'DSH_STUDIO_PUBLIC_URL',
  'DSH_STUDIO_ACCESS_SECRET',
  'DSH_STUDIO_SESSION_TTL_SECONDS',
  'DSH_STUDIO_ISOLATION',
  'DSH_STUDIO_MODEL',
];

function withEnvironment(values, run) {
  const prior = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return run(); }
  finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeExpress() {
  return {
    Router() {
      const routes = [];
      return {
        routes,
        get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
      };
    },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) {
      if (typeof name === 'object') Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
    json(value) { this.body = value; return this; },
    redirect(code, location) { this.statusCode = code; this.headers.Location = location; return this; },
    end() { return this; },
  };
}

function request(headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    protocol: 'http',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    get(name) { return normalized[String(name).toLowerCase()] || ''; },
  };
}

test('DSH Studio is disabled by default and validates an explicit secure origin', () => {
  withEnvironment({}, () => {
    assert.deepEqual(dshStudioConfig(), { configured: false, isolation: 'bubblewrap' });
    assert.equal(validateDshStudioEnvironment().configured, false);
  });
  withEnvironment({
    CORE_PUBLIC_URL: 'https://192.0.2.99',
    DSH_STUDIO_PUBLIC_URL: 'https://192.0.2.99:18791',
    DSH_STUDIO_ACCESS_SECRET: 'a'.repeat(48),
    DSH_STUDIO_ISOLATION: 'host',
  }, () => {
    const config = validateDshStudioEnvironment();
    assert.equal(config.configured, true);
    assert.equal(config.isolation, 'host');
    assert.equal(config.publicUrl, 'https://192.0.2.99:18791');
  });
});

test('invalid DSH public, isolation, TTL, and secret settings fail closed', () => {
  const baseline = {
    CORE_PUBLIC_URL: 'https://192.0.2.99',
    DSH_STUDIO_PUBLIC_URL: 'https://192.0.2.99:18791',
    DSH_STUDIO_ACCESS_SECRET: 'a'.repeat(48),
  };
  withEnvironment({ ...baseline, DSH_STUDIO_ISOLATION: 'none' }, () => {
    assert.throws(validateDshStudioEnvironment, /bubblewrap or host/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_SESSION_TTL_SECONDS: '60' }, () => {
    assert.throws(validateDshStudioEnvironment, /integer from 300/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_ACCESS_SECRET: 'too-short' }, () => {
    assert.throws(validateDshStudioEnvironment, /at least 32/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_PUBLIC_URL: 'http://192.0.2.99:18791' }, () => {
    assert.throws(validateDshStudioEnvironment, /must use HTTPS/);
  });
  withEnvironment({ ...baseline, DSH_STUDIO_PUBLIC_URL: 'https://other.example:18791' }, () => {
    assert.throws(validateDshStudioEnvironment, /same hostname/);
  });
});

test('signed browser access expires and rejects tampering', () => {
  withEnvironment({ DSH_STUDIO_ACCESS_SECRET: 's'.repeat(48) }, () => {
    const now = Date.parse('2026-09-03T04:00:00Z');
    const token = issueAccessToken({ now, randomBytes: () => Buffer.alloc(18, 7) });
    assert.equal(accessTokenValid(token, { now: now + 1000, ttlSeconds: 300 }), true);
    assert.equal(accessTokenValid(`${token}x`, { now: now + 1000, ttlSeconds: 300 }), false);
    assert.equal(accessTokenValid(token, { now: now + 301000, ttlSeconds: 300 }), false);
  });
  withEnvironment({}, () => {
    assert.throws(() => issueAccessToken(), /access secret is unavailable/);
    assert.equal(accessTokenValid('v1.1.nonce.signature'), false);
  });
});

test('launcher sets a host-only secure cookie and the access check accepts only that cookie', () => {
  withEnvironment({
    CORE_PUBLIC_URL: 'https://192.0.2.99',
    DSH_STUDIO_PUBLIC_URL: 'https://192.0.2.99:18791',
    DSH_STUDIO_ACCESS_SECRET: 'z'.repeat(48),
  }, () => {
    const router = registerDshStudioOperations({ express: fakeExpress() });
    const launch = router.routes.find((route) => route.path === '/control-launch');
    const launched = response();
    launch.handlers.at(-1)(request(), launched);
    assert.equal(launched.statusCode, 302);
    assert.equal(launched.headers.Location, 'https://192.0.2.99:18791');
    assert.match(launched.headers['Set-Cookie'], new RegExp(`^${COOKIE_NAME}=`));
    assert.match(launched.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict/);
    assert.doesNotMatch(launched.headers['Set-Cookie'], /Domain=/);

    const cookie = launched.headers['Set-Cookie'].split(';')[0];
    const check = router.routes.find((route) => route.path === '/access-check').handlers.at(-1);
    const accepted = response();
    check(request({ cookie }), accepted);
    assert.equal(accepted.statusCode, 204);

    const denied = response();
    check(request(), denied);
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.body.code, 'DSH_STUDIO_ACCESS_REQUIRED');
  });
});

test('Studio stays loopback-only and the OpenClaw worker sandbox stays mandatory', () => {
  const studio = fs.readFileSync(path.join(repoRoot, 'integrations/coding/dsh-studio.sh'), 'utf8');
  const worker = fs.readFileSync(path.join(repoRoot, 'integrations/coding/dsh-headless.sh'), 'utf8');

  assert.match(studio, /web --host 127\.0\.0\.1/);
  assert.doesNotMatch(studio, /web --host 0\.0\.0\.0/);
  assert.match(worker, /\/usr\/bin\/bwrap/);
  assert.doesNotMatch(worker, /DSH_STUDIO_ISOLATION|DSH_CODING_AGENT_ISOLATION/);
});
