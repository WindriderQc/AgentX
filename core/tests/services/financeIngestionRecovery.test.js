'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const Statement = require('../../models/FinanceStatement');
const Transaction = require('../../models/FinanceTransaction');
const Override = require('../../models/FinanceOverride');
const Link = require('../../models/FinanceDocumentLink');
const ingestion = require('../../src/services/finance/financeIngestionService');
const journal = require('../../src/services/finance/financeIngestionJournal');
const access = require('../../src/services/finance/financeAccess');
const { normalizeExtraction } = require('../../src/services/finance/statementExtraction');
const { keyOf } = require('../../src/services/finance/financeTransactionIdentity');
const { hash } = require('../../src/services/finance/financeRepairStorage');
const categories = require('../../src/services/finance/financeCategories');
let temp, server, coreOrigin, errorLog;
const records = () => mongoose.connection.db.collection('finance_ingestions');
const raw = (values = [-100, -200]) => ({ issuer: 'Synthetic Bank', account_last4: '1234',
  period_start: '2026-06-01', period_end: '2026-06-30', accounts: [{ code: 'EOP', opening_cents: 10000,
    closing_cents: 10000 + values.reduce((sum, value) => sum + value, 0), transactions: values.map((amount, i) => ({
      date: `2026-06-${String(i + 10).padStart(2, '0')}`, description: `Synthetic purchase ${i}`, amount_cents: amount
    })) }] });
async function file(name) { const p = path.join(temp, name + '.pdf'); await fs.writeFile(p, name); return p; }
function options(value = raw(), extra = {}) {
  return { readText: async () => 'synthetic statement '.repeat(50), extract: async () => ({
    statement: normalizeExtraction(value), problems: [], attempts: 1, model: 'synthetic'
  }), ...extra };
}
async function resume(sourcePath, extra = {}) {
  const record = await records().findOne({ phase: { $in: ['writing', 'applied', 'intent'] } }, { sort: { createdAt: -1 } });
  return journal.resume({ requestKey: record._id, confirmedDigest: record.digest, sourcePath, actor: 'synthetic-operator', coreOrigin, ...extra });
}
function onceAt(phase, index) {
  let thrown = false;
  return async (current, detail) => {
    if (!thrown && current === phase && (index == null || detail?.index === index)) {
      thrown = true; throw new Error('synthetic interruption');
    }
  };
}
beforeEach(async () => {
  // This suite owns a disposable per-suite database, never a runtime store.
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Statement.syncIndexes(), Transaction.syncIndexes(), Override.syncIndexes(), Link.syncIndexes()]);
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-ingestion-recovery-'));
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  const app = express().use('/api/finance', require('../../routes/finance')());
  server = app.listen(0, '127.0.0.1');
  await require('node:events').once(server, 'listening');
  coreOrigin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { await new Promise(resolve => server.close(resolve)); jest.restoreAllMocks(); await fs.rm(temp, { recursive: true, force: true }); });

test('publishes the statement after rows, with stable membership and a terminal receipt', async () => {
  const source = await file('first');
  const seen = [];
  const receipt = await ingestion.ingestDocument(source, options(raw(), { checkpoint: async phase => {
    if (phase === 'accounting_written') seen.push(await Statement.collection.countDocuments({ status: 'reconciled' }));
  } }));
  expect(seen).toEqual([0, 0, 1]);
  expect(receipt).toMatchObject({ outcome: 'reconciled', inserted: 2, overlapping: 0 });
  const saved = await Statement.findById(receipt.statementId).lean();
  expect(saved.rowKeys).toHaveLength(2);
  await journal.verifyStored(saved);
  expect((await access.state()).ingestion).toBeNull();
  expect((await records().findOne({ _id: receipt.requestKey })).receipt).toEqual(receipt);
});

test('journal reads stay bounded when a larger statement records per-row progress', async () => {
  const find = jest.spyOn(mongoose.mongo.Collection.prototype, 'findOne');
  const result = await ingestion.ingestDocument(await file('larger'), options(raw(Array(20).fill(-1))));
  const journalReads = find.mock.contexts.filter(collection => collection.collectionName === 'finance_ingestions').length;
  expect(result.inserted).toBe(20);
  expect(journalReads).toBeLessThanOrEqual(4);
});

