'use strict';

// Short-lived shared effective routing snapshot (#258). A runtime bridge asks
// for the snapshot on every model call, and building it reads each routed
// model's live catalog digest, Benchmark host profile and registry entry.
//
// - Callers asking for the same options within the TTL share one deep-frozen
//   snapshot; concurrent callers share one build.
// - A caller that leaves only detaches itself. The build stops opening host
//   reads (#189) once every waiting caller has left, and an abandoned build is
//   never kept.
// - Within the TTL, one artifact identity resolution answers every read of
//   the same exact model on the same host, across tasks and option sets.
// - A router configuration change (its version) or a host preference or pin
//   write (`invalidateRoutingSnapshots`) discards what is held.
// Admission, busy checks, runtime coordination and model enforcement during
// inference read live state; only these snapshot and identity reads are shared.

const { buildEffectiveRoutingSnapshot } = require('./effectiveRoutingSnapshot');

const DEFAULT_TTL_MS = 5000;

let generation = 0;

/** Called by host preference and pin writers: nothing held before is reused. */
function invalidateRoutingSnapshots() {
  generation += 1;
}

/** `AGENTX_ROUTING_SNAPSHOT_CACHE_MS`; unset or invalid: 5000. 0 disables. */
function snapshotCacheTtlMs(raw = process.env.AGENTX_ROUTING_SNAPSHOT_CACHE_MS) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_TTL_MS;
}

function abortReason(signal) {
  return signal.reason || new Error('routing snapshot aborted');
}

function createRoutingSnapshotCache({ build, routingVersion = null, ttlMs = snapshotCacheTtlMs, now = Date.now }) {
  const snapshots = new Map();
  const identities = new Map();

  function currentVersion() {
    try {
      return routingVersion ? routingVersion() : null;
    } catch {
      // A version that cannot be read matches nothing, so nothing is reused.
      return {};
    }
  }

  function unexpired(entry) {
    return entry.generation === generation
      && !entry.signal.aborted
      && (entry.expiresAt === null || entry.expiresAt > now());
  }

  // One resolution per exact model and host, owned by the build that opened it.
  function identityMemo(signal, ttl) {
    return (key, resolve) => {
      const held = identities.get(key);
      if (held && unexpired(held)) {
        // A read cut short by its own callers' departure is not evidence.
        return held.promise.then((identity) => (held.signal.aborted ? resolve() : identity), () => resolve());
      }
      const entry = { generation, signal, expiresAt: null, promise: null };
      entry.promise = Promise.resolve(resolve()).then((identity) => (identity ? Object.freeze(identity) : identity));
      identities.set(key, entry);
      const settle = (keep) => {
        if (identities.get(key) !== entry) return;
        if (keep && unexpired(entry)) entry.expiresAt = now() + ttl;
        else identities.delete(key);
      };
      entry.promise.then(() => settle(true), () => settle(false));
      return entry.promise;
    };
  }

  function start(key, options, version, ttl) {
    const controller = new AbortController();
    const entry = {
      generation, version, signal: controller.signal, controller, waiting: 0, settled: false, expiresAt: null
    };
    entry.promise = build({
      includeCatalog: options.includeCatalog !== false,
      includeArtifactIdentity: options.includeArtifactIdentity === true,
      signal: controller.signal,
      identityMemo: identityMemo(controller.signal, ttl)
    });
    snapshots.set(key, entry);
    const settle = (keep) => {
      entry.settled = true;
      if (snapshots.get(key) !== entry) return;
      // A write that landed during the build may be missing from its result.
      if (keep && unexpired(entry) && entry.version === currentVersion()) entry.expiresAt = now() + ttl;
      else snapshots.delete(key);
    };
    entry.promise.then(() => settle(true), () => settle(false));
    return entry;
  }

  // The caller waits for the shared build; leaving rejects only this caller.
  function join(entry, signal) {
    if (entry.settled) return entry.promise;
    entry.waiting += 1;
    if (!signal) return entry.promise;
    return new Promise((resolve, reject) => {
      const leave = () => {
        entry.waiting -= 1;
        reject(abortReason(signal));
        if (entry.waiting === 0 && !entry.settled) entry.controller.abort(abortReason(signal));
      };
      signal.addEventListener('abort', leave, { once: true });
      entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
    });
  }

  async function get(options = {}) {
    const ttl = ttlMs();
    // A caller choosing router options gets its own build, as without cache.
    if (ttl <= 0 || options.routerOptions) return build(options);
    if (options.signal?.aborted) throw abortReason(options.signal);
    const key = `${options.includeCatalog !== false}:${options.includeArtifactIdentity === true}`;
    const version = currentVersion();
    const held = snapshots.get(key);
    const entry = held && unexpired(held) && held.version === version
      ? held
      : start(key, options, version, ttl);
    return join(entry, options.signal);
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
  DEFAULT_TTL_MS,
  createRoutingSnapshotCache,
  effectiveSnapshotReader,
  invalidateRoutingSnapshots,
  snapshotCacheTtlMs
};
