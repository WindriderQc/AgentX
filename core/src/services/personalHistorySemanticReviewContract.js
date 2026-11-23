'use strict';
const original = require('./personalHistoryManifestConfirmationContract');
const manifest = require('./personalHistoryReviewManifestContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const CONTRACT = 'agentx.history-human-semantic-review/v1';
const GAP = 'native_semantic_acceptance_unavailable';
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const error = (suffix, status = 409) => failure('The exact original semantic review cannot be established; reconcile its identity.', status, `HISTORY_SEMANTIC_REVIEW_${suffix}`);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const requireEvidence = condition => { if (!condition) throw error('UNAVAILABLE', 503); };
function parse(requestId, value, mode, deps) {
  original.owner(deps); original.identity(requestId);
  const keys = ['checks', 'before', ...(mode === 'prepare' ? ['requestId'] : ['manifestRequestId']),
    ...(mode === 'read' ? ['source', 'resource', 'offset'] : mode === 'decide' ? ['bindingSha256', 'decision'] : [])];
  if (!exact(value, keys)) throw error('INVALID', 400);
  const manifestRequestId = mode === 'prepare' ? requestId : value.manifestRequestId;
  original.identity(manifestRequestId);
  if (mode === 'prepare') original.identity(value.requestId);
  if (mode === 'decide' && (!isHash(value.bindingSha256) || !['accepted_selected_semantics', 'held_ambiguous'].includes(value.decision))) throw error('INVALID', 400);
  if (mode === 'read' && ['source', 'resource', 'offset'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw error('INVALID', 400);
  const { checks, before } = manifest.selection({ checks: value.checks, before: value.before, observationId: requestId });
  return { manifestRequestId, checks, before };
}
function coverage(row) {
  const resources = row.sources.flatMap(source => source.resources);
  requireEvidence(resources.length > 0 && resources.length <= 5120 && resources.every(r =>
    Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= 16 * 1024 * 1024
    && Number.isSafeInteger(r.nextOffset) && r.nextOffset >= 0 && r.nextOffset <= r.bytes && typeof r.served === 'boolean'));
  const complete = resources.every(resource => resource.served && resource.nextOffset === resource.bytes);
  return { resources: resources.length, totalBytes: resources.reduce((n, r) => n + r.bytes, 0),
    servedResources: resources.filter(r => r.served && r.nextOffset === r.bytes).length,
    servedBytes: resources.reduce((n, r) => n + r.nextOffset, 0), complete };
}
function view(row, requestId, { preview, replayed = true } = {}) {
  requireEvidence(isHash(row.inputSha256) && ['preparing', 'prepared', 'deciding', 'accepted', 'held', 'blocked'].includes(row.state));
  if (['prepared', 'deciding', 'accepted', 'held'].includes(row.state)) requireEvidence(isHash(row.bindingSha256)
    && row.preparedAt instanceof Date && Number.isFinite(row.preparedAt.getTime()) && row.preparedAt.getTime() <= Date.now() && row.sources.length > 0);
  if (['accepted', 'held'].includes(row.state)) requireEvidence(row.decidedAt instanceof Date && row.decision === (row.state === 'accepted' ? 'accepted_selected_semantics' : 'held_ambiguous'));
  if (row.decidedAt) requireEvidence(Number.isFinite(row.decidedAt.getTime()) && row.decidedAt >= row.preparedAt && row.decidedAt.getTime() <= Date.now());
  return { contract: CONTRACT, requestId, state: row.state, inputSha256: row.inputSha256,
    bindingSha256: row.bindingSha256 || null, preparedAt: row.preparedAt?.toISOString() || null,
    decidedAt: row.decidedAt?.toISOString() || null, decision: row.decision || null, blockedCode: row.blockedCode || null,
    coverage: row.sources.length ? coverage(row) : { resources: 0, totalBytes: 0, servedResources: 0, servedBytes: 0, complete: false },
    recordedVia: 'private_lan_surface', authenticatedPerson: null, semanticAcceptance: false,
    approvalBound: false, executionAllowed: false, cleanupStatus: 'blocked', mailboxEffects: 0, replayed,
    nativeState: preview ? 'observed' : 'not_rechecked', ...(preview ? { preview } : {}) };
}
function originalScope(row, selected) {
  if (row.inputSha256 !== digest(selected)) throw error('SCOPE_CHANGED');
  return row;
}
module.exports = { CONTRACT, GAP, isHash, exact, error, requireEvidence, parse, coverage, view, originalScope };
