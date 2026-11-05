'use strict';

const { BSON, ObjectId } = require('mongoose').mongo;
const { error } = require('./financeAccess');
const { hash, plain, canonical } = require('./financeRepairStorage');
const { COLLECTIONS, keyOf, afterImages, parts } = require('./financeRepairManifest');
const conflict = message => error(message, 'FINANCE_REPAIR_STATE_CONFLICT', 409);

async function snapshot(db) {
  const out = {}; let bytes = 0;
  for (const name of COLLECTIONS) {
    out[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    bytes += Buffer.byteLength(canonical(out[name]));
    if (bytes > 32 * 1024 * 1024) throw conflict('Finance snapshot exceeds the bounded repair limit');
  }
  return out;
}
const signatures = state => Object.fromEntries(COLLECTIONS.map(name => [name, { count: state[name].length, sha256: hash(state[name]) }]));
function assertSignatures(state, expected) {
  if (canonical(signatures(state)) !== canonical(expected)) throw conflict('Finance changed outside the reviewed statement scope');
}
function images(state, manifest) {
  return manifest.updates.map(u => {
    const found = state[u.collection].filter(x => String(x._id) === u.id);
    if (found.length !== 1) throw conflict('A reviewed Finance document is missing');
    return found[0];
  });
}
function derive(state, manifest, documents) {
  return Object.fromEntries(COLLECTIONS.map(name => [name, state[name].map(row => {
    const i = manifest.updates.findIndex(u => u.collection === name && u.id === String(row._id));
    return i === -1 ? row : documents[i];
  })]));
}
function validateScope(state, manifest, destination) {
  const group = parts(manifest), s = group.statement.before;
  if (Array.isArray(s.rowKeys)) throw conflict('Explicit statement membership requires a membership-aware reviewed repair');
  const rowIds = group.transactions.map(u => u.id).sort();
  const exactRows = state.finance_transactions.filter(x => String(x.statementId) === s._id);
  if (canonical(exactRows.map(x => String(x._id)).sort()) !== canonical(rowIds)) throw conflict('Statement transaction scope changed');
  const rows = group.transactions.map(u => u.before);
  const keys = new Set(rows.flatMap((t,i) => [keyOf(t),keyOf({...t,accountKey:group.transactions[i].set.accountKey})]));
  const decisionIds = group.overrides.map(u => u.id).sort();
  const decisions = state.finance_overrides.filter(x => keys.has(keyOf(x)));
  if (canonical(decisions.map(x => String(x._id)).sort()) !== canonical(decisionIds)) throw conflict('Statement owner decision scope changed');
  const documentIds = new Set(group.links.map(u => u.before.documentId));
  const links = state.finance_document_links.filter(x => documentIds.has(x.documentId) || keys.has(x.transactionKey)
    || (x.transaction?.accountKey && [...keys].some(k => k.startsWith(x.transaction.accountKey + '|' + x.transaction.date + '|'))));
  if (canonical(links.map(x => String(x._id)).sort()) !== canonical(group.links.map(u => u.id).sort())) {
    throw conflict('Statement document link scope changed or was not reviewed');
  }
  for (const name of ['finance_statements','finance_transactions','finance_overrides','finance_document_links']) {
    const indexes = manifest.updates.flatMap((u,i) => u.collection === name ? [i] : []);
    const ownedIds = new Set(indexes.map(i => manifest.updates[i].id));
    const identity = name === 'finance_statements' ? row => row.statementKey : name === 'finance_document_links' ? row => row.key : keyOf;
    const targetKeys = new Set(indexes.map(i => identity(destination[i])));
    if (state[name].some(row => !ownedIds.has(String(row._id)) && targetKeys.has(identity(row)))) throw conflict('A destination identity is occupied');
  }
}
function assertImages(current, allowed) {
  current.forEach((doc,i) => {
    if (!allowed.some(set => hash(doc) === hash(set[i]))) throw conflict('A reviewed Finance document has drifted');
  });
}
function typedAfter(current, manifest, at) {
  const derived = afterImages(manifest, at.toISOString());
  return current.map((doc,i) => {
    const next = BSON.deserialize(BSON.serialize(doc));
    for (const field of Object.keys(manifest.updates[i].set)) {
      const parts = field.split('.'); let at = next; let expected = derived[i];
      for (const part of parts.slice(0,-1)) { at = at[part]; expected = expected[part]; }
      at[parts.at(-1)] = expected[parts.at(-1)];
    }
    next.updatedAt = new Date(derived[i].updatedAt);
    return next;
  });
}
async function replace(db, update, expected, next) {
  const current = await db.collection(update.collection).findOne({ _id: new ObjectId(update.id) });
  if (hash(current) === hash(next)) return 'already_received';
  if (hash(current) !== hash(expected)) throw conflict('Finance CAS before image no longer matches');
  const filter = { ...expected };
  if (!Object.hasOwn(expected,'ledger')) filter.ledger = { $exists: false };
  const result = await db.collection(update.collection).replaceOne(filter, next, { writeConcern: { w: 'majority', j: true } });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) throw conflict('Finance CAS was refused');
  return 'changed';
}
async function nativeViews() {
  const query = require('./financeQueryService');
  const result = {};
  // Receipt v1/v2 pins the accounting balance projection. Historical source
  // coverage may change while these latest balances remain exactly unchanged.
  // Keep the original proof bytes; new reader metadata is not a balance.
  for (const ledger of ['perso','corp']) {
    const { accounts } = await query.balances({ ledger });
    result[ledger] = { accounts };
  }
  return plain(result);
}
function assertBalancePlan(manifest,state,before,destination,direction='apply') {
  if (manifest.schemaVersion === 4) require('./financeRepairBalanceProof').assertPlan(manifest,state,before,derive(state,manifest,destination),direction);
}
function assertBalances(manifest, before, after, direction='apply') {
  if (manifest.schemaVersion === 4) return require('./financeRepairBalanceProof').assertResult(manifest,before,after,direction);
  if (manifest.expectedAccounting?.latestBalancesExpectedUnchangedInBothLedgers !== true || canonical(before) !== canonical(after)) {
    throw conflict('The repair changed the latest account balances');
  }
  return { latestBalancesUnchanged:true };
}

module.exports = { snapshot, signatures, assertSignatures, images, derive, validateScope, assertImages,
  typedAfter, replace, nativeViews, assertBalances, assertBalancePlan, conflict };
