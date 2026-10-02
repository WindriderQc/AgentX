'use strict';

const { verifyProfilerAuthorityReceipt } = require('./profilerAuthorityReceipt');
const { completeRepeatedStatistics } = require('./profilerStatistics');

function _buildProfilerCapabilities(depth, hardwareTelemetry) {
  const hardwareCapability = hardwareTelemetry?.capability
    || hardwareTelemetry?.latest?.capability
    || {
      contract: 'agentx.profiler-hardware-capability/v1',
      status: 'unavailable',
      qualificationAuthority: 'none',
      collector: {
        requiredContract: 'agentx.profiler-hardware-collector/v1',
        status: 'not_configured',
        ownershipBoundary: 'deployment_extension'
      }
    };
  return {
    contract: 'agentx.profiler-capability-coverage/v1',
    profileDepth: depth,
    qualificationScope: 'single_request_exact_artifact_runtime',
    singleRequestPerformance: { status: 'measured', authority: 'profiler_pipeline' },
    contextCapacity: { status: depth === 'quick' ? 'unknown' : 'measured', authority: depth === 'quick' ? 'none' : 'profiler_pipeline' },
    hardwareTelemetry: hardwareCapability,
    concurrentServing: {
      status: 'unknown',
      authority: 'none',
      reason: 'concurrency_not_measured_by_current_profiler',
      metrics: {
        goodput: null,
        latencyP95Ms: null,
        fairness: null,
        saturationConcurrency: null
      }
    },
    responseQuality: {
      status: 'not_measured',
      authority: 'none',
      reason: 'profiler_measures_runtime_performance_not_semantic_quality'
    },
    productionServingQualification: {
      qualified: false,
      reason: 'concurrency_goodput_fairness_and_long_context_quality_not_measured'
    }
  };
}

function contextProbeRepeatsForDepth(depth, settings = {}) {
  return depth === 'full'
    ? Math.min(20, Math.max(5, Number(settings.fullPhaseRepeats) || 5))
    : 2;
}

function hasProfilerAuthorityReceipt(readiness, evidence, identity = {}) {
  return verifyProfilerAuthorityReceipt(readiness, evidence, identity);
}