test.each([['intent_prepared', null], ['accounting_written', 0], ['accounting_written', 1], ['accounting_written', 2], ['terminal_saved', null]])(
  'recovers the same identity after %s/%s without inference or a duplicate effect', async (phase, index) => {
    const source = await file('interrupted');
    await expect(ingestion.ingestDocument(source, options(raw(), { checkpoint: onceAt(phase, index) }))).rejects.toThrow('synthetic interruption');
    const before = await records().findOne({});
    expect((await access.state()).ingestion.requestKey).toBe(before._id);
    await expect(Transaction.find().lean()).rejects.toMatchObject({ code: 'FINANCE_MAINTENANCE' });
    const result = await resume(source);
    expect(result.requestKey).toBe(before._id);
    expect(result.digest).toBe(before.digest);
    expect(await Transaction.countDocuments()).toBe(2);
    expect(await Statement.countDocuments({ status: 'reconciled' })).toBe(1);
    const after = await records().findOne({});
    expect(await resume(source)).toEqual(result);
    expect(await records().findOne({})).toEqual(after);
    const extract = jest.fn();
    expect((await ingestion.ingestDocument(source, options(raw(), { extract }))).outcome).toBe('duplicate');
    expect(extract).not.toHaveBeenCalled();
  });

test('quarantines an unanswered accounting write and never retries an unobserved effect', async () => {
  const source = await file('unanswered');
  const originalInsert = mongoose.mongo.Collection.prototype.insertOne;
  let thrown = false;
  const insert = jest.spyOn(mongoose.mongo.Collection.prototype, 'insertOne').mockImplementation(function (...args) {
    if (this.collectionName === 'finance_transactions' && !thrown) {
      thrown = true; return Promise.reject(new Error('synthetic lost database reply'));
    }
    return originalInsert.apply(this, args);
  });
  await expect(ingestion.ingestDocument(source, options())).rejects.toThrow('synthetic lost database reply');
  expect(await Statement.collection.countDocuments({ status: 'reconciled' })).toBe(0);
  expect(await Transaction.collection.countDocuments()).toBe(0);
  await expect(resume(source)).rejects.toMatchObject({ code: 'FINANCE_INGESTION_WRITE_UNCERTAIN' });
  expect(insert.mock.contexts.filter(collection => collection.collectionName === 'finance_transactions')).toHaveLength(1);
  const extract = jest.fn();
  await expect(ingestion.ingestDocument(source, options(raw(), { extract }))).rejects.toMatchObject({ code: 'FINANCE_MAINTENANCE' });
  expect(extract).not.toHaveBeenCalled();
  insert.mockRestore();
  // Independent native observation: the exact outstanding command arrived.
  // Recovery may now observe it; it still never reissues that insert.
  const saved = await records().findOne({});
  await Transaction.collection.insertOne(saved.steps[0].after);
  expect((await resume(source)).outcome).toBe('reconciled');
  expect(await Transaction.countDocuments()).toBe(2);
});

test('blocks ordinary API reads, mutations and repairs until native recovery releases ingestion', async () => {
  const source = await file('fenced');
  await expect(ingestion.ingestDocument(source, options(raw(), { checkpoint: onceAt('accounting_written', 0) }))).rejects.toThrow();
  const server = express().use('/api/finance', require('../../routes/finance')());
  await request(server).get('/api/finance/transactions').expect(503);
  await request(server).post('/api/finance/plan/ops').expect(503);
  const maintenance = await request(server).get('/api/finance/maintenance').expect(200);
  expect(maintenance.body.data).toMatchObject({ held: true, operation: 'ingestion', protocol: 'agentx.finance-maintenance/v2' });
  await expect(access.hold('repair', 'digest', 'synthetic-root')).rejects.toMatchObject({ code: 'FINANCE_REPAIR_HELD' });
  await resume(source);
  await request(server).get('/api/finance/transactions').expect(200);
});

test('replacement preserves stable row ids, owner decisions and confirmed links', async () => {
  const first = await file('old');
  await ingestion.ingestDocument(first, options(raw([-100, -200])));
  const old = await Transaction.find().sort({ date: 1 }).lean();
  await categories.setTransactions({ id: String(old[0]._id), category: 'Restaurants', tags: ['owner'] });
  await Link.create({ key: 'document|' + keyOf(old[0]), documentId: 'document', transactionKey: keyOf(old[0]), status: 'confirmed' });
  const links = await Link.find().lean();
  const source = await file('replacement');
  await expect(ingestion.ingestDocument(source, options(raw([-100, -200, -300]), { checkpoint: onceAt('accounting_written', 0) }))).rejects.toThrow();
  const receipt = await resume(source);
  expect(receipt).toMatchObject({ replaced: true, inserted: 1 });
  const retained = await Transaction.findById(old[0]._id).lean();
  expect(retained).toMatchObject({ category: 'Restaurants', tags: ['owner'], manual: true });
  expect(await Link.find().lean()).toEqual(links);
  expect(await Transaction.countDocuments()).toBe(3);
});

