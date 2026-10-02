'use strict';

const hostTestService = require('../hostTestService');
const { jsonMutationDuration } = require('./profilerMutationObservation');
const { listRunning, generate } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const logger = require('../../../config/logger');
const { _median, summarizePositiveMeasurements } = require('./profilerStatistics');
const { _formatCtx } = require('./profilerContextInsight');

/**
 * Detect GPU spill by querying Ollama /api/ps and comparing size_vram vs size.
 * If size_vram < size, the model has spilled weights to CPU RAM.
 */
async function _detectSpill(hostUrl, modelName, signal = null) {
  const safeDefaults = {
    spillDetected: null,
    verified: false,
    lastSafeNumCtx: null,
    spillNumCtx: null,
    vramAtSpill: null,
    sizeVram: null,
    sizeTotal: null
  };

  try {
    const data = await listRunning(hostUrl, { timeoutMs: 8000, signal });
    const models = data.models || [];

    // Same matcher as contextProbeService.snapshotGpuOffload — the two spill
    // checks must agree on which /api/ps row is "this model".
    const entry = models.find(m =>
      isSameOllamaModel(m.name, modelName) || isSameOllamaModel(m.model, modelName)
    );

    if (!entry) {
      logger.debug(`_detectSpill: model ${modelName} not found in /api/ps on ${hostUrl}`);
      return safeDefaults;
    }

    const sizeVram = entry.size_vram;
    const sizeTotal = entry.size;
    if (!Number.isFinite(Number(sizeVram)) || !Number.isFinite(Number(sizeTotal)) || Number(sizeTotal) <= 0) {
      return safeDefaults;
    }
    const spillDetected = require('../probePlacement').placementMismatch(hostUrl, sizeTotal, sizeVram);

    return {
      spillDetected,
      verified: true,
      lastSafeNumCtx: null,
      spillNumCtx: null,
      vramAtSpill: spillDetected ? Math.round(sizeVram / (1024 * 1024)) : null,
      sizeVram,
      sizeTotal
    };
  } catch (err) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
    logger.debug(`_detectSpill: failed to query ${hostUrl}/api/ps — ${err.message}`);
    return safeDefaults;
  }
}

/**
 * Test throughput at 5 context fill percentages: 10%, 25%, 50%, 75%, 90%.
 * Returns array of { contextFillPct, numCtx, tokensPerSec, vramUsedMiB, gpuOffloaded }.
 */
async function _runThroughputCurve(hostUrl, modelName, maxCtx, settings, notify, { checkpoint = () => {}, claimIdentity = null, signal = null } = {}) {
  const percentages = [10, 25, 50, 75, 90];
  const minimumSamples = Math.max(5, Number(settings.fullPhaseRepeats) || 5);
  const results = [];

  for (const pct of percentages) {
    checkpoint();
    const numCtx = Math.max(512, Math.round(maxCtx));
    if (notify) notify('throughput_curve', { message: `Throughput curve: testing ${pct}% fill (${_formatCtx(numCtx)} ctx)…` });
    const samples = [];
    for (let repeat = 1; repeat <= minimumSamples; repeat += 1) {
      try {
        checkpoint();
        const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, {
          numPredict: settings.numPredict,
          contextFillPct: pct,
          numCtx,
          promptWorkloadMode: 'scaled',
          timeoutMs: settings.testTimeoutSec * 1000,
          benchmarkClaim: claimIdentity,
          assertClaimActive: checkpoint,
          signal
        });
        checkpoint();
        const spillCheck = await _detectSpill(hostUrl, modelName, signal);
        checkpoint();
        samples.push({
          repeat,
          status: testResult.status === 'pass' ? 'pass' : 'error',
          tokensPerSec: testResult.tokensPerSec,
          vramUsedMiB: testResult.vramUsedMiB,
          gpuOffloaded: spillCheck.verified === true ? spillCheck.spillDetected : null,
          error: testResult.status === 'pass' ? null : (testResult.error || testResult.status)
        });
      } catch (err) {
        if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
        logger.warn(`_runThroughputCurve: ${pct}% repeat ${repeat} failed for ${modelName} — ${err.message}`);
        samples.push({ repeat, status: 'error', tokensPerSec: null, vramUsedMiB: null, gpuOffloaded: null, error: err.message });
      }
    }
    const passing = samples.filter(sample => sample.status === 'pass'
      && Number(sample.tokensPerSec) > 0);
    const throughputStatistics = summarizePositiveMeasurements(
      passing.map(sample => sample.tokensPerSec),
      { minimumSamples }
    );
    results.push({
      contextFillPct: pct,
      numCtx,
      tokensPerSec: throughputStatistics.p50 || 0,
      vramUsedMiB: _median(passing.map(sample => Number(sample.vramUsedMiB)).filter(Number.isFinite)),
      gpuOffloaded: samples.every(sample => sample.gpuOffloaded === false)
        ? false
        : samples.some(sample => sample.gpuOffloaded === true) ? true : null,
      sampleCount: samples.length,
      passingSampleCount: passing.length,
      minimumSamples,
      samples,
      throughputStatistics
    });
  }

  return results;
}

