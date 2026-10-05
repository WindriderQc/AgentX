/**
 * Host Test Service
 *
 * Lightweight performance probe for models on Ollama hosts.
 * Measures: tokens/sec, prompt eval speed, latency, TTFT, VRAM.
 * Persists results to HostPerformanceSnapshot (benchmark-owned collection).
 *
 * Warm-up protocol ensures model is loaded into VRAM before measuring.
 * All models on a single host are tested sequentially to avoid GPU contention.
 *
 * Config (env vars):
 *   HOST_TEST_TIMEOUT_MS       - Per-model test timeout (default 60000)
 *   HOST_TEST_NUM_PREDICT      - Tokens to generate (default 64)
 *   HOST_TEST_CONTEXT_FILL_PCT - % of num_ctx to fill with prompt (default 25)
 *   HOST_TEST_WARMUP           - Enable warm-up (default true)
 */

const { generateFillPrompt }   = require('./contextProbePayload');
const { getConfiguredHosts }   = require('../helpers/ollamaHostConfig');
const {
  OUTBOUND_ERROR_CODES,
  readBoundedText
} = require('../../../shared/outboundHttpExecutor');
const { resolveModelNumCtxDetails, normalizeModelName } = require('./modelContextResolver');
const circuitBreaker           = require('../helpers/circuitBreaker');
const logger                   = require('../../config/logger');
const {
  HOST_TEST_OPERATIONS,
  HOST_TEST_OPERATION_SPECS,
  configuredCoreOrigin,
  operationMatches,
  createHostTestExecutor,
  hostTestExecutor,
  hostTestRequest,
  createLocalDeadline,
  legacyHttpErrorMessage,
  checkHost,
  combineAbortSignals,
  throwIfAborted
} = require('./hostTestOutbound');
const { getConfig, buildProbePlan } = require('./hostTestConfig');
const {
  getLoadedModelInfo,
  buildWarmupRequest,
  unloadCurrentModel,
  unloadOneModel,
  warmUp,
  snapshotVram,
  verifyAppliedContext
} = require('./hostTestWarmup');
const { persistHostSnapshot, persistFailureSnapshot } = require('./hostTestSnapshots');
const { readExactGenerateTerminal, readOllamaGenerateStream } = require('./hostTestRuntimeTransport');

/** Parse Ollama's NDJSON stream and measure the first emitted output token. */
// ── Core Test Functions ────────────────────────────────────────────────────────

/**
 * Test a single model on a specific host.
 *
 * @param {string} modelName
 * @param {string} hostUrl
 * @param {object} [options]
 * @param {string} [options.hostId] - 'primary' | 'secondary' | 'tertiary'
 * @returns {Promise<object>} HostPerformanceSnapshot-compatible snapshot
 */
