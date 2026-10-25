'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { avatarModuleUrl, createScriptRelay, CACHE_MS } = require('../asset-relay');

function response() {
  return {
    headers: {}, status: 200, body: undefined, contentType: undefined,
    type(value) { this.contentType = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    send(body) { this.body = body; return this; }
  };
}

test('the avatar module URL is explicit, http(s) and credential-free', () => {
  assert.throws(() => avatarModuleUrl({}), error => error.code === 'AVATAR_NOT_CONFIGURED' && error.status === 404);
  assert.equal(avatarModuleUrl({ HOUSEHOLD_AVATAR_MODULE_URL: ' https://graphysx.example/embed/llmx-face.js ' }), 'https://graphysx.example/embed/llmx-face.js');
  assert.throws(() => avatarModuleUrl({ HOUSEHOLD_AVATAR_MODULE_URL: 'https://user:pw@graphysx.example/x.js' }), /without credentials/);
  assert.throws(() => avatarModuleUrl({ HOUSEHOLD_AVATAR_MODULE_URL: 'file:///etc/passwd' }), /http\(s\)/);
});

test('a relayed script is cached, refreshed after expiry and served stale while the upstream is down', async () => {
  let clock = 0;
  let calls = 0;
  let upstream = async () => ({ ok: true, text: async () => `export const v = ${++calls};` });
  const failures = [];
  const relay = createScriptRelay({
    resolveUrl: () => 'https://graphysx.example/embed/llmx-face.js',
    fetchWithTimeout: (...args) => upstream(...args),
    unavailable: (res, error) => { failures.push(error.message); return res; },
    now: () => clock
  });
  const first = await relay({}, response());
  assert.equal(first.body, 'export const v = 1;');
  assert.equal(first.contentType, 'application/javascript');
  assert.equal(first.headers['Cache-Control'], 'public, max-age=300');
  assert.equal((await relay({}, response())).body, 'export const v = 1;', 'within the cache window');
  clock = CACHE_MS + 1;
  assert.equal((await relay({}, response())).body, 'export const v = 2;', 'refreshed after expiry');
  clock = 2 * CACHE_MS + 2;
  upstream = async () => { throw new Error('connection refused'); };
  assert.equal((await relay({}, response())).body, 'export const v = 2;', 'stale copy while the upstream restarts');
  assert.deepEqual(failures, []);
});

test('an unconfigured or failing relay answers through the caller without caching', async () => {
  const failures = [];
  const unconfigured = createScriptRelay({
    resolveUrl: () => avatarModuleUrl({}),
    fetchWithTimeout: async () => assert.fail('must not fetch'),
    unavailable: (res, error) => { failures.push(error.code); return res; }
  });
  await unconfigured({}, response());
  const broken = createScriptRelay({
    resolveUrl: () => 'http://voix.lan/assets/voice-audio.js',
    fetchWithTimeout: async () => ({ ok: false, status: 502, text: async () => '' }),
    unavailable: (res, error) => { failures.push(error.message); return res; }
  });
  await broken({}, response());
  assert.deepEqual(failures, ['AVATAR_NOT_CONFIGURED', 'Upstream answered 502']);
});

test('one relay may require a JavaScript answer and set its own size cap', async () => {
  const typed = (type, body) => async () => ({ ok: true, headers: new Map([['content-type', type]]), text: async () => body });
  const failures = [];
  const unavailable = (res, error) => { failures.push([error.status, error.message]); return res; };
  let upstream = typed('text/html; charset=utf-8', '<!doctype html><title>app</title>');
  const strict = createScriptRelay({ resolveUrl: () => 'https://graphysx.example/embed/diskx.js', fetchWithTimeout: (...args) => upstream(...args),
    unavailable, requireScriptType: true, maxBytes: 16 });
  assert.equal((await strict({}, response())).body, undefined, 'an HTML fallback is not relayed');
  upstream = typed('text/javascript', 'export const too_long = 1;');
  await strict({}, response());
  upstream = typed('application/javascript; charset=utf-8', 'export {};');
  assert.equal((await strict({}, response())).body, 'export {};');
  assert.deepEqual(failures, [[502, 'Upstream did not answer with JavaScript'], [502, 'Relayed script is too large']]);

  // Existing relays keep the default: no type check, the shared 4 MB cap.
  const lenient = createScriptRelay({ resolveUrl: () => 'http://voix.lan/assets/voice-audio.js',
    fetchWithTimeout: async () => ({ ok: true, text: async () => 'x'.repeat(1024) }), unavailable });
  assert.equal((await lenient({}, response())).body.length, 1024);
  assert.equal(failures.length, 2);
});
