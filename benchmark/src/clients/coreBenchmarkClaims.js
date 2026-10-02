/**
 * Core benchmark host claims: acquire, heartbeat, release and discovery.
 */

const crypto = require('crypto');
const logger = require('../../config/logger');
const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS, PIN_RESTORE_TIMEOUT_MS } = require('./coreOperations');
const { claimProofByOwner, workloadAdmissionById, claimOwnerKey } = require('./coreProofState');
const {
  isSha256Hex,
  canonicalRuntimeResident,
  exactRuntimeSnapshot,
  exactBenchmarkReleaseReceipt,
} = require('./coreRuntimeReceipts');

// ── Benchmark Coordination ──────────────────────────────────────────────────
//
// Announce to core that a benchmark batch is taking over a host, so that
// other consumers (chat, buddy, bounded API clients) can route around us while we
// swap models in and out of VRAM. Callers treat claim acquisition as a
// required startup guard; a failed claim must block the batch before warmup.

/**
 * POST /api/nerve-center/host-preferences/:hostUrl/benchmark-claim
 * @param {string} hostUrl
 * @param {string} batchId
 * @param {number} [estimatedDurationMs]
 * @param {Object} [claimOptions]
 * @returns {Promise<{ claimed: boolean, reason?: string, pref?: object }>}
 */
