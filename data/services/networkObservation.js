'use strict';

/**
 * Temporal semantics for network device observations.
 *
 * A device row carries `status: 'online'` from the last sweep that saw it,
 * but a sweep that stops (a retired vantage, a paused collector) never turns
 * that flag off. The observation state below is therefore derived from the
 * age of `lastSeen` against explicit rules, never from the raw flag alone:
 *
 * - `online`          seen within the online window by a sweep that reported it online;
 * - `recent`          seen within the recent window;
 * - `historical`      seen, but longer ago than the recent window;
 * - `never_confirmed` no `lastSeen` at all.
 *
 * The windows are configuration, not hidden numbers: the online window
 * defaults to twice the collector sweep cadence (sweep 15m → 30m), the recent
 * window to 24h. Override with NETWORK_ONLINE_TTL_MS / NETWORK_RECENT_TTL_MS.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_ONLINE_TTL_MS = 2 * DEFAULT_SWEEP_INTERVAL_MS;
const DEFAULT_RECENT_TTL_MS = 24 * 60 * 60 * 1000;

const OBSERVATION_STATES = Object.freeze({
  ONLINE: 'online',
  RECENT: 'recent',
  HISTORICAL: 'historical',
  NEVER_CONFIRMED: 'never_confirmed'
});

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function observationRules(env = process.env) {
  const onlineTtlMs = positiveMs(env.NETWORK_ONLINE_TTL_MS, DEFAULT_ONLINE_TTL_MS);
  const recentTtlMs = Math.max(positiveMs(env.NETWORK_RECENT_TTL_MS, DEFAULT_RECENT_TTL_MS), onlineTtlMs);
  return Object.freeze({
    onlineTtlMs,
    recentTtlMs,
    sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS,
    source: {
      onlineTtl: env.NETWORK_ONLINE_TTL_MS ? 'NETWORK_ONLINE_TTL_MS' : 'default: 2 × collector sweep (15m)',
      recentTtl: env.NETWORK_RECENT_TTL_MS ? 'NETWORK_RECENT_TTL_MS' : 'default: 24h'
    }
  });
}

function toTime(value) {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function classifyDevice(device, { now = Date.now(), rules = observationRules() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const lastSeenMs = toTime(device?.lastSeen || device?.last_seen);
  const lastSeenAt = lastSeenMs ? new Date(lastSeenMs).toISOString() : null;
  const ageMs = lastSeenMs ? Math.max(0, nowMs - lastSeenMs) : null;
  const reportedOnline = device?.status === 'online' || device?.online === true;
  let state;
  if (ageMs === null) state = OBSERVATION_STATES.NEVER_CONFIRMED;
  else if (reportedOnline && ageMs <= rules.onlineTtlMs) state = OBSERVATION_STATES.ONLINE;
  else if (ageMs <= rules.recentTtlMs) state = OBSERVATION_STATES.RECENT;
  else state = OBSERVATION_STATES.HISTORICAL;
  return {
    state,
    lastSeenAt,
    ageMs,
    reportedStatus: device?.status || null,
    source: device?.scanSource || null,
    lastScanAt: device?.lastScanAt ? new Date(device.lastScanAt).toISOString() : null
  };
}

function classifyDevices(devices, { now = Date.now(), rules = observationRules() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const list = Array.isArray(devices) ? devices : [];
  const counts = { online: 0, recent: 0, historical: 0, never_confirmed: 0 };
  const classified = list.map((device) => {
    const observation = classifyDevice(device, { now: nowMs, rules });
    counts[observation.state] += 1;
    return { ...device, observation };
  });
  return {
    devices: classified,
    summary: {
      referenceTime: new Date(nowMs).toISOString(),
      onlineTtlMs: rules.onlineTtlMs,
      recentTtlMs: rules.recentTtlMs,
      rulesSource: rules.source,
      total: list.length,
      ...counts,
      // The raw flag, kept visible so the difference with `online` is explicit
      // instead of silently replaced.
      reportedOnline: list.filter((device) => device?.status === 'online' || device?.online === true).length
    }
  };
}

module.exports = {
  DEFAULT_ONLINE_TTL_MS,
  DEFAULT_RECENT_TTL_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  OBSERVATION_STATES,
  classifyDevice,
  classifyDevices,
  observationRules
};
