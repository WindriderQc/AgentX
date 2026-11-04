'use strict';

// A standalone-Mongo ingestion publishes only after every planned row exists.
// Each accounting command has a persisted dispatch intent. Recovery observes
// that exact command's after-image; an absent effect is never replay authority.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const access = require('./financeAccess');
const { hash, canonical } = require('./financeRepairStorage');
const { keyOf, selector } = require('./financeTransactionIdentity');
const { classifyRows } = require('./financeCategories');
const Statement = require('../../../models/FinanceStatement');
const Transaction = require('../../../models/FinanceTransaction');
const { ledgerOf } = require('./ledgers');
const coreProof = require('./financeRepairCoreProof');
const { ObjectId } = mongoose.mongo;
const { WRITE, error } = access;
const MAX_INTENT_BYTES = 8 * 1024 * 1024;
const store = () => mongoose.connection.db.collection('finance_ingestions');
const accounting = name => mongoose.connection.db.collection(name);
const requestOf = (fileSha256, ledger) => `finance-ingestion:${hash(`${ledgerOf(ledger)}|${fileSha256}`)}`;
const same = (a, b) => hash(a) === hash(b);
const conflict = message => error(message, 'FINANCE_INGESTION_STATE_CONFLICT', 409);
const review = message => error(message, 'FINANCE_INGESTION_REVIEW_REQUIRED', 422);
const digestOf = candidate => hash({ ...candidate, base: { ...candidate.base, ingestedAt: null } });
function verifyRecord(record) {
  if (record._id !== requestOf(record.candidate.base.fileSha256, record.candidate.base.ledger)
    || digestOf(record.candidate) !== record.digest) throw conflict('The saved ingestion intent has changed');
  if (['writing', 'applied'].includes(record.phase)
    && record.planDigest !== hash({ steps: record.steps, result: record.result })) throw conflict('The saved ingestion plan has changed');
}

async function memberRows(statement) {
  if (!Array.isArray(statement.rowKeys)) return Transaction.find({ statementId: statement._id }).lean();
  if (!statement.rowKeys.length) return [];
  return Transaction.find({ $or: statement.rowKeys.map(selector) }).lean();
}

async function verifyStored(statement) {
  if (!statement) throw conflict('The published statement is missing');
  const rows = await memberRows(statement);
  if (rows.length !== statement.accounts.reduce((sum, account) => sum + account.transactionCount, 0)
    || rows.some(row => ledgerOf(row.ledger) !== ledgerOf(statement.ledger))) {
    throw conflict('Stored statement rows do not match the declared account scope');
  }
  if (Array.isArray(statement.rowKeys) && (rows.length !== statement.rowKeys.length
    || new Set(statement.rowKeys).size !== statement.rowKeys.length)) throw conflict('Stored statement membership is incomplete');
  for (const account of statement.accounts) {
    const members = rows.filter(row => row.accountKey === account.accountKey);
    const sum = members.reduce((total, row) => total + row.amountCents, 0);
    if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(account.openingCents + sum)
      || members.length !== account.transactionCount || account.openingCents + sum !== account.closingCents) {
      throw conflict('Stored statement rows do not reproduce their reconciled count and balance');
    }
  }
}

async function pending(fileSha256, ledger) {
  const record = await store().findOne({ _id: requestOf(fileSha256, ledger) });
  return record && record.phase !== 'applied' ? record : null;
}

