'use strict';

const { randomUUID } = require('node:crypto');
const { selection } = require('./personalHistoryGlobalDecisions');
const messageScope = require('./personalHistoryMessageScope');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const native = require('./personalHistoryStorageContract');
const CONTRACT = 'agentx.history-storage-scope/v1';
const changed = () => failure('Selected native storage evidence changed during observation.', 409, 'HISTORY_STORAGE_CHANGED');
const bounded = value => {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw failure('Complete selected storage metadata exceeds its capacity.', 413, 'HISTORY_STORAGE_CAPACITY');
};

async function member(reference, control) {
  const nonce = randomUUID(), copies = [];
  for (const copy of ['primary', 'mirror']) {
    const value = await control.probeStorageEvidence(copy, { requestId: nonce, ...reference });
    copies.push({ copy, ...native.describe(value, nonce, reference) });
  }
  return { reference, copies, coverage: native.coverage(copies) };
}

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Selected storage evidence belongs to the owner surface.', 403, 'HISTORY_STORAGE_SCOPE');
  const sources = selection(input);
  const initial = await messageScope.observeSelection(sources);
  if (initial.messages.some(row => row.members.some(pin => pin.sourceBinding !== 'exact'))) throw changed();
  const control = deps.control || new (require('../../integrations/runtime-bridges/secretary-preservation-control').SecretaryPreservationControl)();
  const members = [];
  for (const reference of sources) { members.push(await member(reference, control)); bounded(members); }
  // Repeat the entire selected set before the common final Core/privacy fence.
  // Individual native commands also pin every selected source FD and restore.
  for (const first of members) if (digest(await member(first.reference, control)) !== digest(first)) throw changed();
  const final = await messageScope.observeSelection(sources);
  if (digest(final.messages) !== digest(initial.messages)) throw changed();
  const held = members.filter(row => row.coverage.blockers.length).length;
  const snapshot = { contract: CONTRACT, sources, sourceSetSha256: digest(sources), coreScopes: final.messages,
    members, coverage: { counts: { messages: sources.length, distinctKernelDeviceMessages: sources.length - held, heldMessages: held },
      blockers: held ? ['selected_storage_evidence_held'] : [] } };
  bounded(snapshot);
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'two-complete-storage-passes-with-final-core-fence', atomicBatch: false, reviewOnly: true,
    physicalIndependenceAccepted: false, semanticAcceptance: false, authenticatedPerson: null, approvalBound: false,
    mailboxEffects: 0, executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

async function safe(...args) {
  try { return await discover(...args); }
  catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('HISTORY_STORAGE_')) throw error;
    if (error.statusCode === 400) throw failure('Use only the complete exact selected storage observation fields.', 400, 'HISTORY_STORAGE_INVALID');
    throw native.unavailable();
  }
}

module.exports = { discover: safe, CONTRACT };
