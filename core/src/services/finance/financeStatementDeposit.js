'use strict';

// Bank statements the Secretary found in mail, checked against the ledger's coverage, and
// copied into the finance inbox on the owner's yes. The copy never deletes anything: the
// normal ingestion decides, reconciling to the cent. A file whose hash is already ingested
// is refused here as well.

const crypto = require('crypto');
const fs = require('fs/promises');
const { constants: fsConstants } = require('fs');
const path = require('path');
const FinanceStatement = require('../../../models/FinanceStatement');
const { loadRegister, documentLedger } = require('./financeDocumentRegister');
const { ledgerOf } = require('./ledgers');

const MAX_IDS = 10;
const ID = /^[a-f0-9]{16}$/;
const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function depositError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

// Compares each statement with the coverage of its series: a month inside a gap fills it;
// a month already covered is already ingested; anything not matched is unknown.
async function classifyStatements(statements, scope) {
  // Required at call time: the query service loads this module through the links service.
  const { coverage } = require('./financeQueryService');
  const { series } = await coverage({ ledger: scope });
  return statements.map((doc) => {
    const month = doc.documentDate ? doc.documentDate.slice(0, 7) : null;
    const match = doc.supplier ? series.find((item) => fold(item.series).includes(fold(doc.supplier))) : null;
    let status = 'unknown';
    if (match && month) {
      if (match.missing.includes(month)) status = 'fillsGap';
      else if (match.first && month >= match.first && month <= match.last) status = 'alreadyIngested';
    }
    return { id: doc.id, supplier: doc.supplier, documentNumber: doc.documentNumber, documentDate: doc.documentDate,
      originalFilename: doc.originalFilename, series: match?.series || null, status };
  });
}

const safeName = (name) => path.basename(String(name || 'statement.pdf')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

// The first file the Secretary kept for the document that exists in the Secretary files folder.
async function sourceFile(doc, filesDir) {
  for (const name of doc.files || []) {
    const candidate = path.join(filesDir, name);
    if (path.basename(candidate) !== name) continue;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // try the next name
    }
  }
  return null;
}

// Copies the chosen statements into the inbox (corporate ones into inbox/corp). Bounded and copy-only.
async function deposit(ids, ledger) {
  const scope = ledgerOf(ledger);
  const inbox = String(process.env.FINANCE_INBOX_PATH || '').trim();
  const filesDir = String(process.env.FINANCE_SECRETARY_FILES || '').trim();
  if (!inbox || !filesDir) throw depositError('Statement deposit is not configured', 409, 'FINANCE_DEPOSIT_UNCONFIGURED');
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))].filter((id) => ID.test(id)).slice(0, MAX_IDS);
  if (!wanted.length) throw depositError('Give 1 to 10 statement ids', 400, 'FINANCE_DEPOSIT_INVALID');
  const register = await loadRegister();
  if (register.status !== 'ok') throw depositError('Secretary register unavailable', 409, 'FINANCE_REGISTER_UNAVAILABLE');

  const dir = scope === 'corp' ? path.join(inbox, 'corp') : inbox;
  await fs.mkdir(dir, { recursive: true });
  const copied = [];
  const refused = [];
  for (const id of wanted) {
    const doc = register.invoices.find((item) => item.id === id);
    if (!doc || doc.kind !== 'bank_statement' || documentLedger(doc) !== scope) {
      refused.push({ id, reason: 'not a bank statement of this ledger' });
      continue;
    }
    const source = await sourceFile(doc, filesDir);
    if (!source) {
      refused.push({ id, reason: 'file not found' });
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
    if (await FinanceStatement.exists({ fileSha256: sha256 })) {
      refused.push({ id, reason: 'already ingested' });
      continue;
    }
    // The name keeps the provenance: the Secretary document id, its date, then the original name.
    const target = path.join(dir, `secretary-${doc.id}-${doc.documentDate || 'undated'}-${safeName(doc.originalFilename || source)}`);
    try {
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      copied.push({ id });
    } catch (error) {
      refused.push({ id, reason: error.code === 'EEXIST' ? 'already in inbox' : 'copy failed' });
    }
  }
  return { ledger: scope, copied, refused };
}

module.exports = { classifyStatements, deposit, sourceFile, safeName };
