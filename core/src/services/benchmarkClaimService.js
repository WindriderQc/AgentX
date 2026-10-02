'use strict';
/**
 * Benchmark Claim Service
 *
 * Owns the lifecycle of benchmark host claims. Extracted from
 * hostPreferenceService.js — that file was over 1.6× the
 * service-file budget and mixed CRUD/pin/warm/health concerns with the
 * benchmark-claim machinery.
 *
 * Responsibilities:
 *   - claimBenchmark / releaseBenchmarkClaim / listBenchmarkClaims
 *   - reapStaleBenchmarkClaims + the periodic reaper interval
 *   - hasActiveBenchmarkClaim (the helper the reconciler in
 *     hostPreferenceService.js still uses to short-circuit pin warming)
 *
 * What stays in hostPreferenceService.js:
 *   - the pin reconciler (`checkAndReloadDefaults`)
 *   - the pin auto-restore grace-period state machine
 *   - pin warm / restore / unload primitives
 *
 * Cross-module calls between the two services are intentionally lazy
 * (`require('./hostPreferenceService')` inside the function bodies) to keep
 * the two-way edge from forming a load-time cycle: the reconciler imports
 * `hasActiveBenchmarkClaim` from this module, while release/reap call
 * `restorePinnedModels` / `getPinnedEntries` from hostPreferenceService.
 *
 * Symbol stability: hostPreferenceService.js re-exports every name listed
 * below so that callers that previously did
 * `hostPreferenceService.releaseBenchmarkClaim(...)` continue to work.
 */

// The lifecycle is split by capability contract into sibling modules; this
// file stays the facade so existing imports keep the same names.
const { hasActiveBenchmarkClaim, listBenchmarkClaims } = require('./benchmarkClaimProjection');
const { claimBenchmark, heartbeatBenchmarkClaim } = require('./benchmarkClaimAcquisition');
const { releaseBenchmarkClaim } = require('./benchmarkClaimRelease');
const {
  restoreClaimsForWorkloadRecovery,
  recoverBenchmarkClaimRelease
} = require('./benchmarkClaimRecovery');
const {
  reapStaleBenchmarkClaims,
  summarizeBenchmarkClaimReaps,
  startBenchmarkClaimReaper,
  stopBenchmarkClaimReaper,
  getBenchmarkClaimReaperIntervalMs
} = require('./benchmarkClaimReaper');

module.exports = {
  hasActiveBenchmarkClaim,
  claimBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  recoverBenchmarkClaimRelease,
  restoreClaimsForWorkloadRecovery,
  listBenchmarkClaims,
  summarizeBenchmarkClaimReaps,
  reapStaleBenchmarkClaims,
  startBenchmarkClaimReaper,
  stopBenchmarkClaimReaper,
  getBenchmarkClaimReaperIntervalMs
};
