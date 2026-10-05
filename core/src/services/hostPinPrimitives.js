'use strict';
const { withContextRefusal } = require('./routing/contextIntegrityPolicy');
/**
 * Host Pin Primitives
 *
 * Low-level, mostly-pure helpers shared by the host-preference facade
 * (hostPreferenceService.js), the pin reconciler (pinReconciler.js), and the
 * warm/restore primitives. Extracted from hostPreferenceService.js —
 * that file was 1042 lines (cap 700) and mixed pin CRUD, a health-check
 * daemon, the pin-reconciler grace-period state machine, and these shared
 * helpers.
 *
 * This module holds the pin-name normalisation aliases, the pinnedModels
 * normalisation/fallback logic (getPinnedEntries and friends), the
 * loaded-model status helpers, and the bounded residency verifier. The
 * function bodies are copied VERBATIM — this is a pure structural split, no
 * behavior change.
 *
 * Symbol stability: hostPreferenceService.js re-exports getPinnedEntries,
 * getPinnedModelNames, and getPrimaryPinnedModel so existing callers keep
 * working.
 */

const {
  normalizeModelName: canonicalNormalize,
  modelsMatch
} = require('../helpers/modelNameNormalization');
const { isEmbeddingModelName } = require('../../../shared/embeddingModels');
const { gpuResidency, placementMatches, expectedStatus } = require('../../../shared/gpuResidency');
const { hostResidency } = require('../helpers/hostResidency');

let pinRestoreVerifyTimeoutMs = parseInt(process.env.PIN_RESTORE_VERIFY_TIMEOUT_MS, 10);
if (!Number.isFinite(pinRestoreVerifyTimeoutMs) || pinRestoreVerifyTimeoutMs < 1_000) {
  pinRestoreVerifyTimeoutMs = 15_000;
}

// ── Helpers to normalise pinnedModels ──────────────────────
// Runtime tolerance for pre-migration docs: if pinnedModels is empty but
// legacy `defaultModels` / `pinnedModel` still exist on the raw doc, derive
// entries on the fly. This lets a freshly-deployed binary run against
// un-migrated data without losing keep-alive behavior.

// Local aliases onto the ecosystem-wide normalizer (src/helpers/
// modelNameNormalization.js). Kept so the health check and pin-equivalence
// call sites read the same as before; namespaces remain part of identity.
const normalizePinName = canonicalNormalize;
const pinNamesMatch = modelsMatch;

function getPinnedEntries(pref) {
  if (!pref) return [];
  if (Array.isArray(pref.pinnedModels) && pref.pinnedModels.length > 0) {
    return pref.pinnedModels.map(entry => ({
      model: entry.model,
      keepAlive: entry.keepAlive ?? -1,
      contextSize: entry.contextSize ?? 0,
      autoRestore: entry.autoRestore !== false,
      ...(entry.numThread > 0 ? { numThread: entry.numThread } : {})
    }));
  }
  // Legacy fallback — pref was fetched as .lean() so stray keys are visible
  const legacy = [];
  const seen = new Set();
  const fallbackKeepAlive = pref.keepAlive ?? -1;
  const fallbackContextSize = pref.contextSize ?? 0;
  const fallbackAutoRestore = pref.autoRestore !== false;
  if (pref.pinnedModel) {
    legacy.push({
      model: pref.pinnedModel,
      keepAlive: -1, // pinnedModel semantics — always kept loaded
      contextSize: fallbackContextSize,
      autoRestore: fallbackAutoRestore
    });
    seen.add(pref.pinnedModel);
  }
  if (Array.isArray(pref.defaultModels)) {
    for (const m of pref.defaultModels) {
      if (!m || seen.has(m)) continue;
      legacy.push({
        model: m,
        keepAlive: fallbackKeepAlive,
        contextSize: fallbackContextSize,
        autoRestore: fallbackAutoRestore
      });
      seen.add(m);
    }
  }
  return legacy;
}

function getPinnedModelNames(pref) {
  return getPinnedEntries(pref).map(e => e.model);
}

function getPrimaryPinnedModel(pref) {
  const entries = getPinnedEntries(pref);
  return entries.length > 0 ? entries[0].model : null;
}

/**
 * Resolve the runtime-loading options shared by pin warming and inference.
 * Explicit caller values win; otherwise a matching pin supplies its context
 * and keep-alive. Keeping this in one helper prevents a warm 49K model from
 * being reloaded at its Modelfile context by the first chat turn.
 */
