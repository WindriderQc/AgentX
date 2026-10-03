'use strict';

// Short-lived shared effective routing snapshot (#258). A runtime bridge asks
// for the snapshot on every model call, and building it reads each routed
// model's live catalog digest, Benchmark host profile and registry entry.
//
// - Callers asking for the same options within the fresh window share one
//   deep-frozen snapshot; concurrent callers share one build.
// - Past the fresh window and inside the stale window, a caller gets the held
//   snapshot at once while one background refresh replaces it for the next
//   caller. A failed refresh keeps the held snapshot until it leaves the stale
//   window. The exact-artifact view is never served stale: its qualification
//   verdict gates the Pipeline alias and the runtime configuration export.
// - A caller that leaves only detaches itself. A build callers wait for stops
//   opening host reads (#189) once every one of them has left, and an
//   abandoned build is never kept. A background refresh belongs to no caller.
// - Within the fresh window, one artifact identity resolution answers every
//   read of the same exact model on the same host, across tasks and option sets.
// - A router configuration change (its version) or a host preference or pin
//   write (`invalidateRoutingSnapshots`) discards what is held, fresh or stale.
// Admission, busy checks, runtime coordination and model enforcement during
// inference read live state; only these snapshot and identity reads are shared.

const logger = require('../../../config/logger');
const { buildEffectiveRoutingSnapshot } = require('./effectiveRoutingSnapshot');

const DEFAULT_TTL_MS = 5000;
const DEFAULT_STALE_MS = 300000;

let generation = 0;

/** Called by host preference and pin writers: nothing held before is reused. */
function invalidateRoutingSnapshots() {
  generation += 1;
}

function windowMs(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Fresh window, `AGENTX_ROUTING_SNAPSHOT_CACHE_MS`; unset or invalid: 5000. 0 disables the cache. */
function snapshotCacheTtlMs(raw = process.env.AGENTX_ROUTING_SNAPSHOT_CACHE_MS) {
  return windowMs(raw, DEFAULT_TTL_MS);
}

/** Stale window, `AGENTX_ROUTING_SNAPSHOT_STALE_MS`, from the build; unset or invalid: 300000. 0: never stale. */
function snapshotStaleMs(raw = process.env.AGENTX_ROUTING_SNAPSHOT_STALE_MS) {
  return windowMs(raw, DEFAULT_STALE_MS);
}

function abortReason(signal) {
  return signal.reason || new Error('routing snapshot aborted');
}

function createRoutingSnapshotCache({
  build, routingVersion = null, ttlMs = snapshotCacheTtlMs, staleMs = snapshotStaleMs, now = Date.now
}) {
  const slots = new Map(); // option set → { held, pending }
  const identities = new Map();

  function currentVersion() {
    try {
      return routingVersion ? routingVersion() : null;
    } catch {
      // A version that cannot be read matches nothing, so nothing is reused.
      return {};
    }
  }

  // Built under the router configuration and the writes that still stand.
  function current(entry, version) {
    return entry.generation === generation && entry.version === version;
  }

  // One resolution per exact model and host, owned by the build that opened it.
  function identityMemo(signal, ttl) {
    const usable = (entry) => entry.generation === generation && !entry.signal.aborted
      && (entry.expiresAt === null || entry.expiresAt > now());
    return (key, resolve) => {
      const held = identities.get(key);
      if (held && usable(held)) {
        // A read cut short by its own callers' departure is not evidence.
        return held.promise.then((identity) => (held.signal.aborted ? resolve() : identity), () => resolve());
      }
      const entry = { generation, signal, expiresAt: null, promise: null };
      entry.promise = Promise.resolve(resolve()).then((identity) => (identity ? Object.freeze(identity) : identity));
      identities.set(key, entry);
      const settle = (keep) => {
        if (identities.get(key) !== entry) return;
        if (keep && usable(entry)) entry.expiresAt = now() + ttl;
        else identities.delete(key);
      };
      entry.promise.then(() => settle(true), () => settle(false));
      return entry.promise;
    };
  }

  function start(slot, options, version, fresh, background) {
    const controller = new AbortController();
    const entry = { generation, version, controller, background, waiting: 0, settled: false, promise: null };
    entry.promise = build({
      includeCatalog: options.includeCatalog !== false,
      includeArtifactIdentity: options.includeArtifactIdentity === true,
      signal: controller.signal,
      identityMemo: identityMemo(controller.signal, fresh)
    });
    slot.pending = entry;
    const settle = (built, result) => {
      entry.settled = true;
      // A newer build took this option set over: its result is the one kept.
      if (slot.pending !== entry) return;
      slot.pending = null;
      if (!built) {
        // The callers of a build they wait for receive its error; a refresh has none.
        if (background) {
          logger.debug('[RoutingSnapshotCache] background refresh failed', { error: String(result?.message || result) });
        }
        return;
      }
      // A write that landed during the build may be missing from its result.
      if (controller.signal.aborted || !current(entry, currentVersion())) return;
      slot.held = { snapshot: result, generation: entry.generation, version: entry.version, builtAt: now() };
    };
    entry.promise.then((snapshot) => settle(true, snapshot), (error) => settle(false, error));
    return entry;
  }

  // The caller waits for the shared build; leaving rejects only this caller.
  function join(entry, signal) {
    entry.waiting += 1;
    if (!signal) return entry.promise;
    return new Promise((resolve, reject) => {
      const leave = () => {
        entry.waiting -= 1;
        reject(abortReason(signal));
        if (entry.waiting === 0 && !entry.settled && !entry.background) entry.controller.abort(abortReason(signal));
      };
      signal.addEventListener('abort', leave, { once: true });
      entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
    });
  }

  async function get(options = {}) {
    const fresh = ttlMs();
    // A caller choosing router options gets its own build, as without cache.
    if (fresh <= 0 || options.routerOptions) return build(options);
    if (options.signal?.aborted) throw abortReason(options.signal);
    const exact = options.includeArtifactIdentity === true;
    const key = `${options.includeCatalog !== false}:${exact}`;
    if (!slots.has(key)) slots.set(key, { held: null, pending: null });
    const slot = slots.get(key);
    const version = currentVersion();
    if (slot.held && !current(slot.held, version)) slot.held = null;
    const underway = slot.pending && current(slot.pending, version) && !slot.pending.controller.signal.aborted
      ? slot.pending
      : null;
    const age = slot.held ? now() - slot.held.builtAt : Infinity;
    if (age < fresh) return slot.held.snapshot;
    // The exact-artifact view is an authority: its verdict is never served stale.
    if (!exact && age < staleMs()) {
      if (!underway) start(slot, options, version, fresh, true);
      return slot.held.snapshot;
    }
    return join(underway || start(slot, options, version, fresh, false), options.signal);
  }

  return Object.freeze({ get });
}

/** `routing.getEffectiveSnapshot` of the trusted runtime services, over their dependencies. */
function effectiveSnapshotReader(deps) {
  const cache = createRoutingSnapshotCache({
    build: options => buildEffectiveRoutingSnapshot(deps, options),
    // Required on first use: the router configuration loads the pin writers, which load this module.
    routingVersion: deps.getRoutingConfigVersion || require('../modelRouterConfig').getRoutingConfigVersion
  });
  return options => cache.get(options);
}

module.exports = {
  DEFAULT_STALE_MS,
  DEFAULT_TTL_MS,
  createRoutingSnapshotCache,
  effectiveSnapshotReader,
  invalidateRoutingSnapshots,
  snapshotCacheTtlMs,
  snapshotStaleMs
};
