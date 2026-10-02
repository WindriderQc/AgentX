'use strict';
/**
 * Benchmark claim recovery: workload-recovery host restoration and
 * release-receipt recovery. Part of the benchmarkClaimService facade.
 */

const HostPreference = require('../../models/HostPreference');
const { cleanClaimGeneration } = require('./benchmarkClaimShared');
const { releaseBenchmarkClaim } = require('./benchmarkClaimRelease');

async function restoreClaimsForWorkloadRecovery({
  recoveryId,
  recoveryGeneration,
  principal,
  ownerId,
  excludedModelsByHost = {}
} = {}) {
  const runtimeCoordinationService = require('./runtimeCoordinationService');
  const ownership = await runtimeCoordinationService.assertWorkloadRecovery({
    recoveryId,
    recoveryGeneration,
    principal,
    ownerId
  });
  if (ownership.owned !== true) {
    return { restored: false, reason: ownership.reason || 'recovery quarantine ownership required', details: [] };
  }
  // Authority reconciliation verifies its database compensation before restoring
  // the host. Both recovery phases still retain the same exclusive quarantine.
  if (!['UNKNOWN', 'VERIFIED'].includes(ownership.recoveryState)) {
    return { restored: false, reason: 'recovery quarantine must be UNKNOWN or VERIFIED before host restoration', details: [] };
  }
  const preferences = await HostPreference.find({
    'benchmarkClaim.admissionId': ownership.admissionId,
    'benchmarkClaim.admissionGeneration': ownership.generation,
    'benchmarkClaim.admissionPrincipal': principal,
    'benchmarkClaim.batchId': ownership.workloadId
  }).lean();
  const details = [];
  for (const pref of preferences) {
    const claim = pref.benchmarkClaim;
    const result = await releaseBenchmarkClaim(pref.hostUrl, claim.batchId, {
      claimGeneration: claim.claimGeneration,
      admissionId: ownership.admissionId,
      admissionGeneration: ownership.generation,
      admissionPrincipal: principal,
      requireAdmissionProof: true,
      recoveryOwnership: {
        recoveryId,
        recoveryGeneration,
        principal,
        ownerId
      },
      excludedModels: Array.isArray(excludedModelsByHost?.[pref.hostUrl])
        ? excludedModelsByHost[pref.hostUrl]
        : []
    });
    details.push({ hostUrl: pref.hostUrl, ...result });
    if (result.released !== true) {
      return { restored: false, reason: result.reason || `host restore failed for ${pref.hostUrl}`, details };
    }
  }
  return {
    restored: true,
    admissionId: ownership.admissionId,
    workloadId: ownership.workloadId,
    recoveryId,
    recoveryGeneration,
    recoveryOwnerId: ownership.recoveryOwnerId || null,
    details
  };
}

async function recoverBenchmarkClaimRelease(hostUrl, batchId, opts = {}) {
  const claimGeneration = cleanClaimGeneration(opts.claimGeneration ?? opts.claim_generation);
  if (!hostUrl || !batchId || !claimGeneration) {
    return { recovered: false, released: false, reason: 'hostUrl, batchId and claimGeneration are required' };
  }
  const existing = await HostPreference.findOne({ hostUrl })
    .select('+lastBenchmarkReleaseReceipt')
    .lean();
  if (!existing) return { recovered: false, released: false, reason: 'host preference not found' };
  const receipt = existing.lastBenchmarkReleaseReceipt;
  if (receipt?.contract === 'agentx.benchmark-claim-release/v1'
    && receipt.hostUrl === hostUrl
    && receipt.batchId === batchId
    && receipt.claimGeneration === claimGeneration
    && receipt.state?.claimCleared === true
    && receipt.state?.finalizerCleared === true) {
    return {
      recovered: true,
      released: true,
      releaseReceipt: receipt,
      pinRestore: receipt.verification,
      runtimeRestore: receipt.verification
    };
  }
  const claim = existing.benchmarkClaim;
  if (claim?.batchId === batchId && claim?.claimGeneration === claimGeneration) {
    return {
      recovered: true,
      released: false,
      retryable: !claim.finalizeToken,
      finalizing: Boolean(claim.finalizeToken),
      reason: claim.finalizeToken
        ? 'exact claim release is still finalizing'
        : 'exact claim remains active and can be released again'
    };
  }
  return {
    recovered: false,
    released: false,
    retryable: false,
    reason: claim?.batchId ? 'host is owned by another claim' : 'no matching release receipt or active claim'
  };
}

module.exports = {
  restoreClaimsForWorkloadRecovery,
  recoverBenchmarkClaimRelease
};
