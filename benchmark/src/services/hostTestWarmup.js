/**
 * Host test model residency: loaded-model lookup, unloads, warm-up passes,
 * VRAM snapshot and applied-context verification. Re-exported by
 * ./hostTestService.
 */

const ollamaVramService        = require('./ollamaVramService');
const { withBenchmarkServiceAuth } = require('../helpers/coreServiceAuth');
const { isSameOllamaModel }    = require('../helpers/ollamaModelIdentity');
const {
  OUTBOUND_ERROR_CODES,
  readBoundedJson
} = require('../../../shared/outboundHttpExecutor');
const logger                   = require('../../config/logger');
const {
  CORE_URL,
  HOST_TEST_OPERATIONS,
  HOST_TEST_OPERATION_SPECS,
  hostTestExecutor,
  hostTestRequest,
  createLocalDeadline,
  legacyHttpErrorMessage,
  combineAbortSignals,
  throwIfAborted
} = require('./hostTestOutbound');
const { readExactGenerateTerminal } = require('./hostTestRuntimeTransport');

/**
 * Return loaded model metadata from /api/ps when the target is already in VRAM.
 */
async function getLoadedModelInfo(hostUrl, modelName, executor = hostTestExecutor, signal = null) {
  try {
    const url = `${hostUrl}/api/ps`;
    const res = await hostTestRequest(
      HOST_TEST_OPERATIONS.LOADED_PS,
      url,
      { method: 'GET', signal },
      executor
    );
    if (!res.ok) {
      await res.cancel();
      return null;
    }
    const data = await readBoundedJson(res);
    const loaded = data.models || [];
    return loaded.find(m => isSameOllamaModel(m.name || m.model, modelName)) || null;
  } catch (error) {
    throwIfAborted(signal);
    return null;
  }
}

function readLoadedContextLength(modelInfo) {
  const value = modelInfo?.context_length ?? modelInfo?.contextLength ?? modelInfo?.details?.context_length;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

const WARMUP_TIMEOUT_COLD   = 600000; // 10 min — 40GB+ model swap and context allocation
const WARMUP_TIMEOUT_LOADED =  90000; // 1.5 min — model already in VRAM

function buildWarmupRequest(hostUrl, modelName, alreadyLoaded, numCtx) {
  const { options } = require('./probeThreads').withPinThreads(hostUrl, { model: modelName, options: {
    num_predict: 1,
    temperature: 0.1,
    ...(numCtx ? { num_ctx: numCtx } : {})
  } });
  if (!alreadyLoaded) {
    return {
      phase: 'cold_preload',
      url: `${hostUrl}/api/generate`,
      timeoutMs: WARMUP_TIMEOUT_COLD,
      body: {
        model: modelName,
        prompt: 'Hello',
        stream: false,
        think: false,
        keep_alive: '10m',
        options
      }
    };
  }
  return {
    phase: 'loaded_prime',
    url: `${CORE_URL}/api/inference/generate`,
    timeoutMs: WARMUP_TIMEOUT_LOADED,
    body: {
      model: modelName,
      host: hostUrl,
      prompt: 'Hello',
      stream: false,
      responseMode: 'normalized',
      think: false,
      callerDetail: 'benchmark-host-test-warmup',
      options
    }
  };
}

/**
 * Unload whatever model is currently occupying VRAM so the target model
 * can load cleanly without Ollama juggling both simultaneously.
 */
async function unloadCurrentModel(hostUrl, targetModelName, executor = hostTestExecutor, signal = null) {
  try {
    const url = `${hostUrl}/api/ps`;
    const res = await hostTestRequest(
      HOST_TEST_OPERATIONS.UNLOAD_PS,
      url,
      { method: 'GET', signal },
      executor
    );
    if (!res.ok) {
      await res.cancel();
      return;
    }
    const data = await readBoundedJson(res);
    const loaded = data.models || [];

    for (const m of loaded) {
      if (isSameOllamaModel(m.name, targetModelName)) continue; // already our target
      logger.info('Unloading model before warmup', { hostUrl, model: m.name });
      const genUrl = `${hostUrl}/api/generate`;
      const unloadResponse = await hostTestRequest(HOST_TEST_OPERATIONS.UNLOAD_CURRENT, genUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name, keep_alive: 0, stream: false }),
        signal
      }, executor);
      await readExactGenerateTerminal(unloadResponse, 'pre-warmup unload');
    }
  } catch (err) {
    throwIfAborted(signal);
    err.retainAdmission = true;
    err.code = err.code || 'OLLAMA_UNLOAD_TERMINALITY_UNKNOWN';
    throw err;
  }
}

async function unloadOneModel(hostUrl, modelName, executor = hostTestExecutor, signal = null) {
  const genUrl = `${hostUrl}/api/generate`;
  const response = await hostTestRequest(HOST_TEST_OPERATIONS.UNLOAD_ONE, genUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, keep_alive: 0, stream: false }),
    signal
  }, executor);
  await readExactGenerateTerminal(response, 'context-reload unload');
}

/**
 * Warm up a model by sending a trivial 1-token generation.
 * Ensures the model is loaded into VRAM before the timed test.
 * Uses a longer timeout for cold loads (model not yet in VRAM).
 */
