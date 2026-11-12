'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const privacy = require('./personalHistoryPrivacy');
const { basis, digest, references, failure } = require('./personalHistorySourceReviewSources');
const { collect, GAPS } = require('./personalHistoryPreservationContract');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[a-f0-9]{24}$/;
const MAIL_ID = /^[a-f0-9]{10,32}$/;
const HASH = /^[a-f0-9]{64}$/;
const missing = () => failure('This preservation receipt is unavailable.', 404, 'HISTORY_PRESERVATION_UNAVAILABLE');

function owner(deps) {
  if (deps?.audience !== 'owner') throw failure('Preservation checks belong to the owner surface.', 403, 'HISTORY_PRESERVATION_SCOPE');
}
function requestId(key) {
  if (typeof key !== 'string' || !UUID.test(key)) throw failure('Retain the exact original request UUID.', 400, 'HISTORY_PRESERVATION_INVALID');
}
function control(deps) {
  return deps.control || new (require('../../integrations/runtime-bridges/secretary-preservation-control').SecretaryPreservationControl)();
}
async function load(id) {
  if (!ID.test(id || '')) throw missing();
  const row = await Entry.findOne({ _id: id, scope: 'owner', reviewState: { $ne: 'forgotten' } }).lean();
  if (!row) throw missing();
  if (await privacy.forgottenSource({ noteId: row.source?.personalNoteId, contentHash: row.contentHash })) {
    await privacy.suppress({ _id: row._id }); throw missing();
  }
  // Privacy lookup itself awaits native storage. An explicit erasure can settle
  // during that await, so the final returned row must be read after it.
  const current = await Entry.findOne({ _id: id, scope: 'owner', reviewState: { $ne: 'forgotten' } }).lean();
  if (!current || current.source?.personalNoteId !== row.source?.personalNoteId || current.contentHash !== row.contentHash) throw missing();
  return current;
}
function find(row, key) {
  const check = (row.preservationChecks || []).find(check => check.requestId === key);
  if (!check) throw missing();
  if (digest(check.snapshot) !== check.snapshotHash) throw failure('The stored preservation receipt failed its integrity check.',
    500, 'HISTORY_PRESERVATION_INTEGRITY');
  return check;
}
function view(row, check, nativeState = 'not_rechecked') {
  return { requestId: check.requestId, observationId: check.observationId, entryRevision: check.entryRevision, sourceIndex: check.sourceIndex,
    preparedAt: check.preparedAt, snapshotHash: check.snapshotHash, snapshot: check.snapshot,
    entryCurrent: basis(row) === check.basisHash, nativeState, executionAllowed: false, cleanupStatus: 'blocked',
    nativeValidationGaps: GAPS, meaning: 'Exact native byte and MIME checks on two machines; no semantic, whole-archive, storage-failure-domain or mailbox approval.' };
}
function source(row, index) {
  const reference = references(row)[index];
  if (!reference || reference.system !== 'gmail' || !MAIL_ID.test(reference.messageId)
    || !MAIL_ID.test(reference.threadId) || !HASH.test(reference.sourceSha256 || '')) {
    throw failure('Choose an existing exact Gmail archive source.', 400, 'HISTORY_PRESERVATION_SOURCE');
  }
  return reference;
}
async function fresh(id, check) {
  const row = await load(id);
  if (basis(row) !== check.basisHash) throw failure('The assertion or its context changed during native verification.');
  return row;
}

