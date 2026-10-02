'use strict';
/**
 * Host Preference Service
 *
 * Manages pinned model preferences per host, warmup, and periodic health checks.
 *
 * The legacy `defaultModels` + `pinnedModel` dual-state model
 * has been unified into a single `pinnedModels: [{ model, keepAlive,
 * contextSize, autoRestore }]` array. The service still exposes
 * helpers that expose the pinned model collection to routing and scheduling
 * callers (modelRouterConfig pin cache, clusterScheduleService recommendHost,
 * inference.js keep-alive lookup).
 *
 * This file was 1042 lines (cap 700) and mixed four concerns:
 * pin CRUD, a health-check daemon, the pin-reconciler grace-period state
 * machine, and benchmark-claim re-exports. The split moved:
 *   - the shared pin/loaded-model helpers → ./hostPinPrimitives
 *   - the reconciler + grace-period state machine → ./pinReconciler
 *   - the health-check interval scheduler → ./hostHealthDaemon
 *   - the warm/unload requests and loadedModel/status writes → ./hostModelRuntime
 *   - the benchmark residency snapshot → ./benchmarkRuntimeSnapshot
 * This file remains the facade: it keeps pin CRUD, the warm/restore/swap
 * orchestration, and re-exports every name the extracted modules own so the
 * public export surface is UNCHANGED. (The benchmark-claim lifecycle had already
 * moved to ./benchmarkClaimService; those re-exports stay.)
 */

const HostPreference = require('../../models/HostPreference');
const hostGate = require('./hostGate');
const logger = require('../../config/logger');
const { observePinRestoreFailure } = require('./laneObservabilityService');
const benchmarkClaimService = require('./benchmarkClaimService');
const hostHealthDaemon = require('./hostHealthDaemon');
const pinReconciler = require('./pinReconciler');
const hostPreferenceIdentity = require('./hostPreferenceIdentity');
const { normalizePinUpdate, getPinStatus, setPinnedModel, clearPinnedModel,
  addPinnedModel, updatePinnedModel, removePinnedModel } = require('./hostPinService');
const { runHostModelOperation } = require('./inferenceAdmissionService');
const {
  pinRestoreVerifyTimeoutMs,
  normalizePinName,
  pinNamesMatch,
  getPinnedEntries,
  getPinnedModelNames,
  getPrimaryPinnedModel,
  resolvePinnedRuntimeOptions, buildWarmPayload,
  positiveInteger,
  readLoadedContextLength,
  findLoadedModelInfo,
  isEmbeddingModelName,
  getWarmOrder,
  getLoadedEntryStatus,
  entrySatisfiedByLoadedModel,
  fetchRunningModelInfos,
  fetchRunningModelInfosStrict,
  sleep,
  verifyPinnedEntriesLoaded
} = require('./hostPinPrimitives');

// The benchmark-claim lifecycle (acquire/release/list/reap +
// hasActiveBenchmarkClaim) was extracted to benchmarkClaimService.js.
// The reconciler (now in pinReconciler.js) still calls hasActiveBenchmarkClaim
// to short-circuit pin warming. The grace-period state machine also
// moved to pinReconciler.js.
const { hasActiveBenchmarkClaim } = benchmarkClaimService;
const { hasActiveSessionHold, observeSessionHold } = require('./hostSessionHoldService');
// Warm/unload requests and loadedModel/status writes live in ./hostModelRuntime;
// the benchmark residency snapshot lives in ./benchmarkRuntimeSnapshot.
const { warmDefaultModel, unloadModel, updateLoadedModel, setHostStatus } = require('./hostModelRuntime');
const {
  benchmarkRuntimeSnapshotIdentity,
  captureBenchmarkRuntime,
  desiredBenchmarkResidents,
  benchmarkResidentExpiryMatches
} = require('./benchmarkRuntimeSnapshot');

const activePinRestores = new Map();

// ── CRUD ────────────────────────────────────────────────────

async function getAll() {
  return HostPreference.find().lean();
}

