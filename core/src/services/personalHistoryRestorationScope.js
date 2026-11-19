'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const privacy = require('./personalHistoryPrivacy');
const preservation = require('./personalHistoryPreservation');
const { basis, digest, failure } = require('./personalHistorySourceReviewSources');
const { inputOf } = require('./personalHistoryMessageScope');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-restoration-scope/v1';
const REVIEW_CONTRACT = 'agentx.history-restoration-scope/v2';
const ID = /^[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => failure('The complete selected restoration scope is unavailable or changed.', 409, 'HISTORY_RESTORATION_SCOPE_CHANGED');
const reference = value => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, value?.[key]]));

function selection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['observationId', 'checks', 'expected', 'verification'].includes(key))
    || typeof input.observationId !== 'string' || !UUID.test(input.observationId)
    || (input.expected !== undefined && (typeof input.expected !== 'string' || !HASH.test(input.expected)))
    || (input.verification !== undefined && !['restoration', 'review-restoration'].includes(input.verification))
    || !Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 20) {
    throw failure('Select 1-20 exact retained restoration receipts and a fresh observation UUID.', 400, 'HISTORY_RESTORATION_SCOPE_INVALID');
  }
  const seen = new Set();
  return input.checks.map(check => {
    if (!check || typeof check !== 'object' || Array.isArray(check)
      || Object.keys(check).sort().join(',') !== 'entryId,requestId,snapshotHash,source'
      || typeof check.entryId !== 'string' || !ID.test(check.entryId)
      || typeof check.requestId !== 'string' || !UUID.test(check.requestId)
      || typeof check.snapshotHash !== 'string' || !HASH.test(check.snapshotHash)) {
      throw failure('Use exact retained entry, request and snapshot identities.', 400, 'HISTORY_RESTORATION_SCOPE_INVALID');
    }
    const source = inputOf({ source: check.source, observationId: input.observationId });
    if (seen.has(source.messageId)) throw failure('Select each message exactly once.', 400, 'HISTORY_RESTORATION_SCOPE_INVALID');
    seen.add(source.messageId);
    return { entryId: check.entryId, requestId: check.requestId, snapshotHash: check.snapshotHash, source };
  }).sort((a, b) => a.source.messageId.localeCompare(b.source.messageId));
}

async function read(checks, mode) {
  // Bound each record inside Mongo before materializing it, including growth
  // racing the query. No context body is needed for the existing basis hash.
  const packets = await Entry.aggregate([
    { $match: { _id: { $in: checks.map(check => new Entry.base.Types.ObjectId(check.entryId)) },
      scope: 'owner', reviewState: { $ne: 'forgotten' } } },
    { $project: { 'context.sources.body': 0 } },
    { $project: { bytes: { $bsonSize: '$$ROOT' },
      row: { $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, 512 * 1024] }, '$$ROOT', null] } } }
  ]).option({ maxTimeMS: 5000 });
  if (packets.some(packet => !packet.row) || packets.reduce((sum, packet) => sum + packet.bytes, 0) > 4 * 1024 * 1024) {
    throw failure('The complete restoration selection exceeds its capacity.', 413, 'HISTORY_RESTORATION_SCOPE_CAPACITY');
  }
  const rows = new Map(packets.map(packet => [String(packet.row._id), packet.row]));
  const pins = checks.map(selected => {
    const row = rows.get(selected.entryId), check = row?.preservationChecks?.find(item => item.requestId === selected.requestId);
    if (!row || !check || check.snapshotHash !== selected.snapshotHash || digest(check.snapshot) !== check.snapshotHash
      || check.basisHash !== basis(row) || check.snapshot?.contract !== (mode === 'review-restoration' ? 'agentx.history-preservation/v3' : 'agentx.history-preservation/v2')
      || check.snapshot.status !== 'verified_scope' || digest(reference(check.snapshot.reference)) !== digest(selected.source)) throw fail();
    return { ...selected, entryRevision: row.revision, basisHash: basis(row),
      privacyHash: digest([row.contentHash, row.source?.personalNoteId]) };
  });
  return { rows: [...rows.values()], pins };
}

async function observe(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Restoration scope belongs to the owner surface.', 403, 'HISTORY_RESTORATION_SCOPE_FORBIDDEN');
  const checks = selection(input);
  const mode = input.verification || 'restoration';
  const contract = mode === 'review-restoration' ? REVIEW_CONTRACT : CONTRACT;
  const privacyFence = async rows => {
    for (const row of rows) {
      if (await privacy.forgottenSource({ noteId: row.source?.personalNoteId, contentHash: row.contentHash })) {
        await privacy.suppress({ _id: row._id }); throw fail();
      }
    }
  };
  let before = await read(checks, mode);
  await privacyFence(before.rows);
  const guarded = await read(checks, mode);
  if (digest(before.pins) !== digest(guarded.pins)) throw fail();
  before = guarded;
  const members = [];
  let copyIdentities;
  for (const selected of checks) {
    // Reuse the native reader, nonce, immutable mode and erasure fences. GET
    // creates no receipt and cannot upgrade a v1 check or replace an old proof.
    const { receipt } = await preservation.get(selected.entryId, selected.requestId, deps);
    if (!receipt || receipt.nativeState !== 'current' || receipt.entryCurrent !== true
      || receipt.verification !== mode || receipt.snapshotHash !== selected.snapshotHash
      || receipt.snapshot.status !== 'verified_scope' || digest(receipt.snapshot) !== selected.snapshotHash) throw fail();
    const identities = receipt.snapshot.copies.map(copy => [copy.copy, copy.machineIdSha256, copy.archiveIdSha256]);
    if (copyIdentities && digest(copyIdentities) !== digest(identities)) throw fail();
    copyIdentities = identities;
    members.push({ ...selected, snapshot: receipt.snapshot });
  }
  // Recheck every selected document after ALL native calls. An earlier member
  // changing while a later member restores cannot escape as a partial success.
  await privacyFence(before.rows);
  const after = await read(checks, mode);
  if (digest(before.pins) !== digest(after.pins)) throw fail();
  const snapshot = { contract, sourceSetSha256: digest(checks.map(check => check.source)),
    pins: after.pins, members };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) {
    throw failure('The complete restoration proof exceeds its response capacity.', 413, 'HISTORY_RESTORATION_SCOPE_CAPACITY');
  }
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract, observationId: input.observationId,
    observedAt: new Date().toISOString(), snapshot, fingerprint,
    status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'retained-restoration-rechecks-with-final-core-fence', coverage: mode === 'review-restoration' ? 'complete-selected-review-packet-source-set' : 'complete-selected-source-set',
    atomicBatch: false, semanticAcceptance: false, authenticatedPerson: null,
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { observe, CONTRACT, REVIEW_CONTRACT, selection };
