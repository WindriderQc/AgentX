'use strict';

// Ingests one statement document into the finance ledger. Only a statement
// whose every account reconciles to the cent writes transactions; anything else
// is recorded as needs_review with the exact problems, and writes nothing.
// Accounting-write interruptions retain a journal and Finance exclusion for
// same-identity native recovery, rather than publishing a partial statement.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const FinanceStatement = require('../../../models/FinanceStatement');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { extractStatement } = require('./statementExtraction');
const { extractScannedStatement } = require('./scannedStatement');
const { ledgerOf, ledgerPrefix, flowOf, LIABILITY_CODE } = require('./ledgers');
const journal = require('./financeIngestionJournal');

// Below this many non-space characters the PDF is treated as a scan.
const MIN_TEXT_CHARS = 400;

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

function readPdfText(filePath) {
  return new Promise((resolve, reject) => {
    execFile('pdftotext', ['-layout', filePath, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
      (error, stdout) => {
        if (error) {
          reject(Object.assign(new Error(error.code === 'ENOENT'
            ? 'pdftotext is not installed' : `pdftotext failed: ${error.message}`),
          { code: 'FINANCE_TEXT_UNAVAILABLE', status: 422 }));
        } else resolve(stdout);
      });
  });
}

function slug(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function statementKeyOf(statement, ledger) {
  return [ledgerPrefix(ledger) + slug(statement.issuer), statement.accountLast4 || '-', statement.periodStart, statement.periodEnd].join('|');
}

function accountKeyOf(statement, code, ledger) {
  return [ledgerPrefix(ledger) + slug(statement.issuer), statement.accountLast4 || '-', code].join('|');
}

function fingerprintOf(row) {
  const description = row.description.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${description}|${row.amountCents}`).digest('hex').slice(0, 24);
}

// Numbers identical rows (same account, day, description and amount) in
// statement order, so two same-day coffees stay two lines.
function ledgerRows(statement, statementId, ledger) {
  const seen = new Map();
  const rows = [];
  for (const account of statement.accounts) {
    const accountKey = accountKeyOf(statement, account.code, ledger);
    for (const row of account.transactions) {
      const fingerprint = fingerprintOf(row);
      const identity = `${accountKey}|${row.date}|${fingerprint}`;
      const occurrence = (seen.get(identity) || 0) + 1;
      seen.set(identity, occurrence);
      rows.push({
        statementId, ledger: ledgerOf(ledger), accountKey, accountCode: account.code, date: row.date, description: row.description,
        amountCents: row.amountCents, flowCents: flowOf(account.code, row.amountCents),
        balanceAfterCents: row.balanceAfterCents, fingerprint, occurrence,
        category: null, tags: []
      });
    }
  }
  return rows;
}

async function recordReview(base, accounts, problems) {
  const doc = await FinanceStatement.findOneAndUpdate(
    { fileSha256: base.fileSha256, status: 'needs_review' },
    { $set: { ...base, accounts, problems, status: 'needs_review', statementKey: null } },
    { upsert: true, new: true }
  ).lean();
  return { outcome: 'needs_review', statementId: String(doc._id), fileName: base.fileName, problems, attempts: base.attempts };
}

/**
 * Ingests one document. Returns { outcome: 'reconciled' | 'needs_review' |
 * 'duplicate', ... }. Inference refusals propagate so the caller can leave the
 * file in the inbox and retry later.
 */
async function ingestDocument(filePath, {
  readText = readPdfText,
  extract = extractStatement,
  extractScanned = extractScannedStatement,
  archivePath = null,
  ledger = 'perso',
  checkpoint
} = {}) {
  const fileName = path.basename(filePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) {
    throw Object.assign(new Error(`${fileName} is not a readable document under 25 MiB`), { code: 'FINANCE_DOCUMENT_INVALID', status: 422 });
  }
  const fileSha256 = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  const known = await FinanceStatement.findOne({ fileSha256, status: 'reconciled' }).lean();
  if (known && ledgerOf(known.ledger) !== ledgerOf(ledger)) {
    throw Object.assign(new Error('This file is reconciled in another ledger. Review its ledger before depositing it again.'),
      { code: 'FINANCE_STATEMENT_LEDGER_CONFLICT', status: 422 });
  }
  if (known) {
    await journal.verifyStored(known);
    return { outcome: 'duplicate', statementId: String(known._id), statementKey: known.statementKey, fileName };
  }
  const pending = await journal.pending(fileSha256, ledger);
  if (pending) {
    try { return await journal.continueRecord(pending, checkpoint); }
    catch (error) {
      if (error.code !== 'FINANCE_INGESTION_REVIEW_REQUIRED') throw error;
      return recordReview(pending.candidate.base, pending.candidate.accounts, [error.message]);
    }
  }

  const text = await readText(filePath);
  const scanned = String(text || '').replace(/\s+/g, '').length < MIN_TEXT_CHARS;
  const { statement, problems, attempts, model } = scanned ? await extractScanned(filePath) : await extract(text);
  const base = {
    issuer: statement.issuer, accountLast4: statement.accountLast4,
    periodStart: statement.periodStart, periodEnd: statement.periodEnd,
    fileName, fileSha256, archivePath, model, attempts, problems, ingestedAt: new Date(), source: scanned ? 'image' : 'text',
    ledger: ledgerOf(ledger)
  };
  const accounts = statement.accounts.map((account) => ({
    code: account.code, accountKey: accountKeyOf(statement, account.code, ledger),
    openingCents: account.openingCents, closingCents: account.closingCents,
    transactionCount: account.transactions.length
  }));

  const statementKey = statementKeyOf(statement, ledger);
  const previous = await FinanceStatement.findOne({ statementKey }).lean();
  // With no account identifier, issuer + period can name two different
  // accounts. Arithmetic alone cannot authorize replacing the first one.
  if (previous && !statement.accountLast4 && previous.fileSha256 !== fileSha256) {
    problems.push('Statement identity is ambiguous: another file covers this issuer and period without an account number. Confirm account identity before replacement.');
  }

  const currentStat = await fs.stat(filePath);
  if (!currentStat.isFile() || currentStat.size > MAX_DOCUMENT_BYTES) throw Object.assign(new Error('The source PDF changed during extraction'),
    { code: 'FINANCE_INGESTION_SOURCE_CHANGED', status: 409 });
  const currentSha256 = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  if (currentSha256 !== fileSha256) throw Object.assign(new Error('The source PDF changed during extraction; keep it stable before retrying'),
    { code: 'FINANCE_INGESTION_SOURCE_CHANGED', status: 409 });

  if (problems.length) {
    return recordReview(base, accounts, problems);
  }

  try { return await journal.write({ base, accounts, statementKey, statement }, { checkpoint }); }
  catch (error) {
    if (error.code !== 'FINANCE_INGESTION_REVIEW_REQUIRED') throw error;
    return recordReview(base, accounts, [...problems, error.message]);
  }
}

// Fills flowCents on rows written before it existed (idempotent).
async function backfillFlow() {
  const missing = { flowCents: null };
  const liability = await FinanceTransaction.updateMany({ ...missing, accountCode: { $regex: LIABILITY_CODE } },
    [{ $set: { flowCents: { $multiply: ['$amountCents', -1] } } }]);
  const cash = await FinanceTransaction.updateMany(missing, [{ $set: { flowCents: '$amountCents' } }]);
  return { updated: liability.modifiedCount + cash.modifiedCount };
}

async function setArchivePath(statementId, archivePath) {
  await FinanceStatement.updateOne({ _id: statementId }, { $set: { archivePath } });
}

module.exports = { ingestDocument, readPdfText, setArchivePath, backfillFlow, statementKeyOf, accountKeyOf, fingerprintOf, ledgerRows, MAX_DOCUMENT_BYTES };

require('./financeAccess').guard(module.exports, ['ingestDocument', 'backfillFlow', 'setArchivePath']);