async function plan(record) {
  const { base, accounts, statementKey, statement } = record.candidate;
  const known = await Statement.findOne({ fileSha256: base.fileSha256, status: 'reconciled' }).lean();
  if (known && ledgerOf(known.ledger) !== ledgerOf(base.ledger)) throw review('The source PDF is already reconciled in another ledger');
  if (known) throw conflict('The source was published outside its saved ingestion intent');
  if (accounts.some(account => {
    const source = statement.accounts.find(item => item.code === account.code);
    const total = source.transactions.reduce((sum, row) => sum + row.amountCents, 0);
    return !Number.isSafeInteger(total) || !Number.isSafeInteger(account.openingCents + total)
      || account.openingCents + total !== account.closingCents;
  })) throw review('The prepared statement does not reconcile within integer cents');
  const previous = await Statement.findOne({ statementKey }).lean();
  if (previous && !statement.accountLast4 && previous.fileSha256 !== base.fileSha256) {
    throw review('Statement identity changed while ingestion was waiting; confirm the account before replacement');
  }
  const refused = await Statement.findOne({ fileSha256: base.fileSha256, status: 'needs_review' }).lean();
  const original = previous || refused;
  const id = original?._id || new ObjectId();
  const now = new Date();
  const raw = require('./financeIngestionService').ledgerRows(statement, id, base.ledger);
  const desired = await classifyRows(raw);
  const rowKeys = desired.map(keyOf);
  if (new Set(rowKeys).size !== rowKeys.length) throw review('The extracted statement repeats a ledger identity');
  const steps = [];
  let inserted = 0;
  let overlapping = 0;
  for (const row of desired) {
    const existing = await Transaction.findOne(selector(keyOf(row))).lean();
    if (existing && String(existing.statementId) !== String(id)) {
      if (existing.amountCents !== row.amountCents || existing.flowCents !== row.flowCents) throw review('An overlapping row has conflicting amounts');
      overlapping += 1;
      continue;
    }
    const after = { ...row, _id: existing?._id || new ObjectId(), createdAt: existing?.createdAt || now, updatedAt: now };
    steps.push({ collection: 'finance_transactions', id: after._id, before: existing, after });
    if (!existing) inserted += 1;
  }
  const owned = original ? await Transaction.find({ statementId: original._id }).lean() : [];
  for (const row of owned.filter(item => !rowKeys.includes(keyOf(item)))) {
    const other = await Statement.findOne({ _id: { $ne: id }, status: 'reconciled', rowKeys: keyOf(row) }).lean();
    if (other) {
      steps.push({ collection: 'finance_transactions', id: row._id, before: row,
        after: { ...row, statementId: other._id, updatedAt: now } });
      continue;
    }
    // Old statements lack exact membership. Never delete a row another legacy
    // period may require merely because the replacing PDF omits it.
    const ambiguous = await Statement.exists({ _id: { $ne: id }, status: 'reconciled', rowKeys: { $exists: false },
      'accounts.accountKey': row.accountKey, periodStart: { $lte: row.date }, periodEnd: { $gte: row.date } });
    if (ambiguous) throw review('A legacy overlapping statement requires reviewed row membership before replacement');
    steps.push({ collection: 'finance_transactions', id: row._id, before: row, after: null });
  }
  const history = [...(original?.reviewHistory || [])];
  if (refused) history.push({ id: refused._id, attempts: refused.attempts, problems: refused.problems,
    model: refused.model, ingestedAt: refused.ingestedAt, fileSha256: refused.fileSha256 });
  const after = { ...(original || {}), ...base, _id: id, accounts, rowKeys, status: 'reconciled', statementKey,
    attempts: base.attempts + (refused?.attempts || 0), createdAt: original?.createdAt || now, updatedAt: now,
    ...(history.length && { reviewHistory: history }) };
  const invalid = new Statement(after).validateSync();
  if (invalid) throw review('The prepared statement does not satisfy the ledger schema');
  // Publish the reconciled statement only after all row mutations are received.
  steps.push({ collection: 'finance_statements', id, before: original, after });
  if (refused && String(refused._id) !== String(id)) steps.push({ collection: 'finance_statements', id: refused._id, before: refused, after: null });
  if (Buffer.byteLength(canonical({ candidate: record.candidate, steps })) > MAX_INTENT_BYTES) {
    throw review('The ingestion intent exceeds its bounded journal size');
  }
  return { steps, result: { outcome: 'reconciled', statementId: String(id), statementKey,
    fileName: base.fileName, attempts: after.attempts, replaced: Boolean(previous), accounts: accounts.length, inserted, overlapping } };
}

