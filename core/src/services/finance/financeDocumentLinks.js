'use strict';

// Links between the Secretary's invoice register and the ledger. Matching is
// deterministic: the same amount in cents, a row dated from 3 days before to 10
// days after the document, and a stronger match when the supplier appears in the
// row's description. A single strong candidate is proposed as confident; any
// other candidate is proposed as ambiguous, for the owner to confirm. Core never
// writes to the register.

const FinanceDocumentLink = require('../../../models/FinanceDocumentLink');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { loadRegister, documentLedger } = require('./financeDocumentRegister');
const { classifyStatements } = require('./financeStatementDeposit');
const { ledgerFilter, ledgerOf } = require('./ledgers');

const DAY_MS = 86400000;
const BEFORE_DAYS = 3;
const AFTER_DAYS = 10;
const MAX_CANDIDATES = 5;
const DEFAULT_THRESHOLD_CENTS = 10000;
const CLAIM_KINDS = ['claim', 'remit_advice'];
// Statements are read by the owner, never matched to rows.
const NOT_MATCHED_KINDS = ['bank_statement', 'insurance_statement'];
const SETTLED = new Set(['paid', 'reimbursed', 'settled', 'regle']);
const GENERIC = new Set(['inc', 'ltee', 'ltd', 'canada', 'services', 'compagnie', 'groupe', 'magasin']);
const GOVERNMENT = ['revenu quebec', 'agence du revenu', 'canada revenue', 'gouvernement', 'ministere', 'retraite quebec'];
const HEALTH = ['clinique', 'pharmac', 'dentaire', 'dentist', 'optom', 'physio', 'medic', 'hopital', 'laboratoire', 'chiro', 'psycho', 'orthophon'];
const HEALTH_CATEGORY = 'Santé';
const DEFAULT_CLAIM_MAX_CENTS = 500000;
const TRANSFERS = 'Virements internes';

const dayOf = (date) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dayString = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const transactionKey = (row) => [row.accountKey, row.date, row.fingerprint, row.occurrence].join('|');
const includesAny = (text, words) => words.some((word) => fold(text).includes(word));
const claimMaxCents = () => Number.parseInt(process.env.FINANCE_DOCUMENT_CLAIM_MAX_CENTS, 10) || DEFAULT_CLAIM_MAX_CENTS;

function supplierTokens(supplier) {
  return fold(supplier).split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !GENERIC.has(token));
}

const isMatchable = (doc) => doc.amountCents != null && Boolean(doc.documentDate) && !NOT_MATCHED_KINDS.includes(doc.kind);
const isSettled = (doc) => SETTLED.has(fold(doc.reimbursementStatus));
const isGovernment = (doc) => doc.kind === 'tax' || includesAny(doc.supplier, GOVERNMENT);
// Health and insurance only: an insurer, a health or insurance supplier, or a row categorized as health.
// A claim or remittance kind alone is not enough (a client's payment advice is not an insurer's).
const isHealthOrInsurance = (doc, category) => Boolean(doc.insurer) || includesAny(doc.supplier, HEALTH)
  || includesAny(doc.supplier, ['assur', 'insur']) || doc.kind === 'insurance_statement' || category === HEALTH_CATEGORY;
// A figure the register cannot be trusted with: above the ceiling, or inconsistent with the gross amount.
function suspicious(doc) {
  const { amountCents: amount, grossAmountCents: gross, patientPaidCents: patient } = doc;
  if (amount > claimMaxCents()) return true;
  return gross != null && gross > 0 && (amount > gross * 2 || (patient != null && patient > gross));
}

// Outgoing personal rows of the document window, indexed by amount in cents.
async function rowsByAmount(documents, ledger) {
  const days = documents.map((doc) => dayOf(doc.documentDate));
  const rows = await FinanceTransaction.find({ ...ledgerFilter(ledger), flowCents: { $lt: 0 },
    date: { $gte: dayString(Math.min(...days) - BEFORE_DAYS), $lte: dayString(Math.max(...days) + AFTER_DAYS) } })
    .select('accountKey date description flowCents fingerprint occurrence category').lean();
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
          kind: doc.kind, amountCents: doc.amountCents, originalFilename: doc.originalFilename, ledger: documentLedger(doc) },
        transaction: { accountKey: row.accountKey, date: row.date, description: row.description, flowCents: row.flowCents, category: row.category || null }
      });
    }
  }
  return links;
}