async function getByHost(hostUrl) {
  return HostPreference.findOne({ hostUrl }).lean();
}

async function updatePreference(hostUrl, updates) {
  const current = await getByHost(hostUrl);
  const normalizedUpdates = hostPreferenceIdentity.normalizeHostPreferenceUpdates(hostUrl, normalizePinUpdate(current, updates));
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    { $set: { hostUrl, ...normalizedUpdates } },
    { new: true, upsert: true, runValidators: true }
  ).lean();
}

async function deletePreference(hostUrl) {
  return HostPreference.deleteOne({ hostUrl });
}

// ── Pin / loaded-model helpers ─────────────────────────────
// The shared low-level helpers (getPinnedEntries, getLoadedEntryStatus,
// fetchRunningModelInfos, verifyPinnedEntriesLoaded, the normalize aliases,
// etc.) live in ./hostPinPrimitives and are imported above. They are
// re-exported below where they were part of the public surface.

async function restoreBenchmarkRuntime(hostUrl, snapshot, benchmarkClaim) {
  return require('./benchmarkRuntimeRestore').restoreBenchmarkRuntime(hostUrl, snapshot, benchmarkClaim,
    { warmDefaultModel, unloadModel, benchmarkRuntimeSnapshotIdentity, benchmarkResidentExpiryMatches, desiredBenchmarkResidents });
}

async function prepareExclusiveModel(hostUrl, model, options = {}) {
  let runningModelInfos;
  try {
    options.assertAuthorityActive?.();
    runningModelInfos = await fetchRunningModelInfosStrict(hostUrl, 5_000, {
      signal: options.signal
    });
    options.assertAuthorityActive?.();
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : error;
    }
    return { host: hostUrl, model, status: 'error', error: error.message, unloaded: [] };
  }
  const runningModels = runningModelInfos.map(entry => entry.name || entry.model).filter(Boolean);
  const unloaded = [];

  for (const loaded of runningModels) {
    if (pinNamesMatch(loaded, model)) continue;
    options.assertAuthorityActive?.();
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      return { host: hostUrl, model, status: 'busy', unloaded, blockingModel: loaded };
    }
    const result = await unloadModel(hostUrl, loaded, options);
    options.assertAuthorityActive?.();
    if (result.status !== 'ok') {
      return { host: hostUrl, model, status: 'error', error: result.error, unloaded };
    }
    unloaded.push(loaded);
  }

  if (unloaded.length > 0) {
    options.assertAuthorityActive?.();
    await HostPreference.findOneAndUpdate(
      { hostUrl },
      { $set: { status: 'swapping', loadedModel: null, loadedModels: [] } },
      options.signal ? { signal: options.signal } : {}
    );
    options.assertAuthorityActive?.();
    logger.info(`[HostPreference] Prepared exclusive model handoff to ${model} on ${hostUrl}`, { unloaded });
  }
  return { host: hostUrl, model, status: 'ready', unloaded };
}

/**
 * Warm every pinned model on a single host. Skips entries whose model is
 * already loaded. Updates loadedModel/status where appropriate.
 */
