'use strict';

/**
 * Runtime quarantine watch — observe-only.
 *
 * A held admission that only an operator can release used to be silent: on
 * A Profiler run once lost its claim after 30 s while its workload
 * went to UNKNOWN recovery, and Nestor was refused on that host for twenty
 * minutes before anyone looked. This scan finds those states once a minute
 * and raises `runtime-recovery-quarantine`. It never releases or changes
 * anything; the alert resolves as stale once the state is gone.
 */

const Runtime = require('../../models/RuntimeCoordination');
const HostPreference = require('../../models/HostPreference');
const logger = require('../../config/logger');

// An owner that misses its heartbeat this long is gone, not just late.
const EXPIRED_GRACE_MS = 60_000;
const SCAN_INTERVAL_MS = 60_000;
let interval = null;

function expiredFor(item, now) {
  const expiresAt = new Date(item?.expiresAt).getTime();
  return Number.isFinite(expiresAt) ? now - expiresAt : 0;
}

function findQuarantines(runtime, prefs, now = Date.now()) {
  const found = [];
  if (runtime?.maintenance?.state === 'UNKNOWN') {
    found.push({ host: 'maintenance', holder: runtime.maintenance.requestId || runtime.maintenance.leaseId,
      kind: `maintenance:${runtime.maintenance.scope || 'unknown'}`, failureCode: 'maintenance_unknown',
      reason: runtime.maintenance.unknownReason, since: runtime.maintenance.unknownAt });
  }
  for (const item of runtime?.workloads || []) {
    const unknown = item.recoveryState === 'UNKNOWN';
    if (!unknown && expiredFor(item, now) < EXPIRED_GRACE_MS) continue;
    for (const host of item.hosts || []) {
      found.push({ host, holder: item.workloadId || item.requestId, kind: item.kind,
        failureCode: unknown ? 'workload_recovery_unknown' : 'workload_owner_gone',
        reason: item.recoveryReceipt?.reason || item.recoveryReceipt?.event || null,
        since: unknown ? item.recoveryArmedAt : item.expiresAt });
    }
  }
  for (const item of runtime?.inferences || []) {
    const notActive = item.state && item.state !== 'ACTIVE';
    if (!notActive && expiredFor(item, now) < EXPIRED_GRACE_MS) continue;
    found.push({ host: item.host, holder: item.requestId, kind: `inference:${item.kind}`,
      failureCode: notActive ? 'inference_recovery_unknown' : 'inference_owner_gone',
      reason: item.model, since: item.expiresAt });
  }
  // The claim heartbeat and finalizer both match status 'benchmarking'; a
  // claim under any other status can neither renew nor release itself.
  for (const pref of prefs || []) {
    const claim = pref.benchmarkClaim;
    if (!claim?.batchId || pref.status === 'benchmarking') continue;
    found.push({ host: pref.hostUrl, hostKey: pref.hostKey, holder: claim.batchId, kind: claim.source || 'benchmark-claim',
      failureCode: 'claim_status_overwritten', reason: `host status ${pref.status || 'unset'}`, since: claim.claimedAt });
  }
  return found;
}

async function scan(now = Date.now()) {
  const [runtime, prefs] = await Promise.all([
    Runtime.findById('runtime').lean(),
    HostPreference.find({ 'benchmarkClaim.batchId': { $ne: null } }).lean()
  ]);
  const found = findQuarantines(runtime, prefs, now);
  const { observeRuntimeQuarantine } = require('./laneObservabilityService');
  for (const item of found) await observeRuntimeQuarantine(item);
  if (found.length) logger.warn('[RuntimeQuarantineWatch] runtime held for operator recovery', {
    holders: found.map(item => `${item.failureCode}:${item.holder}@${item.host}`)
  });
  return found;
}

function start() {
  if (interval) return interval;
  const run = () => scan().catch(error => logger.warn('[RuntimeQuarantineWatch] scan failed (non-fatal)', { error: error.message }));
  interval = setInterval(run, SCAN_INTERVAL_MS);
  interval.unref?.();
  return interval;
}

function stop() {
  if (interval) clearInterval(interval);
  interval = null;
}

module.exports = { findQuarantines, scan, start, stop, EXPIRED_GRACE_MS };
