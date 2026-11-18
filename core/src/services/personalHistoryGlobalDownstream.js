'use strict';

const { randomUUID } = require('node:crypto');
const { selection } = require('./personalHistoryGlobalDecisions');
const messageScope = require('./personalHistoryMessageScope');
const downstream = require('./personalHistoryDownstreamScope');
const history = require('./personalHistoryService');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-global-downstream/v1';
const changed = () => failure('The complete selected linked-souvenir evidence changed.', 409, 'HISTORY_GLOBAL_DOWNSTREAM_CHANGED');
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) {
    throw failure('The complete selected linked-souvenir proof exceeds its capacity.', 413, 'HISTORY_GLOBAL_DOWNSTREAM_CAPACITY');
  }
}

function coverage(members) {
  const entries = new Map(), notes = new Set();
  for (const member of members) for (const row of member.snapshot.entries) {
    if (entries.has(row.entryId) && digest(entries.get(row.entryId)) !== digest(row)) throw changed();
    entries.set(row.entryId, row);
    if (row.note) notes.add(row.note.id);
  }
  const counts = { messages: members.length, entries: entries.size, observedNotes: notes.size,
    notLinked: 0, currentLinks: 0, unavailable: 0, needsReview: 0, heldMessages: 0 };
  for (const row of entries.values()) counts[{ not_linked: 'notLinked', current_link: 'currentLinks',
    unavailable: 'unavailable', needs_review: 'needsReview' }[row.state]] += 1;
  counts.heldMessages = members.filter(row => row.snapshot.coverage.blockers.length).length;
  return { counts, blockers: counts.heldMessages ? ['selected_native_downstream_needs_review'] : [] };
}

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Global linked-souvenir review belongs to the owner surface.', 403, 'HISTORY_GLOBAL_DOWNSTREAM_SCOPE');
  const sources = selection(input);
  const notes = deps.notes || require('./memoryNoteService').personal();
  const initial = await messageScope.observeSelection(sources, { souvenirs: notes });
  if (initial.messages.some(row => row.members.some(pin => pin.sourceBinding !== 'exact'))) throw changed();
  const expectedLinks = reference => {
    const members = initial.messages.find(row => row.reference.messageId === reference.messageId).members;
    const ids = new Set(members.map(row => row.entryId));
    return downstream.links(initial.rows.filter(row => ids.has(String(row._id))).map(history.project), initial.souvenirs, members);
  };
  const members = [];
  for (const reference of sources) {
    const result = await downstream.discover({ source: reference, observationId: randomUUID() }, deps);
    const pins = initial.messages.find(row => row.reference.messageId === reference.messageId).members;
    const coreScope = { contract: messageScope.CONTRACT, members: pins,
      fingerprint: digest({ contract: messageScope.CONTRACT, reference, entries: pins }) };
    if (digest(result.snapshot.findingScope.snapshot.coreScope) !== digest(coreScope)
      || digest(result.snapshot.entries) !== digest(expectedLinks(reference))) throw changed();
    members.push({ reference, fingerprint: result.fingerprint, snapshot: result.snapshot });
    bounded(members);
  }
  for (const member of members) {
    const result = await downstream.discover({ source: member.reference, observationId: randomUUID(), expected: member.fingerprint }, deps);
    if (result.status !== 'observed_match' || digest(result.snapshot) !== member.fingerprint) throw changed();
  }
  // Both Core entries and active linked notes are read in the same final
  // bounded aggregate AFTER the privacy awaits and every native producer.
  // No external or asynchronous evidence read follows this final query.
  const final = await messageScope.observeSelection(sources, { souvenirs: notes });
  if (digest(final.messages) !== digest(initial.messages) || digest(final.souvenirs) !== digest(initial.souvenirs)) throw changed();
  const snapshot = { contract: CONTRACT, sources, sourceSetSha256: digest(sources), members, coverage: coverage(members) };
  bounded(snapshot);
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'two-complete-downstream-passes-with-final-joined-core-note-fence', downstreamState: 'selected-linked-souvenirs-observed',
    atomicBatch: false, semanticAcceptance: false, authenticatedPerson: null,
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { discover, CONTRACT };
