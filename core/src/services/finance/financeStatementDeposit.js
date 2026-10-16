'use strict';

// Bank statements the Secretary found in mail, matched to the account series of either ledger,
// checked against that series' coverage, and copied into the finance inbox on the owner's yes.
// The series is found by the last four digits of the document number and a tolerant issuer
// name; the ledger follows from the series. The copy never deletes anything: the normal
// ingestion decides, reconciling to the cent. A file whose hash is already ingested is refused.

const crypto = require('crypto');
const fs = require('fs/promises');
const { constants: fsConstants } = require('fs');
const path = require('path');
const FinanceStatement = require('../../../models/FinanceStatement');
const { loadRegister } = require('./financeDocumentRegister');

const MAX_IDS = 10;
const ID = /^[a-f0-9]{16}$/;
const LEDGERS = ['perso', 'corp'];
// Common misreadings of the issuer, folded: "caisse" is the Desjardins credit union.
const ISSUER_ALIASES = [[/\bcaisse\b/g, 'desjardins']];

const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (value) => fold(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 4);

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// A tolerant issuer match: one word of the series issuer appears in the supplier, up to a small
// edit distance for longer words ("Déserjardins" for "Desjardins").
function issuerMatches(supplier, seriesIssuer) {
  let folded = fold(supplier);
  for (const [pattern, replacement] of ISSUER_ALIASES) folded = folded.replace(pattern, replacement);
  const supplierTokens = tokens(folded);
  return tokens(seriesIssuer).some((wanted) => supplierTokens.some((word) => (
    word === wanted || distance(word, wanted) <= (wanted.length >= 8 ? 2 : 1))));
}

