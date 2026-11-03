import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stageJournal, commitJournal, flushJournal } from '../lib/journal-outbox.js';

const entry = { threadId: 'thread001', messageId: 'message001', category: 'Needs Reply', occurredAt: '2026-01-01T00:00:00Z',
  subject: 'Synthetic', counterpart: 'Synthetic sender', summary: 'Synthetic request to return a form.' };
const success = data => ({ ok: true, json: async () => ({ status: 'success', data: { ok: true, ...data } }) });
async function config(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gmail-journal-outbox-'));
  t.after(() => rm(root, { recursive: true }));
  return { account: 'synthetic', coreUrl: 'http://synthetic.invalid', triageStateFile: path.join(root, 'cursor.json') };
}

test('a classified message whose digest failed is delivered on a later empty-mail turn', async t => {
  const settings = await config(t), staged = await stageJournal(settings, entry);
  const failed = await commitJournal(settings, staged, async () => { throw new Error('Synthetic Core unavailable'); });
  assert.equal(failed.queued, true);
  const writes = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'record') writes.push(body);
    return success(body.action === 'search' ? { entries: [] } : { recorded: true });
  };
  assert.deepEqual(await flushJournal(settings, { fetchImpl, applied: () => assert.fail('ready delivery needs no provider read') }), { pending: 0, delivered: 1 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].messageId, entry.messageId);
  assert.deepEqual(await flushJournal(settings, { fetchImpl }), { pending: 0, delivered: 0 });
});

test('an interrupted prepared classification needs exact native confirmation before publishing its digest', async t => {
  const settings = await config(t);
  await stageJournal(settings, entry);
  assert.equal((await flushJournal(settings, { applied: async () => false, fetchImpl: () => assert.fail('no premature digest') })).pending, 1);
  let writes = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'record') writes++;
    return success(body.action === 'search' ? { entries: [] } : { recorded: true });
  };
  assert.equal((await flushJournal(settings, { applied: async (_config, source) => source.messageId === entry.messageId, fetchImpl })).pending, 0);
  assert.equal(writes, 1);
});

test('a lost Core acknowledgement replays by exact message identity without replacing an existing digest', async t => {
  const settings = await config(t), staged = await stageJournal(settings, entry);
  let recorded = false, writes = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'search') return success({ entries: recorded ? [{ threadId: entry.threadId, messageId: entry.messageId }] : [] });
    writes++; recorded = true;
    throw new Error('Synthetic response lost after commit');
  };
  assert.equal((await commitJournal(settings, staged, fetchImpl)).queued, true);
  assert.equal((await flushJournal(settings, { fetchImpl })).delivered, 1);
  assert.equal(writes, 1);
});

test('round-robin retries do not let unconfirmed classifications starve ready digests', async t => {
  const settings = await config(t), staged = [];
  for (let n = 0; n < 4; n++) staged.push(await stageJournal(settings, { ...entry, messageId: `message00${n}` }));
  staged.sort((a, b) => a.file.localeCompare(b.file));
  await commitJournal(settings, staged.at(-1), async () => { throw new Error('Synthetic outage'); });
  let delivered = 0;
  for (let n = 0; n < 4; n++) {
    const value = await flushJournal(settings, { limit: 1, applied: async () => false,
      fetchImpl: async (_url, init) => success(JSON.parse(init.body).action === 'search' ? { entries: [] } : { recorded: true }) });
    delivered += value.delivered;
  }
  assert.equal(delivered, 1);
});
