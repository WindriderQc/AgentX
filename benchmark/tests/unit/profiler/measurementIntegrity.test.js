'use strict';
const { summarizeThroughputSamples, completeRepeatedStatistics } = require('../../../src/services/profiler/profilerStatistics');
const { profileQualificationFailures } = require('../../../src/services/profiler/profilerQualification');
const { buildLaneCapability } = require('../../../src/services/profiler/laneCapability');

describe('profiler evidence integrity', () => {
  test.each([null, undefined, '', false, NaN, Infinity, -1])('does not turn absent or invalid timing %p into a measurement', value => {
    for (const count of [1, 5]) {
      const samples = Array.from({ length: count }, () => ({ status: 'pass', tokensPerSec: 50,
        ttftMeasurement: 'streamed_wall_clock', ttftMs: value, promptEvalDurationMs: value }));
      expect(summarizeThroughputSamples(samples)).toMatchObject({
        ttftP50Ms: null, ttftP95Ms: null, ttftSampleCount: 0, promptEvalP50Ms: null, promptEvalP95Ms: null
      });
    }
  });
  test('single sample requires streamed timing provenance and preserves measured zero', () => {
    const sample = { status: 'pass', tokensPerSec: 50, ttftMs: 0, promptEvalDurationMs: 0 };
    expect(summarizeThroughputSamples([sample])).toMatchObject({ ttftP50Ms: null, ttftSampleCount: 0 });
    expect(summarizeThroughputSamples([{ ...sample, ttftMeasurement: 'streamed_wall_clock' }]))
      .toMatchObject({ ttftP50Ms: 0, ttftSampleCount: 1, promptEvalP50Ms: 0 });
  });
  test('requires finite ordered repeated statistics', () => {
    const valid = { sampleCount: 5, mean: 10, reliability: 'high', coefficientOfVariation: 0,
      confidenceInterval95: { low: 10, high: 10 } };
    expect(completeRepeatedStatistics(valid, 5)).toBe(true);
    for (const value of [null, undefined, '', false, NaN, Infinity, -1]) {
      expect(completeRepeatedStatistics({ ...valid, coefficientOfVariation: value }, 5)).toBe(false);
      expect(completeRepeatedStatistics({ ...valid, confidenceInterval95: { low: value, high: 10 } }, 5)).toBe(false);
    }
    expect(completeRepeatedStatistics({ ...valid, confidenceInterval95: { low: 11, high: 10 } }, 5)).toBe(false);
  });
  test('rejects a detected spill and missing TTFT even if residency was verified', () => {
    const failures = profileQualificationFailures({ profileDepth: 'standard', maxVerifiedContext: 8192,
      recommendedInteractiveContext: 4096, recommendedDocumentContext: 8192, requiredRetainedSamples: 5,
      measurementQuality: { passingSampleCount: 5, reliability: 'high', ttftSampleCount: 5 },
      ttftMeasurement: 'streamed_wall_clock', ttftMs: null, spill: { verified: true, spillDetected: true } });
    expect(failures).toEqual(expect.arrayContaining(['streamed_ttft_missing', 'gpu_spill_detected']));
  });
  test.each([null, undefined])('requires an explicit no-spill result rather than %p', spillDetected => {
    expect(profileQualificationFailures({ spill: { verified: true, spillDetected } }))
      .toContain('gpu_residency_unverified');
  });
  const identity = { digest: 'artifact', runtimeFingerprint: 'runtime' };
  const profile = { qualityContextStatus: 'verified', qualityVerifiedContext: 65536,
    concurrency: { status: 'unmeasured', worstSelfSlowdownPct: null },
    agentWorkload: { summary: { sessionLatencyKneeContext: 16384, sessionAccuracyContext: null,
      verificationVerifiedContext: null, reliableOutputTokens: 2000, reliableToolTurns: 10,
      toolChecksCorrect: 10, toolChecksTotal: 10 } } };
  test.each([null, {}, { digest: 'artifact' }])('does not trust performance without installed identity %p', artifact => {
    const lane = buildLaneCapability({ artifact, performanceProfile: { artifact: identity, profile } });
    expect(lane.quality.status).toBe('unknown');
    expect(lane.readiness.codingAgent).toBe('not_measured');
  });
  test('does not trust a legacy performance profile without its measured identity', () => {
    expect(buildLaneCapability({ artifact: identity, performanceProfile: { profile } }).quality.status).toBe('unknown');
  });
  test('requires all three agent context limits and preserves unknown slowdown', () => {
    const lane = buildLaneCapability({ artifact: identity, performanceProfile: { artifact: identity, profile } });
    expect(lane.agent.recommendedStepContext).toBeNull();
    expect(lane.readiness.codingAgent).toBe('limited');
    expect(lane.concurrency.worstSelfSlowdownPct).toBeNull();
  });
});
