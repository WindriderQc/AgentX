const { validateThroughput } = require('./contextProbeStep');

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

module.exports = {
  isValidTokensPerSec,
  findInvalidThroughputStep,
  summarizeCandidateThroughput,
  assessProbeStep
};
