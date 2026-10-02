'use strict';
/**
 * Fenced benchmark claim release: finalizer fence heartbeat, exact runtime
 * restore and the durable release receipt. Part of the benchmarkClaimService
 * facade.
 */

const HostPreference = require('../../models/HostPreference');
const crypto = require('crypto');
const {
  observeClaimReleaseFailure,
  observePinRestoreFailure
} = require('./laneObservabilityService');
const {
  CLAIM_FINALIZE_TTL_MS,
  CLAIM_FINALIZE_HEARTBEAT_MS,
  CLAIM_SNAPSHOT_WAIT_MS,
  sleep,
  cleanString,
  cleanClaimGeneration
} = require('./benchmarkClaimShared');

function startFinalizeFenceHeartbeat({ preferenceId, hostUrl, batchId, claimGeneration, finalizeToken }) {
  const controller = new AbortController();
  let stopped = false;
  let pending = Promise.resolve();
  const assertActive = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : Object.assign(new Error('Benchmark finalizer fence was lost'), { code: 'BENCHMARK_CLAIM_LOST' });
    }
  };
  const refresh = async () => {
    if (stopped || controller.signal.aborted) return;
    const refreshedAt = new Date();
    const result = await HostPreference.updateOne(
      {
        _id: preferenceId,
        hostUrl,
        status: 'benchmarking',
        'benchmarkClaim.batchId': batchId,
        'benchmarkClaim.claimGeneration': claimGeneration,
        'benchmarkClaim.finalizeToken': finalizeToken
      },
      { $set: {
        'benchmarkClaim.heartbeatAt': refreshedAt,
        'benchmarkClaim.heartbeatTtlMs': CLAIM_FINALIZE_TTL_MS,
        'benchmarkClaim.finalizingAt': refreshedAt
      } }
    );
    const matched = Number(result?.matchedCount ?? result?.modifiedCount);
    if (Number.isFinite(matched) && matched !== 1) {
      const error = new Error('Benchmark finalizer fence heartbeat was rejected');
      error.code = 'BENCHMARK_CLAIM_LOST';
      throw error;
    }
  };
  const tick = () => {
    pending = pending.then(refresh).catch(error => {
      if (!controller.signal.aborted) controller.abort(error);
    });
  };
  const timer = setInterval(tick, CLAIM_FINALIZE_HEARTBEAT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    assertActive,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      assertActive();
    }
  };
}

/**
 * Release a benchmark claim, restoring prevStatus.
 *
 * @param {string} hostUrl
 * @param {string} batchId - only releases if current claim matches this batch
 * @returns {Promise<{ released: boolean, reason?: string, pref?: object }>}
 */
