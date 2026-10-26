'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const history = require('./personalHistoryService');
const privacy = require('./personalHistoryPrivacy');
const contract = require('./personalHistoryContextContract');
const { fail, digest, LIMITS } = contract;
const ID = /^[a-f0-9]{24}$/;
const conflict = message => fail(message, 409, 'PERSONAL_HISTORY_CONTEXT_CONFLICT');
const unavailable = () => fail('History context is unavailable', 404, 'PERSONAL_HISTORY_CONTEXT_UNAVAILABLE');
const effective = row => ({ ...row.context.timeline, ...(row.context.overrides || {}) });

async function usable(row) {
  if (!row || row.reviewState === 'forgotten') throw unavailable();
  if (await privacy.forgottenSource({ noteId: row.source?.personalNoteId, contentHash: row.contentHash })) {
    await privacy.suppress({ _id: row._id });
    throw unavailable();
  }
  return row;
}
async function load(id, includeSourceBodies = false) {
  if (!ID.test(id || '')) throw unavailable();
  const query = Entry.findOne({ _id: id, scope: 'owner' });
  if (!includeSourceBodies) query.select('-context.sources.body');
  return usable(await query.lean());
}
function verifySource(record) {
  if (typeof record.body !== 'string' || digest(record.body) !== record.bodySha256) {
    throw fail('Stored source integrity check failed', 500, 'PERSONAL_HISTORY_SOURCE_INTEGRITY');
  }
}
async function get(id, { includeSourceBodies = false } = {}) {
  const row = await load(id, includeSourceBodies);
  if (includeSourceBodies) (row.context?.sources || []).forEach(verifySource);
  return { authority: 'agentx.core', entry: history.project(row, { includeSourceBodies }) };
}
async function source(id, sourceId) {
  const row = await load(id, true);
  const record = row.context?.sources?.find(item => item.id === sourceId);
  if (!record) throw unavailable();
  verifySource(record);
  return { authority: 'agentx.core', source: record };
}
function receipt(row, { created = false, changed = false, replayed = false } = {}) {
  return { entryId: String(row._id), sourceKey: row.key, importId: row.context.importId,
    contextRevision: row.context.revision, contextHash: row.context.inputHash, created, changed, replayed, entry: history.project(row) };
}
function bounded(context) {
  if (Buffer.byteLength(JSON.stringify(context)) > LIMITS.contextBytes) throw fail('Context including owner edits exceeds the byte limit');
}
async function importOne(value) {
  const native = value.entry ? history.normalize(value.entry) : null;
  let row;
  if (value.entryId) {
    row = await usable(await Entry.findOne({ _id: value.entryId, scope: 'owner' }).lean());
    if (row.key !== value.sourceKey || (native && native.key !== row.key)) throw conflict('Native history provenance does not match entryId/sourceKey');
  } else {
    row = await Entry.findOne({ scope: 'owner', contextImportKey: value.importKey }).lean();
    if (row && row.key !== native.key) throw conflict('importId already belongs to another history source');
    if (!row) row = await Entry.findOne({ scope: 'owner', key: native.key }).lean();
    if (!row) {
      if (value.expectedContextRevision !== 0) throw conflict('A new context requires expectedContextRevision 0');
      try {
        const result = await history.record(value.entry, { context: value.context, importKey: value.importKey });
        row = await usable(await Entry.findById(result.entry.id).lean());
        if (result.created) return receipt(row, { created: true, changed: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        row = await Entry.findOne({ scope: 'owner', contextImportKey: value.importKey }).lean();
        if (!row || row.key !== native.key) throw conflict('importId already belongs to another history source');
      }
    }
    await usable(row);
  }
  if (row.contextImportKey && row.contextImportKey !== value.importKey) throw conflict('This history source already has another importId');
  if (row.context?.importId !== undefined && row.context.importId !== value.context.importId) throw conflict('This context already has another importId');
  // A response can be lost after commit. Reconcile the same input before the
  // revision fence, retaining any later owner corrections and decisions.
  if (row.context?.inputHash === value.context.inputHash) return receipt(row, { replayed: true });
  const incomingSources = new Map(value.context.sources.map(source => [source.id, source]));
  for (const previous of row.context?.sources || []) {
    if (incomingSources.get(previous.id)?.bodySha256 !== previous.bodySha256) {
      throw conflict('Retain previous exact source bodies; use a new source ID for a revised extraction');
    }
  }
  const revision = row.context?.revision || 0;
  if (revision !== value.expectedContextRevision) throw conflict('History context changed; reload its contextRevision');
  const context = { ...value.context, revision: revision + 1, overrides: row.context?.overrides || {},
    ownerEdits: row.context?.ownerEdits || [], ownerEditedAt: row.context?.ownerEditedAt || null };
  // Imported changes must remain valid under the owner's retained overrides.
  contract.timeline({ ...context.timeline, ...context.overrides });
  bounded(context);
  const filter = { _id: row._id, scope: 'owner', key: row.key, reviewState: { $ne: 'forgotten' },
    ...(revision ? { 'context.revision': revision } : { $or: [{ context: null }, { context: { $exists: false } }] }) };
  let saved;
  try {
    saved = await Entry.findOneAndUpdate(filter, { $set: { context, contextImportKey: value.importKey } }, { new: true, runValidators: true }).lean();
  } catch (error) {
    if (error.code === 11000) throw conflict('importId already belongs to another history source');
    throw error;
  }
  if (!saved) {
    const latest = await usable(await Entry.findById(row._id).lean());
    if (latest.context?.importId === value.context.importId && latest.context.inputHash === value.context.inputHash) return receipt(latest, { replayed: true });
    throw conflict('History context changed; reload its contextRevision');
  }
  await usable(saved);
  return receipt(saved, { changed: true });
}
let importIndex;
async function ensureImportIndex() {
  if (!importIndex) importIndex = Entry.collection.createIndex({ contextImportKey: 1 }, { unique: true, sparse: true })
    .catch(error => { importIndex = null; throw error; });
  return importIndex;
}
async function importBatch(input = {}) {
  const entries = input.entries;
  if (!Array.isArray(entries) || !entries.length || entries.length > LIMITS.batch) throw fail(`Import 1-${LIMITS.batch} complete history contexts`);
  // Prevalidate the full batch before the first write. Mongo writes are bounded
  // per entry, not a cross-entry transaction; importId/hash reconcile retries.
  const values = entries.map(contract.normalize);
  const imports = new Set();
  for (const value of values) {
    if (value.entry) {
      const native = history.normalize(value.entry);
      if (value.sourceKey && value.sourceKey !== native.key) throw conflict('Native history provenance does not match sourceKey');
    }
    if (imports.has(value.importKey)) throw fail('Duplicate importId in batch');
    imports.add(value.importKey);
  }
  await ensureImportIndex();
  const results = [];
  for (const value of values) results.push(await importOne(value));
  return { authority: 'agentx.core', results };
}
const EDIT_FIELDS = new Set(['title', 'description', 'date', 'precision', 'endDate', 'endPrecision', 'ongoing', 'category', 'place',
  'notes', 'rationale', 'relatedEventIds', 'links', 'ageStartWindow', 'ageEndWindow', 'dateWindow', 'ownerTimeLabel', 'ageDateNote',
  'dateEstimateNote', 'tentativeDate', 'hypothesis', 'claimType', 'reviewQuestions']);
async function edit(id, input = {}) {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw fail('The current context revision is required');
  if (Object.keys(input).some(k => !['revision', 'changes'].includes(k)) || !input.changes || typeof input.changes !== 'object' ||
    Array.isArray(input.changes) || Object.keys(input.changes).some(k => k !== 'timeline')) throw fail('Edit only changes.timeline');
  const patch = input.changes.timeline;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw fail('A timeline edit is required');
  for (const key of Object.keys(patch)) if (!EDIT_FIELDS.has(key)) throw fail(`timeline.${key} cannot be owner-edited`);
  const row = await load(id, true);
  if (!row.context) throw unavailable();
  if (row.context.revision !== input.revision) throw conflict('History context changed; reload its contextRevision');
  const before = effective(row);
  for (const [dateKey, windows] of [['date', ['dateWindow', 'ageStartWindow']], ['endDate', ['ageEndWindow']]]) {
    const precisionKey = dateKey === 'date' ? 'precision' : 'endPrecision';
    if ((patch[dateKey] !== undefined && patch[dateKey] !== before[dateKey]) ||
      (patch[precisionKey] !== undefined && patch[precisionKey] !== before[precisionKey])) {
      for (const key of windows) if (before[key] && patch[key] !== null) throw fail(`Changing ${dateKey} requires explicitly clearing ${key}`);
    }
  }
  const normalized = contract.timeline({ ...before, ...patch });
  const changes = Object.fromEntries(Object.keys(patch).map(key => [key, normalized[key]]));
  if (changes.relatedEventIds) {
    if (changes.relatedEventIds.some(ref => !ID.test(ref))) throw fail('relatedEventIds must name native history entries');
    const count = await Entry.countDocuments({ _id: { $in: changes.relatedEventIds }, scope: 'owner', reviewState: { $ne: 'forgotten' } });
    if (count !== changes.relatedEventIds.length) throw fail('Every relatedEventId must exist in the same owner scope');
  }
  if (Object.keys(changes).every(key => JSON.stringify(changes[key]) === JSON.stringify(before[key]))) {
    return { authority: 'agentx.core', changed: false, entry: history.project(row) };
  }
  if ((row.context.ownerEdits || []).length >= 1000) throw conflict('Owner context edit capacity reached; retain the audit before continuing');
  const at = new Date();
  const context = { ...row.context, revision: input.revision + 1, overrides: { ...(row.context.overrides || {}), ...changes }, ownerEditedAt: at,
    ownerEdits: [...(row.context.ownerEdits || []), { revision: input.revision + 1, at, changes }] };
  bounded(context);
  const saved = await Entry.findOneAndUpdate({ _id: id, scope: 'owner', reviewState: { $ne: 'forgotten' }, 'context.revision': input.revision },
    { $set: { context } }, { new: true, runValidators: true }).lean();
  if (!saved) throw conflict('History context changed; reload its contextRevision');
  await usable(saved);
  return { authority: 'agentx.core', changed: true, entry: history.project(saved) };
}
module.exports = { importBatch, get, source, edit };
