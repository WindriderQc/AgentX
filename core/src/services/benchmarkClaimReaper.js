'use strict';
/**
 * Stale benchmark claim reaper and its periodic scheduler. Part of the
 * benchmarkClaimService facade.
 */

const HostPreference = require('../../models/HostPreference');
const logger = require('../../config/logger');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');
const { claimSourceOf, shouldAskBenchmarkService } = require('./benchmarkClaimShared');
const { releaseBenchmarkClaim } = require('./benchmarkClaimRelease');

let benchmarkClaimReaperInterval = null;
let benchmarkClaimReaperIntervalMs = parseInt(process.env.BENCHMARK_CLAIM_REAP_INTERVAL_MS, 10) || 300_000;
const TERMINAL_BENCHMARK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'stopped']);

// ── Reaper scheduler ──────────────────────────────────────────

function startBenchmarkClaimReaper() {
  if (benchmarkClaimReaperInterval) return;
  benchmarkClaimReaperInterval = setInterval(() => {
    reapStaleBenchmarkClaims().catch(err => {
      logger.warn(`[HostPreference] Benchmark claim reaper error: ${err.message}`);
    });
  }, benchmarkClaimReaperIntervalMs);
  logger.info(`[HostPreference] Benchmark claim reaper started (interval: ${benchmarkClaimReaperIntervalMs / 1000}s)`);
}

function stopBenchmarkClaimReaper() {
  if (benchmarkClaimReaperInterval) {
    clearInterval(benchmarkClaimReaperInterval);
    benchmarkClaimReaperInterval = null;
    logger.info('[HostPreference] Benchmark claim reaper stopped');
  }
}

function getBenchmarkClaimReaperIntervalMs() {
  return benchmarkClaimReaperIntervalMs;
}

/**
 * Reap benchmark claims that outlived their estimated duration (×grace factor)
 * or that have no estimatedDurationMs and exceeded the hard cap. Used as a
 * safety net for batches that crash between claim and release — without this,
 * HostPreference.status could stay 'benchmarking' indefinitely.
 *
 * @param {object} [opts]
 * @param {number} [opts.graceFactor=1.5]       - Multiplier on estimatedDurationMs before a claim is considered stale.
 * @param {number} [opts.hardCapMs=7200000]     - Upper bound on claim age when estimatedDurationMs is missing (2h).
 * @returns {Promise<{ reaped: Array, now: string }>}
 */