async function prepare(id, input, deps) {
  owner(deps);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['requestId', 'revision', 'source'].includes(key))
    || !Number.isSafeInteger(input.revision) || input.revision < 0
    || !Number.isSafeInteger(input.source) || input.source < 0 || input.source > 18) {
    throw failure('Use only the displayed revision and selected source.', 400, 'HISTORY_PRESERVATION_INVALID');
  }
  requestId(input.requestId);
  const row = await load(id);
  const existing = (row.preservationChecks || []).find(check => check.requestId === input.requestId);
  if (existing) {
    if (existing.entryRevision !== input.revision || existing.sourceIndex !== input.source) {
      throw failure('This request UUID already belongs to another preservation intent.');
    }
    return { replayed: true, receipt: view(row, find(row, input.requestId)) };
  }
  if (row.revision !== input.revision) throw failure('Refresh the assertion before preparing a check.');
  if ((row.preservationChecks || []).length >= 20) throw failure('This assertion retains its 20 existing receipts.', 409, 'HISTORY_PRESERVATION_CAPACITY');
  const reference = source(row, input.source);
  const observed = await collect(reference, control(deps));
  const check = { requestId: input.requestId, observationId: observed.observationId, entryRevision: row.revision, sourceIndex: input.source,
    basisHash: basis(row), snapshot: observed.snapshot, snapshotHash: digest(observed.snapshot), preparedAt: new Date() };
  if (Buffer.byteLength(JSON.stringify(check)) > 128 * 1024) throw failure('The native proof exceeds its bounded capacity.', 413);
  const filter = { _id: row._id, scope: 'owner', revision: row.revision, reviewState: { $ne: 'forgotten' },
    ...(row.context ? { 'context.revision': row.context.revision, 'context.inputHash': row.context.inputHash } : { context: null }),
    preservationChecks: { $not: { $elemMatch: { requestId: input.requestId } } }, 'preservationChecks.19': { $exists: false } };
  let saved;
  try {
    saved = await Entry.findOneAndUpdate(filter, { $push: { preservationChecks: check },
      $addToSet: { preservationRequestKeys: digest(input.requestId) } }, { new: true, runValidators: true }).lean();
  } catch (error) {
    if (error.code === 11000) throw failure('This preservation UUID belongs to another assertion.');
    throw error;
  }
  if (!saved) {
    const current = await load(id);
    if (!(current.preservationChecks || []).some(check => check.requestId === input.requestId)) {
      if ((current.preservationChecks || []).length >= 20) throw failure('Preservation receipt capacity reached.', 409, 'HISTORY_PRESERVATION_CAPACITY');
      throw failure('The assertion changed during native verification; retain this intent and refresh.');
    }
    const retained = find(current, input.requestId);
    if (retained.entryRevision !== input.revision || retained.sourceIndex !== input.source) throw failure('Conflicting preservation intent.');
    return { replayed: true, receipt: view(current, retained) };
  }
  const current = await fresh(id, check);
  return { replayed: false, receipt: view(current, find(current, input.requestId), 'observed') };
}

async function get(id, key, deps) {
  owner(deps); requestId(key);
  let row;
  try { row = await load(id); }
  catch (error) {
    if (error.statusCode === 404 && ID.test(id || '') && await Entry.exists({ _id: id, scope: 'owner',
      reviewState: 'forgotten', preservationRequestKeys: digest(key) })) return { erased: true, requestId: key, executionAllowed: false };
    throw error;
  }
  const check = find(row, key);
  if (basis(row) !== check.basisHash) return { receipt: view(row, check, 'stale') };
  const observed = await collect(check.snapshot.reference, control(deps));
  const current = await fresh(id, check), retained = find(current, key);
  const state = observed.snapshot.copies.some(copy => copy.status === 'unavailable') ? 'unknown'
    : digest(observed.snapshot) === retained.snapshotHash ? 'current' : 'stale';
  return { receipt: view(current, retained, state) };
}

async function list(id, deps) {
  owner(deps);
  const row = await load(id);
  return { receipts: (row.preservationChecks || []).map(check => {
    const value = find(row, check.requestId);
    return { requestId: value.requestId, preparedAt: value.preparedAt, sourceIndex: value.sourceIndex,
      entryRevision: value.entryRevision, entryCurrent: basis(row) === value.basisHash, nativeState: 'not_rechecked' };
  }), executionAllowed: false };
}

module.exports = { prepare, get, list };
