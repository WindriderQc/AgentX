'use strict';

// A closed single-statement operation. Operator manifests are data, never free
// Mongo update expressions. All after images are derived from domain keys.
const { error } = require('./financeAccess');
const { plain, hash } = require('./financeRepairStorage');
const { validate, keyOf, parts } = require('./financeRepairStatementContract');
const COLLECTIONS = ['finance_statements', 'finance_transactions', 'finance_overrides',
  'finance_document_links', 'finance_rules', 'finance_plan', 'finance_alerts'];
const invalid = message => error(message, 'FINANCE_REPAIR_MANIFEST_INVALID', 400);

function read(bytes, confirmation) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024) throw invalid('A bounded original manifest file is required');
  const digest = hash(bytes);
  if (confirmation !== digest) throw error('Confirm the exact reviewed Finance manifest digest', 'FINANCE_REPAIR_CONFIRMATION_REQUIRED', 409);
  let m;
  try { m = JSON.parse(bytes); } catch { throw invalid('Manifest is not JSON'); }
  if (!m || ![1,2].includes(m.schemaVersion) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(m.requestKey || '') || !Array.isArray(m.updates) || m.updates.length < 2 || m.updates.length > 101) {
    throw invalid('One reviewed statement and its bounded rows/decisions are required');
  }
  const names = ['finance_statements', 'finance_transactions', 'finance_overrides'];
  for (const u of m.updates) {
    if (!u || !names.includes(u.collection) || !/^[a-f0-9]{24}$/.test(u.id || '') || u.before?._id !== u.id
      || hash(u.before) !== u.expectedBeforeSha256 || u.upsert !== false || u.insert !== false || u.matchCountRequired !== 1
      || u.setAtExecution?.updatedAt !== 'receipt.appliedAtUtc' || Object.keys(u.setAtExecution).length !== 1
      || !u.set || Array.isArray(u.set)) throw invalid('Invalid exact Finance before image');
  }
  validate(m);
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

module.exports = { read, afterImages, revive, keyOf, parts, COLLECTIONS };
