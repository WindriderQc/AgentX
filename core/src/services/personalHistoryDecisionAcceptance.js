'use strict';

const current = require('./personalHistoryManifestConfirmationCurrent');
const original = require('./personalHistoryManifestConfirmationContract');
const policy = require('./personalHistoryDecisionAcceptancePolicy');
const { digest, failure } = require('./personalHistorySourceReviewSources');

async function discover(requestId, input, deps) {
  original.owner(deps);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['checks', 'before', 'observationId', 'expected', 'expectedCurrent'].includes(key))
    || ['expected', 'expectedCurrent'].some(key => input[key] !== undefined
      && (typeof input[key] !== 'string' || !/^[a-f0-9]{64}$/.test(input[key])))) {
    throw failure('Use only the original native decision selection and observation expectations.', 400, 'HISTORY_DECISION_ACCEPTANCE_INVALID');
  }
  const { checks, before, observationId, expectedCurrent } = input;
  const { observation, preview } = await current.observeWithEvidence(requestId,
    { checks, before, observationId, ...(expectedCurrent !== undefined ? { expected: expectedCurrent } : {}) }, deps);
  // Policy is synchronous: the current reader's full native source fence is
  // still the final awaited evidence read. No actor or outcome is supplied.
  const snapshot = policy.build(observation, preview), fingerprint = digest(snapshot);
  const result = { authority: 'agentx.core', contract: policy.CONTRACT, observationId, observedAt: new Date().toISOString(), snapshot, fingerprint,
    status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'native-recorded-decisions-with-current-human-confirmation', currentObservation: observation,
    reviewOnly: true, atomicBatch: false, semanticAcceptance: false, authenticatedPerson: null, approvalBound: false,
    mailboxEffects: 0, executionAllowed: false, cleanupStatus: 'blocked', decisionReconciliationAccepted: snapshot.decisionReconciliationAccepted,
    nativeValidationGaps: snapshot.remainingNativeValidationGaps };
  return { observation: result, preview };
}

async function safe(...args) {
  try { return await discover(...args); }
  catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('HISTORY_DECISION_ACCEPTANCE_')) throw error;
    if ([400, 403, 404, 409].includes(error.statusCode)) throw failure('The original native decision acceptance scope cannot be established.',
      error.statusCode, 'HISTORY_DECISION_ACCEPTANCE_SCOPE');
    throw policy.unavailable();
  }
}

module.exports = { discover: async (...args) => (await safe(...args)).observation, observeWithEvidence: safe, CONTRACT: policy.CONTRACT };