async function releaseBenchmarkClaim(hostUrl, batchId, opts = {}) {
  // opts.skipPinRestore — internal recovery/testing escape hatch. Normal
  // callers and the reaper restore under the exact claim before releasing.
  const { skipPinRestore = false, allowLegacyMissingGeneration = false } = opts;
  const rawClaimGeneration = opts.claimGeneration ?? opts.claim_generation;
  const claimGeneration = cleanClaimGeneration(rawClaimGeneration);
  const legacyMissingGeneration = allowLegacyMissingGeneration === true
    && (rawClaimGeneration === null || rawClaimGeneration === undefined);
  const expectedLegacyClaimedAt = legacyMissingGeneration && opts.expectedClaimedAt
    ? new Date(opts.expectedClaimedAt)
    : null;
  const expectedHeartbeatAt = opts.expectedHeartbeatAt === null
    ? null
    : opts.expectedHeartbeatAt
      ? new Date(opts.expectedHeartbeatAt)
      : undefined;
  const excludedModels = [...new Set((Array.isArray(opts.excludedModels) ? opts.excludedModels : [])
    .map(cleanString)
    .filter(Boolean))];
  if (!hostUrl || !batchId) {
    return { released: false, reason: 'hostUrl and batchId required' };
  }
  if (!claimGeneration && !legacyMissingGeneration) {
    return { released: false, reason: 'claimGeneration is required' };
  }
  if (legacyMissingGeneration
    && (!expectedLegacyClaimedAt || !Number.isFinite(expectedLegacyClaimedAt.getTime()))) {
    return { released: false, reason: 'legacy claim expectedClaimedAt is required' };
  }
  if (expectedHeartbeatAt instanceof Date && !Number.isFinite(expectedHeartbeatAt.getTime())) {
    return { released: false, reason: 'expectedHeartbeatAt is invalid' };
  }

  let existing = await HostPreference.findOne({ hostUrl }).lean();
  if (!existing) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'host preference not found',
      source: 'benchmark-claim-release'
    });
    return { released: false, reason: 'host preference not found' };
  }

  // Only release if the claim still belongs to this batch — prevents a
  // late-returning batch from clobbering a newer claim.
  if (!existing.benchmarkClaim?.batchId) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'host is not claimed',
      source: 'benchmark-claim-release'
    });
    return { released: false, reason: 'host is not claimed', pref: existing };
  }
  if (existing.benchmarkClaim.batchId !== batchId) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'claim belongs to another owner',
      source: 'benchmark-claim-release'
    });
    return {
      released: false,
      reason: `claim belongs to batch ${existing.benchmarkClaim.batchId}, not ${batchId}`,
      pref: existing
    };
  }
  const storedClaimGeneration = existing.benchmarkClaim.claimGeneration ?? null;
  if ((legacyMissingGeneration && storedClaimGeneration !== null)
    || (!legacyMissingGeneration && storedClaimGeneration !== claimGeneration)) {
    return {
      released: false,
      reason: 'claim generation no longer owns the host',
      pref: existing
    };
  }
  if (legacyMissingGeneration
    && new Date(existing.benchmarkClaim.claimedAt).getTime() !== expectedLegacyClaimedAt.getTime()) {
    return {
      released: false,
      reason: 'legacy claim changed since reaper scan',
      pref: existing
    };
  }
  if (opts.requireAdmissionProof === true
    && (cleanString(opts.admissionId) !== existing.benchmarkClaim.admissionId
      || cleanString(opts.admissionGeneration) !== existing.benchmarkClaim.admissionGeneration
      || cleanString(opts.admissionPrincipal) !== existing.benchmarkClaim.admissionPrincipal)) {
    return {
      released: false,
      reason: 'workload admission proof no longer matches the host claim',
      pref: existing
    };
  }
  if (expectedHeartbeatAt !== undefined) {
    const currentHeartbeat = existing.benchmarkClaim.heartbeatAt
      ? new Date(existing.benchmarkClaim.heartbeatAt).getTime()
      : null;
    const expectedHeartbeat = expectedHeartbeatAt
      ? expectedHeartbeatAt.getTime()
      : null;
    if (currentHeartbeat !== expectedHeartbeat) {
      return {
        released: false,
        reason: 'claim heartbeat changed since reaper scan',
        pref: existing
      };
    }
  }

  // A failed exact restore deliberately leaves its finalizer token in place so
  // neither the reaper nor an ordinary retry can race an ambiguous mutation.
  // The sole takeover path is an adopted, live workload-recovery quarantine.
  // Revalidate that durable ownership here (not only in the route caller), then
  // CAS the old token directly to a new token below so there is no unfenced gap.
  let quarantinedFinalizeToken = null;
  if (existing.benchmarkClaim?.finalizeToken) {
    const recovery = opts.recoveryOwnership;
    if (recovery) {
      const runtimeCoordinationService = require('./runtimeCoordinationService');
      const ownership = await runtimeCoordinationService.assertWorkloadRecovery({
        recoveryId: recovery.recoveryId,
        recoveryGeneration: recovery.recoveryGeneration,
        principal: recovery.principal,
        ownerId: recovery.ownerId
      });
      const exactRecoveryOwner = ownership.owned === true
        && ['UNKNOWN', 'VERIFIED'].includes(ownership.recoveryState)
        && ownership.admissionId === existing.benchmarkClaim.admissionId
        && ownership.generation === existing.benchmarkClaim.admissionGeneration
        && ownership.principal === existing.benchmarkClaim.admissionPrincipal
        && ownership.workloadId === existing.benchmarkClaim.batchId;
      if (!exactRecoveryOwner) {
        return {
          released: false,
          reason: ownership.reason || 'exact UNKNOWN or VERIFIED recovery quarantine does not own finalizer takeover',
          pref: existing
        };
      }
      quarantinedFinalizeToken = existing.benchmarkClaim.finalizeToken;
    }
  }

  if (!skipPinRestore && !legacyMissingGeneration
    && existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
    const deadline = Date.now() + CLAIM_SNAPSHOT_WAIT_MS;
    do {
      await sleep(50);
      const current = await HostPreference.findOne({ hostUrl }).lean();
      const sameClaim = current?.status === 'benchmarking'
        && current?.benchmarkClaim?.batchId === batchId
        && (legacyMissingGeneration
          ? (current?.benchmarkClaim?.claimGeneration ?? null) === null
            && new Date(current?.benchmarkClaim?.claimedAt).getTime() === expectedLegacyClaimedAt.getTime()
          : current?.benchmarkClaim?.claimGeneration === claimGeneration);
      if (!sameClaim) {
        return {
          released: false,
          reason: 'claim changed while awaiting exact pre-claim snapshot',
          pref: current || undefined
        };
      }
      existing = current;
      if (existing.benchmarkClaim?.preClaimRuntime?.exact === true) break;
    } while (Date.now() < deadline);
    if (existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
      return {
        released: false,
        reason: 'exact pre-claim runtime snapshot remained unavailable',
        pref: existing
      };
    }
  }

  // Fenced finalization: restore and verify the exact observable pre-claim
  // Ollama runtime while this
  // exact batch+generation still owns the host. Renew the heartbeat from
  // inside Core so the reaper cannot clear the claim during a cold reload.
  // If restoration fails, keep the claim in place and fail closed; exposing
  // the host before its pins are verified would race chat/watchdog traffic.
  let pinRestore = null;
  let restoredSnapshot = null;
  let expiredModels = [];
  let filterEvaluatedAt = null;
  const hostPrefService = require('./hostPreferenceService');
  const finalizeToken = crypto.randomUUID();
  const finalizingFilter = {
    _id: existing._id,
    hostUrl,
    status: 'benchmarking',
    'benchmarkClaim.batchId': batchId,
    'benchmarkClaim.claimGeneration': legacyMissingGeneration ? null : claimGeneration,
    'benchmarkClaim.finalizeToken': quarantinedFinalizeToken
  };
  if (legacyMissingGeneration) finalizingFilter['benchmarkClaim.claimedAt'] = expectedLegacyClaimedAt;
  if (expectedHeartbeatAt !== undefined) finalizingFilter['benchmarkClaim.heartbeatAt'] = expectedHeartbeatAt;
  const renewed = await HostPreference.findOneAndUpdate(
    finalizingFilter,
    { $set: {
      'benchmarkClaim.heartbeatAt': new Date(),
      'benchmarkClaim.heartbeatTtlMs': CLAIM_FINALIZE_TTL_MS,
      'benchmarkClaim.finalizeToken': finalizeToken,
      'benchmarkClaim.finalizingAt': new Date()
    } },
    { new: true }
  ).lean();
  if (!renewed) {
    const current = await HostPreference.findOne({ hostUrl }).lean();
    const currentOwnerChanged = current?.benchmarkClaim?.batchId
      && current.benchmarkClaim.batchId !== batchId;
    return {
      released: false,
      reason: currentOwnerChanged
        ? `claim belongs to batch ${current.benchmarkClaim.batchId}, not ${batchId}`
        : expectedHeartbeatAt !== undefined
        && (current?.benchmarkClaim?.heartbeatAt
          ? new Date(current.benchmarkClaim.heartbeatAt).getTime()
          : null) !== (expectedHeartbeatAt ? expectedHeartbeatAt.getTime() : null)
        ? 'claim heartbeat changed since reaper scan'
        : 'claim changed or another finalizer owns runtime restoration',
      pref: current || undefined
    };
  }
  const finalizerHeartbeat = startFinalizeFenceHeartbeat({
    preferenceId: renewed._id,
    hostUrl,
    batchId,
    claimGeneration: legacyMissingGeneration ? null : claimGeneration,
    finalizeToken
  });

  if (!skipPinRestore) {
    const originalSnapshot = renewed.benchmarkClaim?.preClaimRuntime;
    const afterExplicitExclusions = (originalSnapshot?.residents || []).filter(entry =>
      !excludedModels.some(model => hostPrefService.pinNamesMatch(model, entry.model)));
    // Freeze the TTL decision once and attest that instant in the durable
    // receipt. Consumers can then independently recompute which residents
    // were naturally expired instead of trusting Core's projected arrays.
    filterEvaluatedAt = new Date();
    const applicableResidents = hostPrefService.desiredBenchmarkResidents({
      ...originalSnapshot,
      residents: afterExplicitExclusions
    }, filterEvaluatedAt.getTime());
    expiredModels = afterExplicitExclusions
      .filter(entry => !applicableResidents.includes(entry))
      .map(entry => entry.model);
    let restoreSnapshot = {
      ...originalSnapshot,
      residents: applicableResidents
    };
    if (excludedModels.length > 0 || expiredModels.length > 0) {
      restoreSnapshot = {
        ...restoreSnapshot,
        identityDigest: hostPrefService.benchmarkRuntimeSnapshotIdentity(restoreSnapshot)
      };
    }
    restoredSnapshot = restoreSnapshot;
    try {
      pinRestore = await hostPrefService.restoreBenchmarkRuntime(
        hostUrl,
        restoreSnapshot,
        {
          batchId,
          claimGeneration: legacyMissingGeneration ? null : claimGeneration,
          finalizeToken,
          snapshotAlreadyFiltered: true,
          signal: finalizerHeartbeat.signal,
          assertAuthorityActive: finalizerHeartbeat.assertActive
        }
      );
      finalizerHeartbeat.assertActive();
    } catch (err) {
      pinRestore = {
        host: hostUrl,
        status: 'error',
        verified: false,
        degraded: err.code === 'BENCHMARK_RUNTIME_SNAPSHOT_MISSING',
        error: err.message
      };
    }
    if (pinRestore?.status !== 'ready'
      || pinRestore?.verified !== true
      || pinRestore?.degraded !== false
      || pinRestore?.mode !== 'exact_runtime_snapshot'
      || pinRestore?.snapshotIdentity !== restoreSnapshot.identityDigest) {
      const error = pinRestore?.error || 'Pre-claim runtime restore did not verify';
      void observePinRestoreFailure({
        host: hostUrl,
        models: (renewed.benchmarkClaim?.preClaimRuntime?.residents || []).map(entry => entry.model),
        batchId,
        error,
        source: 'benchmark-claim-fenced-release'
      });
      await finalizerHeartbeat.stop().catch(() => {});
      return {
        released: false,
        reason: `fenced runtime restore failed: ${error}`,
        finalizationQuarantined: true,
        pinRestore,
        runtimeRestore: pinRestore,
        pref: await HostPreference.findOne({ hostUrl }).lean()
      };
    }
  }

  await finalizerHeartbeat.stop();

  const restoreStatus = renewed.benchmarkClaim?.prevStatus || 'idle';
  const releaseFilter = {
    _id: existing._id,
    hostUrl,
    status: 'benchmarking',
    'benchmarkClaim.batchId': batchId,
    'benchmarkClaim.claimGeneration': legacyMissingGeneration ? null : claimGeneration,
    'benchmarkClaim.finalizeToken': finalizeToken
  };
  // The reaper is the only caller allowed to drain a pre-generation claim.
  // Bind its exact timestamp as well as batch and null/missing generation so a
  // stale read can never clear a replacement UUID-backed claim.
  if (legacyMissingGeneration) {
    releaseFilter['benchmarkClaim.claimedAt'] = expectedLegacyClaimedAt;
  }

  const releaseReceipt = {
    contract: 'agentx.benchmark-claim-release/v1',
    hostUrl,
    batchId,
    claimGeneration: legacyMissingGeneration ? null : claimGeneration,
    snapshot: {
      identityDigest: renewed.benchmarkClaim?.preClaimRuntime?.identityDigest || null,
      appliedIdentityDigest: restoredSnapshot?.identityDigest || null,
      exact: renewed.benchmarkClaim?.preClaimRuntime?.exact === true,
      capturedAt: renewed.benchmarkClaim?.preClaimRuntime?.capturedAt || null,
      source: renewed.benchmarkClaim?.preClaimRuntime?.source || null,
      filterEvaluatedAt,
      residentCount: restoredSnapshot?.residents?.length || 0,
      residents: (restoredSnapshot?.residents || []).map(entry => ({
        model: entry.model,
        digest: entry.digest,
        artifactSize: Number(entry.artifactSize),
        sizeVram: Number(entry.sizeVram),
        contextLength: Number(entry.contextLength),
        keepAlive: Number(entry.keepAlive),
        expiresAt: entry.expiresAt || null
      })),
      excludedModels,
      expiredModels
    },
    verification: {
      status: pinRestore?.status || (skipPinRestore ? 'skipped' : 'unknown'),
      ready: pinRestore?.status === 'ready',
      verified: pinRestore?.verified === true,
      degraded: pinRestore?.degraded !== false,
      mode: pinRestore?.mode || null,
      snapshotIdentity: pinRestore?.snapshotIdentity || null
    },
    state: {
      restoredStatus: restoreStatus,
      claimCleared: true,
      finalizerCleared: true
    },
    releasedAt: new Date()
  };

  let updated;
  try {
    updated = await HostPreference.findOneAndUpdate(
      releaseFilter,
      {
        $set: {
          status: restoreStatus,
          lastBenchmarkReleaseReceipt: releaseReceipt,
          benchmarkClaim: {
            batchId: null,
            claimGeneration: null,
            admissionId: null,
            admissionGeneration: null,
            admissionPrincipal: null,
            prevStatus: null,
            claimedAt: null,
            estimatedDurationMs: null,
            source: null,
            owner: null,
            note: null,
            heartbeatAt: null,
            heartbeatTtlMs: null,
            finalizeToken: null,
            finalizingAt: null,
            preClaimRuntime: null
          }
        }
      },
      { new: true }
    ).lean();
  } catch (err) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: err.message,
      source: 'benchmark-claim-release'
    });
    throw err;
  }
  if (!updated) {
    void observeClaimReleaseFailure({
      host: hostUrl,
      batchId,
      error: 'claim release update did not match',
      source: 'benchmark-claim-release'
    });
    const current = await HostPreference.findOne({ hostUrl }).lean();
    return {
      released: false,
      reason: current?.benchmarkClaim?.batchId
        ? `claim belongs to batch ${current.benchmarkClaim.batchId}, not ${batchId}`
        : 'claim release update did not match',
      pref: current || undefined
    };
  }

  const claimCleared = !updated.benchmarkClaim?.batchId
    && !updated.benchmarkClaim?.claimGeneration
    && !updated.benchmarkClaim?.preClaimRuntime;
  const finalizerCleared = !updated.benchmarkClaim?.finalizeToken
    && !updated.benchmarkClaim?.finalizingAt;
  const verifiedRestore = pinRestore
    ? pinRestore.status === 'ready'
      && pinRestore.verified === true
      && pinRestore.degraded === false
      && pinRestore.mode === 'exact_runtime_snapshot'
    : false;
  if ((!skipPinRestore && !verifiedRestore) || !claimCleared || !finalizerCleared) {
    return {
      released: false,
      reason: 'final benchmark release receipt did not verify restored runtime and cleared fences',
      pref: updated,
      pinRestore,
      runtimeRestore: pinRestore,
      releaseReceipt
    };
  }

  return {
    released: true,
    pref: updated,
    pinRestore,
    runtimeRestore: pinRestore,
    releaseReceipt,
    legacyClaimRecovered: legacyMissingGeneration
  };
}

module.exports = {
  startFinalizeFenceHeartbeat,
  releaseBenchmarkClaim
};
