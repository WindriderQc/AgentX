import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreVaultClient } from '../core-vault.js';

const receiptData = { ok: true, authority: 'agentx.core', operation: 'write_vault_note', status: 'inbox',
  file: '2026-09-23 Synthetic.md', title: 'Synthetic', created: '2026-09-23T00:00:00.000Z' };

test('vault_note forwards only note fields and validates the Core receipt', async () => {
  let captured;
  const client = createCoreVaultClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ status: 'success', data: receiptData }) };
  } });
  const result = await client({ title: 'Synthetic', body: 'Text', tags: ['idee'], author: 'nestor', path: '/ignored' });
  assert.equal(result.file, '2026-09-23 Synthetic.md');
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/consumers/nestor/v1/vault/notes');
  assert.deepEqual(JSON.parse(captured.options.body), { title: 'Synthetic', body: 'Text', tags: ['idee'] });
  assert.equal(captured.options.redirect, 'error');
});

test('vault_note refuses a failed or foreign receipt', async () => {
  const failing = createCoreVaultClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing({ title: 'x', body: 'y' }), /unavailable \(503\)/);
  for (const data of [{ ...receiptData, authority: 'openclaw' }, { ...receiptData, file: '../x' }, { ...receiptData, status: 'saved' }]) {
    const broken = createCoreVaultClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: true,
      json: async () => ({ status: 'success', data }) }) });
    await assert.rejects(broken({ title: 'x', body: 'y' }), /receipt is invalid/);
  }
  assert.throws(() => createCoreVaultClient(), /Configure/);
});
