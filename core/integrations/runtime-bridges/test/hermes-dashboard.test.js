'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { getHermesStatusEvidence, hermesPublicUrl, registerHermesOperations } = require('../operations');

test('Hermes launcher uses only its public dashboard and keeps native authentication', () => {
  const previous = process.env.HERMES_PUBLIC_URL;
  const routes = new Map();
  const router = { get: (path, handler) => routes.set(path, handler) };
  registerHermesOperations({ express: { Router: () => router } });
  function launch() {
    const res = { headers: {}, statusCode: 200,
      set(headers) { Object.assign(this.headers, headers); return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      redirect(code, url) { this.statusCode = code; this.url = url; return this; } };
    routes.get('/control-launch')({}, res);
    return res;
  }
  try {
    process.env.HERMES_PUBLIC_URL = 'https://runtime.example/hermes/?token=excluded#old';
    const ready = launch();
    assert.equal(ready.statusCode, 302);
    assert.equal(ready.url, 'https://runtime.example/hermes/');
    assert.equal(ready.headers['Cache-Control'], 'no-store');
    assert.equal(ready.headers['Referrer-Policy'], 'no-referrer');
    for (const url of ['', 'javascript:alert(1)', 'https://user:secret@runtime.example/hermes/', '/hermes/']) {
      process.env.HERMES_PUBLIC_URL = url;
      const refused = launch();
      assert.equal(refused.statusCode, 503);
      assert.equal(refused.body.code, 'HERMES_DASHBOARD_NOT_CONFIGURED');
      assert.equal(refused.url, undefined);
    }
    assert.equal(hermesPublicUrl({ HERMES_DASHBOARD_URL: 'http://internal.example:9119' }), null);
  } finally {
    if (previous === undefined) delete process.env.HERMES_PUBLIC_URL;
    else process.env.HERMES_PUBLIC_URL = previous;
  }
});

test('internal dashboard health probes retain the browser-facing management link', async () => {
  const original = { fetch: global.fetch, dashboard: process.env.HERMES_DASHBOARD_URL, public: process.env.HERMES_PUBLIC_URL };
  const calls = [];
  process.env.HERMES_DASHBOARD_URL = 'http://127.0.0.1:9119';
  process.env.HERMES_PUBLIC_URL = 'https://workshop.example/hermes';
  global.fetch = async url => {
    calls.push(url);
    return String(url).endsWith('/api/status')
      ? { ok: true, json: async () => ({ version: 'test', auth_required: true }) }
      : { ok: true, text: async () => '<html>Native login required</html>' };
  };
  try {
    const view = await getHermesStatusEvidence();
    assert.deepEqual(calls, ['http://127.0.0.1:9119/api/status', 'http://127.0.0.1:9119/']);
    assert.equal(view.dashboard.url, 'https://workshop.example/hermes');
    assert.equal(view.authority.liveConfig.status, 'protected');
  } finally {
    global.fetch = original.fetch;
    for (const [key, value] of [['HERMES_DASHBOARD_URL', original.dashboard], ['HERMES_PUBLIC_URL', original.public]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