function profileQualificationFailures(profileData) {
  const failures = [];
  const required = Number(profileData.requiredRetainedSamples) || 0;
  const quality = profileData.measurementQuality || {};
  if (profileData.profileDepth === 'quick') failures.push('quick_diagnostic_only');
  if (!(Number(profileData.maxVerifiedContext) > 0)) failures.push('max_context_unverified');
  if (!(Number(profileData.recommendedInteractiveContext) > 0)) failures.push('interactive_context_unverified');
  if (!(Number(profileData.recommendedDocumentContext) > 0)) failures.push('document_context_unverified');
  if (Number(profileData.recommendedInteractiveContext) > Number(profileData.maxVerifiedContext)) {
    failures.push('interactive_context_exceeds_verified_max');
  }
  if (Number(profileData.recommendedDocumentContext) > Number(profileData.maxVerifiedContext)) {
    failures.push('document_context_exceeds_verified_max');
  }
  if (Number(quality.passingSampleCount) < required) failures.push('retained_sample_minimum_not_met');
  if (!['medium', 'high'].includes(quality.reliability)) failures.push(`reliability_${quality.reliability || 'unknown'}`);
  const mainMean = Number(quality.tokensPerSecMean);
  const mainLow = Number(quality.confidenceInterval95?.low);
  const mainHigh = Number(quality.confidenceInterval95?.high);
  const maxCv = Number(profileData.fullMaxCoefficientOfVariation ?? 0.12);
  const maxRelativeCi95Width = Number(profileData.fullMaxRelativeCi95Width ?? 0.30);
  if (profileData.profileDepth === 'full'
    && (!(Number(quality.coefficientOfVariation) <= maxCv)
      || !(mainMean > 0)
      || !Number.isFinite(mainLow)
      || !Number.isFinite(mainHigh)
      || ((mainHigh - mainLow) / mainMean) > maxRelativeCi95Width)) {
    failures.push('full_primary_measurement_uncertain');
  }
  if (profileData.ttftMeasurement !== 'streamed_wall_clock'
    || !Number.isFinite(Number(profileData.ttftMs))
    || Number(profileData.ttftMs) < 0) failures.push('streamed_ttft_missing');
  const requiredTtftSamples = Number(profileData.requiredTtftSamples) || required;
  if (requiredTtftSamples > 0 && Number(quality.ttftSampleCount) < requiredTtftSamples) {
    failures.push('streamed_ttft_sample_minimum_not_met');
  }
  if (profileData.spill?.verified !== true) failures.push('gpu_residency_unverified');

  if (profileData.profileDepth === 'full') {
    const requiredFullSamples = Math.max(5, Number(profileData.requiredFullPhaseSamples) || 5);
    const fullStatOptions = {
      maxCoefficientOfVariation: maxCv,
      maxRelativeCi95Width
    };
    const authoritativeContexts = [...new Set([
      profileData.maxVerifiedContext,
      profileData.recommendedInteractiveContext,
      profileData.recommendedDocumentContext
    ].map(Number).filter(value => value > 0))];
    const contextSteps = Array.isArray(profileData.probeSteps) ? profileData.probeSteps : [];
    const contextEvidenceComplete = Number(profileData.contextProbeCandidateRepeats) >= requiredFullSamples
      && authoritativeContexts.length > 0
      && authoritativeContexts.every(numCtx => {
        const step = contextSteps.find(candidate => Number(candidate.numCtx) === numCtx && candidate.passed === true);
        return step
          && Number(step.repetitionCount) >= requiredFullSamples
          && completeRepeatedStatistics(step.throughputStatistics, requiredFullSamples, fullStatOptions);
      });
    if (!contextEvidenceComplete) failures.push('full_context_probe_incomplete');
    const curve = Array.isArray(profileData.throughputCurve) ? profileData.throughputCurve : [];
    const curveCoverage = [...new Set(curve.map(point => Number(point.contextFillPct)))].sort((a, b) => a - b);
    if (curve.length !== 5
      || JSON.stringify(curveCoverage) !== JSON.stringify([10, 25, 50, 75, 90])
      || curve.some(point => !(Number(point.tokensPerSec) > 0)
        || point.gpuOffloaded !== false
        || Number(point.passingSampleCount) < requiredFullSamples
        || !completeRepeatedStatistics(point.throughputStatistics, requiredFullSamples, fullStatOptions))) {
      failures.push('full_throughput_curve_incomplete');
    }
    const stability = Array.isArray(profileData.generationStability) ? profileData.generationStability : [];
    const stabilityCoverage = [...new Set(stability.map(point => Number(point.numPredict)))].sort((a, b) => a - b);
    if (stability.length !== 3
      || JSON.stringify(stabilityCoverage) !== JSON.stringify([64, 256, 512])
      || stability.some(point => !(Number(point.tokensPerSec) > 0)
        || !(Number(point.totalLatencyMs) > 0)
        || Number(point.passingSampleCount) < requiredFullSamples
        || !completeRepeatedStatistics(point.throughputStatistics, requiredFullSamples, fullStatOptions)
        || !completeRepeatedStatistics(point.latencyStatistics, requiredFullSamples, fullStatOptions))) {
      failures.push('full_generation_stability_incomplete');
    }
    const matrix = profileData.prefillDecodeMatrix;
    const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
    const expectedCellCount = Array.isArray(matrix?.prefillTokens) && Array.isArray(matrix?.decodeTokens)
      ? matrix.prefillTokens.length * matrix.decodeTokens.length
      : 0;
    const completeMatrix = expectedCellCount > 0
      && cells.length === expectedCellCount
      && Number(matrix.cellCount) === expectedCellCount
      && Number(matrix.passCount) === expectedCellCount
      && Number(matrix.skippedCount || 0) === 0
      && cells.every(cell => cell.status === 'pass'
        && Number(cell.promptTokens) > 0
        && Number(cell.requestedPromptTokens) > 0
        && Number(cell.promptCoveragePct) >= Number(cell.minimumPromptCoveragePct || 80)
        && Number(cell.promptEvalDurationMs) > 0
        && Number(cell.evalDurationMs) > 0
        && Number(cell.runtimeContextLength) === Number(matrix.numCtx)
        && Number(cell.passingSampleCount) >= requiredFullSamples
        && completeRepeatedStatistics(cell.prefillStatistics, requiredFullSamples, fullStatOptions)
        && completeRepeatedStatistics(cell.decodeStatistics, requiredFullSamples, fullStatOptions)
        && Number.isFinite(Number(cell.prefillTokensPerSec))
        && Number(cell.prefillTokensPerSec) > 0
        && Number.isFinite(Number(cell.decodeTokensPerSec))
        && Number(cell.decodeTokensPerSec) > 0);
    if (!completeMatrix) {
      failures.push('full_prefill_decode_matrix_incomplete');
    }
    if (!(Number(profileData.loadTiming?.coldLoadMs) > 0)
      || !(Number(profileData.loadTiming?.hotLoadMs) > 0)
      || profileData.loadTiming?.unloadVerified !== true
      || Number(profileData.loadTiming?.passingSampleCount) < requiredFullSamples
      || !completeRepeatedStatistics(profileData.loadTiming?.coldStatistics, requiredFullSamples, fullStatOptions)
      || !completeRepeatedStatistics(profileData.loadTiming?.hotStatistics, requiredFullSamples, fullStatOptions)) {
      failures.push('full_load_timing_incomplete');
    }
  }
  return failures;
}

module.exports = {
  _buildProfilerCapabilities,
  contextProbeRepeatsForDepth,
  hasProfilerAuthorityReceipt,
  profileQualificationFailures
};