async function continueRecord(record, checkpoint = async () => {}, actor = 'core-ingestion', verifyFenced) {
  verifyRecord(record);
  const { _id: requestKey, digest } = record;
  const save = async fields => {
    const result = await store().updateOne({ _id: requestKey, digest }, { $set: fields }, WRITE);
    if (result.matchedCount !== 1) throw conflict('Ingestion journal identity changed');
    // An acknowledged update advances this owner's local image. Rereading the
    // entire row plan after each command would transfer a quadratic payload.
    // A lost reply still throws before advancing; recovery reloads the journal.
    for (const [field, value] of Object.entries(fields)) {
      const parts = field.split('.');
      let target = record;
      for (const part of parts.slice(0, -1)) target = target[part] ||= {};
      target[parts.at(-1)] = value;
    }
  };
  return access.withIngestion(requestKey, digest, async () => {
    try {
      if (verifyFenced) await verifyFenced();
      if (actor !== 'core-ingestion') await save({ lastResumedBy: actor, lastResumedAt: new Date() });
      if (record.phase === 'intent') {
        const prepared = await plan(record);
        await save({ ...prepared, planDigest: hash(prepared), phase: 'writing' });
        await checkpoint('intent_prepared');
      }
      if (record.phase === 'rejected') throw review(record.reason);
      for (let i = 0; i < record.steps.length; i += 1) {
        await access.assertIngestion(requestKey, digest);
        const step = record.steps[i];
        const current = await accounting(step.collection).findOne({ _id: step.id });
        const state = record.received?.[i];
        if (state) {
          if (!same(current, step.after)) throw error('An ingestion command has no verified after-image; reconcile its native outcome', 'FINANCE_INGESTION_WRITE_UNCERTAIN');
        } else {
          if (!same(current, step.before)) throw conflict('A prepared accounting image changed before dispatch');
          await save({ [`received.${i}`]: 'dispatching' });
          await checkpoint('dispatch_saved', { index: i });
          await access.assertIngestion(requestKey, digest);
          const collection = accounting(step.collection);
          if (!step.before) {
            const result = await collection.insertOne(step.after, WRITE);
            if (!result.acknowledged) throw conflict('Ingestion insert was not acknowledged');
          } else {
            const match = { ...step.before };
            if (!Object.hasOwn(step.before, 'ledger')) match.ledger = { $exists: false };
            const result = step.after ? await collection.replaceOne(match, step.after, WRITE)
              : await collection.deleteOne(match, WRITE);
            if ((step.after ? result.matchedCount : result.deletedCount) !== 1) throw conflict('Ingestion accounting compare-and-set was refused');
          }
          await checkpoint('accounting_written', { index: i });
        }
        await save({ [`received.${i}`]: 'received' });
        await checkpoint('step_received', { index: i });
      }
      const statement = await Statement.findById(record.result.statementId).lean();
      await verifyStored(statement);
      if (!record.receipt) await save({ phase: 'applied', receipt: { ...record.result,
        requestKey, digest, actor, appliedAt: new Date().toISOString() } });
      await checkpoint('terminal_saved');
      await access.releaseIngestion(requestKey, digest);
      await checkpoint('released');
      return record.receipt;
    } catch (e) {
      // A deterministic rejection before dispatch has no uncertain accounting
      // effect. Other failures retain the exact intent and Finance fence.
      if (e.code === 'FINANCE_INGESTION_REVIEW_REQUIRED' && !Object.keys(record.received || {}).length) {
        await save({ phase: 'rejected', reason: e.message });
        await access.releaseIngestion(requestKey, digest);
      }
      throw e;
    }
  });
}

async function write(candidate, { checkpoint } = {}) {
  candidate = mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(candidate));
  const requestKey = requestOf(candidate.base.fileSha256, candidate.base.ledger);
  const digest = digestOf(candidate);
  let record = await store().findOne({ _id: requestKey });
  if (!record) {
    record = { _id: requestKey, digest, candidate, phase: 'intent', createdAt: new Date() };
    if (Buffer.byteLength(canonical(record)) > MAX_INTENT_BYTES) throw review('The extracted ingestion exceeds its bounded journal size');
    try { await store().insertOne(record, WRITE); }
    catch (e) { if (e.code !== 11000) throw e; record = await store().findOne({ _id: requestKey }); }
  }
  if (record.digest !== digest) throw conflict('The same source has a different saved ingestion intent');
  if (record.phase === 'applied') throw conflict('This completed ingestion has no matching reconciled statement; review its native state');
  return continueRecord(record, checkpoint);
}

async function resume({ requestKey, confirmedDigest, sourcePath, actor, coreOrigin, checkpoint }) {
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 80) throw error('Native ingestion recovery requires a bounded operator attribution', 'FINANCE_INGESTION_ACTOR_REQUIRED', 400);
  const record = await store().findOne({ _id: String(requestKey || '') });
  if (!record || record.digest !== confirmedDigest) throw conflict('Confirm the exact saved ingestion digest before recovery');
  verifyRecord(record);
  const source = await fs.stat(sourcePath);
  if (!source.isFile() || source.size > require('./financeIngestionService').MAX_DOCUMENT_BYTES) throw conflict('The recovery source is not a bounded PDF file');
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');
  if (sha256 !== record.candidate.base.fileSha256) throw conflict('The source PDF differs from the saved ingestion');
  const gate = await access.state();
  if (record.phase === 'applied' && !gate.ingestion) return record.receipt;
  if (!gate.ingestion && record.phase !== 'intent') throw conflict('An interrupted ingestion lost its native admission fence');
  await coreProof.protocol(coreOrigin);
  const run = () => continueRecord(record, checkpoint, actor.trim(), () => coreProof.fenced(coreOrigin));
  return gate.ingestion ? run() : access.withAccess(run);
}

module.exports = { write, resume, pending, continueRecord, verifyStored, requestOf };
