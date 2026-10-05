'use strict';

const hostTestService = require('../hostTestService');
const contextProbeService = require('../contextProbeService');
const { projectProbeStep } = require('../probeResidency');
const { identitiesMatch, resolveArtifactIdentity } = require('./artifactIdentityService');
const hostProfileService = require('./hostProfileService');
const settingsService = require('./settingsService');
const { _captureHardwareSnapshot, _buildHardwareTelemetry } = require('./profilerHardwareSnapshots');
const { runPrefillDecodeMatrix } = require('./prefillDecodeMatrix');
const { runLongContextQualityProbe } = require('./longContextQualityProbe');
const { profileThinkingBehavior } = require('./thinkingProfileService');
const { resolveModelNumCtxDetails } = require('../modelContextResolver');
const { listRunning, showModel } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const logger = require('../../../config/logger');
const buddySurface = require('../benchmark/buddySurfaceEvents');
const { _formatCtx, buildContextInsight } = require('./profilerContextInsight');
const {
  _median,
  summarizeThroughputSamples,
  _sampleFromResult,
  summarizePositiveMeasurements
} = require('./profilerStatistics');
const {
  _buildProfilerCapabilities,
  contextProbeRepeatsForDepth,
  hasProfilerAuthorityReceipt,
  profileQualificationFailures
} = require('./profilerQualification');
const { persistProfileEvidence } = require('./profilerEvidencePersistence');
const {
  _detectSpill,
  _runThroughputCurve,
  _runGenerationStability,
  _runLoadTiming
} = require('./profilerMeasurementPhases');

