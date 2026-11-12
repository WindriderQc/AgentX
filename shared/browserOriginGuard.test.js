'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { allowedBrowserOrigins, createBrowserOriginGuard } = require('./browserOriginGuard');

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    headers,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = String(value); },
    end(body) { this.ended = true; this.body = body; },
  };
}

function run(guard, { method = 'GET', headers = {} } = {}) {
  const res = fakeRes();
  let passed = false;
  guard({ method, headers }, res, () => { passed = true; });
  return { res, passed };
}

const guard = createBrowserOriginGuard({
  publicUrls: ['http://127.0.0.1:3180', 'http://127.0.0.1:3181', 'https://household.example.invalid'],
});

test('derives origins and loopback variants from public URLs', () => {
  const origins = allowedBrowserOrigins(['http://127.0.0.1:3180/', 'https://household.example.invalid', '', 'not a url']);
  assert.ok(origins.has('http://127.0.0.1:3180'));
  assert.ok(origins.has('http://localhost:3180'));
  assert.ok(origins.has('http://[::1]:3180'));
  assert.ok(origins.has('https://household.example.invalid'));
  assert.ok(!origins.has('http://localhost:9999'));
});

test('reflects an allowed origin instead of a wildcard', () => {
  const { res, passed } = run(guard, { headers: { origin: 'http://localhost:3181', 'sec-fetch-site': 'same-site' } });
  assert.equal(passed, true);
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3181');
  assert.match(res.headers.vary, /Origin/);
});

test('does not reflect a foreign origin and does not block its GET', () => {
  const { res, passed } = run(guard, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  assert.equal(passed, true);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('rejects a cross-site state-changing request with a JSON 403', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { res, passed } = run(guard, { method, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).code, 'CROSS_SITE_REQUEST_REJECTED');
  }
});

test('rejects unlisted same-site origins before state-changing handlers run', () => {
  for (const origin of ['https://other.example.invalid', 'http://127.0.0.1:9999']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { res, passed } = run(guard, { method, headers: { origin, 'sec-fetch-site': 'same-site' } });
      assert.equal(passed, false, `${method} ${origin}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.ended, true);
      assert.equal(JSON.parse(res.body).code, 'CROSS_SITE_REQUEST_REJECTED');
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  }
});

test('rejects an unlisted Origin even without Fetch Metadata', () => {
  const { res, passed } = run(guard, { method: 'POST', headers: { origin: 'https://other.example.invalid' } });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test('lets listed same-site, same-origin and header-less POSTs through', () => {
  for (const headers of [
    { origin: 'http://127.0.0.1:3181', 'sec-fetch-site': 'same-site' },
    { origin: 'https://household.example.invalid', 'sec-fetch-site': 'same-origin' },
    { origin: 'https://household.example.invalid' },
    { 'sec-fetch-site': 'none' },
    {},
  ]) {
    const { res, passed } = run(guard, { method: 'POST', headers });
    assert.equal(passed, true, JSON.stringify(headers));
    assert.equal(res.statusCode, 200);
  }
});

test('answers an allowed preflight and leaves a foreign one unanswered', () => {
  const allowedPreflight = run(guard, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://127.0.0.1:3180',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(allowedPreflight.passed, false);
  assert.equal(allowedPreflight.res.statusCode, 204);
  assert.equal(allowedPreflight.res.headers['access-control-allow-headers'], 'content-type');

  const foreignPreflight = run(guard, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(foreignPreflight.passed, true);
  assert.equal(foreignPreflight.res.headers['access-control-allow-origin'], undefined);
});

test('explicit gateway aliases allow same-origin writes without widening trust', () => {
  const recovery = 'https://192.0.2.10';
  const aliasGuard = createBrowserOriginGuard({
    publicUrls: ['https://household.example.invalid'],
    additionalOrigins: ` ${recovery}, https://recovery.example.invalid:8443 `,
  });
  for (const origin of [recovery, 'https://recovery.example.invalid:8443', 'https://household.example.invalid']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { res, passed } = run(aliasGuard, { method, headers: { origin, 'sec-fetch-site': 'same-origin' } });
      assert.equal(passed, true, `${method} ${origin}`);
      assert.equal(res.headers['access-control-allow-origin'], origin);
    }
  }
  for (const origin of ['https://192.0.2.11', 'http://192.0.2.10', 'https://recovery.example.invalid', 'https://localhost:8443', 'null']) {
    const { res, passed } = run(aliasGuard, { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' } });
    assert.equal(passed, false, origin);
    assert.equal(res.statusCode, 403);
  }
  const crossSite = run(aliasGuard, { method: 'POST', headers: { origin: recovery, 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.res.statusCode, 403);
  assert.equal(crossSite.passed, false);
  const preflight = run(aliasGuard, { method: 'OPTIONS', headers: { origin: recovery, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.res.statusCode, 204);
  assert.equal(preflight.res.headers['access-control-allow-origin'], recovery);
});

test('refuses malformed gateway alias configuration at startup', () => {
  for (const additionalOrigins of ['*', 'null', 'https://*.example.invalid', 'https://example.invalid/path',
    'https://user:password@example.invalid', 'file:///tmp/example', 'https://example.invalid?x=1']) {
    assert.throws(() => createBrowserOriginGuard({ additionalOrigins }), /AGENTX_BROWSER_ORIGINS/);
  }
});

test('reads gateway aliases from the instance environment', () => {
  const previous = process.env.AGENTX_BROWSER_ORIGINS;
  try {
    process.env.AGENTX_BROWSER_ORIGINS = 'https://recovery.example.invalid';
    const { res, passed } = run(createBrowserOriginGuard(), {
      method: 'POST', headers: { origin: 'https://recovery.example.invalid', 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(passed, true);
    assert.equal(res.headers['access-control-allow-origin'], 'https://recovery.example.invalid');
  } finally {
    if (previous === undefined) delete process.env.AGENTX_BROWSER_ORIGINS;
    else process.env.AGENTX_BROWSER_ORIGINS = previous;
  }
});
