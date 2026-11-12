'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const history = require('./personalHistoryService');
const privacy = require('./personalHistoryPrivacy');
const state = require('./personalHistoryDecisionState');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-message-scope/v1';
const MAIL_ID = /^[a-f0-9]{10,32}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT = 100;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_SCOPE_BYTES = 8 * 1024 * 1024;
const changed = () => failure('Historical message membership or decisions changed during discovery.', 409, 'HISTORY_MESSAGE_SCOPE_CHANGED');

function inputOf(input) {
  const source = input?.source;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['source', 'observationId', 'expected'].includes(key))
    || typeof input.observationId !== 'string' || !UUID.test(input.observationId)
    || (input.expected !== undefined && (typeof input.expected !== 'string' || !HASH.test(input.expected)))
    || !source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).some(key => !['system', 'messageId', 'threadId', 'sourceSha256'].includes(key))
    || source.system !== 'gmail' || typeof source.messageId !== 'string' || !MAIL_ID.test(source.messageId)
    || typeof source.threadId !== 'string' || !MAIL_ID.test(source.threadId)
    || typeof source.sourceSha256 !== 'string' || !HASH.test(source.sourceSha256)) {
    throw failure('Use only an exact Gmail message reference and a fresh observation UUID.', 400, 'HISTORY_MESSAGE_SCOPE_INVALID');
  }
  return { system: 'gmail', messageId: source.messageId, threadId: source.threadId, sourceSha256: source.sourceSha256 };
}

function describe(row, reference) {
  const refs = [row.source, ...(row.relatedSources || [])].filter(source => source?.system === 'gmail'
    && source.messageId === reference.messageId);
  return { entryId: String(row._id), entryRevision: row.revision, fingerprint: digest(state.snapshot(row)),
    sourceBinding: refs.length && refs.every(source => source.threadId === reference.threadId
      && source.sourceSha256 === reference.sourceSha256) ? 'exact' : 'conflict' };
}

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Historical message discovery belongs to the owner surface.', 403, 'HISTORY_MESSAGE_SCOPE_FORBIDDEN');
  const reference = inputOf(input);
  // Match message identity first. A conflicting recorded thread/hash must be
  // visible as a conflict, not disappear behind an overly narrow hash filter.
  const filter = { scope: 'owner', reviewState: { $ne: 'forgotten' }, $or: [
    { 'source.system': 'gmail', 'source.messageId': reference.messageId },
    { relatedSources: { $elemMatch: { system: 'gmail', messageId: reference.messageId } } }
  ] };
  const read = async () => {
    // Enforce the individual byte bound inside Mongo before materializing any
    // full record in Node. A preflight size query alone would race with growth.
    const packets = await Entry.aggregate([
      { $match: filter }, { $sort: { _id: 1 } }, { $limit: LIMIT + 1 },
      { $project: { 'context.sources.body': 0 } },
      { $project: { _id: 0, bytes: { $bsonSize: '$$ROOT' },
        row: { $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, MAX_RECORD_BYTES] }, '$$ROOT', null] } } }
    ]).option({ maxTimeMS: 5000 });
    if (packets.length > LIMIT || packets.some(packet => !packet.row)
      || packets.reduce((total, packet) => total + packet.bytes, 0) > MAX_SCOPE_BYTES) {
      throw failure('The complete selected message exceeds its record or byte capacity; no partial scope is returned.', 413, 'HISTORY_MESSAGE_SCOPE_CAPACITY');
    }
    return packets.map(packet => packet.row);
  };
  const before = await read();
  const pins = before.map(row => describe(row, reference));
  const privacyGuards = rows => rows.map(row => [String(row._id), row.contentHash, row.source?.personalNoteId]);
  const guardsHash = digest(privacyGuards(before));
  for (const row of before) {
    if (await privacy.forgottenSource({ noteId: row.source?.personalNoteId, contentHash: row.contentHash })) {
      await privacy.suppress({ _id: row._id }); throw changed();
    }
  }
  // No pagination, count query, external note read or await follows this final
  // bounded membership query. Still not an atomic cross-document snapshot.
  const current = await read();
  if (guardsHash !== digest(privacyGuards(current)) || digest(pins) !== digest(current.map(row => describe(row, reference)))) throw changed();
  const snapshot = { contract: CONTRACT, reference, entries: pins };
  const fingerprint = digest(snapshot);
  const result = { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId,
    observedAt: new Date().toISOString(), snapshot, fingerprint, entries: current.map(row => history.project(row)),
    status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'two-agreeing-bounded-membership-queries', coverage: 'selected-message-visible-core-entries',
    atomicBatch: false, downstreamState: 'not_rechecked', authenticatedPerson: null,
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) {
    throw failure('The selected message scope exceeds its bounded response capacity.', 413, 'HISTORY_MESSAGE_SCOPE_CAPACITY');
  }
  return result;
}

module.exports = { discover, inputOf, CONTRACT };
