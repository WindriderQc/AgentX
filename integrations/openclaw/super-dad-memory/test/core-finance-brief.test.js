import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreFinanceBriefClient } from '../core-finance-brief.js';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const client = fetchImpl => createCoreFinanceBriefClient({ baseUrl: 'http://core.invalid', fetchImpl });

test('returns the finance line from Core as a text section', async () => {
  const seen = [];
  const line = await client(async (url, init) => {
    seen.push([String(url), init.method]);
    return reply(200, { status: 'success', data: { summary: 'Finances : Impôt corp en retard · 1 relevé attendu', counts: {} } });
  })();
  assert.deepEqual(seen, [['http://core.invalid/api/finance/brief', 'GET']]);
  assert.deepEqual(line, { text: 'Finances : Impôt corp en retard · 1 relevé attendu' });
});

test('omits the section when Core is down, refuses, or has nothing to say', async () => {
  assert.equal(await client(async () => { throw new Error('connect ECONNREFUSED'); })(), null);
  assert.equal(await client(async () => reply(503, { status: 'error' }))(), null);
  assert.equal(await client(async () => reply(200, { status: 'success', data: { summary: null } }))(), null);
  assert.equal(await createCoreFinanceBriefClient({ baseUrl: undefined })(), null);
});

test('never relays a line that carries an amount or a long number', async () => {
  const withAmount = client(async () => reply(200, { status: 'success', data: { summary: 'Finances : Odyssée 150 $ à payer' } }));
  assert.equal(await withAmount(), null);
  const withAccount = client(async () => reply(200, { status: 'success', data: { summary: 'Finances : compte 1234567 en retard' } }));
  assert.equal(await withAccount(), null);
});