async function profile(modelName, hostId, hostUrl, depth = 'standard', {
  onProgress,
  assertClaimActive,
  claimIdentity,
  signal
} = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const checkpoint = typeof assertClaimActive === 'function' ? assertClaimActive : () => {};
  logger.info(`Profiling ${modelName} on ${hostId} (${depth})`);
  checkpoint();
  let residentCtx = null;
  try {
    const running = await listRunning(hostUrl, { timeoutMs: 8000, signal });
    const resident = (running.models || []).find(model =>
      isSameOllamaModel(model.name, modelName) || isSameOllamaModel(model.model, modelName)
    );
    const value = Number(resident?.context_length);
    if (Number.isFinite(value) && value > 0) {
      residentCtx = { num_ctx: Math.floor(value), source: 'ollama_ps_resident' };
    }
  } catch (err) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
    logger.debug(`Could not snapshot resident context for ${modelName}: ${err.message}`);
  }
  const artifact = await resolveArtifactIdentity(modelName, hostId, hostUrl, { refresh: true });
  const settings = await settingsService.getAll();
  const hardwareSnapshots = [];
  const initialHardware = await _captureHardwareSnapshot(hostId, 'before_profile', settings);
  if (initialHardware) hardwareSnapshots.push(initialHardware);

  // Preserve the context of an already-loaded model. Falling back to model
  // metadata is appropriate only when there is no resident runtime to retain.
  let previousCtx = residentCtx;
  if (!previousCtx) {
    try {
      const showData = await showModel(hostUrl, modelName, { signal });
      const paramLines = (showData.parameters || '').split('\n');
      const ctxLine = paramLines.find(l => /^\s*num_ctx\b/i.test(l));
      if (ctxLine) {
        const val = parseInt(ctxLine.replace(/^\s*num_ctx\s+/i, ''), 10);
        if (Number.isFinite(val) && val > 0) {
          previousCtx = { num_ctx: val, source: 'modelfile' };
        }
      }
      // Fall back to model_info context_length (native architecture max)
      if (!previousCtx) {
        const mi = showData.model_info || {};
        const ctxKey = Object.keys(mi).find(k => k.endsWith('.context_length'));
        if (ctxKey && Number.isFinite(mi[ctxKey]) && mi[ctxKey] > 0) {
          previousCtx = { num_ctx: mi[ctxKey], source: 'model_architecture' };
        }
      }
    } catch (err) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
      logger.debug(`Could not read Modelfile context for ${modelName}: ${err.message}`);
    }
  }
  // Last resort: resolution chain
  if (!previousCtx) {
    try {
      previousCtx = await resolveModelNumCtxDetails(modelName, { targetHost: hostUrl });
    } catch (err) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
      logger.debug(`Could not resolve pre-profile context for ${modelName}: ${err.message}`);
    }
  }

  // --- warmup + single throughput test ---
  // skipPriorProfileArtifacts: the materialized context profile and latest probe
  // snapshot are exactly what this re-profile is about to replace. Letting
  // them dictate warm-up ctx makes re-profiling impossible whenever the
  // previous run picked an ambitious ctx the host can no longer warm up
  // within the timeout (e.g. 131072 on a 24GB host).
  notify('warmup', { message: 'Warming up model — sending test prompt…' });
  const baseTestOptions = {
    maxPromptTokens: settings.maxPromptTokens,
    numPredict: settings.numPredict,
    promptWorkloadMode: 'fixed',
    timeoutMs: settings.testTimeoutSec * 1000,
    skipPriorProfileArtifacts: true,
    benchmarkClaim: claimIdentity || null,
    assertClaimActive: checkpoint,
    signal,
    ...(residentCtx ? { numCtx: residentCtx.num_ctx } : {})
  };
  checkpoint();
  const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, baseTestOptions);
  if (testResult.status !== 'pass') {
    throw new Error(`Throughput test failed: ${testResult.error || testResult.status}`);
  }

  const minimumRetainedSamples = depth === 'full'
    ? Math.max(10, Number(settings.fullRetainedSamples) || 10)
    : depth === 'standard'
      ? Math.max(5, Number(settings.standardRetainedSamples) || 5)
      : 1;
  const requestedSamples = depth === 'quick'
    ? 1
    : Math.min(26, Math.max(minimumRetainedSamples + 1, Number(settings.throughputSamples) || 0));
  // When 3+ samples are requested, drop sample 1 from CV stats: even after
  // the explicit 2-pass warm-up, the first measured run can carry KV-cache
  // settle overhead that inflates variance. With 1 or 2 samples we have no
  // budget to discard, so we keep them all.
  const discardFirst = requestedSamples >= 3;
  const throughputSamples = [_sampleFromResult(testResult, 1, discardFirst
    ? { discarded: true, discardReason: 'warmup_settle' }
    : {})];
  for (let i = 2; i <= requestedSamples; i++) {
    checkpoint();
    notify('throughput', { message: `Throughput sample ${i}/${requestedSamples} — repeat run for reliability…`, sample: i, sampleCount: requestedSamples });
    const repeat = await hostTestService.testModelOnHost(modelName, hostUrl, {
      ...baseTestOptions,
      warmup: false
    });
    throughputSamples.push(_sampleFromResult(repeat, i));
    if (repeat.status !== 'pass') {
      logger.warn(`Throughput repeat sample failed for ${modelName} on ${hostId}`, { sample: i, error: repeat.error || repeat.status });
    }
  }
  const measurementQuality = summarizeThroughputSamples(throughputSamples, { minimumRetainedSamples });
  const throughputHardware = await _captureHardwareSnapshot(hostId, 'after_throughput', settings);
  if (throughputHardware) {
    hardwareSnapshots.push(throughputHardware);
    const hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
    if (hardwareTelemetry?.latest?.ok) {
      const hw = hardwareTelemetry.latest;
      const util = hw.utilization != null ? `GPU ${Math.round(hw.utilization)}%` : null;
      const vram = hw.vramUsedMiB != null && hw.vramTotalMiB
        ? `VRAM ${(hw.vramUsedMiB / 1024).toFixed(1)}/${(hw.vramTotalMiB / 1024).toFixed(0)}GB`
        : null;
      const parts = [util, vram, hw.pcieGen && hw.pcieWidth ? `PCIe Gen${hw.pcieGen} x${hw.pcieWidth}` : null].filter(Boolean);
      if (parts.length) {
        notify('throughput', {
          message: `Hardware: ${parts.join(' · ')}`,
          hardwareTelemetry
        });
      }
    }
  }

  const representativeTokensPerSec = measurementQuality.tokensPerSecMedian;
  if (!representativeTokensPerSec) throw new Error('No retained passing throughput sample');
  const representativeSample = throughputSamples
    .filter(sample => !sample.discarded && sample.status === 'pass' && Number(sample.tokensPerSec) > 0)
    .sort((left, right) => Math.abs(Number(left.tokensPerSec) - representativeTokensPerSec)
      - Math.abs(Number(right.tokensPerSec) - representativeTokensPerSec))[0];
  const tpsStr = Number(representativeTokensPerSec).toFixed(1);
  const ttftStr = measurementQuality.ttftP50Ms != null
    ? ` · TTFT p50 ${Math.round(measurementQuality.ttftP50Ms)}ms`
    : '';
  const pevalStr = testResult.promptEvalTokensPerSec ? ` · prompt eval ${Number(testResult.promptEvalTokensPerSec).toFixed(0)} tok/s` : '';
  notify('throughput', {
    message: `Throughput: ${tpsStr} tok/s${ttftStr}${pevalStr} · reliability ${measurementQuality.reliability}`,
    tokensPerSec: representativeTokensPerSec,
    measurementQuality,
    sampleCount: throughputSamples.length
  });

  notify('spill_detection', { message: 'Checking GPU memory offload…' });
  checkpoint();
  const spill = await _detectSpill(hostUrl, modelName, signal);
  checkpoint();
  const spillMsg = spill.verified === false
    ? 'GPU residency unknown — no-spill is not verified'
    : spill.spillDetected
    ? `Spill detected — ${spill.sizeVram && spill.sizeTotal ? Math.round(spill.sizeVram / spill.sizeTotal * 100) : '?'}% on GPU`
    : 'No spill — model placed as the host declares';
  notify('spill_detection', { message: spillMsg });
  const spillHardware = await _captureHardwareSnapshot(hostId, 'after_spill_detection', settings);
  if (spillHardware) hardwareSnapshots.push(spillHardware);

  let thinkingProfile = null;
  if (settings.thinkingProbeEnabled !== false) {
    checkpoint();
    notify('thinking_behavior', { message: 'Checking think=true behavior and visible-answer safety…' });
    try {
      thinkingProfile = await profileThinkingBehavior(modelName, hostUrl, {
        numCtx: testResult.numCtx || null,
        maxNumCtx: testResult.numCtx || undefined,
        numPredict: 512,
        timeoutMs: Math.max(60000, (Number(settings.testTimeoutSec) || 60) * 1000, require('../probePlacement').cpuProbeLimits(hostUrl).timeoutMs || 0),
        signal,
        assertClaimActive: checkpoint
      });
      checkpoint();
      notify('thinking_behavior', {
        message: `Thinking behavior: ${thinkingProfile.recommendedPolicy} (${thinkingProfile.channel}, ${thinkingProfile.supportSignal})`,
        thinking: thinkingProfile
      });
    } catch (err) {
      if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      logger.warn(`Thinking behavior probe failed for ${modelName} on ${hostId}`, { error: err.message });
      thinkingProfile = {
        profiledAt: new Date(),
        apiMode: 'chat',
        supported: false,
        supportSignal: 'error',
        channel: 'error',
        visibleFinalAnswerOk: false,
        finalAnswerContractOk: false,
        thinkingOnlyResponse: false,
        runawayRisk: false,
        recommendedPolicy: 'unknown',
        recommendationReason: `thinking probe failed: ${err.message}`
      };
      notify('thinking_behavior', { message: `Thinking behavior probe failed: ${err.message}`, thinking: thinkingProfile });
    }
  }

  const initialHardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
  const profileData = {
    tokensPerSec: representativeTokensPerSec,
    promptEvalTokensPerSec: representativeSample?.promptEvalTokensPerSec || null,
    promptEvalDurationMs: representativeSample?.promptEvalDurationMs || null,
    ttftMs: measurementQuality.ttftP50Ms ?? null,
    ttftP50Ms: measurementQuality.ttftP50Ms ?? null,
    ttftP95Ms: measurementQuality.ttftP95Ms ?? null,
    ttftMeasurement: measurementQuality.ttftP50Ms != null ? 'streamed_wall_clock' : null,
    // Prompt eval speed and TTFT from samples that each evaluated their whole
    // prompt; profiles without it may report prefill served from Ollama's cache.
    promptIsolation: 'unique_first_line',
    comparisonPromptTokens: representativeSample?.promptTokens || null,
    comparisonPromptTargetTokens: testResult.requestedPromptTokens || null,
    contextProbeFillPct: Number(settings.contextProbeFillPct) || 80,
    comparisonWorkloadMode: testResult.promptWorkloadMode || 'fixed',
    comparisonNumCtx: testResult.numCtx || null,
    comparisonLatencyMs: _median(throughputSamples
      .filter(sample => !sample.discarded && sample.status === 'pass')
      .map(sample => sample.latencyMs)
      .filter(value => Number.isFinite(value) && value > 0)),
    optimalNumCtx: testResult.numCtx || null,
    performanceKneeContext: null,
    performanceKneeDegradationPct: Number(settings.performanceKneeDegradationThreshold) || 15,
    qualityVerifiedContext: null,
    qualityContextStatus: 'unknown',
    vramUsedMiB: testResult.vramUsedMiB || null,
    throughputSamples,
    measurementQuality,
    requiredRetainedSamples: minimumRetainedSamples,
    requiredTtftSamples: minimumRetainedSamples,
    requiredFullPhaseSamples: depth === 'full'
      ? Math.max(5, Number(settings.fullPhaseRepeats) || 5)
      : null,
    fullMaxCoefficientOfVariation: Number(settings.fullMaxCoefficientOfVariation) || 0.12,
    fullMaxRelativeCi95Width: Number(settings.fullMaxRelativeCi95Width) || 0.30,
    spill: {
      ...spill,
      // /api/ps reports offload, not the context that caused it. Attribute a
      // spill only to the throughput call's reported numCtx; if that evidence
      // is absent, keep it null rather than inventing a fallback. A spill also
      // proves no safe context; a later context probe may provide one.
      spillNumCtx: spill.spillDetected === true ? (testResult.numCtx || null) : null,
      lastSafeNumCtx: spill.verified === true && spill.spillDetected === false
        ? (testResult.numCtx || null)
        : null
    },
    profiledAt: new Date(),
    profileDepth: depth,
    thinking: thinkingProfile,
    hardwareTelemetry: initialHardwareTelemetry,
    profilerCapabilities: _buildProfilerCapabilities(depth, initialHardwareTelemetry)
  };

  // --- quick: done here ---
  if (depth === 'quick') {
    notify('saving', { message: 'Saving profile to database…' });
    checkpoint();
    const evidence = await persistProfileEvidence({
      modelName, hostId, hostUrl, artifact, profileData, claimIdentity, assertClaimActive: checkpoint, signal
    });
    return { modelName, hostId, artifact, evidenceId: evidence?._id || null, profile: profileData };
  }

  // --- standard: add context probe ---
  notify('context_probe', { message: 'Probing context window — resolving model limits…' });
  const probeResult = await contextProbeService.probeModelContext(modelName, {
    hostUrl, ...require('../probePlacement').cpuProbeLimits(hostUrl),
    artifactIdentity: artifact,
    acknowledgeMaintenance: true,
    contextProbeFillPct: Number(settings.contextProbeFillPct) || 80,
    interactiveDegradationThreshold: Number(settings.interactiveDegradationThreshold),
    documentDegradationThreshold: Number(settings.documentDegradationThreshold),
    performanceKneeDegradationThreshold: Number(settings.performanceKneeDegradationThreshold),
    candidateRepeats: contextProbeRepeatsForDepth(depth, settings),
    profileDepth: depth,
    workloadId: claimIdentity?.claimBatchId,
    assertClaimActive: checkpoint,
    signal,
    onProgress: (info) => {
      if (info.type === 'resident') {
        const msg = info.tokensPerSec == null
          ? `Validating resident ${_formatCtx(info.numCtx)} context before reload…`
          : `Resident ${_formatCtx(info.numCtx)} context: ${info.tokensPerSec} tok/s ${info.passed ? '✓' : '✗'}`;
        notify('context_probe', { message: msg });
      } else if (info.type === 'baseline') {
        const msg = info.tokensPerSec == null
          ? `Measuring baseline at ${_formatCtx(info.numCtx)} ctx…`
          : `Baseline: ${info.tokensPerSec} tok/s at ${_formatCtx(info.numCtx)} ctx`;
        notify('context_probe', { message: msg });
      } else if (info.type === 'sample') {
        notify('context_probe', { message: `Measuring ${_formatCtx(info.numCtx)} ctx — sample ${info.sample}/${info.sampleCount}…` });
      } else if (info.type === 'step') {
        const dropStr = info.degradationPct != null ? ` (${info.degradationPct}% drop)` : '';
        const verdict = info.passed ? '✓' : '✗';
        notify('context_probe', { message: `Testing ${_formatCtx(info.numCtx)} ctx — ${info.tokensPerSec} tok/s${dropStr} ${verdict}` });
      } else if (info.type === 'result') {
        notify('context_probe', { message: `Largest verified context: ${_formatCtx(info.testedNumCtx)} (${info.degradationPct}% throughput change)` });
      }
    }
  });
  checkpoint();
  // `optimalNumCtx` is retained as a persisted compatibility field. Its value
  // is the largest verified context, not a synthetic performance tier.
  profileData.optimalNumCtx = probeResult.testedNumCtx || null;
  profileData.maxVerifiedContext = probeResult.testedNumCtx || null;
  // 'transport' marks maxVerifiedContext as a floor: the ladder stopped on a
  // client deadline or lost connection with the model fully GPU-resident, not
  // on a capacity limit. The context profile keeps any higher committed ceiling.
  profileData.contextCeilingFailureKind = probeResult.ceilingFailureKind || null;
  profileData.recommendedInteractiveContext = probeResult.recommendedInteractiveContext || null;
  profileData.recommendedDocumentContext = probeResult.recommendedDocumentContext || null;
  profileData.performanceKneeContext = probeResult.performanceKneeContext || null;
  profileData.performanceKneeDegradationPct = Number(probeResult.performanceKneeDegradationThreshold)
    || Number(settings.performanceKneeDegradationThreshold)
    || 15;
  // A window that fits is not a window the model still reads well: only the
  // Full profile's long-context quality probe (below) verifies that.
  profileData.qualityVerifiedContext = null;
  profileData.qualityContextStatus = 'unknown';
  profileData.degradationPct = probeResult.degradationPct || null;
  profileData.contextProbeCandidateRepeats = contextProbeRepeatsForDepth(depth, settings);
  // Samples carry the co-residents observed beside the model (pin proposal evidence).
  profileData.probeSteps = (probeResult.steps || []).map(projectProbeStep);
  const contextHardware = await _captureHardwareSnapshot(hostId, 'after_context_probe', settings);
  if (contextHardware) {
    hardwareSnapshots.push(contextHardware);
    profileData.hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
    profileData.profilerCapabilities = _buildProfilerCapabilities(depth, profileData.hardwareTelemetry);
  }
  // The context probe already records the largest passing point. Preserve the
  // measured value exactly; arbitrary percentage margins create a second,
  // hidden runtime context policy.
  profileData.spill.lastSafeNumCtx = probeResult.testedNumCtx || null;

  // Context insight: compare what was configured vs what probe discovered
  if (previousCtx?.num_ctx) {
    const discovered = profileData.maxVerifiedContext;
    profileData.contextInsight = buildContextInsight(previousCtx.num_ctx, previousCtx.source, discovered);
    if (profileData.contextInsight?.upgradeAvailable) {
      logger.info(`Context upgrade available for ${modelName} on ${hostId}: ${profileData.contextInsight.recommendation}`);
    }
  }

  if (depth === 'standard') {
    notify('saving', { message: 'Saving profile to database…' });
    checkpoint();
    const evidence = await persistProfileEvidence({
      modelName, hostId, hostUrl, artifact, profileData, claimIdentity, assertClaimActive: checkpoint, signal
    });
    notify('saved', { message: `Profile saved for exact artifact ${modelName}` });
    return { modelName, hostId, artifact, evidenceId: evidence?._id || null, profile: profileData };
  }

  // --- full: add throughputCurve + generationStability + loadTiming ---
  const maxCtx = profileData.maxVerifiedContext;
  notify('throughput_curve', { message: `Running throughput curve across 5 context fills (max ${_formatCtx(maxCtx)})…` });
  checkpoint();
  profileData.throughputCurve = await _runThroughputCurve(hostUrl, modelName, maxCtx, settings, notify, { checkpoint, claimIdentity, signal });
  notify('generation_stability', { message: 'Testing generation stability at 64/256/512 output tokens…' });
  checkpoint();
  profileData.generationStability = await _runGenerationStability(hostUrl, modelName, maxCtx, settings, notify, { checkpoint, claimIdentity, signal });
  notify('prefill_decode_matrix', { message: 'Running fixed prefill/decode matrix…' });
  profileData.prefillDecodeMatrix = await runPrefillDecodeMatrix(hostUrl, modelName, {
    safeNumCtx: profileData.spill?.lastSafeNumCtx || maxCtx,
    timeoutMs: require('../probePlacement').residencyTimeoutMs(hostUrl, Math.max(120000, (Number(settings.testTimeoutSec) || 60) * 1000)),
    assertClaimActive: checkpoint,
    signal,
    repeats: Math.max(5, Number(settings.fullPhaseRepeats) || 5),
    captureTelemetry: ({ prefillTokens, decodeTokens, repeat }) => _captureHardwareSnapshot(
      hostId,
      `matrix_${prefillTokens}p_${decodeTokens}d_r${repeat}`,
      settings
    ),
    longPrefill: {
      timeoutMs: require('../probePlacement').residencyTimeoutMs(hostUrl, contextProbeService.getConfig().timeoutMs),
      onProgress: ({ index, total, size }) => notify('prefill_decode_matrix', {
        message: `Agent-sized prefill ${index}/${total} — ${_formatCtx(size.numCtx)}: ${size.status === 'pass'
          ? `${size.prefillTokensPerSec} tok/s, first token ${Math.round(size.ttftMs)} ms` : size.status}`,
      }),
    },
    onProgress: ({ index, total, cell }) => {
      const label = `${cell.prefillTokens}p/${cell.decodeTokens}d`;
      const detail = cell.status === 'pass'
        ? `prefill ${cell.prefillTokensPerSec ?? '?'} tok/s · decode ${cell.decodeTokensPerSec ?? '?'} tok/s`
        : cell.status;
      notify('prefill_decode_matrix', { message: `Matrix ${index}/${total} — ${label}: ${detail}` });
    }
  });
  if (settings.longContextQualityEnabled !== false) {
    notify('long_context_quality', { message: 'Checking recall of planted facts at agent-sized contexts…' });
    checkpoint();
    profileData.longContextQuality = await runLongContextQualityProbe(hostUrl, modelName, {
      maxVerifiedContext: maxCtx,
      timeoutMs: require('../probePlacement').residencyTimeoutMs(hostUrl, contextProbeService.getConfig().timeoutMs),
      signal,
      checkpoint,
      onProgress: ({ index, total, result }) => notify('long_context_quality', {
        message: `Quality ${index}/${total} — ${_formatCtx(result.numCtx)}: ${result.status}`
          + (result.score != null ? ` (${Math.round(result.score * 100)}% exact)` : ''),
      }),
    });
    profileData.qualityVerifiedContext = profileData.longContextQuality.qualityVerifiedContext;
    profileData.qualityContextStatus = profileData.qualityVerifiedContext ? 'verified' : 'unknown';
  }
  notify('load_timing', { message: 'Measuring cold and hot load timing…' });
  profileData.loadTiming = await _runLoadTiming(hostUrl, modelName, {
    checkpoint,
    signal,
    numCtx: maxCtx,
    minimumSamples: profileData.requiredFullPhaseSamples
  });
  const fullHardware = await _captureHardwareSnapshot(hostId, 'after_full_profile', settings);
  if (fullHardware) {
    hardwareSnapshots.push(fullHardware);
    profileData.hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
    profileData.profilerCapabilities = _buildProfilerCapabilities(depth, profileData.hardwareTelemetry);
  }

  notify('saving', { message: 'Saving profile to database…' });
  checkpoint();
  const evidence = await persistProfileEvidence({
    modelName, hostId, hostUrl, artifact, profileData, claimIdentity, assertClaimActive: checkpoint, signal
  });
  notify('saved', { message: `Profile saved for exact artifact ${modelName}` });
  return { modelName, hostId, artifact, evidenceId: evidence?._id || null, profile: profileData };
}