async function claimHostForBenchmark(hostUrl, batchId, estimatedDurationMs = null, claimOptions = {}) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim`;
  const ownerKey = claimOwnerKey(hostUrl, batchId);
  const claimGeneration = claimOptions.claimGeneration
    || claimProofByOwner.get(ownerKey)?.claimGeneration
    || crypto.randomUUID();
  const admission = workloadAdmissionById.get(String(batchId));
  if (!admission?.admissionId || !admission?.generation) {
    const error = new Error('Exact workload admission proof is required before claiming a host');
    error.code = 'WORKLOAD_ADMISSION_REQUIRED';
    throw error;
  }
  claimProofByOwner.set(ownerKey, { claimGeneration });
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CLAIM_ACQUIRE,
      body: JSON.stringify({
        ...claimOptions,
        batchId,
        claimGeneration,
        admissionId: admission.admissionId,
        admissionGeneration: admission.generation,
        estimatedDurationMs
      })
    });
    const result = data?.data;
    if (!result || typeof result !== 'object' || typeof result.claimed !== 'boolean') {
      const error = new Error('Core claim response did not contain an explicit claim decision');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_INVALID';
      throw error;
    }
    const confirmedGeneration = result.claimGeneration || result.pref?.benchmarkClaim?.claimGeneration;
    const confirmedBatchId = result.batchId || result.pref?.benchmarkClaim?.batchId;
    const prevStatus = result.prevStatus || result.pref?.benchmarkClaim?.prevStatus;
    const snapshotExact = result.snapshotExact === true
      || result.pref?.benchmarkClaim?.preClaimRuntime?.exact === true;
    const snapshotIdentity = result.snapshotIdentity
      || result.pref?.benchmarkClaim?.preClaimRuntime?.identityDigest;
    const nestedClaim = result.pref?.benchmarkClaim;
    const preClaimRuntime = nestedClaim?.preClaimRuntime;
    if (result.claimed === true
      && (confirmedBatchId !== batchId || confirmedGeneration !== claimGeneration)) {
      const error = new Error('Core claim receipt did not attest the requested batch and generation');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_MISMATCH';
      throw error;
    }
    if (result.claimed === true && nestedClaim
      && (nestedClaim.batchId !== confirmedBatchId
        || nestedClaim.claimGeneration !== confirmedGeneration
        || nestedClaim.prevStatus !== prevStatus
        || nestedClaim.preClaimRuntime?.exact !== snapshotExact
        || nestedClaim.preClaimRuntime?.identityDigest !== snapshotIdentity)) {
      const error = new Error('Core claim receipt projections disagree');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_MISMATCH';
      throw error;
    }
    if (result.claimed === true
      && (typeof prevStatus !== 'string'
        || !prevStatus
        || !snapshotExact
        || !isSha256Hex(snapshotIdentity)
        || !exactRuntimeSnapshot(preClaimRuntime)
        || preClaimRuntime.identityDigest !== snapshotIdentity)) {
      const error = new Error('Core claim receipt did not attest an exact pre-claim runtime snapshot');
      error.code = 'BENCHMARK_CLAIM_RECEIPT_MISMATCH';
      throw error;
    }
    if (result.claimed === true) {
      claimProofByOwner.set(ownerKey, {
        claimGeneration,
        prevStatus,
        snapshotIdentity,
        preClaimRuntime: {
          capturedAt: new Date(preClaimRuntime.capturedAt).toISOString(),
          source: preClaimRuntime.source,
          exact: true,
          identityDigest: preClaimRuntime.identityDigest,
          residents: preClaimRuntime.residents.map(canonicalRuntimeResident),
        },
      });
    } else claimProofByOwner.delete(ownerKey);
    return result;
  } catch (err) {
    // 409 Conflict = already claimed — surface without throwing
    if (err.status === 409) {
      logger.warn('Benchmark claim conflict — host already claimed', {
        hostUrl, batchId, error: err.message
      });
      claimProofByOwner.delete(ownerKey);
      return { claimed: false, reason: err.message };
    }
    // The request may have reached Core even when its response was lost.
    // Cleanup is fenced by the locally generated UUID, so it can never clear
    // another owner or a replacement generation.
    if (err.code !== 'OUTBOUND_REQUEST_TOO_LARGE') {
      try {
        const cleanup = await releaseBenchmarkClaim(hostUrl, batchId);
        if (cleanup?.released !== true) {
          const cleanupError = new Error(cleanup?.reason || 'Ambiguous claim cleanup was not verified');
          cleanupError.code = 'BENCHMARK_CLAIM_CLEANUP_UNVERIFIED';
          err.cleanupError = cleanupError;
          err.retainAdmission = true;
          throw err;
        }
      } catch (cleanupError) {
        if (cleanupError === err) throw err;
        err.cleanupError = cleanupError;
        err.retainAdmission = true;
        throw err;
      }
    }
    claimProofByOwner.delete(ownerKey);
    throw err;
  }
}

async function heartbeatBenchmarkClaim(hostUrl, batchId, estimatedDurationMs = null, claimOptions = {}) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(batchId)}/heartbeat`;
  const proof = claimProofByOwner.get(claimOwnerKey(hostUrl, batchId));
  const admission = workloadAdmissionById.get(String(batchId));
  if (!admission?.admissionId || !admission?.generation) {
    return { heartbeat: false, reason: 'exact workload admission proof missing' };
  }
  try {
    const data = await coreRequest(path, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CLAIM_HEARTBEAT,
      body: JSON.stringify({
        claimGeneration: proof?.claimGeneration || null,
        admissionId: admission.admissionId,
        admissionGeneration: admission.generation,
        estimatedDurationMs,
        source: claimOptions.source || 'benchmark',
        owner: claimOptions.owner || 'agentx-benchmark'
      })
    });
    const result = data.data;
    const exact = result?.heartbeat === true
      && result.batchId === batchId
      && result.claimGeneration === proof?.claimGeneration
      && result.prevStatus === proof?.prevStatus
      && result.snapshotExact === true
      && result.snapshotIdentity === proof?.snapshotIdentity;
    if (!exact) {
      return { heartbeat: false, reason: result?.reason || 'Core benchmark heartbeat receipt is invalid' };
    }
    return result;
  } catch (err) {
    if (err.status === 409) return { heartbeat: false, reason: err.message };
    throw err;
  }
}

/**
 * DELETE /api/nerve-center/host-preferences/:hostUrl/benchmark-claim/:batchId
 * @param {string} hostUrl
 * @param {string} batchId
 * @returns {Promise<{ released: boolean, reason?: string }>}
 */
