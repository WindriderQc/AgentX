'use strict';

const { randomUUID } = require('node:crypto');
const messageScope = require('./personalHistoryMessageScope');
const decisionState = require('./personalHistoryDecisionState');
const contract = require('./personalHistoryFindingContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-finding-scope/v1';
const changed = () => failure('The recorded findings or native Core decisions changed during review.', 409, 'HISTORY_FINDINGS_CHANGED');

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Recorded finding review belongs to the owner surface.', 403, 'HISTORY_FINDINGS_SCOPE');
  const reference = messageScope.inputOf(input);
  const control = deps.control || new (require('../../integrations/runtime-bridges/secretary-findings-control').SecretaryFindingsControl)();
  const first = await messageScope.discover({ source: reference, observationId: randomUUID() }, { audience: 'owner' });
  if (first.snapshot.entries.some(pin => pin.sourceBinding !== 'exact')) throw changed();
  const inventory = await contract.collect(reference, control);
  // Reads stay sequential: at most one full native Entry is materialized by
  // this loop at a time, even if a record grows after initial discovery.
  const states = [];
  for (const pin of first.snapshot.entries) {
    const observed = await decisionState.get(pin.entryId, {}, { audience: 'owner' });
    if (observed.fingerprint !== pin.fingerprint) throw changed();
    states.push(observed);
  }
  if (digest(inventory) !== digest(await contract.collect(reference, control))) throw changed();
  // This is the last awaited native read. It fences decisions, membership and
  // erasure after every producer/entry call; no producer reply can return an
  // earlier private Core observation after an intervening erasure settles.
  const current = await messageScope.discover({ source: reference, observationId: randomUUID(), expected: first.fingerprint }, { audience: 'owner' });
  if (current.status !== 'observed_match') throw changed();
  const snapshot = { contract: CONTRACT, reference, inventory, coreScope: { fingerprint: current.fingerprint,
    contract: current.contract, members: current.snapshot.entries }, coverage: contract.reconcile(inventory, current.entries, states) };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) {
    throw failure('The complete native finding review exceeds its bounded capacity.', 413, 'HISTORY_FINDINGS_CAPACITY');
  }
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    atomicBatch: false, authenticatedPerson: null, semanticAcceptance: false, downstreamState: 'not_rechecked',
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { discover, CONTRACT };
