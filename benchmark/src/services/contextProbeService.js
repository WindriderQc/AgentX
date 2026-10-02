/**
 * Benchmark-owned context probe service.
 *
 * Empirically tests usable context for a model on a host and persists results
 * to benchmark-owned storage instead of writing back into modelregistries.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const ModelProfile = require('../../models/ModelProfile');
const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
const modelContextProfileService = require('./modelContextProfileService');
const authorityReconciliation = require('./benchmark/benchmarkAuthorityReconciliation');
const hostProfileService = require('./profiler/hostProfileService');
const { identitiesMatch, resolveArtifactIdentity } = require('./profiler/artifactIdentityService');
const { showModel, listRunning } = require('../clients/ollamaClient');
const { snapshotGpuOffload } = require('./probeResidency');
const {
  runStep, sendProbeRequest, snapshotVram, validateThroughput, PROBE_NUM_PREDICT, MIN_PROBE_COMPLETION_TOKENS
} = require('./contextProbeStep');
const { isSameOllamaModel } = require('../helpers/ollamaModelIdentity');
const { normalizeHostUrl, getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../helpers/ollamaTargetAdmission');
const { normalizeModelName, resolveModelNumCtxDetails } = require('./modelContextResolver');
const logger = require('../../config/logger');

// Full-window probes can legitimately spend several minutes reloading a large
// resident model and prefilling the requested context. A production 262K Qwen
// probe hit the former 300s cap only because the measured 233.6s prefill was
// preceded by a context-changing reload. Keep enough bounded headroom for both
// phases so a slow-but-valid load is not persisted as a smaller window.
const DEFAULT_TIMEOUT_MS = 420000;
const DEFAULT_MIN_CTX = 2048;
const DEFAULT_MAX_CTX = 262144;

function isValidTokensPerSec(tokensPerSec) {
  const value = Number(tokensPerSec);
  return Number.isFinite(value) && value > 0;
}

function findInvalidThroughputStep(steps = []) {
  return steps.find((step) => !validateThroughput(step?.tokensPerSec).plausible);
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

function studentTCritical95(sampleCount) {
  const byDf = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  const df = Math.max(1, Math.floor(sampleCount) - 1);
  return byDf[Math.min(df, 30)] || 1.96;
}

function summarizeCandidateThroughput(samples = [], minimumSamples = 2) {
  const passing = samples.filter(sample => sample?.passed === true
    && Number.isFinite(Number(sample.tokensPerSec))
    && Number(sample.tokensPerSec) > 0);
  const values = passing.map(sample => Number(sample.tokensPerSec));
  if (!values.length) {
    return {
      attemptedSampleCount: samples.length,
      sampleCount: 0,
      minimumSamples,
      mean: null,
      p50: null,
      p95: null,
      standardDeviation: null,
      coefficientOfVariation: null,
      confidenceInterval95: null,
      reliability: 'unknown'
    };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) {
    return {
      attemptedSampleCount: samples.length,
      sampleCount: values.length,
      minimumSamples,
      mean: Number(mean.toFixed(3)),
      p50: Number(mean.toFixed(3)),
      p95: Number(mean.toFixed(3)),
      standardDeviation: null,
      coefficientOfVariation: null,
      confidenceInterval95: null,
      reliability: 'unknown'
    };
  }
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const cv = mean > 0 ? standardDeviation / mean : null;
  const margin = studentTCritical95(values.length) * standardDeviation / Math.sqrt(values.length);
  return {
    attemptedSampleCount: samples.length,
    sampleCount: values.length,
    minimumSamples,
    mean: Number(mean.toFixed(3)),
    p50: Number(quantile(values, 0.5).toFixed(3)),
    p95: Number(quantile(values, 0.95).toFixed(3)),
    standardDeviation: Number(standardDeviation.toFixed(3)),
    coefficientOfVariation: cv == null ? null : Number(cv.toFixed(4)),
    confidenceInterval95: {
      low: Number(Math.max(0, mean - margin).toFixed(3)),
      high: Number((mean + margin).toFixed(3)),
      method: 'student_t'
    },
    reliability: values.length < minimumSamples || cv == null
      ? 'unknown'
      : cv <= 0.05 ? 'high' : cv <= 0.12 ? 'medium' : 'low'
  };
}

async function persistProbeSnapshot(data, { signal, checkpoint } = {}) {
  const payload = { _id: new mongoose.Types.ObjectId(), ...data };
  checkpoint?.();
  let saved = null;
  try {
    const created = await ModelContextProbeSnapshot.create(
      [payload],
      signal ? { signal } : undefined
    );
    saved = Array.isArray(created) ? created[0] : created;
    checkpoint?.();
    return saved;
  } catch (error) {
    try {
      await ModelContextProbeSnapshot.updateOne(
        { _id: payload._id },
        {
          $setOnInsert: {
            modelName: payload.modelName,
            hostUrl: payload.hostUrl,
            hostId: payload.hostId,
            artifactDigest: payload.artifactDigest,
            runtimeFingerprint: payload.runtimeFingerprint,
            status: 'failed'
          },
          $set: {
            authorityStatus: 'rejected',
            authorityError: 'probe snapshot persistence raced profiler claim loss'
          }
        },
        { upsert: true }
      );
      error.authorityCompensated = true;
    } catch (compensationError) {
      error.compensationError = compensationError;
      error.retainAdmission = true;
      error.code = 'CONTEXT_PROBE_SNAPSHOT_RECONCILIATION_PENDING';
    }
    throw error;
  }
}

function getConfig() {
  return {
    timeoutMs: parseInt(process.env.CONTEXT_PROBE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    minCtx: parseInt(process.env.CONTEXT_PROBE_MIN_CTX, 10) || DEFAULT_MIN_CTX,
    maxCtx: parseInt(process.env.CONTEXT_PROBE_MAX_CTX, 10) || DEFAULT_MAX_CTX
  };
}

function buildCoarseCandidates(minCtx, upperBound) {
  const floorCtx = Math.max(1, Math.floor(minCtx));
  const ceilingCtx = Math.max(floorCtx, Math.floor(upperBound));
  const candidates = [floorCtx];

  let nextCtx = floorCtx;
  while (nextCtx < ceilingCtx) {
    nextCtx *= 2;
    if (nextCtx >= ceilingCtx) break;
    candidates.push(nextCtx);
  }

  if (candidates[candidates.length - 1] !== ceilingCtx) {
    candidates.push(ceilingCtx);
  }

  return candidates;
}

function buildRefinementStages(lowerBound, upperBound, minIncrement) {
  const baseIncrement = Math.max(1, Math.floor(minIncrement));
  const range = Math.max(0, Math.floor(upperBound) - Math.floor(lowerBound));
  if (range <= baseIncrement) return [];

  let step = 2 ** Math.floor(Math.log2(Math.max(baseIncrement, Math.floor(range / 4))));
  const stages = [];

  while (step >= baseIncrement) {
    stages.push(step);
    step = Math.floor(step / 2);
  }

  if (stages[stages.length - 1] !== baseIncrement) {
    stages.push(baseIncrement);
  }

  return stages;
}

function assessProbeStep(step, baselineSpeed) {
  const requestPassed = step.passed;
  // The display percentage rounds small spills to 100; admission uses bytes.
  // Placed as the host declares: wholly in VRAM, or none of it on a CPU host.
  // A partial placement never verifies, on either kind of host.
  const gpuResidencyVerified = require('./probePlacement').placementVerified(step.gpuSizeTotal, step.gpuSizeVram, step.residency);
  const contextHonored = Number(step.ollamaContextLength) >= Number(step.numCtx);
  const promptCoverageVerified = Number(step.promptCoveragePct) >= Number(step.minimumPromptCoveragePct || 70);
  // A request that never completed measured no throughput; 0 tok/s there is
  // an absent reading, not a 100% drop.
  const degradationPct = baselineSpeed > 0 && step.requestSucceeded !== false
    ? Number(((1 - step.tokensPerSec / baselineSpeed) * 100).toFixed(1))
    : null;

  // A larger KV cache is expected to change throughput. Record that change as
  // benchmark evidence, but do not turn an arbitrary speed delta into a
  // smaller runtime context contract. Context verification fails only when the
  // request/decode fails or the model spills off GPU.
  if (requestPassed && gpuResidencyVerified && contextHonored && promptCoverageVerified) {
    step.passed = true;
    step.failureKind = null;
    step.degradationPct = degradationPct;
    step.reason = `${step.tokensPerSec} tok/s (${degradationPct}% drop) GPU=${step.gpuPercent ?? '?'}%`;
    return step;
  }

  step.passed = false;
  // A request that ended without a verdict from Ollama (client deadline or
  // lost connection) while the model stayed fully GPU-resident at the
  // requested context did not meet a capacity limit: the window fits and the
  // probe ran out of time. That is inconclusive transport evidence and must not
  // be read as a smaller usable window. Without that residency proof the
  // failure remains capacity evidence.
  step.failureKind = step.transportFailure === true && gpuResidencyVerified && contextHonored
    ? 'transport'
    : 'capacity';
  step.degradationPct = degradationPct;
  step.reason = !requestPassed
    ? (step.reason || 'Request failed')
    : step.gpuPercent == null
      ? 'GPU residency unknown; no-spill is unverified'
      : !gpuResidencyVerified
      ? `${step.residency === 'cpu' ? 'CPU host uses VRAM' : 'GPU spill'}: ${step.gpuPercent}% on GPU (${step.tokensPerSec} tok/s)`
      : !contextHonored
        ? `Ollama allocated ${step.ollamaContextLength || 'unknown'} ctx, below requested ${step.numCtx}`
        : !promptCoverageVerified
          ? `Prompt eval covered ${step.promptCoveragePct ?? 'unknown'}%, below required ${step.minimumPromptCoveragePct || 70}%`
          : (step.reason || 'Request failed');
  return step;
}

async function refinePassingBracket(lowerPassingCtx, upperFailingCtx, minIncrement, testCandidate) {
  let bestPassingCtx = lowerPassingCtx;
  let failLimit = upperFailingCtx;
  const refinementStages = buildRefinementStages(lowerPassingCtx, upperFailingCtx, minIncrement);

  for (const increment of refinementStages) {
    let candidate = bestPassingCtx + increment;
    while (candidate < failLimit) {
      const step = await testCandidate(candidate);
      if (step.passed) {
        bestPassingCtx = step.numCtx;
        candidate = bestPassingCtx + increment;
        continue;
      }

      failLimit = candidate;
      break;
    }
  }

  return bestPassingCtx;
}

async function resolveHostUrl(modelName, explicitHostUrl) {
  if (explicitHostUrl) {
    return admitOllamaTargetResolved(explicitHostUrl, { configuredHosts: getConfiguredHosts() });
  }

  const entry = await ModelProfile.findOne({
    $or: [
      { name: normalizeModelName(modelName) }
    ]
  }).lean();

  const hostUrl = normalizeHostUrl(entry?.sourceHost || entry?.host || null);
  if (!hostUrl) {
    throw new Error(`No host URL found for model: ${modelName}`);
  }

  return admitOllamaTargetResolved(hostUrl, { configuredHosts: getConfiguredHosts() });
}

async function fetchModelMetadata(hostUrl, modelName, options = {}) {
  try {
    const data = await showModel(hostUrl, modelName, { signal: options.signal });
    const info = data.model_info || {};
    let theoreticalMax = null;
    for (const key of Object.keys(info)) {
      if (key.includes('context_length') && typeof info[key] === 'number') {
        theoreticalMax = info[key];
        break;
      }
    }
    return {
      theoreticalMax,
      modelInfo: info,
      family: data.details?.family || null,
      families: Array.isArray(data.details?.families) ? data.details.families : [],
      architecture: info['general.architecture'] || data.details?.family || null
    };
  } catch (err) {
    if (options.signal?.aborted) throw (options.signal.reason instanceof Error ? options.signal.reason : err);
    logger.warn('Failed to fetch model theoretical max', { hostUrl, modelName, error: err.message });
    return { theoreticalMax: null, modelInfo: {}, family: null, families: [], architecture: null };
  }
}

async function fetchModelTheoreticalMax(hostUrl, modelName) {
  const metadata = await fetchModelMetadata(hostUrl, modelName);
  return metadata.theoreticalMax;
}


async function probeModelContext(modelName, options = {}) {
  // Maintenance-mode gate: the probe sweeps num_ctx across a staged search on a
  // live host, which evicts the KV cache and breaks concurrent production
  // traffic. Callers must explicitly acknowledge they are running maintenance.
  // (Audit 2026-04-18 §4.2 step 5 — the durable version will consult
  // HostPreference.status once the host-pinning plan lands.)
  if (options.acknowledgeMaintenance !== true) {
    throw new Error('Context probe refused: caller must set acknowledgeMaintenance:true — probe evicts KV cache and breaks live traffic');
  }
  const workloadId = String(options.workloadId || '');
  if (!workloadId) {
    const error = new Error('Context probe requires an exact durable profiler workload identity');
    error.code = 'PROFILER_AUTHORITY_JOURNAL_REQUIRED';
    throw error;
  }

  const cfg = getConfig();
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const minCtx = options.minCtx ?? cfg.minCtx;
  const maxCtx = options.maxCtx ?? cfg.maxCtx;
  const promptFillPct = Math.min(100, Math.max(5, Number(options.contextProbeFillPct ?? options.promptFillPct ?? 80) || 80));
  const candidateRepeats = Math.max(2, Math.min(20, Number(options.candidateRepeats) || 2));
  const profileDepth = ['quick', 'standard', 'full'].includes(options.profileDepth)
    ? options.profileDepth
    : 'standard';
  const interactiveThreshold = Number.isFinite(Number(options.interactiveDegradationThreshold))
    ? Math.min(100, Math.max(0, Number(options.interactiveDegradationThreshold))) : 15;
  const documentThreshold = Number.isFinite(Number(options.documentDegradationThreshold))
    ? Math.min(100, Math.max(0, Number(options.documentDegradationThreshold))) : 30;
  const performanceKneeThreshold = Number.isFinite(Number(options.performanceKneeDegradationThreshold))
    ? Math.min(100, Math.max(0, Number(options.performanceKneeDegradationThreshold))) : 15;
  const checkpoint = () => {
    if (options.signal?.aborted) {
      const error = options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Context probe authority stopped');
      error.code = error.code || 'BENCHMARK_CLAIM_STOPPED';
      throw error;
    }
    options.assertClaimActive?.();
  };
  const probeOptions = {
    signal: options.signal,
    assertClaimActive: checkpoint,
    minimumPromptCoveragePct: Number(options.minimumPromptCoveragePct) || 70
  };
  const probeNotify = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const normalizedModel = normalizeModelName(modelName);
  const hostUrl = await resolveHostUrl(normalizedModel, options.hostUrl);
  const hostProfile = options.artifactIdentity ? null : await hostProfileService.getByUrl(hostUrl);
  const artifactIdentity = options.artifactIdentity || await resolveArtifactIdentity(
    normalizedModel,
    hostProfile?.hostId,
    hostUrl,
    { refresh: true }
  );
  const probeStart = Date.now();
  const steps = [];

  try {
    const seedResolution = await resolveModelNumCtxDetails(normalizedModel, {
      targetHost: hostUrl,
      artifactIdentity
    });
    const metadata = await fetchModelMetadata(hostUrl, normalizedModel, { signal: options.signal });
    const theoreticalMax = metadata.theoreticalMax;
    const modelContext = { modelName: normalizedModel, hostUrl, ...metadata };
    const upperBound = Math.max(minCtx, Math.min(theoreticalMax || maxCtx, maxCtx));
    const coarseCandidates = buildCoarseCandidates(minCtx, upperBound);
    const stepCache = new Map();

    async function measureCandidate(numCtx, baselineSpeed = null, seedSteps = []) {
      const repetitions = [...seedSteps];
      while (repetitions.length < candidateRepeats) {
        checkpoint();
        // One failed sample already rejects this candidate. Repeating a
        // timeout or CPU-spilling request cannot make it pass and can waste
        // several minutes per repetition. Passing candidates still retain
        // the full sample count and confidence requirements.
        if (repetitions.some(step => !assessProbeStep(step, baselineSpeed || step.tokensPerSec).passed)) break;
        probeNotify({ type: 'sample', numCtx, sample: repetitions.length + 1, sampleCount: candidateRepeats });
        repetitions.push(await runStep(
          hostUrl, normalizedModel, numCtx, timeoutMs, promptFillPct, modelContext, probeOptions
        ));
      }
      const speeds = repetitions.map(step => Number(step.tokensPerSec)).filter(value => value > 0);
      const comparisonSpeed = baselineSpeed || (speeds.length
        ? [...speeds].sort((a, b) => a - b)[Math.floor(speeds.length / 2)]
        : 0);
      const assessed = repetitions.map(step => assessProbeStep(step, comparisonSpeed));
      const failed = assessed.find(step => !step.passed);
      const representative = failed || [...assessed].sort((a, b) => Number(a.tokensPerSec) - Number(b.tokensPerSec))[0];
      const throughputStatistics = summarizeCandidateThroughput(assessed, candidateRepeats);
      const mean = Number(throughputStatistics.mean) || 0;
      return {
        ...representative,
        tokensPerSec: speeds.length ? Number(mean.toFixed(2)) : 0,
        passed: assessed.every(step => step.passed),
        reason: failed?.reason || representative?.reason || null,
        repetitionCount: assessed.length,
        tokensPerSecMin: speeds.length ? Math.min(...speeds) : null,
        tokensPerSecMax: speeds.length ? Math.max(...speeds) : null,
        tokensPerSecStdDev: throughputStatistics.standardDeviation,
        tokensPerSecCvPct: throughputStatistics.coefficientOfVariation == null
          ? null
          : Number((throughputStatistics.coefficientOfVariation * 100).toFixed(2)),
        throughputStatistics,
        samples: assessed.map(step => ({
          requestSucceeded: step.requestSucceeded,
          tokensPerSec: step.tokensPerSec,
          promptTokens: step.promptTokens,
          estimatedPromptTokens: step.estimatedPromptTokens,
          promptCoveragePct: step.promptCoveragePct,
          completionTokens: step.completionTokens,
          latencyMs: step.latencyMs,
          vramUsedMiB: step.vramUsedMiB,
          vramTotalMiB: step.vramTotalMiB,
          gpuPercent: step.gpuPercent,
          gpuSizeTotal: step.gpuSizeTotal,
          gpuSizeVram: step.gpuSizeVram,
          ollamaContextLength: step.ollamaContextLength, residency: step.residency || 'gpu',
          coResidents: step.coResidents ?? null,
          passed: step.passed,
          failureKind: step.failureKind ?? null,
          failureCode: step.failureCode ?? null,
          reason: step.reason || null
        }))
      };
    }

    if (coarseCandidates.length === 0) {
      throw new Error(`No valid context candidates for ${normalizedModel}`);
    }

    // Test an already-loaded candidate before the ascending sweep changes
    // num_ctx. Large resident models can otherwise spend most of Ollama's
    // fixed request window reloading back to their original context. Cache the
    // raw result here and assess it against the baseline when the sweep reaches
    // that candidate, preserving the existing evidence and pass semantics.
    let residentCandidate = null;
    try {
      const running = await listRunning(hostUrl, { timeoutMs: 8000, signal: options.signal });
      const resident = (running.models || []).find(item =>
        isSameOllamaModel(item.name, normalizedModel) || isSameOllamaModel(item.model, normalizedModel)
      );
      const residentNumCtx = Number(resident?.context_length);
      if (
        Number.isFinite(residentNumCtx)
        && residentNumCtx > coarseCandidates[0]
        && coarseCandidates.includes(residentNumCtx)
      ) {
        probeNotify({ type: 'resident', numCtx: residentNumCtx, tokensPerSec: null });
        checkpoint();
        residentCandidate = await runStep(
          hostUrl,
          normalizedModel,
          residentNumCtx,
          timeoutMs,
          promptFillPct,
          modelContext,
          probeOptions
        );
        probeNotify({
          type: 'resident',
          numCtx: residentNumCtx,
          tokensPerSec: residentCandidate.tokensPerSec,
          passed: residentCandidate.passed
            && (residentCandidate.gpuPercent == null || residentCandidate.gpuPercent === (residentCandidate.residency === 'cpu' ? 0 : 100))
        });
      }
    } catch (err) {
      if (options.signal?.aborted) throw (options.signal.reason instanceof Error ? options.signal.reason : err);
      logger.debug(`Could not pretest resident context for ${normalizedModel}: ${err.message}`);
    }

    probeNotify({ type: 'baseline', numCtx: coarseCandidates[0], tokensPerSec: null });
    checkpoint();
    const baseline = await measureCandidate(coarseCandidates[0]);
    steps.push(baseline);
    stepCache.set(baseline.numCtx, baseline);

    if (!baseline.passed) {
      throw new Error(`Baseline failed at num_ctx=${coarseCandidates[0]}: ${baseline.reason}`);
    }

    const baselineSpeed = baseline.tokensPerSec;
    if (baselineSpeed <= 0) {
      throw new Error('Baseline produced 0 tokens/sec');
    }

    probeNotify({ type: 'baseline', numCtx: coarseCandidates[0], tokensPerSec: baselineSpeed });
    baseline.reason = `Baseline: ${baselineSpeed} tok/s`;
    baseline.degradationPct = 0;

    let bestPassingStep = baseline;

    // After a request timed out and was proven stopped, no further request is sent.
    let deadlineStopped = false;
    async function testCandidate(numCtx) {
      checkpoint();
      if (stepCache.has(numCtx)) {
        return stepCache.get(numCtx);
      }
      if (deadlineStopped) return { numCtx, passed: false, untested: true };

      // The fill percentage is fixed for a whole probe run so throughput
      // remains comparable across verified windows.
      const evaluatedStep = await measureCandidate(
        numCtx,
        baselineSpeed,
        residentCandidate?.numCtx === numCtx ? [residentCandidate] : []
      );

      stepCache.set(numCtx, evaluatedStep);
      steps.push(evaluatedStep);
      deadlineStopped ||= evaluatedStep.requestStopProven === true;
      probeNotify({
        type: 'step',
        numCtx,
        tokensPerSec: evaluatedStep.tokensPerSec,
        degradationPct: evaluatedStep.degradationPct,
        passed: evaluatedStep.passed
      });
      return evaluatedStep;
    }

    for (const candidate of coarseCandidates.slice(1)) {
      const step = await testCandidate(candidate);
      if (step.passed) {
        bestPassingStep = step;
        continue;
      }

      const refinedBestCtx = await refinePassingBracket(
        bestPassingStep.numCtx,
        candidate,
        minCtx,
        testCandidate
      );
      bestPassingStep = stepCache.get(refinedBestCtx) || bestPassingStep;
      break;
    }

    const testedNumCtx = bestPassingStep.numCtx;
    // What stopped the ladder: the nearest failing candidate above the verified
    // window. `transport` means the true ceiling is unknown and at least
    // testedNumCtx; null means every candidate up to the upper bound passed.
    const ceilingFailureKind = steps
      .filter(step => !step.passed && step.numCtx > testedNumCtx)
      .sort((a, b) => a.numCtx - b.numCtx)[0]?.failureKind || null;
    const bestStep = steps.find((step) => step.numCtx === testedNumCtx && step.passed) || baseline;
    const degradation = Number(((1 - bestStep.tokensPerSec / baselineSpeed) * 100).toFixed(1));
    const recommendedFor = threshold => steps
      .filter(step => step.passed && Number(step.degradationPct) <= threshold)
      .reduce((max, step) => Math.max(max, Number(step.numCtx) || 0), 0) || baseline.numCtx;
    const recommendedInteractiveContext = recommendedFor(interactiveThreshold);
    const recommendedDocumentContext = recommendedFor(documentThreshold);
    // The knee is the largest measured/passing point whose throughput loss is
    // within the configured threshold. It says nothing about answer quality.
    const performanceKneeContext = recommendedFor(performanceKneeThreshold);
    probeNotify({ type: 'result', testedNumCtx, degradationPct: degradation });

    const invalidStep = findInvalidThroughputStep(steps);
    if (invalidStep) {
      const { detail } = validateThroughput(invalidStep.tokensPerSec);
      throw new Error(`Invalid throughput at num_ctx=${invalidStep.numCtx}: ${detail || `${invalidStep.tokensPerSec} tok/s invalid`}`);
    }

    const currentArtifact = await resolveArtifactIdentity(
      normalizedModel,
      hostProfile?.hostId || artifactIdentity.hostId,
      hostUrl,
      { refresh: true }
    );
    if (!identitiesMatch(artifactIdentity, currentArtifact)) {
      throw new Error(`Artifact or runtime changed during context probe for ${normalizedModel} on ${hostUrl}`);
    }

    checkpoint();
    const snapshotId = new mongoose.Types.ObjectId();
    const authorityWriteId = crypto.randomUUID();
    const snapshotPayload = {
      _id: snapshotId,
      modelName: normalizedModel,
      hostUrl,
      hostId: currentArtifact.hostId,
      artifactDigest: currentArtifact.digest,
      runtimeFingerprint: currentArtifact.runtimeFingerprint,
      profileDepth,
      candidateRepeats,
      testedNumCtx,
      ceilingFailureKind,
      baselineTokensPerSec: baselineSpeed,
      atLimitTokensPerSec: bestStep.tokensPerSec,
      degradationPct: degradation,
      degradationThreshold: documentThreshold,
      interactiveDegradationThreshold: interactiveThreshold,
      documentDegradationThreshold: documentThreshold,
      performanceKneeDegradationThreshold: performanceKneeThreshold,
      recommendedInteractiveContext,
      recommendedDocumentContext,
      performanceKneeContext,
      qualityVerifiedContext: null,
      qualityContextStatus: 'unknown',
      promptFillPct,
      vramAtLimitMiB: bestStep.vramUsedMiB ?? null,
      gpuPercentAtLimit: bestStep.gpuPercent ?? null,
      modelTheoreticalMax: theoreticalMax,
      resolutionSeedNumCtx: seedResolution.num_ctx,
      resolutionSeedSource: seedResolution.source,
      testedAt: new Date(),
      testDurationMs: Date.now() - probeStart,
      status: 'completed',
      error: null,
      authorityStatus: 'pending',
      authorityError: null,
      authorityWriteId,
      steps
    };
    const priorProfile = await modelContextProfileService.getByIdentityForAuthority(snapshotPayload, {
      signal: options.signal
    });
    checkpoint();
    const authorityJournal = await authorityReconciliation.prepareProfilerAuthorityWrite({
      kind: 'profiler_context_write',
      resultId: `profiler-context:${workloadId}:${authorityWriteId}`,
      workloadId,
      phase: 'profiler context snapshot/profile publication',
      details: {
        snapshotId: String(snapshotId),
        authorityWriteId,
        modelName: normalizedModel,
        hostUrl,
        artifactDigest: currentArtifact.digest,
        runtimeFingerprint: currentArtifact.runtimeFingerprint,
        snapshotPayload,
        priorProfile: priorProfile || null
      }
    });
    snapshotPayload.authorityReconciliationId = String(authorityJournal._id);
    let snapshot;
    try {
      snapshot = await persistProbeSnapshot(snapshotPayload, { signal: options.signal, checkpoint });

      logger.info('Benchmark context probe completed', {
        modelName: normalizedModel,
        hostUrl,
        testedNumCtx,
        durationMs: snapshot.testDurationMs
      });

      const snapshotObject = snapshot.toObject();
      checkpoint();
      const contextAuthority = await modelContextProfileService.updateFromProbeSnapshot(snapshotObject, {
        signal: options.signal,
        assertAuthorityActive: checkpoint,
        authorityState: 'pending_reconciliation',
        authorityWriteId,
        authorityReconciliationId: String(authorityJournal._id)
      });
      if (!contextAuthority) {
        const error = new Error('Model context profile rejected completed probe evidence');
        error.code = 'MODEL_CONTEXT_PROFILE_PERSIST_FAILED';
        throw error;
      }
      checkpoint();
      await authorityReconciliation.completeProfilerAuthorityWrite(authorityJournal, {
        details: authorityJournal.details,
        signal: options.signal,
        assertAuthorityActive: checkpoint
      });
      return {
        ...snapshotObject,
        // The committed ceiling can exceed testedNumCtx when a transport-bounded
        // ladder left an earlier verified ceiling in place.
        maxVerifiedContext: contextAuthority.maxVerifiedContext ?? snapshotObject.testedNumCtx,
        authorityStatus: 'committed',
        authorityError: null
      };
    } catch (profileErr) {
      profileErr.retainAdmission = true;
      profileErr.authorityInvalidationFailed = true;
      profileErr.code = profileErr.code || 'MODEL_CONTEXT_PROFILE_RECONCILIATION_PENDING';
      profileErr.reconciliationId = String(authorityJournal._id);
      logger.warn('Context authority write retained for durable reconciliation', {
        modelName: normalizedModel,
        hostUrl,
        snapshotId: String(snapshotId),
        error: profileErr.message
      });
      throw profileErr;
    }
  } catch (err) {
    if (err?.retainAdmission === true
      || err?.code === 'MODEL_CONTEXT_PROFILE_RECONCILIATION_PENDING') {
      throw err;
    }
    if (options.signal?.aborted) {
      const authorityError = options.signal.reason instanceof Error ? options.signal.reason : err;
      if (err?.compensationError) authorityError.compensationError = err.compensationError;
      if (err?.authorityCompensated === true) authorityError.authorityCompensated = true;
      if (err?.retainAdmission === true) authorityError.retainAdmission = true;
      throw authorityError;
    }
    checkpoint();
    const snapshot = await persistProbeSnapshot({
      modelName: normalizedModel,
      hostUrl,
      hostId: artifactIdentity.hostId,
      artifactDigest: artifactIdentity?.digest || null,
      runtimeFingerprint: artifactIdentity?.runtimeFingerprint || null,
      testedNumCtx: null,
      testedAt: new Date(),
      testDurationMs: Date.now() - probeStart,
      status: 'failed',
      error: err.message,
      authorityStatus: 'rejected',
      authorityError: err.message,
      promptFillPct,
      steps
    }, { signal: options.signal, checkpoint });
    logger.error('Benchmark context probe failed', { modelName: normalizedModel, hostUrl, error: err.message });
    throw Object.assign(new Error(err.message), {
      snapshotId: snapshot?._id ? snapshot._id.toString() : null
    });
  }
}

async function getProbeStatus(modelName, options = {}) {
  const filter = {
    modelName: normalizeModelName(modelName)
  };
  if (options.hostUrl) {
    filter.hostUrl = normalizeHostUrl(options.hostUrl);
  }
  return ModelContextProbeSnapshot.findOne(filter).sort({ testedAt: -1 }).lean();
}

module.exports = {
  probeModelContext,
  getProbeStatus,
  getConfig,
  _internal: {
    assessProbeStep,
    buildCoarseCandidates,
    buildRefinementStages,
    refinePassingBracket,
    fetchModelTheoreticalMax,
    sendProbeRequest,
    snapshotVram,
    snapshotGpuOffload,
    runStep,
    MIN_PROBE_COMPLETION_TOKENS,
    PROBE_NUM_PREDICT,
    persistProbeSnapshot,
    findInvalidThroughputStep,
    summarizeCandidateThroughput,
    validateThroughput,
    isValidTokensPerSec
  }
};
