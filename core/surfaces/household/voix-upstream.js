'use strict';

// Primary/backup choice for the stateless VoiX routes (transcription, synthesis,
// voice catalog, player script). A powered-off voice host times out instead of
// refusing, so asking it on every request would add the full timeout to each
// turn: a cached /health probe decides instead. Native sessions, the media vault
// and configuration stay on the primary, which owns that state.

const PROBE_PERIOD_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;
const RETRY_STATUSES = new Set([502, 503, 504]);

const cleanBase = (value) => String(value || '').trim().replace(/\/+$/, '');

function createVoixUpstream({
  primaryUrl = () => process.env.VOIX_BASE_URL,
  fallbackUrl = () => process.env.VOIX_FALLBACK_URL,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  periodMs = PROBE_PERIOD_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS
} = {}) {
  let probe = { base: '', healthy: null, checkedAt: 0 };
  let inflight = null;

  const bases = () => {
    const primary = cleanBase(primaryUrl());
    const fallback = cleanBase(fallbackUrl());
    return { primary, fallback: fallback && fallback !== primary ? fallback : '' };
  };

  async function runProbe(base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    let healthy = false;
    try {
      const response = await fetchImpl(`${base}/health`, { signal: controller.signal });
      healthy = response.ok;
      response.body?.cancel?.().catch?.(() => {});
    } catch { healthy = false; } finally { clearTimeout(timer); }
    probe = { base, healthy, checkedAt: now() };
    return healthy;
  }

  function refresh(base) {
    if (!inflight) inflight = runProbe(base).finally(() => { inflight = null; });
    return inflight;
  }

  // Fresh result: use it. Stale result: use it and refresh in the background.
  // No result yet: wait for the probe, itself bounded by probeTimeoutMs.
  async function primaryHealthy() {
    const { primary, fallback } = bases();
    if (!primary || !fallback) return true;
    if (probe.base !== primary || probe.healthy === null) return refresh(primary);
    if (now() - probe.checkedAt >= periodMs) refresh(primary).catch(() => {});
    return probe.healthy;
  }

  function markPrimaryDown() {
    const { primary } = bases();
    probe = { base: primary, healthy: false, checkedAt: now() };
  }

  async function choose() {
    const { primary, fallback } = bases();
    if (!primary && !fallback) {
      throw Object.assign(new Error('VoiX is not configured for this instance'), { status: 503, code: 'VOIX_NOT_CONFIGURED' });
    }
    if (!primary) return 'fallback';
    return fallback && !(await primaryHealthy()) ? 'fallback' : 'primary';
  }

  async function urlFor(pathname) {
    const upstream = await choose();
    return { url: `${bases()[upstream]}${pathname}`, upstream };
  }

  // attempt(url) performs one request and resolves to a fetch Response. A
  // primary network error or 502/503/504 is retried once on the backup; 4xx
  // answers are the caller's to handle. canRetry() lets a caller veto the
  // retry, e.g. when its browser already disconnected.
  async function send(pathname, attempt, { canRetry = () => true } = {}) {
    const first = await urlFor(pathname);
    const backup = bases().fallback;
    const retryable = first.upstream === 'primary' && Boolean(backup);
    let response;
    try {
      response = await attempt(first.url);
    } catch (error) {
      if (!retryable || !canRetry(error)) throw error;
      markPrimaryDown();
      return { response: await attempt(`${backup}${pathname}`), upstream: 'fallback' };
    }
    if (retryable && RETRY_STATUSES.has(response.status) && canRetry(null)) {
      response.body?.cancel?.().catch?.(() => {});
      markPrimaryDown();
      return { response: await attempt(`${backup}${pathname}`), upstream: 'fallback' };
    }
    return { response, upstream: first.upstream };
  }

  async function status() {
    const { primary, fallback } = bases();
    const active = primary || fallback ? await choose() : 'none';
    return {
      primaryConfigured: Boolean(primary),
      fallbackConfigured: Boolean(fallback),
      active,
      primaryHealthy: primary && fallback ? probe.healthy : null,
      checkedAt: primary && fallback && probe.checkedAt ? new Date(probe.checkedAt).toISOString() : null
    };
  }

  return { urlFor, send, status, primaryHealthy, markPrimaryDown };
}

module.exports = { createVoixUpstream, PROBE_PERIOD_MS, PROBE_TIMEOUT_MS, RETRY_STATUSES };
