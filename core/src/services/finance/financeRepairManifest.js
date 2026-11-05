'use strict';

// A closed single-statement operation. Operator manifests are data, never free
// Mongo update expressions. All after images are derived from domain keys.
const { error } = require('./financeAccess');
const { plain, hash, canonical } = require('./financeRepairStorage');
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
  if (!m || ![1,2,3,4,5].includes(m.schemaVersion) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(m.requestKey || '') || !Array.isArray(m.updates) || m.updates.length < 2 || m.updates.length > (m.schemaVersion >= 4 ? 251 : m.schemaVersion === 3 ? 151 : 101)) {
    throw invalid('One reviewed statement and its bounded rows/decisions are required');
  }
  const names = ['finance_statements', 'finance_transactions', 'finance_overrides'];
  if (m.schemaVersion >= 3) names.push('finance_document_links');
  for (const u of m.updates) {
    const inserted=m.schemaVersion===5 && u?.insert===true;
    const retained=m.schemaVersion===5 && u?.set && Object.keys(u.set).length===0;
    const times=inserted?{createdAt:'receipt.appliedAtUtc',updatedAt:'receipt.appliedAtUtc'}:retained?{}:{updatedAt:'receipt.appliedAtUtc'};
    if (!u || !names.includes(u.collection) || !/^[a-f0-9]{24}$/.test(u.id || '') || (inserted ? u.before!==null : u.before?._id !== u.id)
      || hash(u.before) !== u.expectedBeforeSha256 || u.upsert !== false || u.insert !== inserted || u.matchCountRequired !== (inserted?0:1)
      || !u.setAtExecution || canonical(u.setAtExecution)!==canonical(times)
      || !u.set || typeof u.set!=='object' || Array.isArray(u.set)) throw invalid('Invalid exact Finance before image');
  }
  validate(m);
  return { manifest: m, digest };
}
function afterImages(manifest, appliedAt) {
  return manifest.updates.map(u => {
    const next = u.before===null?{_id:u.id}:plain(u.before);
    for (const [field, value] of Object.entries(u.set)) {
      const parts = field.split('.'); let at = next;
      for (const part of parts.slice(0,-1)) at = at[part];
      at[parts.at(-1)] = value;
    }
    for (const field of Object.keys(u.setAtExecution)) next[field]=appliedAt;
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
