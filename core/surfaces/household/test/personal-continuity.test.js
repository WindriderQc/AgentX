'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNestorClient } = require('../personal-continuity');

test('gateway bridge uses only existing server credentials and verifies source receipts', async () => {
  const env = { OPENCLAW_GATEWAY_URL: 'ws://localhost:18789', OPENCLAW_GATEWAY_TOKEN: 'test-only' };
  let captured;
  const client = createNestorClient({ env, fetchImpl: async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ ok: true, authority: 'openclaw.nestor', operation: 'agents', agents: [] }) };
  } });
  await client({ operation: 'agents' });
  assert.equal(captured.url, 'http://localhost:18789/api/nestor/continuity');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-only');
  assert.equal(captured.options.redirect, 'error');
  for (const value of [{ ok: false }, { ok: true, authority: 'other', operation: 'agents', agents: [] }, { ok: true, authority: 'openclaw.nestor', operation: 'agents' }]) {
    const invalid = createNestorClient({ env, fetchImpl: async () => ({ ok: true, json: async () => value }) });
    await assert.rejects(invalid({ operation: 'agents' }), { code: 'NESTOR_CONTINUITY_UNAVAILABLE' });
  }
  await assert.rejects(createNestorClient({ env: {} })({ operation: 'agents' }), { statusCode: 503 });
  for (const operation of ['list', 'remember', 'forget', 'context']) {
    await assert.rejects(client({ operation }), { statusCode: 503 });
  }
});
