'use strict';
const preservation = require('./personalHistoryPreservationAcceptance');
const review = require('./personalHistorySemanticReview');
const c = require('./personalHistorySemanticReviewContract');
const original = require('./personalHistoryManifestConfirmationContract');
const current = require('./personalHistoryManifestConfirmationCurrent');
const { same } = require('./personalHistorySemanticReviewEvidence');
const { digest } = require('./personalHistorySourceReviewSources');
const CONTRACT = 'agentx.history-semantic-acceptance/v1';
async function discover(manifestRequestId, input, deps) {
  original.owner(deps); original.identity(manifestRequestId);
  const keys = ['semanticRequestId', 'checks', 'before', 'observationId', ...(input?.expected !== undefined ? ['expected'] : [])];
  if (!c.exact(input, keys) || (input.expected !== undefined && !c.isHash(input.expected))) throw c.error('INVALID', 400);
  original.identity(input.semanticRequestId); original.identity(input.observationId);
  const selected = c.parse(input.semanticRequestId, { manifestRequestId, checks: input.checks, before: input.before }, 'reopen', deps);
  const row = c.originalScope(await review.load(input.semanticRequestId), selected);
  // A parent reuses the independently accepted P/D contracts. It cannot
  // silently change their public v15 contract or reinterpret the old human purpose.
  const p = await preservation.discover(manifestRequestId, { checks: selected.checks, before: selected.before, observationId: input.observationId }, deps);
  const observed = await review.observeOriginal(row, selected, deps);
  if (!same(observed.observation.snapshot.current, p.decisionObservation.currentObservation.snapshot.current)
    || !same(observed.observation.snapshot.confirmation, p.decisionObservation.currentObservation.snapshot.confirmation)) throw c.error('EVIDENCE_CHANGED');
  const retained = c.originalScope(await review.load(input.semanticRequestId), selected);
  if (!same(retained, row)) throw c.error('DECISION_CHANGED');
  // Last awaited read follows ALL producers, witness and original human reads.
  await current.assertEvidenceCurrent(observed, deps);
  const receipt = c.view(row, input.semanticRequestId), blockers = [...observed.blockers];
  if (row.state !== 'accepted') blockers.push('explicit_human_semantic_decision_missing');
  if (!receipt.coverage.complete) blockers.push('semantic_sources_not_fully_served');
  const accepted = blockers.length === 0;
  const snapshot = { contract: CONTRACT, scope: 'human-selected-originals-attachments-and-recorded-analyses',
    policy: 'explicit-human-judgement-on-private-lan/v1', manifestRequestId, semanticRequestId: input.semanticRequestId,
    inputSha256: row.inputSha256, bindingSha256: row.bindingSha256, reviewBinding: observed.snapshot, preservationAcceptanceSha256: p.fingerprint,
    receipt, blockers, semanticAcceptance: accepted, preservationAccepted: p.preservationAccepted,
    decisionReconciliationAccepted: p.decisionReconciliationAccepted,
    remainingNativeValidationGaps: p.nativeValidationGaps.filter(gap => !(gap === c.GAP && accepted)) };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) throw c.error('CAPACITY', 413);
  const fingerprint = digest(snapshot);
  const result = { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'native-human-semantic-with-preservation-and-final-core-fence', preservationObservation: p,
    reviewOnly: true, atomicBatch: false, authenticatedPerson: null, semanticAcceptance: accepted,
    preservationAccepted: p.preservationAccepted, decisionReconciliationAccepted: p.decisionReconciliationAccepted,
    approvalBound: false, executionAllowed: false, cleanupStatus: 'blocked', mailboxEffects: 0,
    nativeValidationGaps: snapshot.remainingNativeValidationGaps };
  if (Buffer.byteLength(JSON.stringify(result)) > 3 * 1024 * 1024) throw c.error('CAPACITY', 413);
  return result;
}
async function safe(...args) {
  try { return await discover(...args); }
  catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('HISTORY_SEMANTIC_REVIEW_')) throw error;
    if ([400, 403, 404, 409, 413].includes(error.statusCode)) throw c.error('SCOPE', error.statusCode);
    throw c.error('UNAVAILABLE', 503);
  }
}
module.exports = { discover: safe, CONTRACT };