// Brings the proposals in line with the register; confirmed and rejected links are never recomputed.
async function syncLinks(documents) {
  const confirmed = await FinanceDocumentLink.find({ status: 'confirmed' }).select('documentId').lean();
  const confirmedDocs = new Set(confirmed.map((link) => link.documentId));
  // Each document matches rows of its own ledger only: a corporate invoice never links to a personal row.
  const desired = new Map();
  for (const ledger of ['perso', 'corp']) {
    const dated = documents.filter((doc) => isMatchable(doc) && documentLedger(doc) === ledger);
    if (!dated.length) continue;
    for (const [key, link] of desiredLinks(dated, await rowsByAmount(dated, ledger), confirmedDocs)) desired.set(key, link);
  }
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

// Proposals the match left ambiguous, grouped by document, each with its candidate rows.
function groupAmbiguous(links) {
  const groups = new Map();
  for (const link of links.filter((item) => item.status === 'proposed' && item.ambiguous)) {
    const group = groups.get(link.documentId) || { documentId: link.documentId, document: link.document, candidates: [] };
    group.candidates.push({ id: String(link._id), transaction: link.transaction });
    groups.set(link.documentId, group);
  }
  return [...groups.values()];
}

// What the owner sees: confident proposals, ambiguous ones grouped by document, confirmed pairs,
// documents without a transaction, big outflows without a document, health and insurance claims still
// to file (figures that look wrong go to toVerify and out of the totals), and bank statements found in mail.
async function documents({ minCents, ledger } = {}) {
  const register = await loadRegister();
  if (register.status !== 'ok') return { status: register.status, generatedAt: null };
  const threshold = Number.parseInt(minCents, 10) > 0 ? Number.parseInt(minCents, 10) : DEFAULT_THRESHOLD_CENTS;
  const scope = ledgerOf(ledger);
  const invoices = register.invoices.filter((doc) => documentLedger(doc) === scope);
  await syncLinks(register.invoices);

  const links = (await FinanceDocumentLink.find({ status: { $in: ['proposed', 'confirmed'] } }).sort({ createdAt: -1 }).limit(500).lean())
    .filter((link) => (link.document?.ledger || 'perso') === scope);
  const linkedDocs = new Set(links.map((link) => link.documentId));
  const linkedRows = new Set(links.map((link) => link.transactionKey));
  const categoryOf = new Map(links.map((link) => [link.documentId, link.transaction?.category || null]));
  const present = (link) => ({ id: String(link._id), status: link.status, ambiguous: link.ambiguous,
    document: link.document, transaction: link.transaction });
  const newestFirst = (a, b) => (b.documentDate || '').localeCompare(a.documentDate || '');

  const documentsToLink = invoices.filter((doc) => isMatchable(doc) && !linkedDocs.has(doc.id)).sort(newestFirst);
  const unlinked = await FinanceTransaction.find({ ...ledgerFilter(scope), flowCents: { $lte: -threshold }, category: { $ne: TRANSFERS } })
    .sort({ date: -1 }).limit(300).select('accountKey date description flowCents fingerprint occurrence').lean();
  // Personal claims only: a corporate document is never a claim of the owner's own.
  const claimable = scope === 'perso' ? invoices.filter((doc) => !isGovernment(doc) && isHealthOrInsurance(doc, categoryOf.get(doc.id))
    && (CLAIM_KINDS.includes(doc.kind) || doc.patientPaidCents != null || doc.insurer)
    && (doc.insurancePaidCents == null || !isSettled(doc))).sort(newestFirst) : [];
  const claims = claimable.filter((doc) => !suspicious(doc));
  const toVerify = claimable.filter(suspicious);
  const statements = await classifyStatements(invoices.filter((doc) => doc.kind === 'bank_statement').sort(newestFirst), scope);

  return {
    status: 'ok',
    generatedAt: register.generatedAt,
    complete: register.complete,
    ledger: scope,
    proposals: links.filter((link) => link.status === 'proposed' && !link.ambiguous).map(present),
    ambiguous: groupAmbiguous(links),
    confirmed: links.filter((link) => link.status === 'confirmed').map(present),
    unmatchedDocuments: { ...summarize(documentsToLink), items: documentsToLink.slice(0, 100) },
    unlinkedTransactions: { thresholdCents: threshold, items: unlinked.filter((row) => !linkedRows.has(transactionKey(row)))
      .slice(0, 100).map(({ _id, ...row }) => ({ id: String(_id), ...row, transactionKey: transactionKey(row) })) },
    toClaim: { ...summarize(claims), maxCents: claimMaxCents(), items: claims.slice(0, 100) },
    toVerify: { count: toVerify.length, maxCents: claimMaxCents(), items: toVerify.slice(0, 100) },
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