test('replacement keeps a removed row when another received export still requires it', async () => {
  const first = await file('full');
  await ingestion.ingestDocument(first, options(raw()));
  const overlap = raw(); overlap.period_end = '2026-06-20';
  const exportReceipt = await ingestion.ingestDocument(await file('export'), options(overlap));
  expect(exportReceipt).toMatchObject({ inserted: 0, overlapping: 2 });
  await ingestion.ingestDocument(await file('corrected'), options(raw([-100])));
  expect(await Transaction.countDocuments()).toBe(2);
  await journal.verifyStored(await Statement.findById(exportReceipt.statementId).lean());
  for (const statement of await Statement.find().lean()) await journal.verifyStored(statement);
});

test('a duplicate with lost stored rows is refused instead of declared healthy', async () => {
  const source = await file('damaged');
  await ingestion.ingestDocument(source, options());
  await Transaction.deleteOne({});
  await expect(ingestion.ingestDocument(source, options())).rejects.toMatchObject({ code: 'FINANCE_INGESTION_STATE_CONFLICT' });
});

test('reuses a needs-review id and retains its attempts and rejection history', async () => {
  const source = await file('review');
  await ingestion.ingestDocument(source, options(raw(), { extract: async () => ({ statement: normalizeExtraction(raw()),
    problems: ['synthetic rejected reading'], attempts: 4, model: 'synthetic' }) }));
  const before = await Statement.findOne().lean();
  const result = await ingestion.ingestDocument(source, options());
  const after = await Statement.findOne().lean();
  expect(String(after._id)).toBe(String(before._id));
  expect(result.attempts).toBe(5);
  expect(after.reviewHistory[0]).toMatchObject({ attempts: 4, problems: ['synthetic rejected reading'] });
});

test('recovery refuses a changed source or digest and retains its fence', async () => {
  const source = await file('source');
  await expect(ingestion.ingestDocument(source, options(raw(), { checkpoint: onceAt('intent_prepared') }))).rejects.toThrow();
  const original = await records().findOne({});
  await expect(resume(source, { confirmedDigest: 'wrong' })).rejects.toMatchObject({ code: 'FINANCE_INGESTION_STATE_CONFLICT' });
  await fs.writeFile(source, 'changed');
  await expect(resume(source)).rejects.toMatchObject({ code: 'FINANCE_INGESTION_STATE_CONFLICT' });
  expect((await access.state()).ingestion.requestKey).toBe(original._id);
  expect(hash(await records().findOne({}))).toBe(hash(original));
});

test('a source changed during extraction is never published', async () => {
  const source = await file('changing');
  const extract = async () => { await fs.writeFile(source, 'different bytes'); return { statement: normalizeExtraction(raw()), problems: [], attempts: 1 }; };
  await expect(ingestion.ingestDocument(source, options(raw(), { extract }))).rejects.toMatchObject({ code: 'FINANCE_INGESTION_SOURCE_CHANGED' });
  expect(await Statement.countDocuments()).toBe(0);
  expect(await records().countDocuments()).toBe(0);
});

test('a changed source is not recorded as a rejected reading of the original bytes', async () => {
  const source = await file('changing-rejection');
  const extract = async () => { await fs.writeFile(source, 'different bytes'); return { statement: normalizeExtraction(raw()), problems: ['bad reading'], attempts: 1 }; };
  await expect(ingestion.ingestDocument(source, options(raw(), { extract }))).rejects.toMatchObject({ code: 'FINANCE_INGESTION_SOURCE_CHANGED' });
  expect(await Statement.countDocuments()).toBe(0);
});

test('native recovery refuses a changed saved plan instead of applying its modified values', async () => {
  const source = await file('plan-drift');
  await expect(ingestion.ingestDocument(source, options(raw(), { checkpoint: onceAt('intent_prepared') }))).rejects.toThrow();
  const saved = await records().findOne({});
  await records().updateOne({ _id: saved._id }, { $set: { 'steps.0.after.amountCents': -99999 } });
  await expect(resume(source)).rejects.toMatchObject({ code: 'FINANCE_INGESTION_STATE_CONFLICT' });
  expect(await Transaction.collection.countDocuments()).toBe(0);
  expect((await access.state()).ingestion.requestKey).toBe(saved._id);
});