async function preflight(batchConfig) {
  const ready = [], profilesNeeded = [], warnings = [];
  // batchOrchestrator passes the SAME hostUrl for every model in the batch —
  // resolve each distinct URL to its hostId once instead of once per model.
  const hostIdByUrl = new Map();
  for (const model of batchConfig.models) {
    // model.host may be a hostId slug or a hostUrl depending on the caller.
    // batchOrchestrator passes hostUrl. Resolve to the hostId used by storage
    // (ModelProfile.readiness is keyed by the HostProfile slug).
    let hostId = model.host;
    let hostUrl = model.hostUrl || null;
    if (typeof hostId === 'string' && /^https?:\/\//i.test(hostId)) {
      hostUrl = hostUrl || hostId;
      if (!hostIdByUrl.has(hostUrl)) {
        const hostDoc = await hostProfileService.getByUrl(hostUrl);
        hostIdByUrl.set(hostUrl, hostDoc?.hostId || null);
      }
      hostId = hostIdByUrl.get(hostUrl);
      if (!hostId) {
        profilesNeeded.push({ ...model, profileReason: 'host_not_registered' });
        continue;
      }
    }
    if (!hostUrl && hostId) {
      const hostDoc = await hostProfileService.getById(hostId);
      hostUrl = hostDoc?.hostUrl || null;
      if (!hostUrl) {
        profilesNeeded.push({ ...model, profileReason: 'host_not_registered' });
        continue;
      }
    }
    // Carry both the resolved hostId (for DB lookups) and hostUrl (for
    // network calls) on the pushed model so runPreflight doesn't have to
    // re-resolve.
    const resolved = { ...model, host: hostId, hostUrl };

    const artifact = await resolveArtifactIdentity(model.name, hostId, hostUrl, { refresh: true });
    const profile = await ModelProfile.findOne({ name: artifact.model }).select('readiness').lean();
    const readinessForHost = profile?.readiness instanceof Map
      ? profile.readiness.get(hostId)
      : profile?.readiness?.[hostId] || null;
    const performanceEvidence = readinessForHost?.evidenceId
      ? await ModelPerformanceProfile.findOne({
        _id: readinessForHost.evidenceId,
        modelName: artifact.model,
        hostId,
        active: true,
        stale: { $ne: true },
        authorityState: { $nin: ['pending_reconciliation', 'authority_invalidated'] }
      }).lean()
      : null;
    const hasProfile = ['standard', 'full'].includes(readinessForHost?.profileDepth)
      && readinessForHost?.benchmarkQualified === true
      && hasProfilerAuthorityReceipt(readinessForHost, performanceEvidence, {
        modelName: artifact.model,
        hostId
      });

    if (!hasProfile || !identitiesMatch(readinessForHost?.artifact, artifact)) {
      profilesNeeded.push({
        ...resolved,
        artifact,
        profileReason: !hasProfile ? 'missing_or_quick_profile' : 'artifact_or_runtime_drift'
      });
      continue;
    }

    if (readinessForHost?.stale) {
      profilesNeeded.push({ ...resolved, artifact, profileReason: 'profile_marked_stale' });
      continue;
    }

    ready.push({ ...resolved, artifact });
  }
  return { ready, profilesNeeded, warnings };
}