async function warmHost(hostUrl, options = {}) {
  options.assertAuthorityActive?.();
  const pref = await HostPreference.findOne(
    { hostUrl },
    null,
    options.signal ? { signal: options.signal } : {}
  ).lean();
  options.assertAuthorityActive?.();
  if (!pref) return [];
  const entries = getPinnedEntries(pref);
  if (entries.length === 0) return [];

  // Refuse to warm the pin while the host is claimed by a benchmark
  // batch. The bench unloaded the pin on purpose so its target model could
  // own VRAM; warming again here forces a swap that will tank every
  // remaining prompt in the batch. Callers (NerveCenter /reload button,
  // bench's restoreAllDedication) get a structured "skipped_claim" result
  // so they can log/UI accordingly. The bench's release path triggers a
  // restore on its own once the claim is cleared.
  if (hasActiveBenchmarkClaim(pref)) {
    logger.info(`[HostPreference] warmHost skipped on ${pref.displayName || hostUrl} — active benchmark claim`, {
      batchId: pref.benchmarkClaim?.batchId || null,
      pinnedModels: entries.map(e => e.model)
    });
    return entries.map(entry => ({
      host: hostUrl,
      model: entry.model,
      status: 'skipped_claim',
      batchId: pref.benchmarkClaim?.batchId || null
    }));
  }
  // A session hold owns the host the same way: warming the pin here (Core
  // startup, the Nerve Center reload button, the watchdog) would evict the
  // held model from under an interactive session. The hold's release or idle
  // expiry restores the pin through the reconciler.
  if (hasActiveSessionHold(pref)) {
    logger.info(`[HostPreference] warmHost skipped on ${pref.displayName || hostUrl} — active session hold`, {
      owner: pref.sessionHold?.owner || null,
      model: pref.sessionHold?.model || null,
      pinnedModels: entries.map(e => e.model)
    });
    return entries.map(entry => ({
      host: hostUrl,
      model: entry.model,
      status: 'skipped_hold',
      holdOwner: pref.sessionHold?.owner || null
    }));
  }

  const results = [];

  // Fetch running models once per host; if unreachable we still attempt warmup
  let runningModelInfos = await fetchRunningModelInfos(hostUrl, 5_000, {
    signal: options.signal
  });
  options.assertAuthorityActive?.();

  for (const entry of getWarmOrder(entries)) {
    const t0 = Date.now();
    logger.info(`[HostPreference] Warming pinned model ${entry.model} on ${pref.displayName || hostUrl}`);

    const loadedStatus = getLoadedEntryStatus(entry, runningModelInfos);
    if (entrySatisfiedByLoadedModel(entry, runningModelInfos)) {
      options.assertAuthorityActive?.();
      await updateLoadedModel(hostUrl, entry.model, options);
      options.assertAuthorityActive?.();
      results.push({
        host: hostUrl, model: entry.model, status: 'already_loaded',
        durationMs: Date.now() - t0
      });
      continue;
    }

    if (loadedStatus.contextMismatch) {
      logger.info(`[HostPreference] Pinned model context mismatch on ${pref.displayName || hostUrl}; warming at configured context`, {
        model: entry.model,
        loadedModel: loadedStatus.loadedModel,
        loadedContextLength: loadedStatus.loadedContextLength,
        expectedContextLength: loadedStatus.expectedContextLength
      });
    }

    // Mark host as restoring while we warm. If there are multiple entries we
    // only care about the primary for status — secondary warmups inherit.
    if (entries[0].model === entry.model) {
      options.assertAuthorityActive?.();
      await setHostStatus(hostUrl, 'restoring', options);
      options.assertAuthorityActive?.();
    }
    const opts = { keepAlive: entry.keepAlive ?? -1, contextSize: entry.contextSize ?? 0, numThread: entry.numThread || 0 };
    const result = await warmDefaultModel(hostUrl, entry.model, { ...opts, ...options });
    result.durationMs = Date.now() - t0;
    results.push(result);

    if (result.status === 'ok' && entries[0].model === entry.model) {
      options.assertAuthorityActive?.();
      await updateLoadedModel(hostUrl, entry.model, options);
      options.assertAuthorityActive?.();
      runningModelInfos = await fetchRunningModelInfos(hostUrl, 5_000, {
        signal: options.signal
      });
      options.assertAuthorityActive?.();
    } else if (result.status !== 'ok' && entries[0].model === entry.model) {
      await setHostStatus(hostUrl, 'idle', options);
      options.assertAuthorityActive?.();
    }
  }

  return results;
}

