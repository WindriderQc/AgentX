'use strict';

const { randomUUID } = require('node:crypto');
const messageScope = require('./personalHistoryMessageScope');
const contract = require('./personalHistoryMailboxContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-mailbox-scope/v1';
const changed = () => failure('The live Gmail source or native Core membership changed during observation.', 409, 'HISTORY_MAILBOX_CHANGED');

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Live historical source observation belongs to the owner surface.', 403, 'HISTORY_MAILBOX_SCOPE');
  const reference = messageScope.inputOf(input);
  const control = deps.control || new (require('../../integrations/runtime-bridges/secretary-mailbox-control').SecretaryMailboxControl)();
  const first = await messageScope.discover({ source: reference, observationId: randomUUID() }, { audience: 'owner' });
  if (first.snapshot.entries.some(pin => pin.sourceBinding !== 'exact')) throw changed();
  const mailbox = await contract.collect(reference, control);
  if (digest(mailbox) !== digest(await contract.collect(reference, control))) throw changed();
  // Last awaited read fences native Core membership, decisions and erasure.
  // Two agreeing provider observations are not an atomic Gmail/Core snapshot.
  const current = await messageScope.discover({ source: reference, observationId: randomUUID(), expected: first.fingerprint }, { audience: 'owner' });
  if (current.status !== 'observed_match') throw changed();
  const snapshot = { contract: CONTRACT, reference, mailbox,
    coreScope: { contract: current.contract, fingerprint: current.fingerprint, members: current.snapshot.entries },
    coverage: contract.coverage(mailbox) };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 128 * 1024) throw failure('The live source observation exceeds its bounded capacity.', 413, 'HISTORY_MAILBOX_CAPACITY');
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'two-agreeing-live-message-reads-with-final-core-fence', mailboxEffects: 0, approvalBound: false,
    atomicBatch: false, authenticatedPerson: null, semanticAcceptance: false, downstreamState: 'not_rechecked',
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { discover, CONTRACT };
