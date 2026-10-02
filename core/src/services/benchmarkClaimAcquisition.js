'use strict';
/**
 * Benchmark claim acquisition and heartbeat renewal. Part of the
 * benchmarkClaimService facade.
 */

const HostPreference = require('../../models/HostPreference');
const {
  CLAIM_SNAPSHOT_WAIT_MS,
  sleep,
  cleanString,
  cleanClaimGeneration,
  normalizeClaimOptions,
  buildBenchmarkClaim,
  claimConflict
} = require('./benchmarkClaimShared');

// ── Claim lifecycle ───────────────────────────────────────────
//
// When a benchmark batch takes over a host, it announces itself here.
// Other consumers (chat, buddy, bounded API clients) read the status and route
// around benchmarking hosts. Claim acquisition is a required startup guard for
// Benchmark work; consumers still enforce the routing exclusion.
//
// Claiming is idempotent per (hostUrl, batchId, claimGeneration): calling
// claimBenchmark twice with the same generation returns the existing claim
// and does NOT overwrite prevStatus. A claim by a *different* owner on a host that
// is already benchmarking is rejected so we don't lose the true prevStatus.

async function ensureHostClaimUniquenessIndex() {
  // Claim atomicity for a previously unseen host depends on the canonical
  // hostUrl uniqueness boundary. Do not rely on background autoIndex timing:
  // every acquisition waits until Mongo confirms the exact unique index.
  await HostPreference.collection.createIndex(
    { hostUrl: 1 },
    { unique: true, name: 'hostUrl_1' }
  );
}

/**
 * Claim a host for a benchmark batch. Stores previous status so we can
 * restore it on release.
 *
 * @param {string} hostUrl
 * @param {string} batchId
 * @param {number} [estimatedDurationMs]
 * @returns {Promise<{ claimed: boolean, reason?: string, pref?: object }>}
 */