// The last four digits of a document number, when it has at least four.
function last4Of(documentNumber) {
  const digits = String(documentNumber || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function depositError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

// Every account series of both ledgers. A series name is "Issuer ···1234" or, when the statements
// carry no last four, just "Issuer".
async function seriesIndex() {
  // Required at call time: the query service loads this module through the links service.
  const { coverage } = require('./financeQueryService');
  const index = [];
  for (const ledger of LEDGERS) {
    const { series } = await coverage({ ledger });
    for (const item of series) {
      const match = item.series.match(/^(.*?)(?:\s*···(\d{4}))?$/);
      index.push({ ...item, ledger, issuer: match[1].trim(), last4: match[2] || null });
    }
  }
  return index;
}

// Series the owner declared in the plan: an issuer, optionally its last four and its ledger.
async function declaredSeries() {
  // Required at call time: the plan loads the query service through the links service.
  const { getPlan } = require('./financePlan');
  const plan = await getPlan();
  return plan.seriesStatus.filter((item) => item.series && item.ledger)
    .map((item) => ({ series: item.series, last4: item.last4 || null, ledger: item.ledger }));
}

// Status of one statement inside a series: a month inside a gap fills it; a month already covered
// is already ingested; no series means unknown.
function statusIn(entry, month) {
  if (!entry || !month) return 'unknown';
  if (entry.missing.includes(month)) return 'fillsGap';
  if (entry.first && month >= entry.first && month <= entry.last) return 'alreadyIngested';
  return 'unknown';
}

const nameOf = (entry) => `${entry.issuer}${entry.last4 ? ` ···${entry.last4}` : ''}`;

// Finds the ledger and series of one statement, in this order: a series the owner declared (issuer,
// last four, ledger); the last four digits of the document number with a matching issuer; a single
// issuer match. Anything else is unknown, with the reason.
function resolve(doc, index, declared = []) {
  const month = doc.documentDate ? doc.documentDate.slice(0, 7) : null;
  const last4 = last4Of(doc.documentNumber);
  const found = (ledger, series, entry, reason = null) => ({ ledger, series, status: statusIn(entry, month), reason });
  const unknown = (reason) => ({ ledger: null, series: null, status: 'unknown', reason });
  if (!month) return unknown('no document date');

  const named = declared.filter((item) => issuerMatches(doc.supplier, item.series) && (!item.last4 || item.last4 === last4));
  if (named.length > 1) return unknown('declared in both ledgers, pick one last four in seriesStatus');
  if (named.length === 1) {
    const [item] = named;
    // The exact last four first; else the issuer's series of that ledger, which carries no last four.
    const sameIssuer = index.filter((e) => e.ledger === item.ledger && fold(e.issuer) === fold(item.series));
    const entry = sameIssuer.find((e) => e.last4 === item.last4) || sameIssuer.find((e) => !e.last4) || null;
    return found(item.ledger, entry ? nameOf(entry) : `${item.series}${item.last4 ? ` ···${item.last4}` : ''}`, entry);
  }

  const byLast4 = last4 ? index.filter((e) => e.last4 === last4 && issuerMatches(doc.supplier, e.issuer)) : [];
  if (byLast4.length === 1) return found(byLast4[0].ledger, nameOf(byLast4[0]), byLast4[0]);
  if (byLast4.length > 1) return unknown('several series share these last four digits');

  // Only series that do not contradict the document's last four digits.
  const byIssuer = index.filter((e) => issuerMatches(doc.supplier, e.issuer) && (!last4 || !e.last4 || e.last4 === last4));
  const ledgers = [...new Set(byIssuer.map((e) => e.ledger))];
  if (ledgers.length > 1) return unknown('series in both ledgers, add last4 in seriesStatus');
  if (byIssuer.length === 1) return found(byIssuer[0].ledger, nameOf(byIssuer[0]), byIssuer[0]);
  if (byIssuer.length > 1) return unknown('several series match this issuer');
  return unknown('no account series matches');
}

async function classifyStatements(statements) {
  const [index, declared] = await Promise.all([seriesIndex(), declaredSeries()]);
  return statements.map((doc) => {
    const { ledger, series, status, reason } = resolve(doc, index, declared);
    return { id: doc.id, supplier: doc.supplier, documentNumber: doc.documentNumber, documentDate: doc.documentDate,
      originalFilename: doc.originalFilename, ledger, series, status, reason };
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

// Copies the chosen statements into the inbox: the ledger comes from the matched series, so a
// corporate statement goes to inbox/corp. Bounded and copy-only.
async function deposit(ids) {
  const inbox = String(process.env.FINANCE_INBOX_PATH || '').trim();
  const filesDir = String(process.env.FINANCE_SECRETARY_FILES || '').trim();
  if (!inbox || !filesDir) throw depositError('Statement deposit is not configured', 409, 'FINANCE_DEPOSIT_UNCONFIGURED');
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))].filter((id) => ID.test(id)).slice(0, MAX_IDS);
  if (!wanted.length) throw depositError('Give 1 to 10 statement ids', 400, 'FINANCE_DEPOSIT_INVALID');
  const register = await loadRegister();
  if (register.status !== 'ok') throw depositError('Secretary register unavailable', 409, 'FINANCE_REGISTER_UNAVAILABLE');
  const [index, declared] = await Promise.all([seriesIndex(), declaredSeries()]);

  const copied = [];
  const refused = [];
  for (const id of wanted) {
    const doc = register.invoices.find((item) => item.id === id);
    if (!doc || doc.kind !== 'bank_statement') {
      refused.push({ id, reason: 'not a bank statement' });
      continue;
    }
    const { ledger, reason } = resolve(doc, index, declared);
    if (!ledger) {
      refused.push({ id, reason: reason || 'no account series matches' });
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
    const dir = ledger === 'corp' ? path.join(inbox, 'corp') : inbox;
    await fs.mkdir(dir, { recursive: true });
    // The name keeps the provenance: the Secretary document id, its date, then the original name.
    const target = path.join(dir, `secretary-${doc.id}-${doc.documentDate || 'undated'}-${safeName(doc.originalFilename || source)}`);
    try {
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      copied.push({ id, ledger });
    } catch (error) {
      refused.push({ id, reason: error.code === 'EEXIST' ? 'already in inbox' : 'copy failed' });
    }
  }
  return { copied, refused };
}

module.exports = { classifyStatements, deposit, sourceFile, safeName, issuerMatches, last4Of, distance, resolve };
