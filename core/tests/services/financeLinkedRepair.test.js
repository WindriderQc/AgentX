'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const mongoose = require('mongoose');
const Statement = require('../../models/FinanceStatement');
const Transaction = require('../../models/FinanceTransaction');
const Override = require('../../models/FinanceOverride');
const Link = require('../../models/FinanceDocumentLink');
const access = require('../../src/services/finance/financeAccess');
const storage = require('../../src/services/finance/financeRepairStorage');
const check = require('../../src/services/finance/financeRepairChecks');
const contract = require('../../src/services/finance/financeRepairManifest');
const { createExecutor } = require('../../src/services/finance/financeRepairExecutor');
const documents = require('../../src/services/finance/financeDocumentLinks');
const register = require('../../src/services/finance/financeDocumentRegister');
const linkContract = require('../../src/services/finance/financeRepairLinkContract');

let temp, server, manifest, options, baseline, rawDocuments, previousRegister, previousNames;
const serialize = () => { const bytes = Buffer.from(JSON.stringify(manifest)); return { bytes, confirmedDigest: storage.hash(bytes) }; };
const execute = (extra = {}) => createExecutor().execute({ ...options, ...serialize(), ...extra });
const update = (collection, before, set) => ({ collection, id: before._id, before, expectedBeforeSha256: storage.hash(before),
  set, setAtExecution: { updatedAt: 'receipt.appliedAtUtc' }, insert: false, upsert: false, matchCountRequired: 1 });
const writeRegister = () => fs.writeFile(process.env.FINANCE_SECRETARY_REGISTER, JSON.stringify({ schemaVersion: 3, invoices: rawDocuments, complete: true }));
const linkUpdates = () => manifest.updates.filter(u => u.collection === 'finance_document_links');
const journal = () => mongoose.connection.db.collection('finance_repairs').findOne({ _id: manifest.requestKey });

