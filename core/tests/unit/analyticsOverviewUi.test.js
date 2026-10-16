'use strict';
const { outcome, outcomeSplit, callSplit, sparkPaths, comparisonRows, buckets, runtimeView, gpuRows } = require('../../public/js/analytics-overview');

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