async function releaseBenchmarkClaim(hostUrl, batchId, options = {}) {
  const path = `/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(batchId)}`;
  const ownerKey = claimOwnerKey(hostUrl, batchId);
  const proof = claimProofByOwner.get(ownerKey);
  const admission = workloadAdmissionById.get(String(batchId));
  if (!admission?.admissionId || !admission?.generation) {
    return { released: false, reason: 'exact workload admission proof missing' };
  }
  const excludedModels = Array.isArray(options.excludedModels) ? options.excludedModels : [];
  const releaseBody = {
      claimGeneration: proof?.claimGeneration || null,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      ...(excludedModels.length > 0
        ? { excludedModels }
        : {})
  };
  const requestRelease = async () => {
    const data = await coreRequest(path, {
      method: 'DELETE',
      operationId: CORE_OPERATIONS.CLAIM_RELEASE,
      timeout: PIN_RESTORE_TIMEOUT_MS,
      body: JSON.stringify(releaseBody)
    });
    return data?.data;
  };
  let result;
  try {
    result = await requestRelease();
  } catch (releaseError) {
    // A transport failure or 5xx after Core's terminal CAS is ambiguous. Ask
    // the same authenticated authority for the durable exact receipt before
    // deciding whether to retry or retain the local fence for recovery.
    try {
      const recovery = await coreRequest(`${path}/release-receipt`, {
        method: 'POST',
        operationId: CORE_OPERATIONS.CLAIM_RELEASE_RECOVERY,
        body: JSON.stringify({
          claimGeneration: proof?.claimGeneration || null,
          admissionId: admission.admissionId,
          admissionGeneration: admission.generation
        })
      });
      const recovered = recovery?.data;
      if (recovered?.released === true) result = recovered;
      else if (recovered?.retryable === true && recovered?.finalizing !== true) result = await requestRelease();
      else throw releaseError;
    } catch (recoveryError) {
      if (recoveryError !== releaseError) releaseError.recoveryError = recoveryError;
      throw releaseError;
    }
  }
  if (!result || typeof result !== 'object' || typeof result.released !== 'boolean') {
    const error = new Error('Core release response did not contain an explicit release decision');
    error.code = 'BENCHMARK_RELEASE_RECEIPT_INVALID';
    throw error;
  }
  if (result.released === true && !exactBenchmarkReleaseReceipt(result, {
    hostUrl,
    batchId,
    claimGeneration: proof?.claimGeneration || null,
    prevStatus: proof?.prevStatus || null,
    snapshotIdentity: proof?.snapshotIdentity || null,
    preClaimRuntime: proof?.preClaimRuntime || null,
    excludedModels
  })) {
    return {
      released: false,
      reason: 'Core benchmark release receipt is invalid',
      releaseReceipt: result.releaseReceipt || null
    };
  }
  if (result.released === true) claimProofByOwner.delete(ownerKey);
  return result;
}

function getBenchmarkClaimIdentity(hostUrl, batchId) {
  const claimGeneration = claimProofByOwner.get(claimOwnerKey(hostUrl, batchId))?.claimGeneration;
  const admission = workloadAdmissionById.get(String(batchId || ''));
  if (!claimGeneration || !admission?.admissionId || !admission?.generation) return null;
  return {
    claimBatchId: batchId,
    claimGeneration,
    workloadAdmissionId: admission.admissionId,
    workloadGeneration: admission.generation
  };
}

/**
 * GET /api/nerve-center/host-preferences/benchmark-claims/active
 * List all hosts currently claimed by benchmark batches.
 * @returns {Promise<Array<{hostUrl, hostKey, batchId, prevStatus, claimedAt, estimatedDurationMs}>>}
 */
async function getBenchmarkClaims() {
  const data = await coreRequest('/api/nerve-center/host-preferences/benchmark-claims/active', {
    method: 'GET',
    operationId: CORE_OPERATIONS.CLAIMS_ACTIVE,
  });
  const claims = data?.data?.claims || [];
  // Discovery is not capability acquisition. Never import claim generations
  // from this operator-visible list into the local proof map.
  return claims;
}

module.exports = {
  claimHostForBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  getBenchmarkClaimIdentity,
  getBenchmarkClaims,
};