async function runPreflight(preflightResult, hostMap, { onEvent, assertClaimActive, claimIdentityFor, signal } = {}) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const profileCount = preflightResult.profilesNeeded.length;
  // Rate-limited: one Buddy preflight_start for the whole reprofile pass
  // (runs before execution → not the judge/scoring critical window). The
  // per-model timeline `emit('preflight_reprofile_start', …)` is preserved
  // below; this only adds the Buddy surface signal alongside it.
  if (profileCount) {
    buddySurface.emitLifecycle(
      'preflight_start',
      `Preflight: profiling ${profileCount} exact artifact(s) before the run…`
    );
  }
  for (const model of preflightResult.profilesNeeded) {
    const hostUrl = hostMap?.[model.host] || model.hostUrl;
    assertClaimActive?.();
    await emit('preflight_reprofile_start', { model: model.name, host: hostUrl, details: { hostId: model.host, reason: model.profileReason || 'missing_profile' } });
    await profile(model.name, model.host, hostUrl, 'standard', {
      assertClaimActive,
      claimIdentity: claimIdentityFor?.(hostUrl) || null,
      signal
    });
  }
  // Pre-run only: profiling finished, batch about to execute. Suggesting
  // is allowed here (no judge/scoring active yet).
  if (profileCount) {
    buddySurface.emitLifecycle('preflight_ok', 'Exact-artifact profiling complete — starting the run.');
  }
}

const { scout, fullPipeline } = require('./profilerPipelineDriver').createProfilerPipelineDriver({ profile, hostTestService });
module.exports = {
  scout, profile, fullPipeline, preflight, runPreflight,
  _detectSpill, _runThroughputCurve, _runGenerationStability, _runLoadTiming,
  summarizeThroughputSamples,
  summarizePositiveMeasurements,
  hasProfilerAuthorityReceipt,
  profileQualificationFailures,
  _contextProbeRepeatsForDepth: contextProbeRepeatsForDepth,
  _buildProfilerCapabilities
};
