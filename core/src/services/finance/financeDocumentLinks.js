'use strict';

// Links between the Secretary's invoice register and the ledger. Matching is
// deterministic: the same amount in cents, a row dated from 3 days before to 10
// days after the document, and a stronger match when the supplier appears in the
// row's description. A single strong candidate is proposed as confident; any
// other candidate is proposed as ambiguous, for the owner to confirm. Core never
// writes to the register.

const FinanceDocumentLink = require('../../../models/FinanceDocumentLink');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { loadRegister } = require('./financeDocumentRegister');
const { ledgerFilter } = require('./ledgers');

const DAY_MS = 86400000;
const BEFORE_DAYS = 3;
const AFTER_DAYS = 10;
const MAX_CANDIDATES = 5;
const DEFAULT_THRESHOLD_CENTS = 10000;
const STATEMENT_KIND = /relev/i;
const CLAIM_KINDS = ['claim', 'remit_advice'];
const SETTLED = new Set(['paid', 'reimbursed', 'settled', 'regle']);
const GENERIC = new Set(['inc', 'ltee', 'ltd', 'canada', 'services', 'compagnie', 'groupe', 'magasin']);
const TRANSFERS = 'Virements internes';

const dayOf = (date) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dayString = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const transactionKey = (row) => [row.accountKey, row.date, row.fingerprint, row.occurrence].join('|');

function supplierTokens(supplier) {
  return fold(supplier).split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !GENERIC.has(token));
}

const isStatement = (doc) => STATEMENT_KIND.test(doc.documentKind);
const isMatchable = (doc) => doc.amountCents != null && Boolean(doc.documentDate) && !isStatement(doc);
const isClaim = (doc) => !isStatement(doc) && (CLAIM_KINDS.includes(doc.documentKind) || doc.patientPaidCents != null);

// Outgoing personal rows of the document window, indexed by amount in cents.
async function rowsByAmount(documents) {
  const days = documents.map((doc) => dayOf(doc.documentDate));
  const rows = await FinanceTransaction.find({ ...ledgerFilter('perso'), flowCents: { $lt: 0 },
    date: { $gte: dayString(Math.min(...days) - BEFORE_DAYS), $lte: dayString(Math.max(...days) + AFTER_DAYS) } })
    .select('accountKey date description flowCents fingerprint occurrence').lean();
  const byAmount = new Map();
  for (const row of rows) {
    const list = byAmount.get(-row.flowCents) || [];
    list.push(row);
    byAmount.set(-row.flowCents, list);
  }
  return byAmount;
}

// The links the register and the ledger support right now, keyed by document and row.
function desiredLinks(documents, byAmount, confirmedDocs) {
  const links = new Map();
  for (const doc of documents.filter(isMatchable)) {
    if (confirmedDocs.has(doc.id)) continue;
    const day = dayOf(doc.documentDate);
    const tokens = supplierTokens(doc.supplier);
    const found = (byAmount.get(doc.amountCents) || []).filter((row) => {
      const diff = dayOf(row.date) - day;
      return diff >= -BEFORE_DAYS && diff <= AFTER_DAYS;
    });
    if (!found.length) continue;
    const strong = found.filter((row) => tokens.some((token) => fold(row.description).includes(token)));
    const pool = (strong.length ? strong : found).slice(0, MAX_CANDIDATES);
    const confident = strong.length === 1;
    for (const row of pool) {
      links.set(`${doc.id}|${transactionKey(row)}`, {
        documentId: doc.id, transactionKey: transactionKey(row), ambiguous: !confident,
        document: { supplier: doc.supplier, documentNumber: doc.documentNumber, documentDate: doc.documentDate,
          documentKind: doc.documentKind, amountCents: doc.amountCents, originalFilename: doc.originalFilename },
        transaction: { accountKey: row.accountKey, date: row.date, description: row.description, flowCents: row.flowCents }
      });
    }
  }
  return links;
}

// Brings the proposals in line with the register; confirmed and rejected links are never recomputed.
async function syncLinks(documents) {
  const confirmed = await FinanceDocumentLink.find({ status: 'confirmed' }).select('documentId').lean();
  const confirmedDocs = new Set(confirmed.map((link) => link.documentId));
  const dated = documents.filter(isMatchable);
  const desired = dated.length ? desiredLinks(dated, await rowsByAmount(dated), confirmedDocs) : new Map();
  if (desired.size) {
    await FinanceDocumentLink.bulkWrite([...desired].map(([key, link]) => ({ updateOne: {
      filter: { key },
      update: { $setOnInsert: { key, status: 'proposed', documentId: link.documentId, transactionKey: link.transactionKey },
        $set: { ambiguous: link.ambiguous, document: link.document, transaction: link.transaction } },
      upsert: true
    } })));
  }
  await FinanceDocumentLink.deleteMany({ status: 'proposed', key: { $nin: [...desired.keys()] } });
}

