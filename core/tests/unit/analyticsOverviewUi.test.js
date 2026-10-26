'use strict';
const { needsReview, statusText, outcome, outcomeSplit, callSplit, sparkPaths, comparisonRows, failureRows, buckets, runtimeView, gpuRows } = require('../../public/js/analytics-overview');

describe('analytics overview evidence', () => {
  test('success excludes both errors and cancellations; no activity is not 100% healthy', () => {
    expect(outcome({ calls: 100, errors: 2, cancellations: 3, nonSuccesses: 5 })).toBe(95);
    for (const totals of [{ calls: 0, nonSuccesses: 0 }, { calls: 10 }, { calls: 1, nonSuccesses: 2 }]) expect(outcome(totals)).toBeNull();
  });

  test('outcome and local/cloud rings refuse inconsistent or missing totals', () => {
    expect(outcomeSplit({ calls: 100, nonSuccesses: 5, errors: 2, cancellations: 3 }))
      .toEqual({ success: 95, errors: 2, canceled: 3, total: 100 });
    expect(outcomeSplit({ calls: 100, nonSuccesses: 5, errors: 1, cancellations: 1 })).toBeNull();
    expect(outcomeSplit({ calls: 0, nonSuccesses: 0, errors: 0, cancellations: 0 })).toBeNull();
    expect(callSplit({ totals: { calls: 100 }, local: { calls: 80 }, cloud: { calls: 20 } })).toEqual({ local: 80, cloud: 20, total: 100, localPct: 80 });
    expect(callSplit({ totals: { calls: 100 }, local: { calls: 80 }, cloud: { calls: 10 } })).toBeNull();
    expect(callSplit({ totals: { calls: 100 } })).toBeNull();
  });

  test('sparklines preserve missing intervals, zero baseline and measured zeroes', () => {
    expect(sparkPaths([null, undefined])).toBeNull();
    expect(sparkPaths([10])).toBeNull();
    const paths = sparkPaths([0, 10, null, 5, 0]);
    expect(paths.line).toBe('M2.00,27.00 L26.00,3.00 M74.00,15.00 L98.00,27.00');
    expect(paths.area.match(/Z/g)).toHaveLength(2);
    expect(sparkPaths([0, 0]).line).toBe('M2.00,27.00 L98.00,27.00');
  });

  test('model shares keep the full denominator and account for omitted models', () => {
    const rows = comparisonRows({ totals: { calls: 100 }, byModel: [
      { model: 'a', calls: 30 }, { model: 'b', calls: 20 }, { model: 'c', calls: 10 }
    ] }, 'byModel', 2);
    expect(rows.map(row => [row.label, row.calls, row.share])).toEqual([
      ['a', 30, 30], ['b', 20, 20], ['All other calls', 50, 50]
    ]);
    expect(rows[2].avgLatencyMs).toBeUndefined();
  });

  test('error shares use all errors and retain the omitted remainder without inventing causes', () => {
    const data = { totals: { calls: 1000, errors: 20 }, failureAnalysis: {}, topErrors: [
      { reason: 'workload_reserved', consumerContract: 'desktop-gateway-v1', calls: 12 },
      { reason: 'unclassified_error', consumerContract: 'unknown', calls: 2 },
    ] };
    expect(failureRows(data).map(row => [row.label, row.calls, row.share])).toEqual([
      ['Workload reserved', 12, 60], ['Cause unrecorded', 2, 10], ['All other errors', 6, 30],
    ]);
    expect(failureRows({ ...data, failureAnalysis: undefined })).toBeNull();
    expect(failureRows({ ...data, totals: { errors: 0 } })).toEqual([]);
    expect(failureRows(data).at(-1).avgLatencyMs).toBeUndefined();
  });

  test('elapsed-time share has its own full-window denominator, not a call-count denominator', () => {
    const rows = comparisonRows({ totals: { calls: 100, inferenceSeconds: 1000 }, byModel: [
      { model: 'slow', calls: 30, inferenceSeconds: 900 }, { model: 'fast', calls: 70, inferenceSeconds: 100 }
    ] }, 'byModel', 1);
    expect(rows.map(row => [row.label, row.share, row.timeShare])).toEqual([['fast', 70, 10], ['All other calls', 30, 90]]);
    expect(comparisonRows({ totals: { calls: 1 }, byModel: [{ model: 'unknown-time', calls: 1 }] }, 'byModel')[0].timeShare).toBeNull();
  });

  test('fills hourly gaps only in the selected window, with an unknown error rate for empty buckets', () => {
    const rows = buckets({ bucketHours: 1, window: { from: '2026-01-01T00:30Z', to: '2026-01-01T03:00Z' },
      byBucket: [{ date: '2026-01-01T01:00Z', calls: 20, errors: 2 }] });
    expect(rows.map(row => [row.calls, row.errorPct])).toEqual([[0, null], [20, 10], [0, null]]);
    expect(buckets({ window: {} })).toEqual([]);
  });

  test('quarantined, expired and malformed admissions remain uncertain', () => {
    const fresh = { active: true, expiresAt: '2026-01-01T01:00Z' };
    const view = runtimeView({ inferences: [fresh, { ...fresh, quarantined: true }, { ...fresh, expiresAt: '2025-01-01' }, { active: true }], workloads: [{}] }, Date.parse('2026-01-01T00:00Z'));
    expect(view).toMatchObject({ active: [fresh], uncertain: 3, workloads: 1 });
    expect(runtimeView({})).toBeNull();
  });

  test('GPU utilization needs fresh collector evidence; configured VRAM and CPU endpoints are excluded', () => {
    const host = { hostId: 'gpu', hostname: 'Host A', telemetry: { status: 'fresh', ageMs: 10, staleAfterMs: 90, collectorHostId: 'a' }, gpus: [{ index: 0, busId: 'pci0', utilization: 0, vramUsed: 1000 }] };
    expect(gpuRows([host, { ...host, hostId: 'alias' }])).toHaveLength(1);
    expect(gpuRows([host])[0]).toMatchObject({ fresh: true, utilization: 0 });
    const stale = gpuRows([host], 100)[0];
    expect(stale).toMatchObject({ fresh: false, state: 'stale' });
    expect(stale.utilization).toBeUndefined();
    expect(gpuRows([{ ...host, residency: 'cpu' }])).toEqual([]);
    expect(gpuRows([{ hostId: 'missing', vramUsedMiB: 0, vramTotalMiB: 24000 }])[0].fresh).toBe(false);
  });
});

