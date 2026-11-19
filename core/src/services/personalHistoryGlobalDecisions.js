'use strict';

const { randomUUID } = require('node:crypto');
const messageScope = require('./personalHistoryMessageScope');
const findingScope = require('./personalHistoryFindingScope');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-global-decisions/v1';
const CAPACITY = 1024 * 1024;
const changed = () => failure('The complete selected native decision evidence changed.', 409, 'HISTORY_GLOBAL_DECISIONS_CHANGED');

function selection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['sources', 'observationId', 'expected'].includes(key))
    || !Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 20) {
    throw failure('Select 1-20 exact native message references.', 400, 'HISTORY_GLOBAL_DECISIONS_INVALID');
  }
  const sources = input.sources.map(source => messageScope.inputOf({ source, observationId: input.observationId,
    ...(input.expected !== undefined && { expected: input.expected }) }));
  if (new Set(sources.map(source => source.messageId)).size !== sources.length) {
    throw failure('Select every message exactly once.', 400, 'HISTORY_GLOBAL_DECISIONS_INVALID');
  }
  return sources.sort((a, b) => a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
}

function corePins(observation) {
  return observation.messages.map(({ reference, members }) => {
    if (members.some(pin => pin.sourceBinding !== 'exact')) throw changed();
    return { reference, contract: messageScope.CONTRACT, members,
      fingerprint: digest({ contract: messageScope.CONTRACT, reference, entries: members }) };
  });
}
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > CAPACITY) {
    throw failure('The complete selected decision evidence exceeds its capacity.', 413, 'HISTORY_GLOBAL_DECISIONS_CAPACITY');
  }
}

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Global native decision review belongs to the owner surface.', 403, 'HISTORY_GLOBAL_DECISIONS_SCOPE');
  const sources = selection(input);
  const initial = corePins(await messageScope.observeSelection(sources));
  const findings = [];
  // Complete pass one precedes complete pass two. Each finding reader also
  // retains its own nonce and single-message privacy/decision fences.
  for (const source of sources) {
    const observed = await findingScope.discover({ source, observationId: randomUUID() }, deps);
    const pin = initial.find(row => row.reference.messageId === source.messageId);
    if (digest(observed.snapshot.coreScope) !== digest({ contract: pin.contract, fingerprint: pin.fingerprint, members: pin.members })) throw changed();
    findings.push({ reference: source, fingerprint: observed.fingerprint, snapshot: observed.snapshot });
    bounded(findings);
  }
  for (const finding of findings) {
    const observed = await findingScope.discover({ source: finding.reference, observationId: randomUUID(), expected: finding.fingerprint }, deps);
    if (observed.status !== 'observed_match' || digest(observed.snapshot) !== finding.fingerprint) throw changed();
  }
  // A single selected-set query fences ALL earlier members after ALL producer
  // calls. Per-message final checks alone leave a cross-message erasure window.
  const final = corePins(await messageScope.observeSelection(sources));
  if (digest(final) !== digest(initial)) throw changed();
  const counts = { messages: sources.length, entries: new Set(final.flatMap(row => row.members.map(pin => pin.entryId))).size,
    recordedFindings: 0, noCoreReference: 0, needsReview: 0, observedDecision: 0, threadQuestions: 0, unmatchedEntries: 0, heldMessages: 0 };
  for (const finding of findings) {
    for (const key of ['recordedFindings', 'noCoreReference', 'needsReview', 'observedDecision', 'threadQuestions', 'unmatchedEntries']) {
      counts[key] += finding.snapshot.coverage.counts[key];
    }
    counts.heldMessages += finding.snapshot.coverage.blockers.length ? 1 : 0;
  }
  // Findings/questions are counted per exact message scope; shared whole-thread
  // questions can therefore occur in more than one member. No unique-total claim.
  const snapshot = { contract: CONTRACT, sources, sourceSetSha256: digest(sources), coreScopes: final, findings,
    coverage: { counts, blockers: counts.heldMessages ? ['selected_native_findings_need_review'] : [] } };
  bounded(snapshot);
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'two-complete-finding-passes-with-final-global-core-fence', atomicBatch: false,
    authenticatedPerson: null, semanticAcceptance: false, downstreamState: 'not_rechecked',
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { discover, CONTRACT, selection };
