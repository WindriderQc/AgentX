'use strict';

const { randomUUID } = require('node:crypto');
const findingScope = require('./personalHistoryFindingScope');
const messageScope = require('./personalHistoryMessageScope');
const souvenirContext = require('./personalHistorySouvenirContext');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-downstream-scope/v1';
const ID = /^[a-f0-9]{24}$/;
const changed = () => failure('Historical decisions or linked souvenirs changed during observation.', 409, 'HISTORY_DOWNSTREAM_CHANGED');

function links(entries, notes, pins) {
  const byId = new Map(notes.map(note => [note.id, note]));
  return entries.map(entry => {
    const noteId = entry.souvenirNoteId || null, note = byId.get(noteId);
    const row = { entryId: entry.id, entryRevision: entry.revision,
      decisionFingerprint: pins.find(pin => pin.entryId === entry.id).fingerprint,
      state: noteId ? 'unavailable' : 'not_linked', note: null, blockers: [] };
    if (!noteId) return row; // No implicit promise or instruction to create memory.
    if (!note) { row.blockers.push('linked_souvenir_unavailable'); return row; }
    const sources = new Set(note.sourceRefs.map(ref => digest(ref)));
    const sourceBinding = souvenirContext.sourceRefs(entry).every(ref => sources.has(digest(ref)));
    const contextual = entry.context ? { _id: entry.id, context: { revision: entry.contextRevision,
      inputHash: entry.contextHash, sources: entry.context.sources } } : { _id: entry.id };
    const expectedContext = souvenirContext.snapshot(contextual, entry.timeline);
    const contextBinding = digest(expectedContext) === note.historyContextSha256;
    if (!sourceBinding) row.blockers.push('linked_souvenir_source_mismatch');
    if (!contextBinding) row.blockers.push('linked_souvenir_context_mismatch');
    if (note.replacementPending) row.blockers.push('linked_souvenir_replacement_pending');
    row.note = { id: note.id, revision: note.revision, fingerprint: note.fingerprint,
      sourceBinding, contextBinding, replacementPending: note.replacementPending };
    row.state = row.blockers.length ? 'needs_review' : 'current_link';
    return row;
  });
}

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Historical downstream evidence belongs to the owner surface.', 403, 'HISTORY_DOWNSTREAM_SCOPE');
  const reference = messageScope.inputOf(input);
  const findings = await findingScope.discover({ source: reference, observationId: randomUUID() }, deps);
  const expected = findings.snapshot.coreScope.fingerprint;
  const current = () => messageScope.discover({ source: reference, observationId: randomUUID(), expected }, { audience: 'owner' });
  const core = await current();
  if (core.status !== 'observed_match') throw changed();
  const ids = [...new Set(core.entries.map(entry => entry.souvenirNoteId).filter(id => typeof id === 'string' && ID.test(id)))];
  const notes = deps.notes || require('./memoryNoteService').personal();
  const first = links(core.entries, await notes.souvenirEvidence(ids), core.snapshot.entries);
  if ((await current()).status !== 'observed_match') throw changed();
  const second = links(core.entries, await notes.souvenirEvidence(ids), core.snapshot.entries);
  if (digest(first) !== digest(second)) throw changed();
  // Final membership/privacy fence follows both memory reads. This is not an
  // atomic snapshot across collections or an acceptance of note content.
  if ((await current()).status !== 'observed_match') throw changed();
  const counts = { entries: second.length, notLinked: 0, currentLinks: 0, unavailable: 0, needsReview: 0 };
  for (const row of second) counts[{ not_linked: 'notLinked', current_link: 'currentLinks', unavailable: 'unavailable', needs_review: 'needsReview' }[row.state]] += 1;
  const blockers = [...findings.snapshot.coverage.blockers];
  if (counts.unavailable || counts.needsReview) blockers.push('linked_souvenirs_need_review');
  const snapshot = { contract: CONTRACT, reference,
    findingScope: { fingerprint: findings.fingerprint, snapshot: findings.snapshot }, entries: second,
    coverage: { counts, blockers } };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 512 * 1024) throw failure('The complete downstream scope exceeds its bounded capacity.', 413, 'HISTORY_DOWNSTREAM_CAPACITY');
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'two-agreeing-linked-souvenir-reads-with-final-core-fence', downstreamState: 'linked-souvenirs-observed',
    atomicBatch: false, authenticatedPerson: null, semanticAcceptance: false, executionAllowed: false,
    cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { discover, CONTRACT };
