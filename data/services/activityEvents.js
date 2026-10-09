'use strict';

/**
 * The facts Data writes to its activity log, one function per fact, called
 * where the fact happens. Each builds a short English sentence and a small
 * `meta`, and none of them throws: a failure is logged and the caller goes on.
 */

const { log } = require('../utils/logger');
const activityLog = require('./activityLog');

const MAX_DEVICE_EVENTS = 25;
const SCAN_COUNT_KEYS = Object.freeze([
  'files_seen', 'files_processed', 'inserted', 'updated', 'upserts', 'stale_removed',
  'directories', 'hashed', 'errors', 'rejected'
]);
// A feed that runs every few seconds may miss a fetch without being down.
const FEED_FAILURES_BEFORE_EVENT = 3;
const SLOW_FEED_INTERVAL_MS = 5 * 60 * 1000;
const feedRuns = new Map(); // feedId -> { failures, state }

async function safely(what, work) {
  try {
    return await work();
  } catch (error) {
    log(`[activity] ${what} failed: ${error.message}`, 'warn');
    return null;
  }
}

function count(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function plural(value, word) {
  return `${count(value)} ${word}${Number(value) === 1 ? '' : 's'}`;
}

function seconds(from, to) {
  const start = from ? new Date(from).getTime() : NaN;
  const end = to ? new Date(to).getTime() : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
}

// --- Storage scans ---

function scanIdentity(scan) {
  const roots = (scan?.config?.roots || scan?.roots || []).map(String).slice(0, 8);
  return {
    scanId: String(scan?._id ?? scan?.scan_id ?? ''),
    source: scan?.config?.source || null,
    external: scan?.config?.external === true,
    roots
  };
}

function scanLabel(identity) {
  return identity.roots.length ? identity.roots.join(', ') : `scan ${identity.scanId}`;
}

function scanQueued(db, scan) {
  return safely('scan queued', () => {
    const identity = scanIdentity(scan);
    return activityLog.record(db, {
      type: 'storage.scan_queued',
      message: `Storage scan of ${scanLabel(identity)} queued for a collector.`,
      meta: identity
    });
  });
}

function scanStarted(db, scan, { scannerId } = {}) {
  return safely('scan started', () => {
    const identity = scanIdentity(scan);
    return activityLog.record(db, {
      type: 'storage.scan_started',
      message: `Storage scan of ${scanLabel(identity)} started${scannerId ? ` by collector ${scannerId}` : ''}.`,
      meta: { ...identity, ...(scannerId ? { scannerId: String(scannerId) } : {}) }
    });
  });
}

function headlineCounts(counts = {}) {
  const headline = {};
  for (const key of SCAN_COUNT_KEYS) {
    if (typeof counts[key] === 'number' && Number.isFinite(counts[key])) headline[key] = counts[key];
  }
  return headline;
}

/** `scan` is the scan document as it ends: status, counts, last_error, dates. */
function scanFinished(db, scan) {
  return safely('scan finished', () => {
    const identity = scanIdentity(scan);
    const outcome = scan.status === 'completed' ? 'complete' : String(scan.status || 'unknown');
    const counts = headlineCounts(scan.counts);
    const files = counts.files_seen ?? counts.files_processed;
    const reason = outcome === 'complete' ? null : (scan.last_error ? String(scan.last_error) : null);
    const facts = [];
    if (files != null) facts.push(`${plural(files, 'file')} seen`);
    if (counts.stale_removed) facts.push(`${plural(counts.stale_removed, 'row')} removed from the index`);
    const detail = outcome === 'complete' || !reason ? facts.join(', ') : reason;
    return activityLog.record(db, {
      type: 'storage.scan_finished',
      severity: outcome === 'complete' ? 'info' : outcome === 'failed' ? 'error' : 'warning',
      message: `Storage scan of ${scanLabel(identity)} ended ${outcome}${detail ? `: ${detail}` : ''}.`,
      meta: {
        ...identity, outcome, reason, counts,
        durationSeconds: seconds(scan.started_at, scan.finished_at)
      }
    });
  });
}

function scanExpired(db, scan) {
  return safely('scan expired', () => {
    const identity = scanIdentity(scan);
    return activityLog.record(db, {
      type: 'storage.scan_expired',
      severity: 'error',
      message: `Storage scan of ${scanLabel(identity)} was failed by the reaper: ${scan.last_error || 'no collector activity'}.`,
      meta: {
        ...identity, outcome: 'failed', reason: scan.last_error || null,
        wasQueued: !scan.started_at, claimedBy: scan.claimed_by || null, counts: headlineCounts(scan.counts)
      }
    });
  });
}

// --- Collectors ---

function collectorKey(kind, collectorId) {
  return `collector:${kind}:${collectorId}`;
}

/**
 * A collector reported. `inserted` says its registry row was created by this
 * report: that is the only "first seen", so a collector registered before the
 * log existed is never announced.
 */
function collectorSeen(db, kind, collectorId, { inserted = false, hostname = '' } = {}) {
  return safely('collector heartbeat', async () => {
    if (!collectorId) return null;
    const previous = await activityLog.setState(db, collectorKey(kind, collectorId), 'active');
    const meta = { kind, collectorId: String(collectorId), hostname: hostname || null };
    if (inserted) {
      return activityLog.record(db, {
        type: 'collector.first_seen',
        message: `The ${kind} collector ${collectorId} reported for the first time.`,
        meta
      });
    }
    if (previous !== 'silent') return null;
    return activityLog.record(db, {
      type: 'collector.back',
      message: `The ${kind} collector ${collectorId} is reporting again.`,
      meta
    });
  });
}

/** Called by the watch for a collector not heard for its silence window. */
function collectorSilent(db, kind, collector, now = new Date()) {
  return safely('collector silence', async () => {
    // Only a collector recorded as reporting can go silent: one that was
    // already away when the log started is neither announced nor, later, "back".
    if (!(await activityLog.moveState(db, collectorKey(kind, collector.collectorId), 'active', 'silent', now))) return null;
    const silentFor = seconds(collector.lastSeen, now);
    return activityLog.record(db, {
      type: 'collector.silent',
      severity: 'warning',
      message: `The ${kind} collector ${collector.collectorId} has not reported for ${Math.round((silentFor || 0) / 60)} minutes.`,
      meta: {
        kind, collectorId: String(collector.collectorId), hostname: collector.hostname || null,
        lastSeen: collector.lastSeen || null, silentForSeconds: silentFor
      }
    });
  });
}

// --- GPU hosts ---

function hostKey(hostId) {
  return `gpu_host:${hostId}`;
}

function gpuHostSampled(db, host) {
  return safely('GPU host sample', async () => {
    const previous = await activityLog.setState(db, hostKey(host.hostId), 'fresh');
    if (previous !== 'stale') return null;
    return activityLog.record(db, {
      type: 'gpu.host_recovered',
      message: `GPU host ${host.name || host.hostId} is sampled again.`,
      meta: { hostId: host.hostId, name: host.name || null, collectorId: host.collectorId || null }
    });
  });
}

function gpuHostStale(db, host, now = new Date()) {
  return safely('GPU host staleness', async () => {
    if (!(await activityLog.moveState(db, hostKey(host.hostId), 'fresh', 'stale', now))) return null;
    const reason = host.lastError ? `: ${host.lastError}` : '';
    return activityLog.record(db, {
      type: 'gpu.host_stale',
      severity: 'warning',
      message: `GPU host ${host.name || host.hostId} has had no successful sample for ${Math.round((seconds(host.lastSampleAt, now) || 0) / 60)} minutes${reason}.`,
      meta: {
        hostId: host.hostId, name: host.name || null, collectorId: host.collectorId || null,
        lastSampleAt: host.lastSampleAt || null, lastError: host.lastError || null,
        consecutiveFailures: host.consecutiveFailures || 0
      }
    });
  });
}

// --- Network devices ---

function deviceMeta(device) {
  return {
    ip: device.ip || null,
    mac: device.mac || null,
    vendor: device.vendor || null,
    hostname: device.hostname || null
  };
}

/** `devices` are the rows a sweep inserted: one event each, or one summary for a large batch. */
function devicesFirstSeen(db, devices, { scanSource } = {}) {
  return safely('new network devices', async () => {
    const list = Array.isArray(devices) ? devices : [];
    if (!list.length) return null;
    if (list.length > MAX_DEVICE_EVENTS) {
      return activityLog.record(db, {
        type: 'network.device_first_seen',
        message: `${count(list.length)} network devices were seen for the first time by ${scanSource || 'a scanner'}.`,
        meta: {
          count: list.length, scanSource: scanSource || null,
          devices: list.slice(0, MAX_DEVICE_EVENTS).map(deviceMeta), devicesOmitted: list.length - MAX_DEVICE_EVENTS
        }
      });
    }
    for (const device of list) {
      const who = [device.hostname, device.vendor].filter(Boolean).join(', ');
      await activityLog.record(db, {
        type: 'network.device_first_seen',
        message: `Network device ${device.ip}${device.mac ? ` (${device.mac})` : ''} seen for the first time${who ? `: ${who}` : ''}.`,
        meta: { count: 1, scanSource: scanSource || null, ...deviceMeta(device) }
      });
    }
    return list.length;
  });
}

// --- Janitor ---

function janitorRunFinished(db, runId) {
  return safely('janitor run', async () => {
    const run = await db.collection('janitor_runs').findOne({ _id: runId });
    if (!run || run.status === 'running') return null;
    const proposed = Array.isArray(run.proposed_actions) ? run.proposed_actions.length : 0;
    const failed = run.status === 'failed';
    return activityLog.record(db, {
      type: 'janitor.run_finished',
      severity: failed ? 'error' : run.status === 'complete' ? 'info' : 'warning',
      message: `Janitor run of profile "${run.profile_name}" ended ${run.status}`
        + `${failed && run.error ? `: ${run.error}` : `: ${plural(proposed, 'proposed action')}`}.`,
      meta: {
        runId: String(run._id), profileId: String(run.profile_id), profileName: run.profile_name,
        status: run.status, scanId: run.scan_id ? String(run.scan_id) : null,
        proposedActions: proposed, proposedActionsOmitted: run.proposed_actions_omitted || 0,
        decisionsRequired: Array.isArray(run.decisions_required) ? run.decisions_required.length : 0,
        error: run.error || null, dedupError: run.dedup_error || null,
        durationSeconds: seconds(run.started_at, run.finished_at)
      }
    });
  });
}

// --- Live feeds ---

/**
 * One feed run ended. Only a change of state is recorded: a feed is "failing"
 * after three failed runs in a row (one for a feed that runs less often than
 * every five minutes), and "recovered" at its next successful run.
 */
function feedRun(db, feed, error) {
  return safely('live feed state', async () => {
    const run = feedRuns.get(feed.id) || { failures: 0, state: null };
    feedRuns.set(feed.id, run);
    run.failures = error ? run.failures + 1 : 0;
    const needed = Number(feed.intervalMs) >= SLOW_FEED_INTERVAL_MS ? 1 : FEED_FAILURES_BEFORE_EVENT;
    const state = error ? (run.failures >= needed ? 'failing' : null) : 'ok';
    // The stored state is consulted only when this process has not reported it yet.
    if (!state || state === run.state) return null;
    const previous = await activityLog.setState(db, `feed:${feed.id}`, state);
    run.state = state;
    const meta = { feedId: feed.id, label: feed.label || feed.id };
    if (state === 'failing' && previous !== 'failing') {
      return activityLog.record(db, {
        type: 'livedata.feed_failing',
        severity: 'warning',
        message: `Live feed ${meta.label} is failing: ${error.message || error}.`,
        meta: { ...meta, error: String(error.message || error), consecutiveFailures: run.failures }
      });
    }
    if (state === 'ok' && previous === 'failing') {
      return activityLog.record(db, {
        type: 'livedata.feed_recovered',
        message: `Live feed ${meta.label} is fetching again.`,
        meta
      });
    }
    return null;
  });
}

// --- MQTT monitor ---

/** `state` is `connected` or `disconnected`; the monitor reports each change once. */
function mqttMonitorState(db, state, { broker, error, everConnected } = {}) {
  return safely('MQTT monitor state', async () => {
    const previous = await activityLog.setState(db, 'mqtt_monitor', state);
    if (previous === state) return null;
    if (state === 'disconnected') {
      return activityLog.record(db, {
        type: 'mqtt.monitor_disconnected',
        severity: 'warning',
        message: everConnected
          ? `The MQTT monitor lost its connection to ${broker || 'the broker'}.`
          : `The MQTT monitor cannot connect to ${broker || 'the broker'}.`,
        meta: { broker: broker || null, error: error || null }
      });
    }
    // A first connection is not a restoration.
    if (previous !== 'disconnected') return null;
    return activityLog.record(db, {
      type: 'mqtt.monitor_connected',
      message: `The MQTT monitor is connected to ${broker || 'the broker'} again.`,
      meta: { broker: broker || null }
    });
  });
}

module.exports = {
  MAX_DEVICE_EVENTS,
  FEED_FAILURES_BEFORE_EVENT,
  scanQueued,
  scanStarted,
  scanFinished,
  scanExpired,
  collectorSeen,
  collectorSilent,
  gpuHostSampled,
  gpuHostStale,
  devicesFirstSeen,
  janitorRunFinished,
  feedRun,
  mqttMonitorState,
  _resetFeedRuns: () => feedRuns.clear()
};
