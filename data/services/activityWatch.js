'use strict';

/**
 * The one periodic check behind the activity log: who stopped reporting.
 *
 * A silence is the absence of a request, so nothing in a request path can
 * notice it. Every minute this reads Data's own records (collector registries,
 * GPU hosts, external scans) and writes the transitions to the log. It reads
 * no file, calls no other service and changes no inventory row, so it runs
 * with or without DATA_BACKGROUND_JOBS_ENABLED, like the scan reaper it also
 * triggers; it never runs in a test process unless a test calls sweep().
 *
 * Data cannot have heard anyone while it was stopped: silence is counted from
 * the later of the last report and this process's start.
 */

const { log } = require('../utils/logger');
const activityEvents = require('./activityEvents');
const hardwareTelemetry = require('./hardwareTelemetryService');
const storageAgentService = require('./storageAgentService');

const SWEEP_INTERVAL_MS = 60_000;
// Longer than the 90 s "active" window of the registries: a host that reboots
// is not an event, one that stays away is.
const SILENT_AFTER_MS = 5 * 60 * 1000;
const COLLECTOR_REGISTRIES = Object.freeze([
  { kind: 'storage', collection: 'storage_scanners', idField: 'scannerId' },
  { kind: 'network', collection: 'network_scanners', idField: 'scannerId' },
  { kind: 'gpu', collection: 'hardware_collectors', idField: 'collectorId' }
]);
const MAX_ROWS = 200;

let timer = null;
let startedAt = null;

function silentAfterMs(intervalMs) {
  return Math.max(SILENT_AFTER_MS, intervalMs ? hardwareTelemetry.staleAfterMs(intervalMs) : 0);
}

function quietSince(lastReport, bootAt) {
  const last = lastReport ? new Date(lastReport).getTime() : 0;
  return Math.max(Number.isFinite(last) ? last : 0, bootAt.getTime());
}

async function sweepCollectors(db, now, bootAt) {
  let silent = 0;
  for (const { kind, collection, idField } of COLLECTOR_REGISTRIES) {
    const rows = await db.collection(collection).find({}).sort({ lastSeen: -1 }).limit(MAX_ROWS).toArray();
    for (const row of rows) {
      if (!row[idField]) continue;
      if (now.getTime() - quietSince(row.lastSeen, bootAt) <= silentAfterMs(row.intervalMs)) continue;
      const event = await activityEvents.collectorSilent(db, kind, {
        collectorId: row[idField], hostname: row.hostname, lastSeen: row.lastSeen
      }, now);
      if (event) silent += 1;
    }
  }
  return silent;
}

async function sweepGpuHosts(db, now, bootAt) {
  let stale = 0;
  const hosts = await db.collection(hardwareTelemetry.HOSTS).find({}).limit(MAX_ROWS).toArray();
  for (const host of hosts) {
    // A host that never gave a sample has nothing to go stale.
    if (!host.lastSampleAt) continue;
    if (now.getTime() - quietSince(host.lastSampleAt, bootAt) <= silentAfterMs(host.intervalMs)) continue;
    if (await activityEvents.gpuHostStale(db, host, now)) stale += 1;
  }
  return stale;
}

/** One pass. Each part is independent: a failure in one does not skip the others. */
async function sweep(db, now = new Date(), bootAt = startedAt || now) {
  const result = { collectorsSilent: 0, gpuHostsStale: 0, scansExpired: 0 };
  const part = async (name, work) => {
    try { return await work(); }
    catch (error) { log(`[activity watch] ${name} failed: ${error.message}`, 'warn'); return 0; }
  };
  result.collectorsSilent = await part('collectors', () => sweepCollectors(db, now, bootAt));
  result.gpuHostsStale = await part('GPU hosts', () => sweepGpuHosts(db, now, bootAt));
  result.scansExpired = await part('scan reaper', async () => {
    const expired = await storageAgentService.expireStaleScans(db, now);
    return expired.running + expired.queued;
  });
  return result;
}

function start(db, { intervalMs = SWEEP_INTERVAL_MS, env = process.env } = {}) {
  if (timer || env.NODE_ENV === 'test') return false;
  startedAt = new Date();
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await sweep(db); } finally { running = false; }
  }, intervalMs);
  timer.unref?.();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  startedAt = null;
}

module.exports = { SWEEP_INTERVAL_MS, SILENT_AFTER_MS, silentAfterMs, sweep, start, stop };