beforeEach(async () => {
  previousRegister = process.env.FINANCE_SECRETARY_REGISTER;
  previousNames = process.env.FINANCE_CORP_NAMES;
  delete process.env.FINANCE_CORP_NAMES;
  for (const name of [...contract.COLLECTIONS, 'finance_repairs', 'finance_coordination', 'finance_ingestions']) {
    await mongoose.connection.db.collection(name).deleteMany({});
  }
  await Promise.all([Statement.syncIndexes(), Transaction.syncIndexes(), Override.syncIndexes(), Link.syncIndexes()]);
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'finance-linked-repair-test-'));
  const archive = path.join(temp, 'archive'); await fs.mkdir(archive);
  const original = path.join(archive, 'original.pdf'); await fs.writeFile(original, 'synthetic linked statement');
  process.env.FINANCE_SECRETARY_REGISTER = path.join(temp, 'register.json');
  rawDocuments = [23000,23000,595].map((grossAmountCents,i) => ({ supplier: 'Example Accountant', documentNumber: 'S-'+i,
    documentDate: ['2025-08-04','2025-08-14','2025-08-30'][i], kind: 'invoice', grossAmountCents,
    person: 'Example Corporation', originalFilename: 'synthetic-invoice-'+i+'.pdf' }));
  await writeRegister();
  const s = await Statement.create({ issuer: 'Example Bank', accountLast4: null, status: 'reconciled',
    statementKey: 'example|-|2025-08-01|2025-08-31', periodStart: '2025-08-01', periodEnd: '2025-08-31',
    fileName: 'original.pdf', fileSha256: storage.hash('synthetic linked statement'), archivePath: original,
    accounts: [{ code: 'EOP', accountKey: 'example|-|EOP', openingCents: 100000, closingCents: 53405, transactionCount: 3 }] });
  const rows = await Transaction.create(rawDocuments.map((doc,i) => ({ _id: (i+1).toString(16).padStart(24,'0'),
    statementId: s._id, accountKey: 'example|-|EOP', accountCode: 'EOP', date: ['2025-08-05','2025-08-15','2025-08-31'][i],
    description: 'Example Accountant '+i, amountCents: -doc.grossAmountCents, flowCents: -doc.grossAmountCents,
    balanceAfterCents: [77000,54000,53405][i], fingerprint: 'row-'+i, occurrence: 1,
    category: 'Impôts', tags: ['preserved'], manual: i === 0 })));
  await Override.create({ accountKey: rows[0].accountKey, date: rows[0].date, fingerprint: rows[0].fingerprint,
    occurrence: 1, category: 'Impôts', tags: ['preserved'], createdBy: 'owner' });
  await Statement.collection.updateOne({ _id: s._id }, { $unset: { ledger: '' } });
  await Transaction.collection.updateMany({ statementId: s._id }, { $unset: { ledger: '' } });
  for (const ledger of ['perso','corp']) {
    const prefix = ledger === 'corp' ? 'corp:' : '';
    await Statement.create({ issuer: 'Example Bank', ledger, status: 'reconciled', fileName: ledger+'.pdf', fileSha256: storage.hash(ledger),
      statementKey: prefix+'example|-|2026-01-01|2026-01-31', periodStart: '2026-01-01', periodEnd: '2026-01-31',
      accounts: [{ code: 'EOP', accountKey: prefix+'example|-|EOP', openingCents: 70000, closingCents: 70000, transactionCount: 0 }] });
  }
  const normalized = (await register.loadRegister()).invoices;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i], doc = normalized[i], key = contract.keyOf(t), status = ['proposed','confirmed','rejected'][i];
    await Link.create({ key: doc.id+'|'+key, documentId: doc.id, transactionKey: key, status, ambiguous: i === 0,
      document: { ...linkContract.documentImage(doc), ledger: 'perso' },
      transaction: { accountKey: t.accountKey, date: t.date, description: t.description, flowCents: t.flowCents, category: t.category },
      decidedAt: i ? new Date('2026-01-01') : null, decidedBy: i ? 'owner' : null });
  }
  await Link.create({ key: 'unrelated|row', documentId: 'unrelated', transactionKey: 'row', status: 'rejected', decidedBy: 'owner' });
  baseline = await check.snapshot(mongoose.connection.db);
  const before = storage.plain(baseline);
  const statement = before.finance_statements.find(row => row._id === String(s._id));
  manifest = { schemaVersion: 3, requestKey: 'synthetic-linked-book-repair-v3',
    verifiedIdentity: { ledger: 'corp', issuer: s.issuer, last4: '1234', periodStart: s.periodStart, periodEnd: s.periodEnd,
      pdfSha256: s.fileSha256, originalArchivePath: original, transactionOrder: { EOP: rows.map(t => String(t._id)) }, documents: normalized },
    legacyIdentityRetained: { accountLast4: null }, expectedAccounting: { latestBalancesExpectedUnchangedInBothLedgers: true },
    updates: [update('finance_statements', statement, { ledger: 'corp', statementKey: 'corp:'+s.statementKey, 'accounts.0.accountKey': 'corp:example|-|EOP' }),
      ...before.finance_transactions.map(t => update('finance_transactions', t, { ledger: 'corp', accountKey: 'corp:'+t.accountKey })),
      ...before.finance_overrides.map(o => update('finance_overrides', o, { accountKey: 'corp:'+o.accountKey })),
      ...before.finance_document_links.filter(l => l.documentId !== 'unrelated').map(l => update('finance_document_links', l,
        { key: l.documentId+'|corp:'+l.transactionKey, transactionKey: 'corp:'+l.transactionKey,
          'transaction.accountKey': 'corp:'+l.transaction.accountKey, 'document.ledger': 'corp',
          bookRepair: { requestKey: 'synthetic-linked-book-repair-v3', documentSha256: storage.hash(normalized.find(d => d.id === l.documentId)) } }))] };
  const app = require('express')().use('/api/finance', require('../../routes/finance')());
  server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  options = { mode: 'apply', actor: 'synthetic-test', receiptRoot: path.join(temp,'receipts'), archiveRoot: archive,
    coreOrigin: 'http://127.0.0.1:'+server.address().port };
});

afterEach(async () => {
  await new Promise(r => server.close(r)); await fs.rm(temp,{ recursive: true, force: true });
  if (previousRegister === undefined) delete process.env.FINANCE_SECRETARY_REGISTER; else process.env.FINANCE_SECRETARY_REGISTER = previousRegister;
  if (previousNames === undefined) delete process.env.FINANCE_CORP_NAMES; else process.env.FINANCE_CORP_NAMES = previousNames;
});