async function testModelOnHost(modelName, hostUrl, options = {}) {
  const cfg = getConfig({ ...options, timeoutMs: require('./probePlacement').residencyTimeoutMs(hostUrl, getConfig(options).timeoutMs) });
  const { hostId, _skipHostCheck } = options;
  const checkpoint = typeof options.assertClaimActive === 'function' ? options.assertClaimActive : () => {};
  const signal = options.signal || null;
  const workloadId = options.benchmarkClaim?.claimBatchId || null;
  const normalizedModelName = normalizeModelName(modelName);
  checkpoint();
  throwIfAborted(signal);

  // Circuit breaker gate (when host check is skipped, we still enforce the breaker)
  if (_skipHostCheck) {
    const gate = circuitBreaker.canRequest(hostUrl);
    if (!gate.allowed) {
      const snapshot = {
        hostUrl, hostId: hostId || null, tokensPerSec: 0, latencyMs: 0,
        numCtx: null, numCtxSource: null, testedAt: new Date(),
        status: 'error', error: gate.reason, source: 'benchmark_host_test'
      };
      checkpoint();
      throwIfAborted(signal);
      await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
      return snapshot;
    }
  }

  // 1. Validate host (skip if caller already verified, e.g. testAllModelsOnHost)
  if (!_skipHostCheck) {
    const hostCheck = await checkHost(hostUrl, { signal });
    throwIfAborted(signal);
    if (!hostCheck.available) {
      throw new Error(`Host unreachable: ${hostUrl} (${hostCheck.error})`);
    }
    if (!hostCheck.models.includes(normalizedModelName)) {
      throw new Error(`Model "${modelName}" not found on host ${hostUrl}`);
    }
  }

  const numCtxDetails = await resolveModelNumCtxDetails(normalizedModelName, {
    targetHost: hostUrl,
    skipPriorProfileArtifacts: options.skipPriorProfileArtifacts === true
  });
  const explicitNumCtx = Number.isFinite(Number(options.numCtx)) && Number(options.numCtx) > 0
    ? Number(options.numCtx)
    : null;
  let numCtx = explicitNumCtx || numCtxDetails.num_ctx;
  let numCtxSource = explicitNumCtx ? 'runtime_override' : numCtxDetails.source;

  // 2. Warm-up (two passes: load model, then prime KV cache at target context)
  if (cfg.warmup) {
    checkpoint();
    logger.info('Host test: warming up model', { modelName, hostUrl, numCtx });
    const warmUpStartedAt = Date.now();
    try {
      await warmUp(hostUrl, normalizedModelName, cfg.timeoutMs, numCtx, hostTestExecutor, options.benchmarkClaim || null, signal);
      checkpoint();
      // A first profile has no measured context yet. Observe the cold load,
      // then keep that exact context for the prime and measured probe.
      if (!numCtx) {
        numCtx = await verifyAppliedContext(hostUrl, normalizedModelName, null, signal);
        numCtxSource = 'ollama_ps_observed';
        checkpoint();
      }
      // Second pass with a small prompt at target num_ctx to prime KV cache allocation
      checkpoint();
      await warmUp(hostUrl, normalizedModelName, cfg.timeoutMs, numCtx, hostTestExecutor, options.benchmarkClaim || null, signal);
      checkpoint();
    } catch (err) {
      throwIfAborted(signal);
      circuitBreaker.recordFailure(hostUrl);
      const snapshot = {
        hostUrl,
        hostId:      hostId || null,
        tokensPerSec: 0,
        latencyMs:    Date.now() - warmUpStartedAt,
        numCtx,
        numCtxSource,
        testedAt:     new Date(),
        status:       'error',
        error:        err.message,
        source:       'benchmark_host_test'
      };
      checkpoint();
      throwIfAborted(signal);
      await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
      return snapshot;
    }
  }

  // 3. Probe
  const probePlan = buildProbePlan(numCtx, cfg);
  const { targetPromptTokens, requestedPromptTokens, promptWorkloadMode } = probePlan;
  const { prompt } = generateFillPrompt(targetPromptTokens);

  checkpoint();
  const start = Date.now();
  let probeData;
  const probeDeadline = createLocalDeadline(
    cfg.timeoutMs,
    HOST_TEST_OPERATION_SPECS[HOST_TEST_OPERATIONS.PROBE].policy.deadlineMs
  );
  try {
    const url = `${hostUrl}/api/generate`;
    const res = await hostTestRequest(HOST_TEST_OPERATIONS.PROBE, url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(require('./probeThreads').withPinThreads(hostUrl, {
        model:   normalizedModelName,
        prompt,
        stream:  true,
        think: false,
        options: {
          ...(numCtx ? { num_ctx: numCtx } : {}),
          num_predict: cfg.numPredict,
          temperature: 0,
          seed: 7
        }
      })),
      signal: combineAbortSignals(probeDeadline.signal, signal)
    });

    if (!res.ok) {
      throwIfAborted(signal);
      const latencyMs = Date.now() - start;
      circuitBreaker.recordFailure(hostUrl);
      const body = await readBoundedText(res).catch(() => '');
      const snapshot = {
        hostUrl, hostId, tokensPerSec: 0, latencyMs, numCtx,
        numCtxSource,
        testedAt: new Date(), status: 'error',
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        source: 'benchmark_host_test'
      };
      checkpoint();
      throwIfAborted(signal);
      await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
      return snapshot;
    }

    const streamed = await readOllamaGenerateStream(res, start);
    throwIfAborted(signal);
    probeData = streamed.data;
    probeData._latencyMs = streamed.clientDurationMs;
    probeData._timeToFirstTokenMs = streamed.timeToFirstTokenMs;
    checkpoint();
    probeData._observedNumCtx = await verifyAppliedContext(hostUrl, normalizedModelName, numCtx, signal);
    if (!numCtx) {
      numCtx = probeData._observedNumCtx;
      numCtxSource = 'ollama_ps_observed';
    }
    checkpoint();
  } catch (err) {
    throwIfAborted(signal);
    if (err.retainAdmission === true || err.code === 'HOST_SNAPSHOT_RECONCILIATION_PENDING') throw err;
    circuitBreaker.recordFailure(hostUrl);
    const latencyMs = Date.now() - start;
    const isTimeout = probeDeadline.expired
      || err.code === OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED
      || err.type === 'request-timeout'
      || err.message.includes('timeout');
    const errorMessage = probeDeadline.expired
      && err?.code === OUTBOUND_ERROR_CODES.CALLER_ABORTED
      ? `request timeout after ${cfg.timeoutMs}ms`
      : legacyHttpErrorMessage(err);
    const snapshot = {
      hostUrl, hostId, tokensPerSec: 0, latencyMs, numCtx,
      numCtxSource,
      testedAt: new Date(), status: isTimeout ? 'timeout' : 'error',
      error: errorMessage,
      source: 'benchmark_host_test'
    };
    checkpoint();
    throwIfAborted(signal);
    await persistFailureSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
    return snapshot;
  } finally {
    probeDeadline.dispose();
  }

  // 4. Parse metrics from Ollama response
  const evalCount           = probeData.eval_count           || 0;
  const evalDuration        = probeData.eval_duration        || 0;  // nanoseconds
  const promptEvalCount     = probeData.prompt_eval_count    || 0;
  const promptEvalDuration  = probeData.prompt_eval_duration || 0;

  const evalDurationSec       = evalDuration / 1e9;
  const promptEvalDurationSec = promptEvalDuration / 1e9;

  const tokensPerSec = evalDurationSec > 0
    ? Number((evalCount / evalDurationSec).toFixed(2))
    : 0;
  const promptEvalTps = promptEvalDurationSec > 0
    ? Number((promptEvalCount / promptEvalDurationSec).toFixed(2))
    : null;
  const promptEvalDurationMs = promptEvalDuration > 0
    ? Number((promptEvalDuration / 1e6).toFixed(1))
    : null;
  const timeToFirstTokenMs = Number.isFinite(probeData._timeToFirstTokenMs)
    ? probeData._timeToFirstTokenMs
    : null;

  // 5. VRAM snapshot
  const vram = await snapshotVram(hostUrl, signal);
  checkpoint();
  throwIfAborted(signal);

  // 6. Build and persist snapshot
  const snapshot = {
    hostUrl,
    hostId:                 hostId || null,
    tokensPerSec,
    promptEvalTokensPerSec: promptEvalTps,
    promptEvalDurationMs,
    latencyMs:              probeData._latencyMs,
    timeToFirstTokenMs,
    ttftMeasurement: timeToFirstTokenMs !== null ? 'streamed_wall_clock' : undefined,
    promptTokens:           promptEvalCount,
    completionTokens:       evalCount,
    requestedPromptTokens,
    promptWorkloadMode,
    vramUsedMiB:            vram.usedMiB,
    vramTotalMiB:           vram.totalMiB,
    numCtx,
    observedNumCtx:          probeData._observedNumCtx,
    numCtxSource,
    testedAt:               new Date(),
    status:                 'pass',
    error:                  null,
    source:                 'benchmark_host_test'
  };

  checkpoint();
  throwIfAborted(signal);
  await persistHostSnapshot(normalizedModelName, snapshot, { signal, checkpoint, workloadId });
  circuitBreaker.recordSuccess(hostUrl);

  logger.info('Host test completed', {
    modelName: normalizedModelName,
    hostUrl,
    tokensPerSec,
    latencyMs: snapshot.latencyMs,
    numCtx,
    numCtxSource,
    promptTokens: promptEvalCount,
    requestedPromptTokens,
    promptWorkloadMode
  });

  return snapshot;
}

