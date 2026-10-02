'use strict';

function _round(n, places = 2) {
  return Number(Number(n || 0).toFixed(places));
}

function _median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

function _studentTCritical95(sampleCount) {
  const byDf = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  const df = Math.max(1, Math.floor(sampleCount) - 1);
  return byDf[Math.min(df, 30)] || 1.96;
}

function summarizeThroughputSamples(samples, { minimumRetainedSamples = 2 } = {}) {
  // Exclude warm-up / discarded samples from steady-state stats. They stay
  // on the record (sample.discarded=true) so the UI can show them, but they
  // never contribute to mean/median/CV/reliability.
  const kept = samples.filter(s => !s.discarded);
  const passing = kept.filter(s => s.status === 'pass' && Number.isFinite(Number(s.tokensPerSec)) && Number(s.tokensPerSec) > 0);
  const values = passing.map(s => Number(s.tokensPerSec));
  if (!values.length) {
    return {
      sampleCount: kept.length,
      retainedSampleCount: kept.length,
      passingSampleCount: 0,
      minimumRetainedSamples,
      tokensPerSecMean: null,
      tokensPerSecMedian: null,
      tokensPerSecMin: null,
      tokensPerSecMax: null,
      tokensPerSecStdDev: null,
      coefficientOfVariation: null,
      p50: null,
      p95: null,
      ttftP50Ms: null,
      ttftP95Ms: null,
      ttftSampleCount: 0,
      promptEvalP50Ms: null,
      promptEvalP95Ms: null,
      confidenceInterval95: null,
      reliability: 'unknown'
    };
  }
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  // Single sample → CV is mathematically 0 but tells us nothing about
  // variance. Surface that as 'unknown' rather than misleading 'high'.
  if (values.length < 2) {
    return {
      sampleCount: kept.length,
      retainedSampleCount: kept.length,
      passingSampleCount: values.length,
      minimumRetainedSamples,
      tokensPerSecMean: _round(mean),
      tokensPerSecMedian: _round(mean),
      tokensPerSecMin: _round(mean),
      tokensPerSecMax: _round(mean),
      tokensPerSecStdDev: null,
      coefficientOfVariation: null,
      p50: _round(mean),
      p95: _round(mean),
      ttftP50Ms: Number.isFinite(Number(passing[0]?.ttftMs)) ? _round(passing[0].ttftMs) : null,
      ttftP95Ms: Number.isFinite(Number(passing[0]?.ttftMs)) ? _round(passing[0].ttftMs) : null,
      ttftSampleCount: passing[0]?.ttftMeasurement === 'streamed_wall_clock'
        && Number.isFinite(Number(passing[0]?.ttftMs)) ? 1 : 0,
      promptEvalP50Ms: Number.isFinite(Number(passing[0]?.promptEvalDurationMs)) ? _round(passing[0].promptEvalDurationMs) : null,
      promptEvalP95Ms: Number.isFinite(Number(passing[0]?.promptEvalDurationMs)) ? _round(passing[0].promptEvalDurationMs) : null,
      confidenceInterval95: null,
      reliability: 'unknown'
    };
  }
  const variance = values.reduce((sum, n) => sum + ((n - mean) ** 2), 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : null;
  const margin95 = _studentTCritical95(values.length) * stdDev / Math.sqrt(values.length);
  const streamedTtft = passing
    .filter(sample => sample.ttftMeasurement === 'streamed_wall_clock' && Number.isFinite(Number(sample.ttftMs)))
    .map(sample => Number(sample.ttftMs));
  const promptEvalDurations = passing
    .filter(sample => Number.isFinite(Number(sample.promptEvalDurationMs)))
    .map(sample => Number(sample.promptEvalDurationMs));
  const reliability = values.length < minimumRetainedSamples || cv == null
    ? 'unknown'
    : cv <= 0.05 ? 'high' : cv <= 0.12 ? 'medium' : 'low';
  return {
    sampleCount: kept.length,
    retainedSampleCount: kept.length,
    passingSampleCount: values.length,
    minimumRetainedSamples,
    tokensPerSecMean: _round(mean),
    tokensPerSecMedian: _round(_median(values)),
    tokensPerSecMin: _round(Math.min(...values)),
    tokensPerSecMax: _round(Math.max(...values)),
    tokensPerSecStdDev: _round(stdDev),
    coefficientOfVariation: cv == null ? null : _round(cv, 4),
    p50: _round(_quantile(values, 0.5)),
    p95: _round(_quantile(values, 0.95)),
    ttftP50Ms: streamedTtft.length ? _round(_quantile(streamedTtft, 0.5)) : null,
    ttftP95Ms: streamedTtft.length ? _round(_quantile(streamedTtft, 0.95)) : null,
    ttftSampleCount: streamedTtft.length,
    promptEvalP50Ms: promptEvalDurations.length ? _round(_quantile(promptEvalDurations, 0.5)) : null,
    promptEvalP95Ms: promptEvalDurations.length ? _round(_quantile(promptEvalDurations, 0.95)) : null,
    confidenceInterval95: {
      low: _round(Math.max(0, mean - margin95)),
      high: _round(mean + margin95),
      method: 'student_t'
    },
    reliability
  };
}

function _sampleFromResult(result, sample, opts = {}) {
  return {
    sample,
    tokensPerSec: result.tokensPerSec ?? null,
    promptEvalTokensPerSec: result.promptEvalTokensPerSec ?? null,
    promptEvalDurationMs: result.promptEvalDurationMs ?? null,
    ttftMs: result.timeToFirstTokenMs ?? null,
    ttftMeasurement: result.ttftMeasurement ?? null,
    latencyMs: result.latencyMs ?? null,
    numCtx: result.numCtx ?? null,
    promptTokens: result.promptTokens ?? null,
    completionTokens: result.completionTokens ?? null,
    vramUsedMiB: result.vramUsedMiB ?? null,
    status: result.status,
    error: result.error || null,
    discarded: opts.discarded === true,
    discardReason: opts.discardReason || null
  };
}

function summarizePositiveMeasurements(values, { minimumSamples = 3 } = {}) {
  const samples = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (!samples.length) return {
    sampleCount: 0, minimumSamples, mean: null, p50: null, p95: null,
    standardDeviation: null, coefficientOfVariation: null,
    confidenceInterval95: null, reliability: 'unknown'
  };
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  if (samples.length < 2) return {
    sampleCount: samples.length,
    minimumSamples,
    mean: _round(mean), p50: _round(mean), p95: _round(mean),
    standardDeviation: null, coefficientOfVariation: null,
    confidenceInterval95: null, reliability: 'unknown'
  };
  const variance = samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (samples.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const cv = mean > 0 ? standardDeviation / mean : null;
  const margin = _studentTCritical95(samples.length) * standardDeviation / Math.sqrt(samples.length);
  return {
    sampleCount: samples.length,
    minimumSamples,
    mean: _round(mean),
    p50: _round(_quantile(samples, 0.5)),
    p95: _round(_quantile(samples, 0.95)),
    standardDeviation: _round(standardDeviation),
    coefficientOfVariation: cv == null ? null : _round(cv, 4),
    confidenceInterval95: {
      low: _round(Math.max(0, mean - margin)),
      high: _round(mean + margin),
      method: 'student_t'
    },
    reliability: samples.length < minimumSamples || cv == null
      ? 'unknown'
      : cv <= 0.05 ? 'high' : cv <= 0.12 ? 'medium' : 'low'
  };
}

function completeRepeatedStatistics(statistics, minimumSamples, options = {}) {
  const maxCv = Number.isFinite(Number(options.maxCoefficientOfVariation))
    ? Number(options.maxCoefficientOfVariation)
    : 0.12;
  const maxRelativeCiWidth = Number.isFinite(Number(options.maxRelativeCi95Width))
    ? Number(options.maxRelativeCi95Width)
    : 0.30;
  const mean = Number(statistics?.mean);
  const low = Number(statistics?.confidenceInterval95?.low);
  const high = Number(statistics?.confidenceInterval95?.high);
  const relativeCiWidth = mean > 0 && Number.isFinite(low) && Number.isFinite(high)
    ? (high - low) / mean
    : Infinity;
  return Number(statistics?.sampleCount) >= minimumSamples
    && ['medium', 'high'].includes(statistics?.reliability)
    && Number.isFinite(Number(statistics?.coefficientOfVariation))
    && Number(statistics.coefficientOfVariation) <= maxCv
    && Number.isFinite(low)
    && Number.isFinite(high)
    && relativeCiWidth <= maxRelativeCiWidth;
}

module.exports = {
  _round,
  _median,
  _quantile,
  _studentTCritical95,
  summarizeThroughputSamples,
  _sampleFromResult,
  summarizePositiveMeasurements,
  completeRepeatedStatistics
};