async function reapStaleBenchmarkClaims(opts = {}) {
  const rawGraceFactor = opts.graceFactor == null ? 1.5 : Number(opts.graceFactor);
  const rawHardCapMs = opts.hardCapMs == null ? (2 * 60 * 60 * 1000) : Number(opts.hardCapMs);
  if (!Number.isFinite(rawGraceFactor) || rawGraceFactor <= 0 || rawGraceFactor > 10
    || !Number.isFinite(rawHardCapMs) || rawHardCapMs < 1_000 || rawHardCapMs > 24 * 60 * 60 * 1000) {
    const error = new Error('graceFactor must be > 0 and <= 10; hardCapMs must be between 1000 and 86400000');
    error.code = 'BENCHMARK_REAPER_OPTIONS_INVALID';
    throw error;
  }
  const graceFactor = rawGraceFactor;
  const hardCapMs = Math.round(rawHardCapMs);
  const now = Date.now();

  const claims = await HostPreference.find({ status: 'benchmarking' }).lean();
  const reaped = [];

  for (const pref of claims) {
    const claim = pref.benchmarkClaim || {};
    if (claim.admissionId && claim.admissionGeneration && claim.admissionPrincipal) {
      const runtimeCoordinationService = require('./runtimeCoordinationService');
      const quarantined = await runtimeCoordinationService.isWorkloadRecoveryRequired({
        id: claim.admissionId,
        generation: claim.admissionGeneration,
        principal: claim.admissionPrincipal
      });
      // A recovery quarantine is durable precisely because ordinary TTL and
      // claim reapers cannot expose the host after the originating process
      // dies. Only the fenced recovery owner may resolve it.
      if (quarantined) continue;
    }
    const claimedAt = claim.claimedAt ? new Date(claim.claimedAt).getTime() : 0;
    if (!claimedAt) continue; // unexpectedly missing timestamp — leave alone
    const est = Number(claim.estimatedDurationMs) || 0;
    const maxAgeMs = est > 0 ? Math.round(est * graceFactor) : hardCapMs;
    const ageMs = now - claimedAt;
    const heartbeatAt = claim.heartbeatAt ? new Date(claim.heartbeatAt).getTime() : claimedAt;
    const heartbeatTtlMs = Number(claim.heartbeatTtlMs) || 0;
    const source = claimSourceOf(claim);
    let staleReason = null;

    if (heartbeatTtlMs > 0 && heartbeatAt > 0 && now - heartbeatAt > heartbeatTtlMs) {
      staleReason = 'claim heartbeat expired';
    }

    if (!staleReason && claim.batchId && shouldAskBenchmarkService(claim)) {
      try {
        const batch = await getBenchmarkServiceClient().getBatch(claim.batchId);
        const batchStatus = String(batch?.status || '').toLowerCase();
        const judgeStatus = String(batch?.judge_status || '').toLowerCase();
        if (TERMINAL_BENCHMARK_STATUSES.has(batchStatus) && (!judgeStatus || TERMINAL_BENCHMARK_STATUSES.has(judgeStatus))) {
          staleReason = `benchmark batch ${batchStatus}${judgeStatus ? ` / judge ${judgeStatus}` : ''}`;
        }
      } catch (err) {
        logger.warn('[hostPreferenceService] benchmark batch status check failed', {
          hostUrl: pref.hostUrl,
          batchId: claim.batchId,
          source,
          error: err.message
        });
      }
    }

    const idleAgeMs = now - Math.max(claimedAt, heartbeatAt || 0);
    if (!staleReason && idleAgeMs > maxAgeMs) {
      staleReason = 'claim age exceeded max age';
    }
    if (!staleReason) continue;

    const result = await releaseBenchmarkClaim(pref.hostUrl, claim.batchId, {
      claimGeneration: claim.claimGeneration,
      allowLegacyMissingGeneration: true,
      expectedClaimedAt: claim.claimedAt,
      expectedHeartbeatAt: claim.heartbeatAt || null
    });
    const pinRestored = result.pinRestore?.verified === true;
    reaped.push({
      hostUrl: pref.hostUrl,
      batchId: claim.batchId,
      source,
      claimedAt: claim.claimedAt,
      heartbeatAt: claim.heartbeatAt || null,
      ageMs,
      maxAgeMs,
      released: result.released,
      reason: result.reason || null,
      staleReason,
      pinRestored
    });
  }

  const { released: releasedReaps, refused: failedReaps } = summarizeBenchmarkClaimReaps(reaped);
  if (releasedReaps.length > 0) {
    logger.warn('[hostPreferenceService] released stale benchmark claims', {
      count: releasedReaps.length,
      details: releasedReaps.map(result => ({
        hostUrl: result.hostUrl,
        batchId: result.batchId,
        ageMinutes: Math.round(result.ageMs / 60000)
      }))
    });
  }
  if (failedReaps.length > 0) {
    logger.warn('[hostPreferenceService] stale benchmark claims remain active', {
      count: failedReaps.length,
      details: failedReaps.map(result => ({
        hostUrl: result.hostUrl,
        batchId: result.batchId,
        reason: result.reason
      }))
    });
  }

  return { reaped, now: new Date(now).toISOString() };
}

function summarizeBenchmarkClaimReaps(reaped = []) {
  const results = Array.isArray(reaped) ? reaped : [];
  return {
    released: results.filter(result => result?.released === true),
    refused: results.filter(result => result?.released !== true)
  };
}

module.exports = {
  reapStaleBenchmarkClaims,
  summarizeBenchmarkClaimReaps,
  startBenchmarkClaimReaper,
  stopBenchmarkClaimReaper,
  getBenchmarkClaimReaperIntervalMs
};