/**
 * Test all models on a specific host (sequential).
 *
 * @param {string} hostUrl
 * @param {object} [options]
 * @param {string} [options.hostId]
 * @param {function} [options.onProgress] - (modelName, result, index, total) => void
 * @returns {Promise<{ host: string, results: object[], summary: object }>}
 */
async function testAllModelsOnHost(hostUrl, options = {}) {
  const { hostId, onProgress, shouldAbort } = options;

  const hostCheck = await checkHost(hostUrl, { signal: options.signal });
  throwIfAborted(options.signal);
  if (!hostCheck.available) {
    throw new Error(`Host unreachable: ${hostUrl} (${hostCheck.error})`);
  }

  const models = hostCheck.models;
  const results = [];

  for (let i = 0; i < models.length; i++) {
    if (typeof shouldAbort === 'function' && shouldAbort()) {
      logger.info('Host test aborted by caller', { hostUrl, completedModels: i, totalModels: models.length });
      break;
    }
    const modelName = models[i];
    let result;
    try {
      result = await testModelOnHost(modelName, hostUrl, {
        hostId,
        _skipHostCheck: true,
        benchmarkClaim: options.benchmarkClaim || null,
        assertClaimActive: options.assertClaimActive,
        signal: options.signal
      });
    } catch (err) {
      throwIfAborted(options.signal);
      if (err.retainAdmission === true || err.code === 'HOST_SNAPSHOT_RECONCILIATION_PENDING') throw err;
      if (err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      result = {
        hostUrl, hostId, tokensPerSec: 0, latencyMs: 0,
        numCtx: null, testedAt: new Date(),
        status: 'error', error: err.message
      };
      logger.error('Host test failed for model', { modelName, hostUrl, error: err.message });
    }
    results.push({ modelName, ...result });
    if (onProgress) {
      try {
        onProgress(modelName, result, i, models.length);
      } catch (_err) {
        // Ignore progress callback failures; they should not abort host testing.
      }
    }
  }

  const passing = results.filter(r => r.status === 'pass');
  const summary = {
    total:   results.length,
    passed:  passing.length,
    failed:  results.length - passing.length,
    avgTps:  passing.length > 0
      ? Number((passing.reduce((s, r) => s + r.tokensPerSec, 0) / passing.length).toFixed(2))
      : 0
  };

  return { host: hostUrl, results, summary };
}

/**
 * Test a model across all configured hosts.
 *
 * @param {string} modelName
 * @param {object} [options]
 * @returns {Promise<{ modelName: string, hostResults: object[] }>}
 */
async function testModelAcrossHosts(modelName, options = {}) {
  const configuredHosts = getConfiguredHosts();
  const hostResults = [];
  const normalizedModelName = normalizeModelName(modelName);

  for (const host of configuredHosts) {
    options.assertClaimActive?.();
    const check = await checkHost(host.url, { signal: options.signal });
    throwIfAborted(options.signal);
    if (!check.available || !check.models.includes(normalizedModelName)) {
      continue;
    }

    options.assertClaimActive?.();
    const snapshot = await (options.runForHost || ((_host, run) => run()))(host, () => testModelOnHost(normalizedModelName, host.url, {
      hostId:         options.hostIdMap?.[host.url] || host.id || null,
      _skipHostCheck: true,
      benchmarkClaim: options.claimIdentityFor?.(host.url) || null,
      assertClaimActive: options.assertClaimActive,
      signal: options.signal
    }));

    hostResults.push({ hostId: host.id, hostUrl: host.url, ...snapshot });
  }

  return { modelName: normalizedModelName, hostResults };
}

module.exports = {
  testModelOnHost,
  testAllModelsOnHost,
  testModelAcrossHosts,
  checkHost,
  getConfig,
  buildProbePlan,
  buildWarmupRequest,
  HOST_TEST_OPERATIONS,
  _internal: {
    HOST_TEST_OPERATION_SPECS,
    configuredCoreOrigin,
    createHostTestExecutor,
    createLocalDeadline,
    combineAbortSignals,
    throwIfAborted,
    getLoadedModelInfo,
    persistHostSnapshot,
    verifyAppliedContext,
    hostTestRequest,
    operationMatches,
    readExactGenerateTerminal,
    unloadCurrentModel,
    unloadOneModel,
    warmUp,
    readOllamaGenerateStream
  }
};