/**
 * Test generation stability at 3 output token lengths: 64, 256, 512.
 * Returns array of { numPredict, tokensPerSec, totalLatencyMs }.
 */
async function _runGenerationStability(hostUrl, modelName, numCtx, settings, notify, { checkpoint = () => {}, claimIdentity = null, signal = null } = {}) {
  const targets = [64, 256, 512];
  const minimumSamples = Math.max(5, Number(settings.fullPhaseRepeats) || 5);
  const results = [];

  for (const target of targets) {
    checkpoint();
    if (notify) notify('generation_stability', { message: `Stability: generating ${target} tokens…` });
    const samples = [];
    for (let repeat = 1; repeat <= minimumSamples; repeat += 1) {
      try {
        checkpoint();
        const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, {
          maxPromptTokens: settings.maxPromptTokens,
          numPredict: target,
          numCtx,
          promptWorkloadMode: 'fixed',
          timeoutMs: settings.testTimeoutSec * 1000,
          benchmarkClaim: claimIdentity,
          assertClaimActive: checkpoint,
          signal
        });
        checkpoint();
        samples.push({
          repeat,
          status: testResult.status === 'pass' ? 'pass' : 'error',
          tokensPerSec: testResult.tokensPerSec,
          totalLatencyMs: testResult.latencyMs,
          error: testResult.status === 'pass' ? null : (testResult.error || testResult.status)
        });
      } catch (err) {
        if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
        logger.warn(`_runGenerationStability: ${target} tokens repeat ${repeat} failed for ${modelName} — ${err.message}`);
        samples.push({ repeat, status: 'error', tokensPerSec: null, totalLatencyMs: null, error: err.message });
      }
    }
    const passing = samples.filter(sample => sample.status === 'pass'
      && Number(sample.tokensPerSec) > 0
      && Number(sample.totalLatencyMs) > 0);
    const throughputStatistics = summarizePositiveMeasurements(passing.map(sample => sample.tokensPerSec), { minimumSamples });
    const latencyStatistics = summarizePositiveMeasurements(passing.map(sample => sample.totalLatencyMs), { minimumSamples });
    results.push({
      numPredict: target,
      tokensPerSec: throughputStatistics.p50 || 0,
      totalLatencyMs: latencyStatistics.p50 || 0,
      sampleCount: samples.length,
      passingSampleCount: passing.length,
      minimumSamples,
      samples,
      throughputStatistics,
      latencyStatistics
    });
  }

  return results;
}

/**
 * Measure cold start and hot start latency.
 * 1. Unload model (keep_alive: 0)
 * 2. Wait 2 seconds
 * 3. Cold start: timed generate call
 * 4. Hot start: immediate second generate call
 */