test('native CLI requires an exact recovery request rather than a reset command', () => {
  const { argumentsOf } = require('../../scripts/finance-ingestion-recovery');
  expect(argumentsOf(['status'])).toEqual({ command: 'status', options: {} });
  expect(() => argumentsOf(['reset'])).toThrow('Choose status or resume');
  expect(() => argumentsOf(['resume', '--request', 'id'])).toThrow('requires');
});

test('drains an existing reader before the first accounting write and refuses new reads', async () => {
  let releaseReader, markStarted;
  const done = new Promise(resolve => { releaseReader = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const reader = access.withAccess(async () => { markStarted(); await done; });
  await started;
  const source = await file('draining');
  const writing = ingestion.ingestDocument(source, options());
  try {
    for (let attempt = 0; attempt < 100 && !(await access.state()).ingestion; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect((await access.state()).ingestion).toBeTruthy();
    expect(await Transaction.collection.countDocuments()).toBe(0);
    await expect(Transaction.find().lean()).rejects.toMatchObject({ code: 'FINANCE_MAINTENANCE' });
  } finally { releaseReader(); await reader; }
  expect((await writing).outcome).toBe('reconciled');
});

test('two concurrently admitted copies cannot both own ingestion or duplicate its rows', async () => {
  const source = await file('concurrent');
  let arrived = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  const readText = async () => { if (++arrived === 2) release(); await both; return 'synthetic statement '.repeat(50); };
  const results = await Promise.allSettled([
    ingestion.ingestDocument(source, options(raw(), { readText })),
    ingestion.ingestDocument(source, options(raw(), { readText }))
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(await Transaction.countDocuments()).toBe(2);
  expect(await records().countDocuments()).toBe(1);
  expect((await access.state()).ingestion).toBeNull();
  expect((await access.state()).readers).toEqual([]);
});

test('native recovery admits only one live writer for an interrupted identity', async () => {
  const source = await file('recovery-owner');
  await expect(ingestion.ingestDocument(source, options(raw(), { checkpoint: onceAt('accounting_written', 0) }))).rejects.toThrow();
  let ready, release;
  const started = new Promise(resolve => { ready = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const recovering = resume(source, { checkpoint: async phase => { if (phase === 'accounting_written') { ready(); await wait; } } });
  await started;
  try { await expect(resume(source)).rejects.toMatchObject({ code: 'FINANCE_INGESTION_HELD' }); }
  finally { release(); }
  expect((await recovering).actor).toBe('synthetic-operator');
  expect(await Transaction.countDocuments()).toBe(2);
});

test('refuses a replacement that may delete a row required by legacy overlapping evidence', async () => {
  await ingestion.ingestDocument(await file('legacy-full'), options());
  const overlap = raw(); overlap.period_end = '2026-06-20';
  const other = await ingestion.ingestDocument(await file('legacy-export'), options(overlap));
  await Statement.updateOne({ _id: other.statementId }, { $unset: { rowKeys: '' } });
  const before = await Transaction.find().sort({ _id: 1 }).lean();
  const result = await ingestion.ingestDocument(await file('legacy-replacement'), options(raw([-100])));
  expect(result).toMatchObject({ outcome: 'needs_review', problems: [expect.stringContaining('legacy overlapping')] });
  expect(await Transaction.find().sort({ _id: 1 }).lean()).toEqual(before);
  expect((await access.state()).ingestion).toBeNull();
});

test.each([['legacy-protocol', 'agentx.finance-maintenance/v1', 503], ['unfenced-core', 'agentx.finance-maintenance/v2', 200]])(
  'native recovery refuses %s without accounting writes', async (_name, protocol, inboxStatus) => {
    const source = await file('unqualified-core');
    await expect(ingestion.ingestDocument(source, options(raw(), { checkpoint: onceAt('intent_prepared') }))).rejects.toThrow();
    const app = express();
    app.get('/api/finance/maintenance', async (_req, res) => res.json({ data: { protocol, databaseIdentity: (await access.state()).identity } }));
    app.get('/api/finance/inbox', (_req, res) => res.status(inboxStatus).json({ code: inboxStatus === 503 ? 'FINANCE_MAINTENANCE' : null }));
    const fake = app.listen(0, '127.0.0.1');
    await require('node:events').once(fake, 'listening');
    try {
      await expect(resume(source, { coreOrigin: `http://127.0.0.1:${fake.address().port}` }))
        .rejects.toMatchObject({ code: 'FINANCE_REPAIR_CORE_UNQUALIFIED' });
      expect(await Transaction.collection.countDocuments()).toBe(0);
      expect((await access.state()).ingestion).toBeTruthy();
    } finally { await new Promise(resolve => fake.close(resolve)); }
  });