async function warmAllDefaults(options = {}) {
  const prefs = await getAll();
  prefs.forEach(pref => observeSessionHold(pref));
  const results = [];
  for (const pref of prefs) {
    const primary = getPinnedEntries(pref)[0];
    if (!primary) continue;
    try {
      const hostResults = await runHostModelOperation({
        host: pref.hostUrl, model: primary.model,
        principal: 'core-startup-pin-warm', kind: 'pin-warm', signal: options.signal
      }, async ({ signal, assertActive }) => {
        const warmed = await warmHost(pref.hostUrl, { signal, assertAuthorityActive: assertActive });
        const failed = warmed.find(result => result.status === 'error');
        if (failed) throw new Error(failed.error || 'Pin warm did not complete');
        return warmed;
      });
      results.push(...hostResults);
    } catch (error) {
      results.push({ host: pref.hostUrl, model: primary.model, status: 'error', error: error.message });
      await HostPreference.updateOne({ hostUrl: pref.hostUrl, status: 'restoring' }, { $set: { status: 'idle' } });
      if (options.signal?.aborted) break;
    }
  }
  return results;
}

/**
 * Return Map<hostUrl, string[]> of pinned model names.
 */
async function getPinnedModelsMap() {
  const prefs = await getAll();
  const map = new Map();
  for (const p of prefs) {
    map.set(p.hostUrl, getPinnedModelNames(p));
  }
  return map;
}

// Pin CRUD lives in hostPinService; the facade keeps its public API.


/**
 * Restore every pinned model on a host that isn't currently loaded. Unloads
 * the primary host's loaded-but-not-pinned model first to free VRAM for the
 * primary pin, then performs bounded warmups and verifies the pinned models
 * are actually resident before reporting success.
 */
async function restorePinnedModels(hostUrl, options = {}) {
  const claim = options.benchmarkClaim || null;
  const restoreKey = claim
    ? `${hostUrl}\n${claim.batchId}\n${claim.claimGeneration}`
    : hostUrl;
  let restorePromise = activePinRestores.get(restoreKey);
  if (!restorePromise) {
    restorePromise = restorePinnedModelsInternal(hostUrl, options)
      .finally(() => activePinRestores.delete(restoreKey));
    activePinRestores.set(restoreKey, restorePromise);
  }

  const result = await restorePromise;
  if (result?.status === 'error') {
    void observePinRestoreFailure({
      host: hostUrl,
      models: result.pinnedModels || result.results?.map(entry => entry.model),
      error: result.error,
      source: 'host-preference-service'
    });
  }
  return result;
}