const summarize = (docs) => ({ count: docs.length, totalCents: docs.reduce((sum, doc) => sum + (doc.amountCents || 0), 0) });

// What the owner sees: proposals to confirm, confirmed pairs, documents without a
// transaction, big outflows without a document, the claims still to file, and the
// bank statements found in mail (listed, never ingested).
async function documents({ minCents } = {}) {
  const register = await loadRegister();
  if (register.status !== 'ok') return { status: register.status, generatedAt: null };
  const threshold = Number.parseInt(minCents, 10) > 0 ? Number.parseInt(minCents, 10) : DEFAULT_THRESHOLD_CENTS;
  const invoices = register.invoices;
  await syncLinks(invoices);

  const links = await FinanceDocumentLink.find({ status: { $in: ['proposed', 'confirmed'] } }).sort({ createdAt: -1 }).limit(500).lean();
  const linkedDocs = new Set(links.map((link) => link.documentId));
  const linkedRows = new Set(links.map((link) => link.transactionKey));
  const present = (link) => ({ id: String(link._id), status: link.status, ambiguous: link.ambiguous,
    document: link.document, transaction: link.transaction });

  const documentsToLink = invoices.filter((doc) => isMatchable(doc) && !linkedDocs.has(doc.id))
    .sort((a, b) => b.documentDate.localeCompare(a.documentDate));
  const unlinked = await FinanceTransaction.find({ ...ledgerFilter('perso'), flowCents: { $lte: -threshold }, category: { $ne: TRANSFERS } })
    .sort({ date: -1 }).limit(300).select('accountKey date description flowCents fingerprint occurrence').lean();
  const claims = invoices.filter((doc) => isClaim(doc) && (doc.insurancePaidCents == null || !SETTLED.has(fold(doc.reimbursementStatus))))
    .sort((a, b) => (b.documentDate || '').localeCompare(a.documentDate || ''));
  const statements = invoices.filter(isStatement).sort((a, b) => (b.documentDate || '').localeCompare(a.documentDate || ''));

  return {
    status: 'ok',
    generatedAt: register.generatedAt,
    complete: register.complete,
    proposals: links.filter((link) => link.status === 'proposed').map(present),
    confirmed: links.filter((link) => link.status === 'confirmed').map(present),
    unmatchedDocuments: { ...summarize(documentsToLink), items: documentsToLink.slice(0, 100) },
    unlinkedTransactions: { thresholdCents: threshold, items: unlinked.filter((row) => !linkedRows.has(transactionKey(row)))
      .slice(0, 100).map(({ _id, ...row }) => ({ id: String(_id), ...row, transactionKey: transactionKey(row) })) },
    toClaim: { ...summarize(claims), items: claims.slice(0, 100) },
    statements: { count: statements.length, items: statements.slice(0, 100) }
  };
}

// Confirmed document of each row, for the transaction list. A confirmed document
// supersedes the other proposals for it.
async function confirmedFor(keys) {
  if (!keys.length) return new Map();
  const links = await FinanceDocumentLink.find({ status: 'confirmed', transactionKey: { $in: keys } }).lean();
  return new Map(links.map((link) => [link.transactionKey, { id: String(link._id), ...link.document }]));
}

// Owner decision on proposals by link id. Confirming one proposal rejects the others for the same document.
async function decide(ids, status, decidedBy = 'owner') {
  if (!['confirmed', 'rejected'].includes(status)) throw Object.assign(new Error('status must be confirmed or rejected'), { status: 400, code: 'FINANCE_DOCUMENT_INVALID' });
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter((id) => /^[a-f0-9]{24}$/.test(id)).slice(0, 20);
  const proposals = await FinanceDocumentLink.find({ _id: { $in: list }, status: 'proposed' }).lean();
  const now = new Date();
  for (const link of proposals) {
    await FinanceDocumentLink.updateOne({ _id: link._id }, { $set: { status, decidedAt: now, decidedBy } });
    if (status === 'confirmed') {
      await FinanceDocumentLink.updateMany({ documentId: link.documentId, status: 'proposed', _id: { $ne: link._id } },
        { $set: { status: 'rejected', decidedAt: now, decidedBy: 'superseded' } });
    }
  }
  return { decided: proposals.length, status };
}

module.exports = { documents, decide, confirmedFor, syncLinks, transactionKey, supplierTokens };
