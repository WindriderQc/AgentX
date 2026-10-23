'use strict';

// A closed three-document operation. Operator manifests are data, never free
// Mongo update expressions. All after images are derived from domain keys.
const { error } = require('./financeAccess');
const { plain, canonical, hash } = require('./financeRepairStorage');
const { ledgerOf, ledgerPrefix, flowOf } = require('./ledgers');
const COLLECTIONS = ['finance_statements', 'finance_transactions', 'finance_overrides',
  'finance_document_links', 'finance_rules', 'finance_plan', 'finance_alerts'];
const invalid = message => error(message, 'FINANCE_REPAIR_MANIFEST_INVALID', 400);
const keyOf = row => [row.accountKey, row.date, row.fingerprint, row.occurrence].join('|');

function read(bytes, confirmation) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024) throw invalid('A bounded original manifest file is required');
  const digest = hash(bytes);
  if (confirmation !== digest) throw error('Confirm the exact reviewed Finance manifest digest', 'FINANCE_REPAIR_CONFIRMATION_REQUIRED', 409);
  let m;
  try { m = JSON.parse(bytes); } catch { throw invalid('Manifest is not JSON'); }
  if (!m || m.schemaVersion !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(m.requestKey || '') || !Array.isArray(m.updates) || m.updates.length !== 3) {
    throw invalid('Exactly one reviewed statement, transaction and decision are required');
  }
  const names = ['finance_statements', 'finance_transactions', 'finance_overrides'];
  for (const [i, u] of m.updates.entries()) {
    if (!u || u.collection !== names[i] || !/^[a-f0-9]{24}$/.test(u.id || '') || u.before?._id !== u.id
      || hash(u.before) !== u.expectedBeforeSha256 || u.upsert !== false || u.insert !== false || u.matchCountRequired !== 1
      || u.setAtExecution?.updatedAt !== 'receipt.appliedAtUtc' || Object.keys(u.setAtExecution).length !== 1
      || !u.set || Array.isArray(u.set)) throw invalid('Invalid exact Finance before image');
  }
  const [s, t, o] = m.updates.map(u => u.before);
  const source = ledgerOf(s.ledger);
  const target = m.verifiedIdentity?.ledger;
  if (!['perso','corp'].includes(target) || target === source || ledgerOf(t.ledger) !== source || t.statementId !== s._id
    || ![undefined,'perso','corp'].includes(s.ledger) || ![undefined,'perso','corp'].includes(t.ledger)
    || !Array.isArray(s.accounts) || !s.accounts.length || s.accounts.length > 20 || !Array.isArray(t.tags) || !Array.isArray(o.tags)
    || typeof s.archivePath !== 'string'
    || s.status !== 'reconciled' || s.accountLast4 !== null || !/^[a-f0-9]{64}$/.test(s.fileSha256 || '')
    || s.fileSha256 !== m.verifiedIdentity.pdfSha256 || s.archivePath !== m.verifiedIdentity.originalArchivePath
    || s.periodStart !== m.verifiedIdentity.periodStart || s.periodEnd !== m.verifiedIdentity.periodEnd
    || s.issuer !== m.verifiedIdentity.issuer || !/^\d{4}$/.test(m.verifiedIdentity.last4 || '')
    || m.legacyIdentityRetained?.accountLast4 !== null) throw invalid('Inconsistent reviewed statement identity');
  const base = s.statementKey?.replace(/^corp:/, '');
  if (!base || s.statementKey !== ledgerPrefix(source) + base || base.split('|').length !== 4
    || base.split('|')[1] !== '-' || base.split('|')[2] !== s.periodStart || base.split('|')[3] !== s.periodEnd) throw invalid('Invalid statement key');
  const accountBase = base.split('|').slice(0,2).join('|');
  for (const a of s.accounts) if (a.accountKey !== ledgerPrefix(source) + accountBase + '|' + a.code) throw invalid('Inconsistent account key');
  if (!s.accounts.some(a => a.accountKey === t.accountKey && a.code === t.accountCode)
    || t.accountKey !== o.accountKey || keyOf(t) !== keyOf(o) || t.manual !== true
    || t.category !== o.category || canonical(t.tags) !== canonical(o.tags)) throw invalid('The owner decision must follow the exact transaction');
  if (s.accounts.reduce((n,a) => n + a.transactionCount,0) !== 1) throw invalid('This repair requires exactly one transaction');
  for (const a of s.accounts) {
    const rows = t.accountKey === a.accountKey ? [t] : [];
    if (!Number.isSafeInteger(a.openingCents) || !Number.isSafeInteger(a.closingCents)
      || rows.length !== a.transactionCount || a.openingCents + rows.reduce((n,r) => n+r.amountCents,0) !== a.closingCents) throw invalid('Account arithmetic does not reconcile');
    for (const r of rows) if (!Number.isSafeInteger(r.amountCents) || r.flowCents !== flowOf(r.accountCode,r.amountCents)
      || r.balanceAfterCents !== a.closingCents || r.date < s.periodStart || r.date > s.periodEnd) throw invalid('Printed running balance or flow does not reconcile');
  }
  const accountKey = ledgerPrefix(target) + t.accountKey.replace(/^corp:/, '');
  const sets = [{ ledger: target, statementKey: ledgerPrefix(target) + base,
    ...Object.fromEntries(s.accounts.map((a,i) => [`accounts.${i}.accountKey`, ledgerPrefix(target) + a.accountKey.replace(/^corp:/, '')])) },
  { ledger: target, accountKey }, { accountKey }];
  for (let i=0;i<3;i++) if (canonical(sets[i]) !== canonical(m.updates[i].set)) throw invalid('Manifest attempts an unreviewed Finance mutation');
  return { manifest: m, digest };
}
function afterImages(manifest, appliedAt) {
  return manifest.updates.map(u => {
    const next = plain(u.before);
    for (const [field, value] of Object.entries(u.set)) {
      const parts = field.split('.'); let at = next;
      for (const part of parts.slice(0,-1)) at = at[part];
      at[parts.at(-1)] = value;
    }
    next.updatedAt = appliedAt;
    return next;
  });
}
function revive(value, field) {
  const { ObjectId } = require('mongoose').mongo;
  if (Array.isArray(value)) return value.map(v => revive(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,revive(v,k)]));
  if (['_id','statementId'].includes(field) && /^[a-f0-9]{24}$/.test(value || '')) return new ObjectId(value);
  if (['createdAt','updatedAt','ingestedAt','decidedAt','acknowledgedAt'].includes(field) && typeof value === 'string') return new Date(value);
  return value;
}

module.exports = { read, afterImages, revive, keyOf, COLLECTIONS };
