/**
 * Exact runtime snapshot and benchmark release receipt verification.
 */

const crypto = require('crypto');
const { normalizeModelTag } = require('../../../shared/modelNames');
const { isOllamaPermanentExpiry } = require('../../../shared/ollamaResidency');

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function canonicalRuntimeResident(entry) {
  const expiryMs = entry?.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  return {
    model: entry?.model,
    digest: entry?.digest,
    artifactSize: Number(entry?.artifactSize),
    sizeVram: Number(entry?.sizeVram),
    contextLength: Number(entry?.contextLength),
    keepAlive: Number(entry?.keepAlive),
    expiresAt: Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null,
  };
}

function runtimeSnapshotIdentity(snapshot, residents = snapshot?.residents || []) {
  const canonicalResidents = residents.map(canonicalRuntimeResident)
    .sort((left, right) => left.model.localeCompare(right.model));
  return crypto.createHash('sha256').update(JSON.stringify({
    capturedAt: snapshot?.capturedAt ? new Date(snapshot.capturedAt).toISOString() : null,
    source: snapshot?.source || null,
    exact: snapshot?.exact === true,
    residents: canonicalResidents,
  })).digest('hex');
}

function modelIdentityKey(value) {
  return normalizeModelTag(String(value || '')).toLowerCase();
}

function runtimeResidentComplete(entry, capturedAt) {
  const keepAlive = Number(entry?.keepAlive);
  const expiryMs = entry?.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  const infiniteExpiry = isOllamaPermanentExpiry(entry?.expiresAt, capturedAt);
  return typeof entry?.model === 'string' && entry.model.length > 0
    && typeof entry?.digest === 'string' && entry.digest.length > 0
    && Number.isFinite(Number(entry.artifactSize)) && Number(entry.artifactSize) > 0
    && Number.isFinite(Number(entry.sizeVram)) && Number(entry.sizeVram) >= 0
    && Number.isInteger(Number(entry.contextLength)) && Number(entry.contextLength) > 0
    && (keepAlive === -1 || (Number.isFinite(keepAlive) && keepAlive > 0))
    && Number.isFinite(expiryMs)
    && (keepAlive !== -1 || infiniteExpiry);
}

function exactRuntimeSnapshot(snapshot) {
  const capturedAtMs = Date.parse(snapshot?.capturedAt);
  const residents = snapshot?.residents;
  const residentKeys = Array.isArray(residents)
    ? residents.map(entry => modelIdentityKey(entry?.model))
    : [];
  return snapshot?.exact === true
    && snapshot?.source === 'ollama_ps'
    && Number.isFinite(capturedAtMs)
    && Array.isArray(residents)
    && residents.every(entry => runtimeResidentComplete(entry, capturedAtMs))
    && residentKeys.every(Boolean)
    && new Set(residentKeys).size === residentKeys.length
    && isSha256Hex(snapshot?.identityDigest)
    && snapshot.identityDigest === runtimeSnapshotIdentity(snapshot);
}

function exactBenchmarkReleaseReceipt(result, expected) {
  const receipt = result?.releaseReceipt;
  const snapshot = receipt?.snapshot;
  const verification = receipt?.verification;
  const state = receipt?.state;
  const residents = snapshot?.residents;
  const actualExclusions = Array.isArray(snapshot?.excludedModels)
    ? [...new Set(snapshot.excludedModels.map(String))].sort()
    : null;
  const expectedExclusions = [...new Set(expected.excludedModels.map(String))].sort();
  const expiredModels = Array.isArray(snapshot?.expiredModels)
    ? [...new Set(snapshot.expiredModels.map(String))].sort()
    : null;
  const originalSnapshot = expected.preClaimRuntime;
  const filterEvaluatedAtMs = Date.parse(snapshot?.filterEvaluatedAt);
  const releasedAtMs = Date.parse(receipt?.releasedAt);
  const expectedExcludedKeys = new Set(expectedExclusions.map(modelIdentityKey));
  const afterExplicitExclusions = exactRuntimeSnapshot(originalSnapshot)
    ? originalSnapshot.residents.filter(entry => !expectedExcludedKeys.has(modelIdentityKey(entry.model)))
    : [];
  const expectedExpired = afterExplicitExclusions
    .filter(entry => Number(entry.keepAlive) !== -1 && Date.parse(entry.expiresAt) <= filterEvaluatedAtMs)
    .map(entry => entry.model)
    .sort();
  const expectedResidents = afterExplicitExclusions
    .filter(entry => Number(entry.keepAlive) === -1 || Date.parse(entry.expiresAt) > filterEvaluatedAtMs)
    .map(canonicalRuntimeResident)
    .sort((left, right) => left.model.localeCompare(right.model));
  const actualResidents = Array.isArray(residents)
    ? residents.map(canonicalRuntimeResident).sort((left, right) => left.model.localeCompare(right.model))
    : null;
  const residentsComplete = Array.isArray(residents)
    && residents.every(runtimeResidentComplete)
    && new Set(residents.map(entry => modelIdentityKey(entry.model))).size === residents.length;
  const identityChainExact = isSha256Hex(snapshot?.identityDigest)
    && isSha256Hex(snapshot?.appliedIdentityDigest)
    && exactRuntimeSnapshot(originalSnapshot)
    && snapshot.identityDigest === originalSnapshot.identityDigest
    && snapshot.identityDigest === expected.snapshotIdentity
    && snapshot.capturedAt === new Date(originalSnapshot.capturedAt).toISOString()
    && snapshot.source === originalSnapshot.source
    && Number.isFinite(filterEvaluatedAtMs)
    && filterEvaluatedAtMs >= Date.parse(originalSnapshot.capturedAt)
    && Number.isFinite(releasedAtMs)
    && releasedAtMs >= filterEvaluatedAtMs
    && snapshot.appliedIdentityDigest === runtimeSnapshotIdentity(originalSnapshot, residents)
    && verification?.snapshotIdentity === snapshot.appliedIdentityDigest
    && JSON.stringify(actualResidents) === JSON.stringify(expectedResidents)
    && JSON.stringify(expiredModels) === JSON.stringify(expectedExpired);

  return result?.released === true
    && receipt?.contract === 'agentx.benchmark-claim-release/v1'
    && receipt.hostUrl === expected.hostUrl
    && receipt.batchId === expected.batchId
    && receipt.claimGeneration === expected.claimGeneration
    && snapshot?.exact === true
    && snapshot?.residentCount === residents?.length
    && residentsComplete
    && identityChainExact
    && JSON.stringify(actualExclusions) === JSON.stringify(expectedExclusions)
    && snapshot.excludedModels.length === actualExclusions.length
    && snapshot.expiredModels.length === expiredModels.length
    && Array.isArray(expiredModels)
    && verification?.status === 'ready'
    && verification?.ready === true
    && verification?.verified === true
    && verification?.degraded === false
    && verification?.mode === 'exact_runtime_snapshot'
    && state?.restoredStatus === expected.prevStatus
    && state?.claimCleared === true
    && state?.finalizerCleared === true
    && Number.isFinite(releasedAtMs);
}

module.exports = {
  isSha256Hex,
  canonicalRuntimeResident,
  runtimeSnapshotIdentity,
  exactRuntimeSnapshot,
  exactBenchmarkReleaseReceipt,
};