async function _runLoadTiming(hostUrl, modelName, { checkpoint = () => {}, signal = null, numCtx, minimumSamples: requestedSamples = 3 } = {}) {
  if (!Number.isInteger(numCtx) || numCtx <= 0) throw new Error('Load timing requires the measured context allocation');
  const minimumSamples = Math.max(3, Number(requestedSamples) || 3);
  const samples = [];
  const verifyContext = async () => {
    const loaded = await listRunning(hostUrl, { timeoutMs: 10000, signal });
    checkpoint();
    const resident = (loaded?.models || []).find(entry => isSameOllamaModel(entry?.name || entry?.model, modelName));
    if (Number(resident?.context_length) !== numCtx) {
      throw new Error(`Load timing context mismatch: requested ${numCtx}, observed ${resident?.context_length ?? 'unknown'}`);
    }
  };
  const abortableDelay = () => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const timer = setTimeout(() => finish(resolve), 2000);
      const abort = () => {
        clearTimeout(timer);
        finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('Profiler claim stopped')));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  for (let repeat = 1; repeat <= minimumSamples; repeat += 1) {
    let unloadPending = false;
    try {
      checkpoint();
      unloadPending = true;
      await generate(hostUrl, { model: modelName, keep_alive: 0, stream: false }, { timeoutMs: 10000, signal });
      unloadPending = false;
      checkpoint();
      await abortableDelay();
      checkpoint();
      const afterUnload = await listRunning(hostUrl, { timeoutMs: 10000, signal });
      const stillResident = (afterUnload?.models || []).some(entry => isSameOllamaModel(entry?.name || entry?.model, modelName));
      if (stillResident) throw Object.assign(new Error('Cold-load sample invalid: model remained resident after unload'), { code: 'COLD_UNLOAD_NOT_ATTESTED' });

      const coldStart = Date.now();
      const request = { model: modelName, prompt: 'Hi', stream: false, think: false, options: { num_ctx: numCtx, num_predict: 1, temperature: 0, seed: 7 } };
      const coldResponse = await generate(hostUrl, request, { timeoutMs: 120000, signal });
      checkpoint();
      const coldLoadMs = jsonMutationDuration(coldResponse, Date.now() - coldStart);
      await verifyContext();
      const hotStart = Date.now();
      const hotResponse = await generate(hostUrl, request, { timeoutMs: 30000, signal });
      checkpoint();
      const hotLoadMs = jsonMutationDuration(hotResponse, Date.now() - hotStart);
      await verifyContext();
      samples.push({ repeat, status: 'pass', unloadVerified: true, contextVerified: true, numCtx, coldLoadMs, hotLoadMs });
    } catch (err) {
      if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      if (unloadPending) {
        err.retainAdmission = true;
        err.code = err.code || 'OLLAMA_UNLOAD_TERMINALITY_UNKNOWN';
        throw err;
      }
      logger.warn(`_runLoadTiming: repeat ${repeat} failed for ${modelName} — ${err.message}`);
      samples.push({ repeat, status: 'error', unloadVerified: false, coldLoadMs: null, hotLoadMs: null, error: err.message });
    }
  }
  const passing = samples.filter(sample => sample.status === 'pass' && sample.unloadVerified === true);
  const coldStatistics = summarizePositiveMeasurements(passing.map(sample => sample.coldLoadMs), { minimumSamples });
  const hotStatistics = summarizePositiveMeasurements(passing.map(sample => sample.hotLoadMs), { minimumSamples });
  return {
    coldLoadMs: coldStatistics.p50,
    hotLoadMs: hotStatistics.p50,
    numCtx,
    contextVerified: passing.length === minimumSamples && passing.every(sample => sample.contextVerified === true),
    unloadVerified: passing.length === minimumSamples,
    sampleCount: samples.length,
    passingSampleCount: passing.length,
    minimumSamples,
    samples,
    coldStatistics,
    hotStatistics
  };
}

module.exports = { _detectSpill, _runThroughputCurve, _runGenerationStability, _runLoadTiming };