describe('analytics overview review threshold', () => {
  test('a single error in a busy window is reported but not flagged', () => {
    expect(needsReview({ calls: 1481, errors: 1, errorRate: 0.07 })).toBe(false);
    expect(statusText({ calls: 1481, errors: 1, errorRate: 0.07 })).toEqual({ state: 'ready', text: '1 recorded error · below the 2% review threshold' });
  });

  test('a rate above 2% needs at least three errors', () => {
    expect(needsReview({ calls: 40, errors: 2, errorRate: 5 })).toBe(false);
    expect(needsReview({ calls: 100, errors: 3, errorRate: 3 })).toBe(true);
    expect(statusText({ calls: 100, errors: 3, errorRate: 3 }).state).toBe('attention');
  });

  test('any error in the last hour needs review, however long the window', () => {
    const totals = { calls: 10000, errors: 50, errorRate: 0.5 };
    expect(needsReview(totals, { calls: 40, errors: 0 })).toBe(false);
    expect(needsReview(totals, { calls: 40, errors: 1 })).toBe(true);
    expect(statusText(totals, { calls: 40, errors: 2 })).toEqual({ state: 'attention', text: '2 errors in the last hour need review' });
  });

  test('no calls is empty, not healthy', () => {
    expect(statusText({ calls: 0, errors: 0 }).state).toBe('empty');
  });

  test('recent admission refusals are informational; unknown failures still need review', () => {
    const totals = { calls: 1000, errors: 100, errorRate: 10 };
    const recent = { calls: 20, errors: 3, admissionRefusals: 3 };
    expect(needsReview(totals, recent)).toBe(false);
    expect(statusText(totals, recent)).toEqual({ state: 'ready', text: '3 admission refusals in the last hour · no other errors recorded' });
    expect(needsReview(totals, { ...recent, admissionRefusals: 2 })).toBe(true);
    expect(statusText(totals, { ...recent, admissionRefusals: 2 }).text).toMatch(/1 error.*2 admission refusals separately/);
    expect(needsReview(totals, { ...recent, admissionRefusals: 4 })).toBe(true);
  });

  test('a high historical rate does not describe current health or turn no recent activity into success', () => {
    const totals = { calls: 100, errors: 20, errorRate: 20 };
    expect(needsReview(totals, { calls: 4, errors: 0 })).toBe(false);
    expect(statusText(totals, { calls: 4, errors: 0 }).text).toMatch(/No errors recorded in the last hour/);
    expect(statusText(totals, { calls: 0, errors: 0 }).text).toMatch(/No calls in the last hour/);
  });
});
