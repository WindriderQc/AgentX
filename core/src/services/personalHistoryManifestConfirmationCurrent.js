'use strict';

const confirmations = require('./personalHistoryManifestConfirmation');
const original = require('./personalHistoryManifestConfirmationContract');
const selection = require('./personalHistoryReviewManifestContract').selection;
const evidence = require('./personalHistoryManifestConfirmationEvidence');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-manifest-confirmation-current/v1';
const unavailable = () => failure('The current native confirmation evidence is unavailable; retain the original receipt.',
  503, 'HISTORY_MANIFEST_CONFIRMATION_CURRENT_UNAVAILABLE');
const changed = () => failure('The original confirmed receipt cannot be bound to this exact observation.',
  409, 'HISTORY_MANIFEST_CONFIRMATION_CURRENT_RECEIPT_CHANGED');

function parse(requestId, input, deps) {
  try { original.owner(deps); }
  catch { throw failure('Current confirmation evidence belongs to the owner human surface.', 403,
    'HISTORY_MANIFEST_CONFIRMATION_CURRENT_SCOPE'); }
  original.identity(requestId);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['checks', 'before', 'observationId', 'expected'].includes(key))) {
    throw failure('Use the exact retained confirmation selection and a fresh observation identity.',
      400, 'HISTORY_MANIFEST_CONFIRMATION_CURRENT_INVALID');
  }
  return selection(input);
}

async function receipt(requestId, deps) {
  const value = await confirmations.get(requestId, deps);
  if (value.state !== 'confirmed') throw changed();
  const start = Date.parse(value.preparedAt), end = Date.parse(value.confirmedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > Date.now()) throw changed();
  return Object.fromEntries(['contract', 'requestId', 'inputSha256', 'bindingSha256', 'manifestSha256',
    'coreRestorationSha256', 'preparedAt', 'confirmedAt', 'recordedVia', 'authenticatedPerson'].map(key => [key, value[key]]));
}

async function discover(requestId, input, deps) {
  const { checks, sources, before } = parse(requestId, input, deps);
  const selected = { checks, before }, inputSha256 = digest(selected);
  const confirmed = await receipt(requestId, deps);
  if (confirmed.inputSha256 !== inputSha256) throw changed();
  let observed;
  try { observed = await evidence.observe(selected, deps); }
  // Native legacy409 can mean a missing mirror or temporary scratch failure.
  // Without a COMPLETE new composition, neither change nor currency is proved.
  catch { throw unavailable(); }
  const retained = await receipt(requestId, deps);
  if (digest(retained) !== digest(confirmed)) throw changed();
  // All metadata awaits precede the same full Core source/index/privacy fence
  // used by the human preview. No private preview or source references escape.
  try { await evidence.assertCurrent(observed.preview, deps); }
  catch { throw unavailable(); }
  const current = Object.fromEntries(['bindingSha256', 'manifestSha256', 'coreRestorationSha256'].map(key => [key, observed[key]]));
  const snapshot = { contract: CONTRACT, requestId, before, inputSha256, checksSha256: digest(checks),
    sourceSetSha256: digest(sources), selectedMessages: sources.length, confirmation: confirmed, current,
    confirmationStatus: current.bindingSha256 === confirmed.bindingSha256 ? 'current' : 'changed' };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 16 * 1024) throw failure('The complete confirmation metadata exceeds its capacity.',
    413, 'HISTORY_MANIFEST_CONFIRMATION_CURRENT_CAPACITY');
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'native-confirmation-binding-with-final-source-fence', reviewOnly: true, atomicBatch: false,
    semanticAcceptance: false, authenticatedPerson: null, approvalBound: false, mailboxEffects: 0,
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

async function safe(...args) {
  try { return await discover(...args); }
  catch (error) {
    if (typeof error.code === 'string' && error.code.startsWith('HISTORY_MANIFEST_CONFIRMATION_CURRENT_')) throw error;
    if (error.statusCode === 400) throw failure('Use only the original exact selection and native observation fields.',
      400, 'HISTORY_MANIFEST_CONFIRMATION_CURRENT_INVALID');
    if (error.code === 'HISTORY_MANIFEST_CONFIRMATION_UNKNOWN') throw failure('The original confirmation identity is not observed.',
      404, 'HISTORY_MANIFEST_CONFIRMATION_CURRENT_UNKNOWN');
    throw unavailable();
  }
}

module.exports = { discover: safe, CONTRACT };