async function claimBenchmark(hostUrl, batchId, estimatedDurationMs = null, opts = {}) {
  if (!hostUrl || !batchId) {
    return { claimed: false, reason: 'hostUrl and batchId required' };
  }

  await ensureHostClaimUniquenessIndex();

  const normalizedOptions = normalizeClaimOptions(estimatedDurationMs, opts);

  let existing = await HostPreference.findOne({ hostUrl }).lean();
  if (!existing) {
    try {
      // Seed only the neutral preference. A host preference created by another
      // writer in this window is left untouched, then acquired through the
      // same status-aware CAS as every known host so prevStatus stays exact.
      await HostPreference.updateOne(
        { hostUrl },
        { $setOnInsert: { hostUrl, hostKey: require('./hostPreferenceIdentity').findConfiguredHostByUrl(hostUrl)?.id || 'unconfigured', status: 'idle' } },
        { upsert: true }
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    existing = await HostPreference.findOne({ hostUrl }).lean();
    if (!existing) return claimConflict(existing, batchId);
  }

  // A live session hold owns the host until it is released or idles out; a
  // batch must wait rather than evict an interactive session's model.
  const sessionHoldService = require('./hostSessionHoldService');
  if (sessionHoldService.hasActiveSessionHold(existing)) {
    return {
      claimed: false,
      reason: 'host is held by an active session hold',
      sessionHold: sessionHoldService.publicHold(existing.sessionHold),
      pref: existing
    };
  }

  // Same batch reclaiming — idempotent
  if (existing.status === 'benchmarking' && existing.benchmarkClaim?.batchId === batchId) {
    if (!normalizedOptions.claimGeneration
        || normalizedOptions.claimGeneration !== existing.benchmarkClaim.claimGeneration) {
      return {
        claimed: false,
        reason: 'claim generation no longer owns the host',
        pref: existing
      };
    }
    const existingHasAdmission = Boolean(existing.benchmarkClaim.admissionId
      || existing.benchmarkClaim.admissionGeneration
      || existing.benchmarkClaim.admissionPrincipal);
    const requestHasAdmission = Boolean(normalizedOptions.admissionId
      || normalizedOptions.admissionGeneration
      || normalizedOptions.admissionPrincipal);
    if ((existingHasAdmission || requestHasAdmission)
      && (normalizedOptions.admissionId !== existing.benchmarkClaim.admissionId
        || normalizedOptions.admissionGeneration !== existing.benchmarkClaim.admissionGeneration
        || normalizedOptions.admissionPrincipal !== existing.benchmarkClaim.admissionPrincipal)) {
      return {
        claimed: false,
        reason: 'workload admission proof no longer matches the host claim',
        pref: existing
      };
    }
    // A concurrent retry can observe the claim after the CAS but before its
    // exact runtime snapshot has been attached. It must not receive a usable
    // capability early, nor attempt to tear down the in-progress owner.
    if (existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
      const deadline = Date.now() + CLAIM_SNAPSHOT_WAIT_MS;
      do {
        await sleep(50);
        existing = await HostPreference.findOne({ hostUrl }).lean();
        if (existing?.status !== 'benchmarking'
          || existing?.benchmarkClaim?.batchId !== batchId
          || existing?.benchmarkClaim?.claimGeneration !== normalizedOptions.claimGeneration) {
          return claimConflict(existing, batchId);
        }
        if (existing.benchmarkClaim?.preClaimRuntime?.exact === true) break;
      } while (Date.now() < deadline);
      if (existing.benchmarkClaim?.preClaimRuntime?.exact !== true) {
        return {
          claimed: false,
          reason: 'exact pre-claim runtime snapshot is still unavailable',
          pref: existing
        };
      }
    }
    const set = {
      'benchmarkClaim.heartbeatAt': normalizedOptions.heartbeatAt
    };
    if (normalizedOptions.estimatedDurationMs != null) {
      set['benchmarkClaim.estimatedDurationMs'] = normalizedOptions.estimatedDurationMs;
    }
    if (normalizedOptions.source) set['benchmarkClaim.source'] = normalizedOptions.source;
    if (normalizedOptions.owner) set['benchmarkClaim.owner'] = normalizedOptions.owner;
    if (normalizedOptions.note) set['benchmarkClaim.note'] = normalizedOptions.note;
    if (normalizedOptions.heartbeatTtlMs != null) {
      set['benchmarkClaim.heartbeatTtlMs'] = normalizedOptions.heartbeatTtlMs;
    }

    const updated = await HostPreference.findOneAndUpdate(
      {
        _id: existing._id,
        hostUrl,
        status: 'benchmarking',
        'benchmarkClaim.batchId': batchId,
        'benchmarkClaim.claimGeneration': normalizedOptions.claimGeneration,
        'benchmarkClaim.finalizeToken': null
      },
      { $set: set },
      { new: true }
    ).lean();
    if (updated) {
      return {
        claimed: true,
        batchId,
        claimGeneration: updated.benchmarkClaim.claimGeneration,
        prevStatus: updated.benchmarkClaim.prevStatus,
        snapshotExact: updated.benchmarkClaim.preClaimRuntime?.exact === true,
        snapshotIdentity: updated.benchmarkClaim.preClaimRuntime?.identityDigest || null,
        pref: updated,
        reason: 'already claimed by this batch'
      };
    }
    return claimConflict(await HostPreference.findOne({ hostUrl }).lean(), batchId);
  }

  // Different batch already owns the claim
  if (existing.status === 'benchmarking' && existing.benchmarkClaim?.batchId && existing.benchmarkClaim.batchId !== batchId) {
    return {
      claimed: false,
      reason: `host already claimed by batch ${existing.benchmarkClaim.batchId}`,
      pref: existing
    };
  }

  // Pin restore is disruptive: it may be actively loading the user's pinned
  // model after a previous benchmark released its claim. Do not let a new
  // benchmark claim race that restore, or the old restore can evict the new
  // batch's warmup model after the new claim has started.
  if (existing.status === 'restoring') {
    return {
      claimed: false,
      reason: 'host is restoring pinned models after a previous claim',
      pref: existing
    };
  }

  if (existing.status === 'benchmarking') {
    return {
      claimed: false,
      reason: 'host is benchmarking without a stable claim owner',
      pref: existing
    };
  }

  const prevStatus = existing.status || 'idle';
  const benchmarkClaim = buildBenchmarkClaim(batchId, prevStatus, normalizedOptions);
  const updated = await HostPreference.findOneAndUpdate(
    {
      _id: existing._id,
      hostUrl,
      status: existing.status,
      'benchmarkClaim.batchId': existing.benchmarkClaim?.batchId ?? null
    },
    {
      $set: {
        status: 'benchmarking',
        benchmarkClaim
      }
    },
    { new: true }
  ).lean();

  if (updated?.benchmarkClaim?.batchId === batchId) {
    const exactClaim = {
      batchId,
      claimGeneration: updated.benchmarkClaim.claimGeneration
    };
    let preClaimRuntime;
    try {
      // The claim CAS above fences chat/watchdog traffic. Snapshot only after
      // that fence exists, and do not return ownership to Benchmark until the
      // snapshot is durably bound to this exact generation.
      const hostPrefService = require('./hostPreferenceService');
      preClaimRuntime = await hostPrefService.captureBenchmarkRuntime(hostUrl);
    } catch (error) {
      await HostPreference.findOneAndUpdate(
        {
          _id: updated._id,
          hostUrl,
          status: 'benchmarking',
          'benchmarkClaim.batchId': batchId,
          'benchmarkClaim.claimGeneration': exactClaim.claimGeneration
        },
        { $set: { status: prevStatus, benchmarkClaim: null } },
        { new: true }
      ).lean();
      return {
        claimed: false,
        reason: `exact pre-claim runtime snapshot failed: ${error.message}`,
        pref: await HostPreference.findOne({ hostUrl }).lean()
      };
    }
    const snapshotted = await HostPreference.findOneAndUpdate(
      {
        _id: updated._id,
        hostUrl,
        status: 'benchmarking',
        'benchmarkClaim.batchId': batchId,
        'benchmarkClaim.claimGeneration': exactClaim.claimGeneration
      },
      { $set: { 'benchmarkClaim.preClaimRuntime': preClaimRuntime } },
      { new: true }
    ).lean();
    if (!snapshotted) {
      // A claim without its exact snapshot is unusable. Clear it only when
      // this exact generation still owns the fence; otherwise leave the new
      // owner untouched and report the conflict.
      await HostPreference.findOneAndUpdate(
        {
          _id: updated._id,
          hostUrl,
          status: 'benchmarking',
          'benchmarkClaim.batchId': batchId,
          'benchmarkClaim.claimGeneration': exactClaim.claimGeneration,
          'benchmarkClaim.preClaimRuntime.exact': { $ne: true }
        },
        { $set: { status: prevStatus, benchmarkClaim: null } },
        { new: true }
      ).lean();
      return claimConflict(await HostPreference.findOne({ hostUrl }).lean(), batchId);
    }
    return {
      claimed: true,
      batchId,
      claimGeneration: snapshotted.benchmarkClaim.claimGeneration,
      prevStatus: snapshotted.benchmarkClaim.prevStatus,
      snapshotExact: snapshotted.benchmarkClaim.preClaimRuntime?.exact === true,
      snapshotIdentity: snapshotted.benchmarkClaim.preClaimRuntime?.identityDigest || null,
      pref: snapshotted
    };
  }
  return claimConflict(await HostPreference.findOne({ hostUrl }).lean(), batchId);
}

/**
 * Refresh an active benchmark/manual claim heartbeat.
 *
 * Operators and ad-hoc scout scripts should call this periodically. If it
 * returns heartbeat=false, the caller no longer owns the host and should stop
 * sending model traffic to avoid bypassing AgentX's scheduler signal.
 */
async function heartbeatBenchmarkClaim(hostUrl, batchId, opts = {}) {
  if (!hostUrl || !batchId) {
    return { heartbeat: false, reason: 'hostUrl and batchId required' };
  }
  const claimGeneration = cleanClaimGeneration(opts.claimGeneration ?? opts.claim_generation);
  if (!claimGeneration) {
    return { heartbeat: false, reason: 'claimGeneration is required' };
  }

  const existing = await HostPreference.findOne({ hostUrl }).lean();
  if (!existing) {
    return { heartbeat: false, reason: 'host preference not found' };
  }
  if (!existing.benchmarkClaim?.batchId) {
    return { heartbeat: false, reason: 'host is not claimed', pref: existing };
  }
  if (existing.benchmarkClaim.batchId !== batchId) {
    return {
      heartbeat: false,
      reason: `claim belongs to batch ${existing.benchmarkClaim.batchId}, not ${batchId}`,
      pref: existing
    };
  }
  if (existing.benchmarkClaim.claimGeneration !== claimGeneration) {
    return {
      heartbeat: false,
      reason: 'claim generation no longer owns the host',
      pref: existing
    };
  }
  if (opts.requireAdmissionProof === true
    && (cleanString(opts.admissionId) !== existing.benchmarkClaim.admissionId
      || cleanString(opts.admissionGeneration) !== existing.benchmarkClaim.admissionGeneration
      || cleanString(opts.admissionPrincipal) !== existing.benchmarkClaim.admissionPrincipal)) {
    return {
      heartbeat: false,
      reason: 'workload admission proof no longer matches the host claim',
      pref: existing
    };
  }

  const normalizedOptions = normalizeClaimOptions(opts);
  const set = {
    'benchmarkClaim.heartbeatAt': normalizedOptions.heartbeatAt
  };
  if (normalizedOptions.estimatedDurationMs != null) {
    set['benchmarkClaim.estimatedDurationMs'] = normalizedOptions.estimatedDurationMs;
  }
  if (normalizedOptions.source) set['benchmarkClaim.source'] = normalizedOptions.source;
  if (normalizedOptions.owner) set['benchmarkClaim.owner'] = normalizedOptions.owner;
  if (normalizedOptions.note) set['benchmarkClaim.note'] = normalizedOptions.note;
  if (normalizedOptions.heartbeatTtlMs != null) {
    set['benchmarkClaim.heartbeatTtlMs'] = normalizedOptions.heartbeatTtlMs;
  }

  const updated = await HostPreference.findOneAndUpdate(
    {
      _id: existing._id,
      hostUrl,
      status: 'benchmarking',
      'benchmarkClaim.batchId': batchId,
      'benchmarkClaim.claimGeneration': claimGeneration,
      ...(opts.requireAdmissionProof === true ? {
        'benchmarkClaim.admissionId': cleanString(opts.admissionId),
        'benchmarkClaim.admissionGeneration': cleanString(opts.admissionGeneration),
        'benchmarkClaim.admissionPrincipal': cleanString(opts.admissionPrincipal)
      } : {}),
      'benchmarkClaim.finalizeToken': null
    },
    { $set: set },
    { new: true }
  ).lean();

  if (!updated) {
    const current = await HostPreference.findOne({ hostUrl }).lean();
    return {
      heartbeat: false,
      reason: current?.benchmarkClaim?.batchId
        ? `claim belongs to batch ${current.benchmarkClaim.batchId}, not ${batchId}`
        : 'claim heartbeat update did not match',
      pref: current || undefined
    };
  }
  return {
    heartbeat: true,
    batchId,
    claimGeneration: updated.benchmarkClaim.claimGeneration,
    prevStatus: updated.benchmarkClaim.prevStatus,
    snapshotExact: updated.benchmarkClaim.preClaimRuntime?.exact === true,
    snapshotIdentity: updated.benchmarkClaim.preClaimRuntime?.identityDigest || null,
    pref: updated
  };
}

module.exports = {
  ensureHostClaimUniquenessIndex,
  claimBenchmark,
  heartbeatBenchmarkClaim
};
