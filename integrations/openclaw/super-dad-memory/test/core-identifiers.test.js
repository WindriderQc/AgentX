import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreIdentifiersClient, householdOwnerSession } from '../core-identifiers.js';

const id = 'a'.repeat(24);
const reply = data => async () => ({ ok: true, json: async () => ({ status: 'success', data }) });

test('personal_identifier sends only the action and id and checks the receipt', async () => {
  let body;
  const client = createCoreIdentifiersClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: 'success', data: { ok: true, authority: 'agentx.core', action: 'reveal', id, value: '1234567890' } }) };
  } });
  assert.equal((await client({ action: 'reveal', id, extra: 'x' })).value, '1234567890');
  assert.deepEqual(body, { action: 'reveal', id });
  const wrong = createCoreIdentifiersClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: reply({ ok: true, authority: 'agentx.core', action: 'reveal', id: 'b'.repeat(24), value: 'x' }) });
  await assert.rejects(wrong({ action: 'reveal', id }), /invalid/);
  await assert.rejects(client({ action: 'store', id }), /Unsupported/);
});

test('values are shown only in the Household owner session', () => {
  assert.equal(householdOwnerSession({ sessionKey: 'agent:main:household:direct:12345678-1234-1234-1234-123456789abc' }), true);
  assert.equal(householdOwnerSession({ sessionKey: 'agent:main:telegram:direct:42' }), false);
  assert.equal(householdOwnerSession({}), false);
});