test('migrates exact links and decisions in place and survives document consultations without global configuration', async () => {
  const receipt = await execute();
  expect(receipt).toMatchObject({ phase: 'applied', documents: 8, inserted: 0, deleted: 0, arithmeticResidualCents: 0, latestBalancesUnchanged: true });
  const after = await check.snapshot(mongoose.connection.db);
  expect(after).toEqual(check.derive(baseline,manifest,check.typedAfter(check.images(baseline,manifest),manifest,new Date(receipt.appliedAtUtc))));
  const corp = await documents.documents({ ledger: 'corp' });
  expect(corp.ambiguous[0].candidates[0].id).toBe(linkUpdates()[0].id);
  expect(corp.confirmed[0].id).toBe(linkUpdates()[1].id);
  const personal = await documents.documents({ ledger: 'perso' });
  expect(personal.unmatchedDocuments.items).toHaveLength(0);
  expect(personal.proposals).toHaveLength(0);
  expect(await check.snapshot(mongoose.connection.db)).toEqual(after);
  expect(await execute({ mode: 'resume' })).toEqual(receipt);
  expect((await execute({ mode: 'rollback' })).exactBeforeImagesRestored).toBe(true);
  expect(await check.snapshot(mongoose.connection.db)).toEqual(baseline);
  expect((await access.state()).repair).toBeNull();
});

test('retains the owner decision made after migration and refuses to roll it back', async () => {
  await execute();
  await documents.decide(linkUpdates()[0].id,'confirmed','owner');
  const decided = await check.snapshot(mongoose.connection.db);
  await documents.documents({ ledger: 'corp' });
  expect(await check.snapshot(mongoose.connection.db)).toEqual(decided);
  await expect(execute({ mode: 'rollback' })).rejects.toMatchObject({ code: 'FINANCE_REPAIR_STATE_CONFLICT' });
  expect(await check.snapshot(mongoose.connection.db)).toEqual(decided);
  expect((await access.state()).repair).toBeNull();
});

test.each(['status','amount','document-id','transaction-key','extra-document','missing-document','missing-link','duplicate-link','unreviewed-set'])('refuses invalid linked manifest: %s', async kind => {
  const u = linkUpdates()[0];
  if (kind === 'status') u.set.status = 'confirmed';
  if (kind === 'amount') u.before.document.amountCents++;
  if (kind === 'document-id') u.before.documentId = 'bad-document';
  if (kind === 'transaction-key') u.before.transactionKey += '|other';
  if (kind === 'extra-document') manifest.verifiedIdentity.documents.push({ ...manifest.verifiedIdentity.documents[0], id: '0000000000000000' });
  if (kind === 'missing-document') manifest.verifiedIdentity.documents.pop();
  if (kind === 'missing-link') manifest.updates.splice(manifest.updates.indexOf(u),1);
  if (kind === 'duplicate-link') manifest.updates.push(structuredClone(u));
  if (kind === 'unreviewed-set') u.set['transaction.category'] = 'Autres';
  u.expectedBeforeSha256 = storage.hash(u.before);
  await expect(execute()).rejects.toMatchObject({ code: 'FINANCE_REPAIR_MANIFEST_INVALID' });
  expect(await journal()).toBeNull();
  expect(await check.snapshot(mongoose.connection.db)).toEqual(baseline);
});

test.each(['new-link','destination-link','linked-other-row','invoice-drift','invoice-missing'])('refuses live relation drift before writing: %s', async kind => {
  const u = linkUpdates()[0], b = u.before;
  if (kind === 'new-link') await Link.create({ ...b, _id: new mongoose.Types.ObjectId(), documentId: 'new-document', key: 'new-document|'+b.transactionKey });
  if (kind === 'destination-link') await Link.create({ ...b, _id: new mongoose.Types.ObjectId(), key: u.set.key, transactionKey: u.set.transactionKey });
  if (kind === 'linked-other-row') await Link.create({ ...b, _id: new mongoose.Types.ObjectId(), key: b.documentId+'|other-row', transactionKey: 'other-row' });
  if (kind === 'invoice-drift') rawDocuments[0].person = 'Another Corporation';
  if (kind === 'invoice-missing') rawDocuments.shift();
  await writeRegister();
  const before = await check.snapshot(mongoose.connection.db);
  await expect(execute()).rejects.toMatchObject({ code: kind.startsWith('invoice') ? 'FINANCE_REPAIR_DOCUMENTS_CHANGED' : 'FINANCE_REPAIR_STATE_CONFLICT' });
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
  expect((await journal()).phase).toBe('rejected');
  expect((await access.state()).repair).toBeNull();
});

