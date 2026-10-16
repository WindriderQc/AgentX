'use strict';

// Read-only view of the Secretary's invoice register (schema v2). Core never
// writes to it. A missing, oversized or unsupported file is reported as such,
// never guessed at.

const { createHash } = require('crypto');
const fs = require('fs/promises');

const SUPPORTED_SCHEMA = 2;
const MAX_BYTES = 20 * 1024 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    documentKind: text(raw.documentKind, 60).toLowerCase() || 'unknown',
    person: text(raw.person, 60) || null,
    // What left the owner's pocket: the patient's share when the register has it, else the gross amount.
    amountCents: patientPaidCents ?? grossAmountCents,
    grossAmountCents,
    patientPaidCents,
    insurancePaidCents: cents(raw.insurancePaidCents),
    insurer: text(raw.insurer, 80) || null,
    reimbursementStatus: text(raw.reimbursementStatus, 40) || null,
    originalFilename: text(raw.originalFilename, 160) || null
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
  if (data?.schemaVersion !== SUPPORTED_SCHEMA || !Array.isArray(data.invoices)) return { status: 'invalid', invoices: [] };
  return {
    status: 'ok',
    generatedAt: text(data.generatedAt, 40) || null,
    complete: data.complete === true,
    invoices: data.invoices.map(normalize).filter(Boolean)
  };
}

module.exports = { loadRegister, normalize, SUPPORTED_SCHEMA };
