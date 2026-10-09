'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { getHermesStatusEvidence } = require('../operations');

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