async function restorePinnedModelsInternal(hostUrl, options = {}) {
  options.assertAuthorityActive?.();
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  const entries = getPinnedEntries(pref);
  if (entries.length === 0) {
    return { host: hostUrl, status: 'error', error: 'No pinned model configured' };
  }

  const claim = options.benchmarkClaim || null;
  const fencedClaim = hasActiveBenchmarkClaim(pref)
    && claim
    && pref.status === 'benchmarking'
    && pref.benchmarkClaim?.batchId === claim.batchId
    && pref.benchmarkClaim?.claimGeneration === claim.claimGeneration;
  if (claim && !fencedClaim) {
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'error',
      code: 'BENCHMARK_CLAIM_LOST',
      error: 'Benchmark claim no longer owns the host; fenced pin restore refused',
      verified: false
    };
  }
  // External restores remain forbidden while any claim is active. The exact
  // claim owner may restore through the fenced release path, which keeps the
  // host unavailable to chat/watchdog until residency has been verified.
  if (hasActiveBenchmarkClaim(pref) && !fencedClaim) {
    logger.info(`[HostPreference] restorePinnedModels skipped on ${pref.displayName || hostUrl} — active benchmark claim`, {
      batchId: pref.benchmarkClaim?.batchId || null,
      pinnedModels: entries.map(e => e.model)
    });
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'skipped_claim',
      batchId: pref.benchmarkClaim?.batchId || null
    };
  }
  if (hasActiveSessionHold(pref)) {
    logger.info(`[HostPreference] restorePinnedModels skipped on ${pref.displayName || hostUrl} — active session hold`, {
      owner: pref.sessionHold?.owner || null,
      model: pref.sessionHold?.model || null,
      pinnedModels: entries.map(e => e.model)
    });
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'skipped_hold',
      holdOwner: pref.sessionHold?.owner || null
    };
  }

  const assertFence = async () => {
    options.assertAuthorityActive?.();
    if (!fencedClaim) return;
    const current = await HostPreference.findOne({ hostUrl }).lean();
    if (current?.status !== 'benchmarking'
      || current?.benchmarkClaim?.batchId !== claim.batchId
      || current?.benchmarkClaim?.claimGeneration !== claim.claimGeneration) {
      const error = new Error('Benchmark claim no longer owns the host while restoring pins');
      error.code = 'BENCHMARK_CLAIM_LOST';
      throw error;
    }
  };

  let runningModelInfos = await fetchRunningModelInfos(hostUrl);
  const allAlreadyLoaded = entries.every(entry => entrySatisfiedByLoadedModel(entry, runningModelInfos)
    && !getLoadedEntryStatus(entry, runningModelInfos).vramSpill);
  if (allAlreadyLoaded) {
    await updateLoadedModel(hostUrl, entries[0].model, { benchmarkClaim: fencedClaim ? claim : null });
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'ready',
      verified: true,
      results: entries.map(entry => ({ host: hostUrl, model: entry.model, status: 'already_loaded' }))
    };
  }

  if (pref.status === 'restoring') {
    logger.info(`[HostPreference] Continuing pin restore on ${pref.displayName || hostUrl}; current status is already restoring`, {
      pinnedModels: entries.map(e => e.model)
    });
  }

  if (!fencedClaim) await setHostStatus(hostUrl, 'restoring');

  // Unload any currently-loaded model that isn't one of our pinned entries —
  // but skip the explicit unload if the loaded model has active inference.
  // Sending keep_alive:0 while a caller is generating risks truncating their
  // stream; letting Ollama manage eviction via the warmup below is safer.
  const pinnedNames = entries.map(e => e.model);
  const liveLoadedList = runningModelInfos.map(m => m.name || m.model).filter(Boolean);
  const loadedList = liveLoadedList.length > 0
    ? liveLoadedList
    : (Array.isArray(pref.loadedModels) && pref.loadedModels.length > 0
        ? pref.loadedModels
        : (pref.loadedModel ? [pref.loadedModel] : []));
  for (const loaded of loadedList) {
    if (pinnedNames.some(p => pinNamesMatch(loaded, p))) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      logger.info(`[HostPreference] Skipping explicit unload of ${loaded} on ${hostUrl} — active inference`);
      continue;
    }
    await assertFence();
    const unloadResult = await unloadModel(hostUrl, loaded, options);
    if (unloadResult.status !== 'ok') {
      logger.warn(`[HostPreference] Failed to unload ${loaded} on ${hostUrl}: ${unloadResult.error}`);
    }
  }

  const results = [];

  // Warm each pinned model and verify residency before reporting success.
  // updateLoadedModel is called on the PRIMARY entry so the host's
  // status/loadedModel reflects the first pin. Secondary pins still get
  // warmed to their configured keep_alive.
  const primaryModel = entries[0].model;
  for (const entry of getWarmOrder(entries)) {
    await assertFence();
    const opts = { keepAlive: entry.keepAlive ?? -1, contextSize: entry.contextSize ?? 0, numThread: entry.numThread || 0 };
    const isPrimary = entry.model === primaryModel;
    const t0 = Date.now();
    const loadedStatus = getLoadedEntryStatus(entry, runningModelInfos);
    if (entrySatisfiedByLoadedModel(entry, runningModelInfos)) {
      results.push({
        host: hostUrl,
        model: entry.model,
        status: 'already_loaded',
        durationMs: Date.now() - t0
      });
      if (isPrimary) await updateLoadedModel(hostUrl, entry.model, { benchmarkClaim: fencedClaim ? claim : null });
      continue;
    }

    let result;
    try {
      result = await warmDefaultModel(hostUrl, entry.model, { ...opts, ...options });
      result.durationMs = Date.now() - t0;
      results.push(result);
    } catch (err) {
      if (err.code === 'RUNTIME_MUTATION_OUTCOME_UNKNOWN') throw err;
      result = { host: hostUrl, model: entry.model, status: 'error', error: err.message, durationMs: Date.now() - t0 };
      results.push(result);
    }

    if (result.status === 'ok') {
      if (isPrimary) await updateLoadedModel(hostUrl, entry.model, { benchmarkClaim: fencedClaim ? claim : null });
      runningModelInfos = await fetchRunningModelInfos(hostUrl);
      logger.info(`[HostPreference] Restored pinned model ${entry.model} on ${hostUrl}`);
    } else {
      if (isPrimary && !fencedClaim) await setHostStatus(hostUrl, 'offline');
      logger.warn(`[HostPreference] Failed to restore pin ${entry.model} on ${hostUrl}: ${result.error}`);
    }
  }

  const verification = await verifyPinnedEntriesLoaded(hostUrl, entries);
  options.assertAuthorityActive?.();
  if (!verification.verified) {
    if (!fencedClaim) await setHostStatus(hostUrl, 'offline');
    logger.warn(`[HostPreference] Pin restore did not verify on ${hostUrl}`, {
      pinnedModels: entries.map(e => e.model),
      runningModels: verification.runningModels,
      statuses: verification.statuses
    });
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'error',
      error: 'Pinned model restore did not verify resident model/context/VRAM',
      verified: false,
      results,
      verification
    };
  }

  options.assertAuthorityActive?.();
  await updateLoadedModel(hostUrl, entries[0].model, { benchmarkClaim: fencedClaim ? claim : null });
  return {
    host: hostUrl,
    pinnedModels: entries.map(e => e.model),
    status: 'ready',
    verified: true,
    results,
    verification
  };
}

