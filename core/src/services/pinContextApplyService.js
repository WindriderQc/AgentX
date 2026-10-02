'use strict';

/**
 * Operator-confirmed change of one resident pin's context allocation.
 *
 * The Profiler proposes a context; this service only guards the Core write:
 * the named model must still be pinned at the context the operator saw, no
 * other owner may hold the host, every resident must verify fully in VRAM and
 * a short prompt must decode about as fast as it did at the current pin. The
 * pin route runs these checks inside its runtime-mutation lease and reuses the
 * existing verified rollback when any check after the write fails.
 *
 * The pin is an allocation, not a task budget. Per-workload context budgets
 * stay with the inference contract (Benchmark modelContextResolver); this
 * service never writes a throughput knee into the pin.
 */

const { hasActiveBenchmarkClaim } = require('./benchmarkClaimService');
const { hasActiveSessionHold } = require('./hostSessionHoldService');
const {
  getPinnedEntries, pinNamesMatch, isEmbeddingModelName, verifyPinnedEntriesLoaded
} = require('./hostPinPrimitives');

const SPEED_PROMPT = 'In one short sentence, say what a context window is.';
const SPEED_NUM_PREDICT = 64;

function applyError(message, code, statusCode = 409, details = undefined) {
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}

// Codes that attest the request was refused before any pin write.
const CONTEXT_APPLY_REFUSALS = Object.freeze([
  'HOST_PIN_NOT_PINNED', 'HOST_PIN_CONTEXT_STALE', 'HOST_PIN_CONTEXT_UNCHANGED',
  'HOST_PIN_CONTEXT_UNSUPPORTED', 'HOST_PIN_OWNER_BUSY', 'HOST_PIN_BASELINE_UNAVAILABLE',
  'HOST_PIN_NOT_FOUND'
]);

function speedTolerancePct() {
  const value = Number(process.env.PIN_CONTEXT_SPEED_TOLERANCE_PCT);
  return Number.isFinite(value) && value >= 0 && value <= 50 ? value : 10;
}

function validateContextApplyRequest(body = {}) {
  const { model, contextSize, expectedContextSize, operatorDecision } = body;
  if (operatorDecision !== 'apply') {
    throw applyError('Applying a pin context requires operatorDecision "apply"', 'HOST_PIN_DECISION_REQUIRED', 400);
  }
  if (typeof model !== 'string' || !model.trim()) throw applyError('model is required', 'HOST_PIN_INVALID', 400);
  if (!Number.isSafeInteger(contextSize) || contextSize <= 0) {
    throw applyError('contextSize must be a positive integer', 'HOST_PIN_INVALID', 400);
  }
  if (!Number.isSafeInteger(expectedContextSize) || expectedContextSize < 0) {
    throw applyError('expectedContextSize must be the current pin context (integer >= 0)', 'HOST_PIN_INVALID', 400);
  }
  return { model: model.trim(), contextSize, expectedContextSize };
}

