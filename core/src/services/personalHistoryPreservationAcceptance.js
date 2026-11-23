'use strict';

const decisions = require('./personalHistoryDecisionAcceptance');
const current = require('./personalHistoryManifestConfirmationCurrent');
const storage = require('./personalHistoryStorageScope');
const original = require('./personalHistoryManifestConfirmationContract');
const policy = require('./personalHistoryPreservationAcceptancePolicy');
const { digest, failure } = require('./personalHistorySourceReviewSources');

async function discover(requestId, input, deps) {
  original.owner(deps);
  const expectations = ['expected', 'expectedDecision', 'expectedCurrent', 'expectedStorage'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['checks', 'before', 'observationId', ...expectations].includes(key))
    || expectations.some(key => input[key] !== undefined && (typeof input[key] !== 'string' || !/^[a-f0-9]{64}$/.test(input[key])))) {
    throw failure('Use only the exact retained preservation selection and observation expectations.', 400, 'HISTORY_PRESERVATION_ACCEPTANCE_INVALID');
  }
  const { checks, before, observationId, expectedDecision, expectedCurrent, expectedStorage } = input;
  const observed = await decisions.observeWithEvidence(requestId, { checks, before, observationId,
    ...(expectedDecision !== undefined && { expected: expectedDecision }), ...(expectedCurrent !== undefined && { expectedCurrent }) }, deps);
  const d = observed.observation, preview = observed.preview;
  const s = await storage.discover({ sources: preview.manifest.sources, observationId,
    ...(expectedStorage !== undefined && { expected: expectedStorage }) }, deps.preservation);
  // Recheck immutable human metadata after all storage producers. The complete
  // native Core source/index/privacy query is the final awaited evidence read.
  await current.assertEvidenceCurrent({ observation: d.currentObservation, preview }, deps);
  const snapshot = policy.build(d, s, preview), fingerprint = digest(snapshot);
  const result = { authority: 'agentx.core', contract: policy.CONTRACT, observationId, observedAt: new Date().toISOString(), snapshot, fingerprint,
    status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'native-preservation-with-current-human-and-core-fence', decisionObservation: d, storageObservation: s,
    reviewOnly: true, atomicBatch: false, semanticAcceptance: false, authenticatedPerson: null, approvalBound: false,
    mailboxEffects: 0, executionAllowed: false, cleanupStatus: 'blocked', preservationAccepted: snapshot.preservationAccepted,
    decisionReconciliationAccepted: snapshot.decisionReconciliationAccepted, nativeValidationGaps: snapshot.remainingNativeValidationGaps };
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw failure('Complete native preservation evidence exceeds its response capacity.', 413, 'HISTORY_PRESERVATION_ACCEPTANCE_CAPACITY');
  return result;
}

async function safe(...args) {
  try { return await discover(...args); }
  catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('HISTORY_PRESERVATION_ACCEPTANCE_')) throw error;
    if ([400, 403, 404, 409].includes(error.statusCode)) throw failure('The original preservation acceptance scope cannot be established.', error.statusCode, 'HISTORY_PRESERVATION_ACCEPTANCE_SCOPE');
    throw policy.unavailable();
  }
}

module.exports = { discover: safe, CONTRACT: policy.CONTRACT };
