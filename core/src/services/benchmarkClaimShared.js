'use strict';
/**
 * Benchmark claim shared primitives: constants, option normalization and
 * claim-shape helpers used by acquisition, heartbeat, release and reaper.
 * Part of the benchmarkClaimService facade.
 */

const crypto = require('crypto');

const MANUAL_CLAIM_SOURCE = 'manual';
const BENCHMARK_CLAIM_SOURCE = 'benchmark';

// Hard cap on the estimated-duration stored with a claim. The reaper uses
// 1.5× estimate as its stale threshold — without a cap, an over-eager
// estimate (e.g., 5h for a 15-min batch) would let a crashed batch lock a
// host for 8+ hours. 2h ceiling matches the reaper's no-estimate hard cap.
const CLAIM_DURATION_CAP_MS = 2 * 60 * 60 * 1000;
const CLAIM_FINALIZE_TTL_MS = 30 * 60 * 1000;
const CLAIM_FINALIZE_HEARTBEAT_MS = Math.max(
  1_000,
  Math.min(CLAIM_FINALIZE_TTL_MS / 3, Number(process.env.BENCHMARK_CLAIM_FINALIZE_HEARTBEAT_MS) || 60_000)
);
const CLAIM_SNAPSHOT_WAIT_MS = Math.max(
  5_000,
  (Number(process.env.BENCHMARK_CLAIM_DRAIN_TIMEOUT_MS) || 30_000) + 5_000
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMongoObjectIdLike(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanClaimGeneration(value) {
  const normalized = cleanString(value);
  return normalized && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function sanitizeEstimate(estimatedDurationMs) {
  const n = positiveInteger(estimatedDurationMs);
  return n ? Math.min(n, CLAIM_DURATION_CAP_MS) : null;
}

function inferClaimSource(batchId, source = null) {
  const explicit = cleanString(source);
  if (explicit) return explicit;
  return isMongoObjectIdLike(batchId) ? BENCHMARK_CLAIM_SOURCE : MANUAL_CLAIM_SOURCE;
}

function normalizeClaimOptions(estimatedDurationMs, opts = {}) {
  if (estimatedDurationMs && typeof estimatedDurationMs === 'object' && !Array.isArray(estimatedDurationMs)) {
    opts = estimatedDurationMs;
    estimatedDurationMs = opts.estimatedDurationMs ?? opts.estimated_duration_ms ?? null;
  }

  return {
    estimatedDurationMs: sanitizeEstimate(estimatedDurationMs),
    source: cleanString(opts.source),
    owner: cleanString(opts.owner),
    note: cleanString(opts.note),
    admissionId: cleanString(opts.admissionId),
    admissionGeneration: cleanString(opts.admissionGeneration),
    admissionPrincipal: cleanString(opts.admissionPrincipal),
    claimGeneration: cleanClaimGeneration(opts.claimGeneration ?? opts.claim_generation),
    heartbeatTtlMs: positiveInteger(opts.heartbeatTtlMs ?? opts.heartbeat_ttl_ms),
    heartbeatAt: opts.heartbeatAt ? new Date(opts.heartbeatAt) : new Date()
  };
}

function buildBenchmarkClaim(batchId, prevStatus, normalizedOptions) {
  return {
    batchId,
    claimGeneration: normalizedOptions.claimGeneration || crypto.randomUUID(),
    admissionId: normalizedOptions.admissionId,
    admissionGeneration: normalizedOptions.admissionGeneration,
    admissionPrincipal: normalizedOptions.admissionPrincipal,
    prevStatus,
    claimedAt: new Date(),
    estimatedDurationMs: normalizedOptions.estimatedDurationMs,
    source: inferClaimSource(batchId, normalizedOptions.source),
    owner: normalizedOptions.owner,
    note: normalizedOptions.note,
    heartbeatAt: normalizedOptions.heartbeatAt,
    heartbeatTtlMs: normalizedOptions.heartbeatTtlMs,
    finalizeToken: null,
    finalizingAt: null
  };
}

function claimSourceOf(claim) {
  return inferClaimSource(claim?.batchId, claim?.source);
}

function shouldAskBenchmarkService(claim) {
  return claimSourceOf(claim) === BENCHMARK_CLAIM_SOURCE;
}

function claimConflict(existing, batchId) {
  if (!existing) {
    return { claimed: false, reason: 'host preference changed while acquiring claim' };
  }
  if (existing.status === 'restoring') {
    return {
      claimed: false,
      reason: 'host is restoring pinned models after a previous claim',
      pref: existing
    };
  }
  if (existing.benchmarkClaim?.batchId && existing.benchmarkClaim.batchId !== batchId) {
    return {
      claimed: false,
      reason: `host already claimed by batch ${existing.benchmarkClaim.batchId}`,
      pref: existing
    };
  }
  return {
    claimed: false,
    reason: 'host preference changed while acquiring claim',
    pref: existing
  };
}

module.exports = {
  MANUAL_CLAIM_SOURCE,
  BENCHMARK_CLAIM_SOURCE,
  CLAIM_DURATION_CAP_MS,
  CLAIM_FINALIZE_TTL_MS,
  CLAIM_FINALIZE_HEARTBEAT_MS,
  CLAIM_SNAPSHOT_WAIT_MS,
  sleep,
  isMongoObjectIdLike,
  cleanString,
  cleanClaimGeneration,
  positiveInteger,
  sanitizeEstimate,
  inferClaimSource,
  normalizeClaimOptions,
  buildBenchmarkClaim,
  claimSourceOf,
  shouldAskBenchmarkService,
  claimConflict
};
