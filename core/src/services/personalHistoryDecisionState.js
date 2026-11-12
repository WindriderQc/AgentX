'use strict';

const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const privacy = require('./personalHistoryPrivacy');
const history = require('./personalHistoryService');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-decision-state/v1';
const ID = /^[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const unavailable = () => failure('The historical decision is unavailable.', 404, 'HISTORY_DECISION_UNAVAILABLE');

// All fingerprinted values come from the same committed Entry document. This
// does not establish a cross-document snapshot or read the souvenir/provider.
function snapshot(row) {
  const projected = JSON.parse(JSON.stringify(history.project(row)));
  return {
    contract: CONTRACT, entryId: String(row._id), entryRevision: row.revision,
    entrySha256: digest(projected), reviewState: row.reviewState, kind: row.kind,
    source: projected.source, relatedSources: projected.relatedSources,
    decisionSha256: digest(row.decision || null), confirmationSha256: digest(row.confirmation || null),
    reviewHistorySha256: digest(row.reviewHistory || []),
    sourceReviewsSha256: digest(row.sourceReviews || []),
    pendingSourceDecisions: (row.sourceReviews || []).filter(review => review.decisionIntent && !review.decision).length,
    contextRevision: row.context?.revision || 0, contextHash: row.context?.inputHash || null,
    souvenirNoteId: row.souvenirNoteId || null, downstreamState: 'not_rechecked'
  };
}

async function get(id, input = {}, deps, expectedEntry, observationId = randomUUID()) {
  if (deps?.audience !== 'owner') throw failure('Historical decisions belong to the owner surface.', 403, 'HISTORY_DECISION_SCOPE');
  if (typeof id !== 'string' || !ID.test(id)) throw unavailable();
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'expected')
    || (input.expected !== undefined && (typeof input.expected !== 'string' || !HASH.test(input.expected)))) {
    throw failure('Use only the original decision fingerprint.', 400, 'HISTORY_DECISION_INVALID');
  }
  const filter = { _id: id, scope: 'owner', reviewState: { $ne: 'forgotten' } };
  // Source bodies never leave their owner and are not needed to project a
  // history entry. The final read follows the awaited suppression lookup.
  const read = () => Entry.findOne(filter).select('-context.sources.body').maxTimeMS(5000).lean();
  const row = await read();
  if (!row) throw unavailable();
  if (await privacy.forgottenSource({ noteId: row.source?.personalNoteId, contentHash: row.contentHash })) {
    await privacy.suppress({ _id: row._id }); throw unavailable();
  }
  const current = await read();
  if (!current || current.contentHash !== row.contentHash
    || current.source?.personalNoteId !== row.source?.personalNoteId) throw unavailable();
  const value = snapshot(current);
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) {
    throw failure('The native decision exceeds its bounded capacity.', 413, 'HISTORY_DECISION_CAPACITY');
  }
  const fingerprint = digest(value);
  return { authority: 'agentx.core', contract: CONTRACT, snapshot: value, fingerprint, observationId,
    status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    ...(expectedEntry ? { entryMatches: digest(expectedEntry) === value.entrySha256 } : {}),
    observedAt: new Date().toISOString(), consistency: 'single-entry-committed-document',
    scope: 'selected-entry-only', authenticatedPerson: null, executionAllowed: false,
    cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

// POST compares an earlier API projection inside Core. Keeping this comparison
// here avoids asking a Python consumer to reproduce JavaScript number/JSON
// serialization. Supplied values are expectations, never native evidence.
async function check(id, input, deps) {
  if (deps?.audience !== 'owner') throw failure('Historical decisions belong to the owner surface.', 403, 'HISTORY_DECISION_SCOPE');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['entry', 'expected', 'observationId'].includes(key))
    || typeof input.observationId !== 'string' || !UUID.test(input.observationId)
    || !input.entry || typeof input.entry !== 'object' || Array.isArray(input.entry)) {
    throw failure('Supply only the selected earlier entry and optional fingerprint.', 400, 'HISTORY_DECISION_INVALID');
  }
  if (Buffer.byteLength(JSON.stringify(input.entry)) > 256 * 1024) {
    throw failure('The earlier entry exceeds its bounded capacity.', 413, 'HISTORY_DECISION_CAPACITY');
  }
  return get(id, input.expected === undefined ? {} : { expected: input.expected }, deps, input.entry, input.observationId);
}

module.exports = { get, check, snapshot, CONTRACT };