function resolvePinnedRuntimeOptions(pref, model, callerOptions = {}, callerKeepAlive) {
  const { keep_alive: optionKeepAlive, ...options } = callerOptions || {};
  let keepAlive = callerKeepAlive ?? optionKeepAlive;
  let numCtxSource = options.num_ctx != null ? 'caller' : 'modelfile';
  const pinnedEntry = getPinnedEntries(pref)
    .find(entry => pinNamesMatch(entry.model, model)) || null;

  if (pinnedEntry) {
    if (keepAlive === undefined || keepAlive === '') {
      keepAlive = pinnedEntry.keepAlive ?? -1;
    }
    const pinnedContext = positiveInteger(pinnedEntry.contextSize);
    if (options.num_ctx == null && pinnedContext) {
      options.num_ctx = pinnedContext;
      numCtxSource = 'host_preference_pin';
    }
    // A different num_thread reloads the runner, so inference reuses the pin's.
    if (options.num_thread == null && positiveInteger(pinnedEntry.numThread)) {
      options.num_thread = positiveInteger(pinnedEntry.numThread);
    }
  }

  return { options, keepAlive, numCtxSource, pinnedEntry };
}

// Ollama warm request for a pin: generate (or embeddings) with the pin's
// keep-alive, context and CPU thread count.
function buildWarmPayload(model, { keepAlive = -1, contextSize = 0, numThread = 0 } = {}) {
  if (isEmbeddingModelName(model)) {
    // keep_alive passes through for embeddings too, including -1 (pin
    // forever); a positive-only guard let embedding pins expire on Ollama's
    // 5-minute default and loop on autoRestore.
    const payload = { model, prompt: 'warmup' };
    if (keepAlive !== undefined && keepAlive !== '') {
      payload.keep_alive = Number(keepAlive) > 0 ? `${Math.round(Number(keepAlive))}s` : keepAlive;
    }
    if (positiveInteger(numThread)) payload.options = { num_thread: positiveInteger(numThread) };
    return payload;
  }
  const payload = withContextRefusal({ model, prompt: 'warmup', stream: false, keep_alive: keepAlive, options: { num_predict: 1 } });
  if (contextSize > 0) payload.options.num_ctx = contextSize;
  if (positiveInteger(numThread)) payload.options.num_thread = positiveInteger(numThread);
  return payload;
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function readLoadedContextLength(modelInfo) {
  const value = modelInfo?.context_length
    ?? modelInfo?.contextLength
    ?? modelInfo?.details?.context_length;
  return positiveInteger(value);
}

const MIN_INFINITE_RESIDENCY_MS = 24 * 60 * 60 * 1000;

function readLoadedExpiresAtMs(modelInfo) {
  const parsed = Date.parse(modelInfo?.expires_at ?? modelInfo?.expiresAt ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function minimumExpectedExpiryMs(keepAlive, nowMs = Date.now()) {
  const seconds = Number(keepAlive);
  if (seconds === -1) return nowMs + MIN_INFINITE_RESIDENCY_MS;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  // Refresh finite pins once less than half their requested TTL remains. Cap
  // the threshold at one day so year-long pins do not churn unnecessarily.
  return nowMs + Math.min(seconds * 500, MIN_INFINITE_RESIDENCY_MS);
}

// Ollama reports `size` (total) and `size_vram` (the GPU share). On a GPU
// host, a resident whose GPU share is below its total runs partly or wholly on
// CPU: a host that booted without its GPU driver, or a pin context too large
// for its co-residents. On a CPU host, any VRAM share means the instance still
// sees a GPU. Missing fields prove nothing, so only a reported mismatch counts.
function readVramSpill(modelInfo, residency = 'gpu') {
  const observed = gpuResidency(modelInfo);
  if (observed.status === 'unknown' || placementMatches(modelInfo, residency)) return null;
  return { size: observed.size, sizeVram: observed.sizeVram, ...(residency === 'cpu' ? { expected: 'cpu' } : {}) };
}

function findLoadedModelInfo(runningModelInfos, model) {
  return (runningModelInfos || []).find(info => pinNamesMatch(info?.name || info?.model, model)) || null;
}

function getWarmOrder(entries) {
  // Load the large generative model first, then the small embedding model.
  // On multi-pin hosts, loading the generative model last can evict an
  // embedding pin that was just restored even when both ultimately fit.
  return [...entries].sort((a, b) => Number(isEmbeddingModelName(a.model)) - Number(isEmbeddingModelName(b.model)));
}

function getLoadedEntryStatus(entry, runningModelInfos, nowMs = Date.now(), residency = 'gpu') {
  const loadedInfo = findLoadedModelInfo(runningModelInfos, entry.model);
  if (!loadedInfo) return { loaded: false, contextMismatch: false, residencyMismatch: false, vramSpill: null };

  const expectedContextLength = positiveInteger(entry.contextSize);
  const loadedContextLength = readLoadedContextLength(loadedInfo);
  const loadedExpiresAtMs = readLoadedExpiresAtMs(loadedInfo);
  const minimumExpiresAtMs = minimumExpectedExpiryMs(entry.keepAlive, nowMs);
  const contextMismatch = !!(
    expectedContextLength &&
    loadedContextLength &&
    loadedContextLength !== expectedContextLength
  );
  const residencyMismatch = !!(
    loadedExpiresAtMs &&
    minimumExpiresAtMs &&
    loadedExpiresAtMs < minimumExpiresAtMs
  );

  return {
    loaded: true,
    gpuResidency: gpuResidency(loadedInfo),
    contextMismatch,
    residencyMismatch,
    vramSpill: readVramSpill(loadedInfo, residency),
    loadedModel: loadedInfo.name || loadedInfo.model || entry.model,
    loadedContextLength,
    expectedContextLength,
    loadedExpiresAt: loadedExpiresAtMs ? new Date(loadedExpiresAtMs).toISOString() : null,
    expectedKeepAlive: entry.keepAlive ?? null
  };
}

// A VRAM spill does not count against satisfaction: reloading the same pin
// cannot fix a missing GPU, so the reconciler reports it instead of churning.
function entrySatisfiedByLoadedModel(entry, runningModelInfos) {
  const status = getLoadedEntryStatus(entry, runningModelInfos);
  return status.loaded && !status.contextMismatch && !status.residencyMismatch;
}

// A pin restore whose warms all completed and whose pins all loaded with their
// context and keep-alive, but with one partly off the GPU: reduced capacity,
// already reported by the reconciler's spill alert, not a lost runtime to
// quarantine (the watchdog must not treat it as a failed mutation).
function isSpillOnlyRestore(result) {
  const statuses = result?.verification?.statuses;
  return Array.isArray(statuses) && statuses.length > 0
    && (result.results || []).every(item => item?.status === 'ok')
    && statuses.every(s => s.loaded && !s.contextMismatch && !s.residencyMismatch)
    && statuses.some(s => s.vramSpill);
}

async function fetchRunningModelInfosStrict(hostUrl, timeoutMs = 5_000, options = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const psResponse = await fetch(`${hostUrl}/api/ps`, { signal });
  if (!psResponse.ok) throw new Error(`Ollama model inventory returned HTTP ${psResponse.status}`);
  const psData = await psResponse.json();
  if (!Array.isArray(psData?.models)) throw new Error('Ollama model inventory is malformed');
  return psData.models;
}

async function fetchRunningModelInfos(hostUrl, timeoutMs = 5_000, options = {}) {
  try {
    return await fetchRunningModelInfosStrict(hostUrl, timeoutMs, options);
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : error;
    }
    return [];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyPinnedEntriesLoaded(hostUrl, entries, timeoutMs = pinRestoreVerifyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const residency = hostResidency(hostUrl);
  let runningModelInfos = [];
  let statuses = [];

  do {
    runningModelInfos = await fetchRunningModelInfos(hostUrl);
    statuses = entries.map(entry => ({
      model: entry.model,
      ...getLoadedEntryStatus(entry, runningModelInfos, Date.now(), residency)
    }));

    // Missing legacy metadata can verify loading without proving placement.
    // gpuVerified means "placed as the host declares": VRAM on a GPU host, none on a CPU host.
    if (statuses.every(status => status.loaded && !status.contextMismatch && !status.residencyMismatch
      && !status.vramSpill)) {
      return {
        verified: true,
        residency,
        gpuVerified: statuses.length > 0 && statuses.every(status => status.gpuResidency?.status === expectedStatus(residency)),
        runningModels: runningModelInfos.map(m => m.name || m.model).filter(Boolean),
        statuses
      };
    }

    if (Date.now() >= deadline) break;
    await sleep(1_000);
  } while (Date.now() < deadline);

  return {
    verified: false,
    residency,
    gpuVerified: false,
    runningModels: runningModelInfos.map(m => m.name || m.model).filter(Boolean),
    statuses
  };
}

module.exports = {
  pinRestoreVerifyTimeoutMs,
  normalizePinName,
  pinNamesMatch,
  getPinnedEntries,
  getPinnedModelNames,
  getPrimaryPinnedModel,
  resolvePinnedRuntimeOptions,
  buildWarmPayload,
  positiveInteger,
  readLoadedContextLength,
  readLoadedExpiresAtMs,
  minimumExpectedExpiryMs,
  readVramSpill,
  findLoadedModelInfo,
  isEmbeddingModelName,
  getWarmOrder,
  getLoadedEntryStatus,
  entrySatisfiedByLoadedModel,
  isSpillOnlyRestore,
  fetchRunningModelInfos,
  fetchRunningModelInfosStrict,
  sleep,
  verifyPinnedEntriesLoaded
};
