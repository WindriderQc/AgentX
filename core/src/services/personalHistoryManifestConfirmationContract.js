'use strict';

const manifest = require('./personalHistoryReviewManifestContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-manifest-confirmation/v1';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const invalid = () => failure('Use only the original selected manifest confirmation fields.', 400, 'HISTORY_MANIFEST_CONFIRMATION_INVALID');
const changed = () => failure('The original selected manifest confirmation changed or is unavailable.', 409, 'HISTORY_MANIFEST_CONFIRMATION_CHANGED');
const unavailable = () => failure('The original manifest confirmation could not be established; reconcile its identity.', 503, 'HISTORY_MANIFEST_CONFIRMATION_UNAVAILABLE');

function identity(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return digest(value);
}

function input(value, requestId, mode) {
  identity(requestId);
  const keys = mode === 'prepare' ? ['requestId', 'checks', 'before'] : mode === 'confirm'
    ? ['checks', 'before', 'bindingSha256', 'confirmation'] : ['checks', 'before'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw invalid();
  if (mode === 'confirm' && (typeof value.bindingSha256 !== 'string'
    || !HASH.test(value.bindingSha256) || value.confirmation !== 'reviewed_selected_manifest')) throw invalid();
  const selected = manifest.selection({ checks: value.checks, before: value.before, observationId: requestId });
  return { checks: selected.checks, before: selected.before };
}

function owner(deps) {
  if (deps?.audience !== 'owner' || ['findings', 'preservation', 'mailbox'].some(key => deps[key]?.audience !== 'owner')) {
    throw failure('Manifest confirmation belongs to the existing owner human surface.', 403, 'HISTORY_MANIFEST_CONFIRMATION_SCOPE');
  }
}

function binding(manifestSha256, coreRestorationSha256) {
  return digest({ contract: CONTRACT, manifestSha256, coreRestorationSha256 });
}

function view(row, requestId, { replayed = true, preview } = {}) {
  if (!HASH.test(row.inputSha256 || '') || !['preparing', 'prepared', 'confirming', 'confirmed', 'blocked'].includes(row.state)) throw unavailable();
  if (['prepared', 'confirming', 'confirmed'].includes(row.state)
    && (![row.bindingSha256, row.manifestSha256, row.coreRestorationSha256].every(value => typeof value === 'string' && HASH.test(value))
      || !(row.preparedAt instanceof Date))) throw unavailable();
  if (row.state === 'confirmed' && !(row.confirmedAt instanceof Date)) throw unavailable();
  if (row.bindingSha256 && row.bindingSha256 !== binding(row.manifestSha256, row.coreRestorationSha256)) throw unavailable();
  return { contract: CONTRACT, requestId, state: row.state,
    preparedAt: row.preparedAt?.toISOString() || null, confirmedAt: row.confirmedAt?.toISOString() || null,
    inputSha256: row.inputSha256, bindingSha256: row.bindingSha256 || null,
    manifestSha256: row.manifestSha256 || null, coreRestorationSha256: row.coreRestorationSha256 || null,
    blockedCode: row.blockedCode || null, recordedVia: 'private_lan_surface', authenticatedPerson: null,
    reviewOnly: true, semanticAcceptance: false, approvalBound: false, executionAllowed: false,
    cleanupStatus: 'blocked', mailboxEffects: 0, nativeValidationGaps: GAPS,
    nativeState: preview ? 'observed' : 'not_rechecked', replayed,
    ...(preview ? { preview } : {}) };
}

module.exports = { CONTRACT, identity, input, owner, binding, view, changed, unavailable };