/** Refuse, without writing, when the pin or host no longer matches the decision. */
function assertContextApplyAllowed(pref, request) {
  if (!pref) throw applyError('Host preference not found', 'HOST_PIN_NOT_FOUND', 404);
  if (hasActiveBenchmarkClaim(pref) || hasActiveSessionHold(pref)) {
    throw applyError('Another owner holds this host; retry after it releases', 'HOST_PIN_OWNER_BUSY');
  }
  const entry = getPinnedEntries(pref).find(item => pinNamesMatch(item.model, request.model));
  if (!entry) throw applyError(`${request.model} is not pinned on this host`, 'HOST_PIN_NOT_PINNED');
  if (isEmbeddingModelName(entry.model)) {
    throw applyError('Embedding pins have no context proposal', 'HOST_PIN_CONTEXT_UNSUPPORTED');
  }
  if ((entry.contextSize || 0) !== request.expectedContextSize) {
    throw applyError(
      `The pin context is now ${entry.contextSize || 0}, not ${request.expectedContextSize}; reload the proposal`,
      'HOST_PIN_CONTEXT_STALE'
    );
  }
  if ((entry.contextSize || 0) === request.contextSize) {
    throw applyError('The pin already uses this context', 'HOST_PIN_CONTEXT_UNCHANGED');
  }
  return entry;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Decode speed of a short prompt at the pin's allocation. The request uses the
 * pin's own num_ctx and keep-alive, so it measures the resident model rather
 * than reloading it. A missing timing is "unknown", never a pass.
 */
async function measureShortPromptSpeed(hostUrl, entry, {
  signal = null, assertActive = null, samples = 2, timeoutMs = 120_000, fetchImpl = fetch
} = {}) {
  const speeds = [];
  for (let index = 0; index < samples; index++) {
    assertActive?.();
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let body;
    try {
      const response = await fetchImpl(`${hostUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: entry.model,
          prompt: SPEED_PROMPT,
          stream: false,
          keep_alive: entry.keepAlive ?? -1,
          options: {
            num_predict: SPEED_NUM_PREDICT,
            temperature: 0,
            ...(entry.contextSize > 0 ? { num_ctx: entry.contextSize } : {})
          }
        }),
        signal: requestSignal
      });
      if (!response.ok) return { ok: false, error: `Ollama returned HTTP ${response.status}` };
      body = await response.json();
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      return { ok: false, error: error.message };
    }
    const evalCount = Number(body?.eval_count);
    const evalDurationNs = Number(body?.eval_duration);
    if (body?.done !== true || !(evalCount > 0) || !(evalDurationNs > 0)) {
      return { ok: false, error: 'Ollama returned no decode timing' };
    }
    speeds.push(evalCount / (evalDurationNs / 1e9));
  }
  assertActive?.();
  return {
    ok: true,
    tokensPerSec: Number(median(speeds).toFixed(2)),
    samples: speeds.map(value => Number(value.toFixed(2)))
  };
}

/**
 * Build the hooks the pin route runs around its verified write and rollback.
 * `beforeWrite` refuses or measures the current speed; `afterVerified` throws
 * (triggering rollback) on unproven GPU residency or a speed regression.
 */
function createContextApplyHooks(hostUrl, request, deps = {}) {
  const loadPreference = deps.loadPreference;
  const measure = deps.measure || measureShortPromptSpeed;
  const verifyLoaded = deps.verifyLoaded || verifyPinnedEntriesLoaded;
  const tolerancePct = deps.tolerancePct ?? speedTolerancePct();
  let entry = null;
  let before = null;

  return {
    async beforeWrite(_previous, runtime) {
      const pref = await loadPreference(hostUrl);
      entry = assertContextApplyAllowed(pref, request);
      before = await measure(hostUrl, entry, runtime);
      if (!before.ok) {
        throw applyError(`Current short-prompt speed is unknown: ${before.error}`, 'HOST_PIN_BASELINE_UNAVAILABLE');
      }
      return { before };
    },
    async afterVerified({ restored }, runtime) {
      const pref = await loadPreference(hostUrl);
      const entries = getPinnedEntries(pref);
      // A restore that found everything already loaded carries no verification.
      const verification = restored?.verification?.statuses
        ? restored.verification
        : await verifyLoaded(hostUrl, entries);
      if (verification?.gpuVerified !== true) {
        throw applyError('Not every resident is proven fully in VRAM at the new context', 'HOST_PIN_VRAM_UNVERIFIED', 409, {
          statuses: verification?.statuses || []
        });
      }
      const after = await measure(hostUrl, { ...entry, contextSize: request.contextSize }, runtime);
      const floor = before.tokensPerSec * (1 - tolerancePct / 100);
      const speed = { before, after, tolerancePct };
      if (!after.ok) {
        throw applyError(`Short-prompt speed at the new context is unknown: ${after.error}`, 'HOST_PIN_SPEED_UNKNOWN', 409, { speed });
      }
      if (after.tokensPerSec < floor) {
        throw applyError(
          `Short-prompt speed fell from ${before.tokensPerSec} to ${after.tokensPerSec} tok/s (more than ${tolerancePct}%)`,
          'HOST_PIN_SPEED_REGRESSION', 409, { speed }
        );
      }
      return {
        contextApply: {
          model: entry.model,
          previousContextSize: request.expectedContextSize,
          contextSize: request.contextSize,
          speed,
          residents: verification.statuses.map(status => ({
            model: status.model,
            loadedContextLength: status.loadedContextLength ?? null,
            gpuResidency: status.gpuResidency?.status || 'unknown'
          }))
        }
      };
    }
  };
}

module.exports = {
  CONTEXT_APPLY_REFUSALS,
  validateContextApplyRequest,
  assertContextApplyAllowed,
  measureShortPromptSpeed,
  createContextApplyHooks,
  speedTolerancePct
};
