'use strict';

// The record's update time can change after a pin or runtime operation. It is
// neither the declaration time of these notes nor a measurement timestamp.
function hostPreferenceDeclarations(pref) {
  return {
    kind: 'operator_notes', source: 'host_preferences', freshness: 'unverified',
    declaredBy: null, declaredAt: null, recordUpdatedAt: pref?.updatedAt || null,
    tags: pref?.tags || [], vramReservedMiB: pref?.vramReservedMiB || 0
  };
}

function persistedHostState(pref) {
  return {
    source: 'host_preferences', freshness: 'unverified', observedAt: null,
    recordUpdatedAt: pref?.updatedAt || null, status: pref?.status || null,
    loadedModel: pref?.loadedModel || null,
    loadedModels: pref?.loadedModels?.length ? pref.loadedModels : (pref?.loadedModel ? [pref.loadedModel] : [])
  };
}

/**
 * Return the capability-free HostPreference shape that may cross a public or
 * operator read boundary. Coordination generations, admission identities,
 * finalizer tokens, exact runtime snapshots, and prior release receipts are
 * bearer evidence and must only be returned by authenticated coordination
 * endpoints.
 */
function projectHostPreferenceForRead(pref) {
  if (!pref) return pref;
  const source = typeof pref.toObject === 'function' ? pref.toObject() : pref;
  const {
    lastBenchmarkReleaseReceipt: _releaseReceipt,
    ...safePref
  } = source;
  safePref.declaredMetadata = hostPreferenceDeclarations(source);
  safePref.persistedState = persistedHostState(source);
  if (!safePref.benchmarkClaim) return safePref;
  const claim = safePref.benchmarkClaim;
  return {
    ...safePref,
    benchmarkClaim: {
      batchId: claim.batchId || null,
      prevStatus: claim.prevStatus || null,
      claimedAt: claim.claimedAt || null,
      estimatedDurationMs: claim.estimatedDurationMs || null,
      source: claim.source || null,
      owner: claim.owner || null,
      note: claim.note || null,
      heartbeatAt: claim.heartbeatAt || null,
      heartbeatTtlMs: claim.heartbeatTtlMs || null,
      snapshotExact: claim.preClaimRuntime?.exact === true,
      snapshotResidentCount: Array.isArray(claim.preClaimRuntime?.residents)
        ? claim.preClaimRuntime.residents.length
        : null,
      finalizing: Boolean(claim.finalizeToken)
    }
  };
}

function projectHostPreferencesForRead(preferences) {
  return Array.isArray(preferences)
    ? preferences.map(projectHostPreferenceForRead)
    : [];
}

module.exports = {
  hostPreferenceDeclarations,
  persistedHostState,
  projectHostPreferenceForRead,
  projectHostPreferencesForRead
};
