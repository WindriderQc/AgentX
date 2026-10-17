'use strict';

// Read-only view of the Secretary's invoice register (schema v2). Core never
// writes to it. A missing, oversized or unsupported file is reported as such,
// never guessed at.

const { createHash } = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Schema 2 has no `kind`: Core classifies the free-text documentKind itself. Schema 3 adds it from the producer.
const SUPPORTED_SCHEMAS = [2, 3];
const KINDS = ['invoice', 'receipt', 'payment_proof', 'claim', 'remit_advice', 'quote', 'bank_statement', 'insurance_statement', 'tax', 'other'];
const MAX_BYTES = 20 * 1024 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const hasAny = (text, words) => words.some((word) => text.includes(word));

// Names of the owner's corporations, from configuration: a document addressed to one of them belongs to the corporate ledger.
const corpNames = () => String(process.env.FINANCE_CORP_NAMES || '').split(',').map((name) => fold(name).trim()).filter(Boolean);
const documentLedger = (doc) => (corpNames().some((name) => fold(doc.person).includes(name)) ? 'corp' : 'perso');

// Same rules as the Secretary producer (document_kind): statements first, since their labels name invoices.
function documentKindOf(label) {
  const t = fold(label);
  if (t.includes('relev') || t.includes('statement')) {
    if (hasAny(t, ['assur', 'insur'])) return 'insurance_statement';
    if (hasAny(t, ['fiscal', 'tax', 'impot', 'revenu'])) return 'tax';
    if (hasAny(t, ['bancaire', 'bank', 'compte', 'account', 'carte', 'card'])) return 'bank_statement';
    return 'other';
  }
  if (hasAny(t, ['remit', 'avis de paiement'])) return 'remit_advice';
  if (hasAny(t, ['claim', 'reclamation'])) return 'claim';
  if (hasAny(t, ['preuve', 'payment proof', 'virement', 'interac'])) return 'payment_proof';
  if (hasAny(t, ['soumission', 'devis', 'quote', 'estimate'])) return 'quote';
  if (hasAny(t, ['fiscal', 'tax', 'impot', 'annexe'])) return 'tax';
  if (hasAny(t, ['assurance', 'insurance'])) return 'insurance_statement';
  if (hasAny(t, ['recu', 'receipt'])) return 'receipt';
  if (hasAny(t, ['facture', 'invoice'])) return 'invoice';
  return 'other';
}

function text(value, max = 160) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const cents = (value) => (Number.isSafeInteger(value) ? value : null);

// One document in Core's shape. The id is stable across rewrites of the register.
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const documentDate = ISO_DATE.test(String(raw.documentDate || '')) ? raw.documentDate : null;
  const grossAmountCents = cents(raw.grossAmountCents);
  const patientPaidCents = cents(raw.patientPaidCents);
  const id = createHash('sha1').update([raw.supplier, raw.documentNumber, raw.documentDate, grossAmountCents, raw.messageId ?? '']
    .map((part) => String(part ?? '')).join('|')).digest('hex').slice(0, 16);
  return {
    id,
    supplier: text(raw.supplier, 120),
    documentNumber: text(raw.documentNumber, 80) || null,
    documentDate,
    // The closed kind; the producer's kind when valid, else Core's reading of the original label.
    kind: KINDS.includes(raw.kind) ? raw.kind : documentKindOf(raw.documentKind),
    documentKindRaw: text(raw.documentKind, 80) || null,
    person: text(raw.person, 60) || null,
    // What left the owner's pocket: the patient's share when the register has it, else the gross amount.
    amountCents: patientPaidCents ?? grossAmountCents,
    grossAmountCents,
    patientPaidCents,
    insurancePaidCents: cents(raw.insurancePaidCents),
    insurer: text(raw.insurer, 80) || null,
    reimbursementStatus: text(raw.reimbursementStatus, 40) || null,
    originalFilename: text(raw.originalFilename, 160) || null,
    // Bare file names the Secretary keeps for this document; never a path.
    files: [raw.originalFilename, ...(Array.isArray(raw.sources) ? raw.sources.map((s) => s?.path || s?.filename) : [])]
      .map((name) => path.basename(String(name || ''))).filter((name) => name && name !== '.' && name !== '..')
  };
}

// Loads the register read-only. `status` is unconfigured, unavailable, invalid or ok.
async function loadRegister(file = process.env.FINANCE_SECRETARY_REGISTER) {
  if (!file) return { status: 'unconfigured', invoices: [] };
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { status: 'unavailable', invoices: [] };
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return { status: 'invalid', invoices: [] };
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { status: 'invalid', invoices: [] };
  }
  if (!SUPPORTED_SCHEMAS.includes(data?.schemaVersion) || !Array.isArray(data.invoices)) return { status: 'invalid', invoices: [] };
  return {
    status: 'ok',
    generatedAt: text(data.generatedAt, 40) || null,
    complete: data.complete === true,
    invoices: data.invoices.map(normalize).filter(Boolean)
  };
}

module.exports = { loadRegister, normalize, documentKindOf, documentLedger, KINDS, SUPPORTED_SCHEMAS };