test.each(['register','row','marker'])('refuses document sync before any write when retained %s drifts', async kind => {
  await execute();
  if (kind === 'register') { rawDocuments[0].kind = 'receipt'; await writeRegister(); }
  if (kind === 'row') await Transaction.updateOne({ _id: manifest.updates[1].id }, { $set: { flowCents: -1 } });
  if (kind === 'marker') await Link.updateOne({ _id: linkUpdates()[0].id }, { $set: { bookRepair: null } });
  const before = await check.snapshot(mongoose.connection.db);
  await expect(documents.documents({ ledger: 'corp' })).rejects.toMatchObject({ code: 'FINANCE_DOCUMENT_REPAIR_CONFLICT' });
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
});

test('does not accept an old Core without durable linked-repair support', async () => {
  await new Promise(r => server.close(r));
  const app = require('express')().get('/api/finance/maintenance',async (_req,res) => res.json({ data: {
    protocol: require('../../src/services/finance/financeRepairCoreProof').PROTOCOL, databaseIdentity: (await access.state()).identity } }));
  server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  options.coreOrigin = 'http://127.0.0.1:'+server.address().port;
  await expect(execute()).rejects.toMatchObject({ code: 'FINANCE_REPAIR_CORE_UNQUALIFIED' });
  expect(await check.snapshot(mongoose.connection.db)).toEqual(baseline);
  expect((await access.state()).repair).toBeNull();
});

async function killAt(mode, stop, index) {
  const file = path.join(temp,'manifest.json'); await fs.writeFile(file,serialize().bytes);
  const child = fork(path.join(__dirname,'../fixtures/financeRepairProcess.cjs'),[
    process.env.MONGODB_URI,options.receiptRoot,options.archiveRoot,file,mode,stop,String(index),options.coreOrigin
  ],{ stdio: ['ignore','ignore','ignore','ipc'], env: { ...process.env } });
  const [message] = await once(child,'message');
  const exit = once(child,'exit'); child.kill('SIGKILL'); await exit;
  expect(message).toMatchObject({ checkpoint: stop, index });
}

test('resumes an interrupted link write, then restores exact links after an interrupted rollback', async () => {
  const i = manifest.updates.indexOf(linkUpdates()[1]);
  await killAt('apply','applied_step',i);
  expect((await execute({ mode: 'resume' })).phase).toBe('applied');
  await killAt('rollback','rollback_step',i);
  expect((await execute({ mode: 'resume' })).phase).toBe('rolled_back');
  expect(await check.snapshot(mongoose.connection.db)).toEqual(baseline);
  expect((await access.state()).repair).toBeNull();
});

test('keeps an uncertain link dispatch excluded until its exact original effect is observed', async () => {
  const i = manifest.updates.indexOf(linkUpdates()[0]);
  await killAt('apply','dispatch_saved',i);
  const partial = await check.snapshot(mongoose.connection.db);
  await expect(execute({ mode: 'resume' })).rejects.toMatchObject({ code: 'FINANCE_REPAIR_WRITE_UNCERTAIN' });
  await expect(execute({ mode: 'rollback' })).rejects.toMatchObject({ code: 'FINANCE_REPAIR_WRITE_UNCERTAIN' });
  expect(await check.snapshot(mongoose.connection.db)).toEqual(partial);
  const record = await journal();
  await Link.collection.replaceOne({ _id: new mongoose.Types.ObjectId(manifest.updates[i].id) },record.after[i]);
  expect((await execute({ mode: 'resume' })).phase).toBe('applied');
  expect((await access.state()).repair).toBeNull();
});
