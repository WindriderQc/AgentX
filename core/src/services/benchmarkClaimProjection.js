'use strict';
/**
 * Benchmark claim read side: the active-claim guard used by pin-warming
 * paths and the claimed-host projection. Part of the benchmarkClaimService
 * facade.
 */

const HostPreference = require('../../models/HostPreference');
const { claimSourceOf } = require('./benchmarkClaimShared');

/**
 * True when the host preference currently belongs to an active benchmark
 * batch. Pin-warming code paths (reconciler, /reload endpoint, restorePinnedModels)
 * MUST short-circuit on this check — reloading a pinned model on a claimed
 * host evicts the bench's working set mid-run and forces 30–90s reload
 * cycles per prompt. The check is defense-in-depth: we look at
 * both `status === 'benchmarking'` and a present `benchmarkClaim.batchId`,
 * so a status drift on either side still trips the guard.
 *
 * The only safe bypass is releaseBenchmarkClaim's fenced restore, which
 * proves the exact batch and generation and keeps the claim active until
 * pinned residency has been verified.
 */
function hasActiveBenchmarkClaim(pref) {
  if (!pref) return false;
  if (pref.status === 'benchmarking') return true;
  if (pref.benchmarkClaim && pref.benchmarkClaim.batchId) return true;
  return false;
}

/**
 * List all hosts currently claimed by benchmark batches.
 * @returns {Promise<Array>}
 */
async function listBenchmarkClaims() {
  const prefs = await HostPreference.find({ status: 'benchmarking' }).lean();
  return prefs.map(p => ({
    hostUrl: p.hostUrl,
    hostKey: p.hostKey,
    displayName: p.displayName,
    batchId: p.benchmarkClaim?.batchId,
    claimGeneration: p.benchmarkClaim?.claimGeneration || null,
    prevStatus: p.benchmarkClaim?.prevStatus,
    claimedAt: p.benchmarkClaim?.claimedAt,
    estimatedDurationMs: p.benchmarkClaim?.estimatedDurationMs,
    source: claimSourceOf(p.benchmarkClaim),
    owner: p.benchmarkClaim?.owner || null,
    note: p.benchmarkClaim?.note || null,
    heartbeatAt: p.benchmarkClaim?.heartbeatAt || null,
    heartbeatTtlMs: p.benchmarkClaim?.heartbeatTtlMs || null,
    snapshotExact: p.benchmarkClaim?.preClaimRuntime?.exact === true,
    snapshotResidentCount: Array.isArray(p.benchmarkClaim?.preClaimRuntime?.residents)
      ? p.benchmarkClaim.preClaimRuntime.residents.length
      : null,
    finalizing: Boolean(p.benchmarkClaim?.finalizeToken)
  }));
}

module.exports = {
  hasActiveBenchmarkClaim,
  listBenchmarkClaims
};