async function swapModel(hostUrl, model, options = {}) {
  options.assertAuthorityActive?.();
  const pref = await HostPreference.findOne({ hostUrl }).lean();

  // Guard: skip if already swapping
  if (pref?.status === 'swapping') {
    const error = new Error(`Host ${hostUrl} has an unresolved model swap`);
    error.code = 'HOST_MODEL_SWAP_IN_PROGRESS';
    error.statusCode = 409;
    throw error;
  }

  await setHostStatus(hostUrl, 'swapping');

  // Unload any currently-loaded model that isn't the swap target — unless it
  // has active inference, in which case we let Ollama's VRAM manager handle
  // eviction rather than force-unloading mid-stream.
  const loadedList = Array.isArray(pref?.loadedModels) && pref.loadedModels.length > 0
    ? pref.loadedModels
    : (pref?.loadedModel ? [pref.loadedModel] : []);
  for (const loaded of loadedList) {
    if (pinNamesMatch(loaded, model)) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      logger.info(`[HostPreference] Skipping explicit unload of ${loaded} on ${hostUrl} during swap — active inference`);
      continue;
    }
    const unloadResult = await unloadModel(hostUrl, loaded, options);
    if (unloadResult.status !== 'ok') {
      logger.warn(`[HostPreference] Failed to unload ${loaded} on ${hostUrl}: ${unloadResult.error}`);
    }
  }

  // Warm the new model — only pinned models get keep_alive -1, everything
  // else uses Ollama default. Look up the model's pinned entry if it exists
  // so contextSize carries over.
  const entries = getPinnedEntries(pref);
  const matchingPin = entries.find(e => e.model === model);
  const opts = matchingPin
    ? { keepAlive: matchingPin.keepAlive ?? -1, contextSize: matchingPin.contextSize ?? 0, numThread: matchingPin.numThread || 0 }
    : { keepAlive: 0, contextSize: 0 };
  const result = await warmDefaultModel(hostUrl, model, { ...opts, ...options });
  options.assertAuthorityActive?.();
  if (result.status === 'ok') {
    await updateLoadedModel(hostUrl, model);
    options.assertAuthorityActive?.();
    logger.info(`[HostPreference] Swapped to ${model} on ${hostUrl}`);
    return { host: hostUrl, model, status: 'ready' };
  }

  try {
    await setHostStatus(hostUrl, 'idle');
  } finally {
    options.assertAuthorityActive?.();
  }
  logger.warn(`[HostPreference] Failed to swap to ${model} on ${hostUrl}: ${result.error}`);
  const error = new Error(result.error || `Swap to ${model} was not terminally verified`);
  error.code = 'HOST_MODEL_SWAP_UNVERIFIED';
  throw error;
}

