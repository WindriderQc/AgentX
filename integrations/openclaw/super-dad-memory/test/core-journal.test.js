import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreJournalClient } from '../core-journal.js';

const entry = { id: 'a'.repeat(24), threadId: 'thread-1', occurredAt: '2026-09-30T12:00:00.000Z', summary: 'Synthetic school notice' };

test('mail_journal forwards only journal fields and validates the Core receipt', async () => {
  let captured;
  const client = createCoreJournalClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body), redirect: options.redirect };
    return { ok: true, json: async () => ({ status: 'success', data: { ok: true, authority: 'agentx.core', action: 'record', recorded: true, entry } }) };
  } });
  const result = await client({ action: 'record', threadId: 'thread-1', occurredAt: entry.occurredAt, summary: entry.summary, scope: 'household', collection: 'x' });
  assert.equal(result.entry.id, entry.id);
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/consumers/nestor/v1/mail-journal');
  assert.deepEqual(captured.body, { action: 'record', threadId: 'thread-1', occurredAt: entry.occurredAt, summary: entry.summary });
  assert.equal(captured.redirect, 'error');
});

test('mail_journal refuses unknown actions, failures and foreign receipts', async () => {
  const ok = data => createCoreJournalClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'success', data }) }) });
  await assert.rejects(ok({})({ action: 'delete' }), /Unsupported/);
  const failing = createCoreJournalClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing({ action: 'search', query: 'x' }), /unavailable \(503\)/);
  await assert.rejects(ok({ ok: true, authority: 'openclaw', action: 'search', entries: [] })({ action: 'search' }), /invalid/);
  await assert.rejects(ok({ ok: true, authority: 'agentx.core', action: 'record', recorded: true, entry: { ...entry, threadId: 'other' } })(
    { action: 'record', threadId: 'thread-1', occurredAt: entry.occurredAt, summary: 'x' }), /invalid/);
  const found = await ok({ ok: true, authority: 'agentx.core', action: 'search', entries: [entry], total: 1 })({ action: 'search', query: 'school' });
  assert.equal(found.entries.length, 1);
});
