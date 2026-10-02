'use strict';

// A Core recreate leaves Benchmark's profiler workloads running (#47). Core
// keeps their admissions in Mongo and does not expire them while it restarts,
// so Benchmark must not treat Core briefly refusing connections as a lost
// workload. It keeps working only while the admission Core last confirmed is
// provably unexpired, with a margin: Core still enforces the same TTL, so a
// dead writer is never hidden.

const { OUTBOUND_ERROR_CODES } = require('../../../../shared/outboundHttpExecutor');

const CORE_OUTAGE_MARGIN_MS = 30_000;
const CORE_OUTAGE_RETRY_MS = 5_000;
const UNAVAILABLE_CODES = new Set([OUTBOUND_ERROR_CODES.REQUEST_FAILED, OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED]);
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

// Core did not answer (connection refused or reset, deadline) or a proxy
// reported it down. A Core answer such as 409 is a decision, never an outage.
function isCoreUnavailable(error) {
  if (!error) return false;
  if (Number.isInteger(error.status)) return UNAVAILABLE_STATUSES.has(error.status);
  return UNAVAILABLE_CODES.has(error.code);
}

function expiryMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function withinConfirmedAdmission(confirmedExpiresAt, now = Date.now(), marginMs = CORE_OUTAGE_MARGIN_MS) {
  const expires = expiryMs(confirmedExpiresAt);
  return expires !== null && now < expires - marginMs;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Runs a Core heartbeat, retrying while Core is unavailable and the admission
// it last confirmed is still valid. Any Core answer, or the margin, ends it.
async function heartbeatThroughCoreOutage(heartbeat, {
  confirmedExpiresAt, signal, retryMs = CORE_OUTAGE_RETRY_MS, marginMs = CORE_OUTAGE_MARGIN_MS, onOutage = null
} = {}) {
  for (;;) {
    try {
      return await heartbeat();
    } catch (error) {
      if (!isCoreUnavailable(error) || !withinConfirmedAdmission(confirmedExpiresAt(), Date.now(), marginMs)) throw error;
      onOutage?.(error);
      await sleep(retryMs, signal);
    }
  }
}

module.exports = {
  CORE_OUTAGE_MARGIN_MS,
  CORE_OUTAGE_RETRY_MS,
  heartbeatThroughCoreOutage,
  isCoreUnavailable,
  withinConfirmedAdmission
};