// ── Exports ─────────────────────────────────────────────────

// Claim-lifecycle names re-export benchmarkClaimService for
// symbol stability. Existing callers (routes/nerve-center.js, server.js,
// clusterScheduleService,
// inferenceHealthService, and the test mocks that replace this module
// wholesale) continue to call `hostPreferenceService.releaseBenchmarkClaim`
// etc. New code SHOULD import directly from `./benchmarkClaimService`.
//
// The health daemon (./hostHealthDaemon), the pin reconciler +
// grace-period state machine (./pinReconciler), and the shared pin helpers
// (./hostPinPrimitives) were extracted. They are re-exported here so the
// public export surface is UNCHANGED.
module.exports = {
  getAll,
  getByHost,
  updatePreference,
  deletePreference,
  hasActiveBenchmarkClaim,
  getPinnedModelsMap,
  getPinnedEntries,
  getPinnedModelNames,
  getPrimaryPinnedModel,
  resolvePinnedRuntimeOptions, buildWarmPayload,
  warmDefaultModel,
  benchmarkRuntimeSnapshotIdentity,
  desiredBenchmarkResidents,
  captureBenchmarkRuntime,
  restoreBenchmarkRuntime,
  warmHost,
  warmAllDefaults,
  checkAndReloadDefaults: pinReconciler.checkAndReloadDefaults,
  startHealthCheck: hostHealthDaemon.startHealthCheck,
  stopHealthCheck: hostHealthDaemon.stopHealthCheck,
  getHealthCheckIntervalMs: hostHealthDaemon.getHealthCheckIntervalMs,
  setHealthCheckIntervalMs: hostHealthDaemon.setHealthCheckIntervalMs,
  startBenchmarkClaimReaper: benchmarkClaimService.startBenchmarkClaimReaper,
  stopBenchmarkClaimReaper: benchmarkClaimService.stopBenchmarkClaimReaper,
  getBenchmarkClaimReaperIntervalMs: benchmarkClaimService.getBenchmarkClaimReaperIntervalMs,
  getPinRestoreGraceMs: pinReconciler.getPinRestoreGraceMs,
  setPinRestoreGraceMs: pinReconciler.setPinRestoreGraceMs,
  getPinStatus,
  findConfiguredHostByUrl: hostPreferenceIdentity.findConfiguredHostByUrl,
  normalizeHostPreferenceIdentity: hostPreferenceIdentity.normalizeHostPreferenceIdentity,
  normalizeHostPreferenceUpdates: hostPreferenceIdentity.normalizeHostPreferenceUpdates,
  detectHostPreferenceIdentityDrift: hostPreferenceIdentity.detectHostPreferenceIdentityDrift,
  setPinnedModel,
  clearPinnedModel,
  addPinnedModel,
  removePinnedModel,
  updatePinnedModel,
  updateLoadedModel,
  setHostStatus,
  unloadModel,
  prepareExclusiveModel,
  restorePinnedModels,
  pinNamesMatch,
  swapModel,
  claimBenchmark: benchmarkClaimService.claimBenchmark,
  heartbeatBenchmarkClaim: benchmarkClaimService.heartbeatBenchmarkClaim,
  releaseBenchmarkClaim: benchmarkClaimService.releaseBenchmarkClaim,
  recoverBenchmarkClaimRelease: benchmarkClaimService.recoverBenchmarkClaimRelease,
  restoreClaimsForWorkloadRecovery: benchmarkClaimService.restoreClaimsForWorkloadRecovery,
  listBenchmarkClaims: benchmarkClaimService.listBenchmarkClaims,
  summarizeBenchmarkClaimReaps: benchmarkClaimService.summarizeBenchmarkClaimReaps,
  reapStaleBenchmarkClaims: benchmarkClaimService.reapStaleBenchmarkClaims
};