async function warmUp(hostUrl, modelName, _timeoutMs, numCtx, executor = hostTestExecutor, benchmarkClaim = null, signal = null) {
  throwIfAborted(signal);
  const loadedInfo = await getLoadedModelInfo(hostUrl, modelName, executor, signal);
  const requestedNumCtx = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0
    ? Math.round(Number(numCtx))
    : null;
  const loadedNumCtx = readLoadedContextLength(loadedInfo);
  const contextMismatch = !!(loadedInfo && requestedNumCtx && loadedNumCtx && loadedNumCtx !== requestedNumCtx);
  let alreadyLoaded = !!loadedInfo && !contextMismatch;

  if (contextMismatch) {
    const loadedName = loadedInfo.name || loadedInfo.model || modelName;
    logger.info('Unloading model before warmup due to context mismatch', {
      hostUrl,
      modelName,
      loadedModel: loadedName,
      loadedNumCtx,
      requestedNumCtx
    });
    try {
      await unloadOneModel(hostUrl, loadedName, executor, signal);
    } catch (err) {
      throwIfAborted(signal);
      err.retainAdmission = true;
      err.code = err.code || 'OLLAMA_UNLOAD_TERMINALITY_UNKNOWN';
      throw err;
    }
    alreadyLoaded = false;
  }

  if (!alreadyLoaded) {
    await unloadCurrentModel(hostUrl, modelName, executor, signal);
  }

  // Cold loading goes directly to the claimed Ollama host. This prevents a
  // large model's disk load/context allocation from being cut off by a proxy
  // timeout. Once resident, the second warm-up pass goes through Core so the
  // normal direct-lane telemetry remains represented.
  const request = buildWarmupRequest(hostUrl, modelName, alreadyLoaded, numCtx);
  if (request.phase === 'loaded_prime' && benchmarkClaim) {
    Object.assign(request.body, benchmarkClaim);
  }
  logger.info('Host test warm-up', {
    hostUrl,
    modelName,
    alreadyLoaded,
    phase: request.phase,
    timeoutMs: request.timeoutMs
  });

  const deadline = createLocalDeadline(
    request.timeoutMs,
    HOST_TEST_OPERATION_SPECS[HOST_TEST_OPERATIONS.WARMUP].policy.deadlineMs
  );
  try {
    const response = await hostTestRequest(HOST_TEST_OPERATIONS.WARMUP, request.url, {
      method:  'POST',
      headers: request.phase === 'loaded_prime'
        ? withBenchmarkServiceAuth({ 'Content-Type': 'application/json' })
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: combineAbortSignals(deadline.signal, signal)
    }, executor);
    await readExactGenerateTerminal(response, `${request.phase} warm-up`);
  } catch (err) {
    throwIfAborted(signal);
    const errorMessage = deadline.expired
      && err?.code === OUTBOUND_ERROR_CODES.CALLER_ABORTED
      ? `request timeout after ${request.timeoutMs}ms`
      : legacyHttpErrorMessage(err);
    logger.warn('Host test warm-up failed', {
      hostUrl,
      modelName,
      phase: request.phase,
      timeoutMs: request.timeoutMs,
      error: errorMessage
    });
    const failure = new Error(`Warm-up failed during ${request.phase}: ${errorMessage}`);
    failure.code = err?.code || 'HOST_TEST_WARMUP_FAILED';
    if (err?.retainAdmission === true || err?.code === 'OLLAMA_RESPONSE_INCOMPLETE') {
      failure.retainAdmission = true;
    }
    throw failure;
  } finally {
    deadline.dispose();
  }
}

/**
 * Snapshot VRAM usage for a host (best-effort).
 */
async function snapshotVram(hostUrl, signal = null) {
  try {
    const result = await ollamaVramService.getHostVram(hostUrl, { signal });
    if (result.ok) {
      return { usedMiB: result.memoryUsedMiBTotal, totalMiB: result.memoryTotalMiBTotal };
    }
  } catch (err) {
    throwIfAborted(signal);
    logger.warn('Host test VRAM snapshot unavailable', { hostUrl, error: err.message });
  }
  return { usedMiB: null, totalMiB: null };
}

async function verifyAppliedContext(hostUrl, modelName, expectedNumCtx, signal = null, executor = hostTestExecutor) {
  const resident = await getLoadedModelInfo(hostUrl, modelName, executor, signal);
  const observedNumCtx = readLoadedContextLength(resident);
  if (!observedNumCtx) {
    const error = new Error(`Ollama /api/ps did not attest context_length=${expectedNumCtx} for ${modelName}`);
    error.code = 'HOST_TEST_CONTEXT_UNVERIFIED';
    throw error;
  }
  if (expectedNumCtx != null && Number(observedNumCtx) !== Number(expectedNumCtx)) {
    const error = new Error(`Ollama applied context_length=${observedNumCtx}, requested ${expectedNumCtx} for ${modelName}`);
    error.code = 'HOST_TEST_CONTEXT_CLAMPED';
    error.observedNumCtx = observedNumCtx;
    error.requestedNumCtx = Number(expectedNumCtx);
    throw error;
  }
  return observedNumCtx;
}

module.exports = {
  getLoadedModelInfo,
  readLoadedContextLength,
  buildWarmupRequest,
  unloadCurrentModel,
  unloadOneModel,
  warmUp,
  snapshotVram,
  verifyAppliedContext
};
