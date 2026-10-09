'use strict';
/**
 * Host model runtime mutations: bounded Ollama warm/unload requests and the
 * HostPreference loadedModel/status writes that follow them. Extracted
 * verbatim from hostPreferenceService.js, which re-exports its public names.
 */

const HostPreference = require('../../models/HostPreference');
const { getPrimaryPinnedModel, buildWarmPayload, isEmbeddingModelName } = require('./hostPinPrimitives');

let pinWarmTimeoutMs = parseInt(process.env.PIN_WARM_TIMEOUT_MS, 10);
if (!Number.isFinite(pinWarmTimeoutMs) || pinWarmTimeoutMs < 30_000) {
  pinWarmTimeoutMs = 600_000;
}

function combineRuntimeSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function warmDefaultModel(hostUrl, model, {
  keepAlive = -1,
  contextSize = 0,
  numThread = 0,
  signal = null,
  assertAuthorityActive = null,
  timeoutMs = pinWarmTimeoutMs
} = {}) {
  let requestSignal = null;
  try {
    assertAuthorityActive?.();
    const isEmbedding = isEmbeddingModelName(model);
    const endpoint = isEmbedding ? 'embeddings' : 'generate';
    const payload = buildWarmPayload(model, { keepAlive, contextSize, numThread });
    requestSignal = combineRuntimeSignal(signal, timeoutMs);
    const response = await fetch(`${hostUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: requestSignal
    });
    if (!response.ok) {
      const text = await response.text();
      return { host: hostUrl, model, status: 'error', error: text };
    }
    const raw = await response.text();
    assertAuthorityActive?.();
    let terminal;
    try { terminal = JSON.parse(raw); } catch { terminal = null; }
    const errorFree = terminal && typeof terminal === 'object' && !Array.isArray(terminal)
      && typeof terminal.error !== 'string';
    const exactTerminal = isEmbedding
      ? errorFree && (Array.isArray(terminal.embedding) || Array.isArray(terminal.embeddings))
      : errorFree && terminal.done === true;
    if (!exactTerminal) {
      throw Object.assign(new Error(isEmbedding
        ? 'Ollama embedding warmup ended without a terminal embedding array'
        : 'Ollama warmup ended without an exact terminal done object'), {
        code: 'OLLAMA_RESPONSE_INCOMPLETE'
      });
    }
    return { host: hostUrl, model, status: 'ok' };
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : err;
    }
    if (requestSignal?.aborted) {
      const error = new Error(`Ollama warmup outcome is unknown after its bounded request expired: ${err.message}`);
      error.code = 'RUNTIME_MUTATION_OUTCOME_UNKNOWN';
      error.cause = err;
      throw error;
    }
    return { host: hostUrl, model, status: 'error', error: err.message };
  }
}

async function unloadModel(hostUrl, model, options = {}) {
  let requestSignal = null;
  try {
    options.assertAuthorityActive?.();
    requestSignal = combineRuntimeSignal(options.signal, options.timeoutMs || 30_000);
    const response = await fetch(`${hostUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: requestSignal
    });
    if (!response.ok) {
      const text = await response.text();
      return { host: hostUrl, model, status: 'error', error: text };
    }
    const raw = await response.text();
    options.assertAuthorityActive?.();
    let terminal;
    try { terminal = JSON.parse(raw); } catch { terminal = null; }
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)
      || typeof terminal.error === 'string' || terminal.done !== true) {
      throw Object.assign(new Error('Ollama unload ended without an exact terminal done object'), {
        code: 'OLLAMA_RESPONSE_INCOMPLETE'
      });
    }
    return { host: hostUrl, model, status: 'ok' };
  } catch (err) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : err;
    }
    if (requestSignal?.aborted) {
      const error = new Error(`Ollama unload outcome is unknown after its bounded request expired: ${err.message}`);
      error.code = 'RUNTIME_MUTATION_OUTCOME_UNKNOWN';
      error.cause = err;
      throw error;
    }
    return { host: hostUrl, model, status: 'error', error: err.message };
  }
}

async function updateLoadedModel(hostUrl, model, options = {}) {
  options.assertAuthorityActive?.();
  const pref = await HostPreference.findOne(
    { hostUrl },
    null,
    options.signal ? { signal: options.signal } : {}
  ).lean();
  options.assertAuthorityActive?.();
  const fencedClaim = options.benchmarkClaim || null;
  if (fencedClaim && (pref?.status !== 'benchmarking'
    || pref?.benchmarkClaim?.batchId !== fencedClaim.batchId
    || pref?.benchmarkClaim?.claimGeneration !== fencedClaim.claimGeneration)) {
    const error = new Error('Benchmark claim no longer owns the host while restoring pins');
    error.code = 'BENCHMARK_CLAIM_LOST';
    throw error;
  }
  const update = { loadedModel: model };
  const primary = getPrimaryPinnedModel(pref);
  if (!fencedClaim && primary && primary === model) {
    update.status = 'ready';
  } else if (!fencedClaim && (pref?.status === 'swapping' || pref?.status === 'restoring')) {
    update.status = 'idle';
  }
  const filter = { hostUrl };
  if (fencedClaim) {
    filter.status = 'benchmarking';
    filter['benchmarkClaim.batchId'] = fencedClaim.batchId;
    filter['benchmarkClaim.claimGeneration'] = fencedClaim.claimGeneration;
  }
  const updated = await HostPreference.findOneAndUpdate(
    filter,
    { $set: update },
    { new: true, ...(options.signal ? { signal: options.signal } : {}) }
  ).lean();
  options.assertAuthorityActive?.();
  if (fencedClaim && !updated) {
    const error = new Error('Benchmark claim changed during fenced pin restore');
    error.code = 'BENCHMARK_CLAIM_LOST';
    throw error;
  }
  return updated;
}

async function setHostStatus(hostUrl, status, options = {}) {
  options.assertAuthorityActive?.();
  const updated = await HostPreference.findOneAndUpdate(
    { hostUrl },
    { $set: { status } },
    { new: true, ...(options.signal ? { signal: options.signal } : {}) }
  ).lean();
  options.assertAuthorityActive?.();
  return updated;
}

module.exports = {
  combineRuntimeSignal,
  warmDefaultModel,
  unloadModel,
  updateLoadedModel,
  setHostStatus
};
