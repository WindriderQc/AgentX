const PerformanceSnapshot = require('../../models/PerformanceSnapshot');

describe('PerformanceSnapshot aggregation', () => {
  beforeEach(async () => {
    await PerformanceSnapshot.deleteMany({});
  });

  test('ignores hours that only counted model-bound requests', async () => {
    const now = Date.now();
    const hour = offset => new Date(Math.floor((now - offset * 3600e3) / 3600e3) * 3600e3);
    await PerformanceSnapshot.create([
      { hour: hour(1), requests_total: 10, requests_successful: 10, requests_failed: 0,
        latency: { min: 5, max: 200, avg: 100, p50: 90, p95: 180, p99: 200 } },
      { hour: hour(2), requests_total: 0, model_bound_requests: 7 }
    ]);

    const metrics = await PerformanceSnapshot.getAggregatedMetrics(new Date(now - 5 * 3600e3), new Date(now));
    expect(metrics.avg_latency).toBe(100);
    expect(metrics.avg_p95).toBe(180);
    expect(metrics.model_bound_requests).toBe(7);

    const trend = await PerformanceSnapshot.getLatencyTrend(5);
    expect(trend).toHaveLength(1);
  });
});
