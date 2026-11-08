const express = require('express');
const request = require('supertest');

const mockAggregate = jest.fn();

jest.mock('../../models/InferenceLog', () => ({
  aggregate: (...args) => mockAggregate(...args)
}));

const telemetryRoutes = require('../../routes/inference-telemetry');

function buildApp() {
  const app = express();
  app.use('/api/telemetry', telemetryRoutes);
  return app;
}

describe('Inference telemetry API', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('filters and summarizes hosts while deriving their top models', async () => {
    mockAggregate.mockResolvedValueOnce([
      {
        host: 'http://primary:11434',
        callCount: 4,
        count: 4,
        avgLatencyMs: 250,
        errorCount: 1,
        errorRate: 25,
        totalTokensIn: 120,
        totalTokensOut: 80,
        models: ['qwen3.5:9b', 'nomic-embed-text:v1.5', 'qwen3.5:9b', 'qwen3.5:9b']
      }
    ]);

    const beforeRequest = Date.now();
    const response = await request(app)
      .get('/api/telemetry/host-summary')
      .query({
        hours: 6,
        host: 'http://primary:11434',
        model: 'qwen3.5:9b',
        caller: 'proxy',
        callerDetailPrefix: 'nestor/',
        taskType: 'buddy_chat',
        status: 'success'
      })
      .expect(200);
    const afterRequest = Date.now();

    const pipeline = mockAggregate.mock.calls[0][0];
    const match = pipeline[0].$match;
    expect(pipeline[1].$group).toEqual(expect.objectContaining({
      errorCount: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
      timeoutCount: { $sum: { $cond: [{ $eq: ['$status', 'timeout'] }, 1, 0] } },
      nonSuccessCount: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } },
    }));
    expect(match).toEqual(expect.objectContaining({
      host: 'http://primary:11434',
      model: 'qwen3.5:9b',
      caller: 'proxy',
      taskType: 'buddy_chat',
      status: 'success'
    }));
    expect(String(match.callerDetail)).toBe('/^nestor\\//');
    expect(match.timestamp.$gte).toBeInstanceOf(Date);
    expect(match.timestamp.$gte.getTime()).toBeGreaterThanOrEqual(beforeRequest - 6 * 3600000);
    expect(match.timestamp.$gte.getTime()).toBeLessThanOrEqual(afterRequest - 6 * 3600000);

    expect(response.body).toEqual({
      status: 'success',
      data: [{
        host: 'http://primary:11434',
        callCount: 4,
        count: 4,
        avgLatencyMs: 250,
        errorCount: 1,
        errorRate: 25,
        totalTokensIn: 120,
        totalTokensOut: 80,
        topModels: [
          { model: 'qwen3.5:9b', count: 3 },
          { model: 'nomic-embed-text:v1.5', count: 1 }
        ],
        hostIdentity: {
          key: 'http://primary:11434',
          displayName: 'primary',
          role: null,
          ip: 'primary',
          url: 'http://primary:11434'
        }
      }]
    });
  });

  it('returns the model and caller aggregate contracts', async () => {
    mockAggregate
      .mockResolvedValueOnce([{
        model: 'qwen3.5:9b',
        callCount: 5,
        avgLatencyMs: 300,
        errorCount: 1,
        errorRate: 20,
        avgTokensOut: 42,
        hosts: ['http://primary:11434']
      }])
      .mockResolvedValueOnce([{
        caller: 'proxy',
        callCount: 5,
        avgLatencyMs: 300,
        errorCount: 1,
        errorRate: 20
      }]);

    const modelResponse = await request(app)
      .get('/api/telemetry/model-summary')
      .expect(200);
    const callerResponse = await request(app)
      .get('/api/telemetry/caller-summary')
      .expect(200);

    expect(mockAggregate.mock.calls[0][0][1].$group._id).toBe('$model');
    expect(mockAggregate.mock.calls[1][0][1].$group._id).toBe('$caller');
    expect(mockAggregate.mock.calls[0][0][2].$project).toHaveProperty('nonSuccessRate');
    expect(mockAggregate.mock.calls[1][0][2].$project).toHaveProperty('nonSuccessRate');
    expect(modelResponse.body.data[0]).toEqual(expect.objectContaining({
      model: 'qwen3.5:9b',
      avgTokensOut: 42
    }));
    expect(callerResponse.body.data[0]).toEqual(expect.objectContaining({
      caller: 'proxy',
      errorRate: 20
    }));
  });

  it('combines host samples including long calls on the latency axis', async () => {
    const firstBucket = new Date('2026-07-17T01:00:00.000Z');
    const secondBucket = new Date('2026-07-17T01:15:00.000Z');
    mockAggregate.mockResolvedValueOnce([
      {
        _id: { bucket: firstBucket, host: 'http://primary:11434' },
        calls: 3,
        avgLatencyMs: 200,
        errors: 1,
        latencies: [100, 300, 80000]
      },
      {
        _id: { bucket: firstBucket, host: 'http://secondary:11434' },
        calls: 1,
        avgLatencyMs: 200,
        errors: 0,
        latencies: [200]
      },
      {
        _id: { bucket: secondBucket, host: 'http://primary:11434' },
        calls: 1,
        avgLatencyMs: 400,
        errors: 0,
        latencies: [400]
      }
    ]);

    const response = await request(app)
      .get('/api/telemetry/timeline')
      .query({ hours: 12, bucketMinutes: 15 })
      .expect(200);

    const pipeline = mockAggregate.mock.calls[0][0];
    expect(pipeline[1].$group._id.bucket.$dateTrunc.binSize).toBe(15);
    expect(response.body.data).toEqual([
      {
        bucket: firstBucket.toISOString(),
        calls: 4,
        avgLatencyMs: 20150,
        p95LatencyMs: 80000,
        latencySampleCount: 4,
        unmeasuredDurationCount: 0,
        shortCallCount: 3,
        longCallCount: 1,
        longCallMaxMs: 80000,
        errors: 1,
        byHost: {
          'http://primary:11434': 3,
          'http://secondary:11434': 1
        },
        coldStartSuspectedCount: 1,
        coldStartSuspectedMaxMs: 80000
      },
      {
        bucket: secondBucket.toISOString(),
        calls: 1,
        avgLatencyMs: 400,
        p95LatencyMs: 400,
        latencySampleCount: 1,
        unmeasuredDurationCount: 0,
        shortCallCount: 1,
        longCallCount: 0,
        longCallMaxMs: null,
        errors: 0,
        byHost: { 'http://primary:11434': 1 },
        coldStartSuspectedCount: 0,
        coldStartSuspectedMaxMs: null
      }
    ]);
  });

  it('does not fabricate timings from missing, nonnumeric, nonfinite or default-zero durations', async () => {
    const latencies = [undefined, null, '90000', NaN, Infinity, -Infinity, -10, 0];
    mockAggregate.mockResolvedValueOnce([{
      _id: { bucket: new Date('2026-07-17T01:00:00Z'), host: 'http://primary:11434' },
      calls: latencies.length, errors: 2, latencies
    }]);
    const response = await request(app).get('/api/telemetry/timeline').expect(200);
    expect(response.body.data[0]).toMatchObject({
      calls: 8, errors: 2, latencySampleCount: 0, unmeasuredDurationCount: 8,
      shortCallCount: 0, longCallCount: 0, longCallMaxMs: null,
      avgLatencyMs: null, p95LatencyMs: null,
      coldStartSuspectedCount: 0, coldStartSuspectedMaxMs: null
    });
  });

  it('uses exact nearest-rank P95 at the twenty-sample boundary', async () => {
    mockAggregate.mockResolvedValueOnce([{
      _id: { bucket: new Date('2026-07-17T01:00:00Z'), host: 'http://primary:11434' },
      calls: 20, errors: 0, latencies: Array.from({ length: 20 }, (_, i) => (20 - i) * 1000)
    }]);
    const response = await request(app).get('/api/telemetry/timeline').expect(200);
    expect(response.body.data[0]).toMatchObject({ avgLatencyMs: 10500, p95LatencyMs: 19000, latencySampleCount: 20 });
  });

  it('zero-fills empty timeline buckets between observed timestamps', () => {
    const dense = telemetryRoutes.densifyTimeline([
      { bucket: '2026-07-17T01:00:00.000Z', calls: 2 },
      { bucket: '2026-07-17T03:00:00.000Z', calls: 1 },
    ], 60);

    expect(dense).toHaveLength(3);
    expect(dense[1]).toEqual(expect.objectContaining({
      bucket: '2026-07-17T02:00:00.000Z',
      calls: 0, errors: 0,
      avgLatencyMs: null, p95LatencyMs: null,
      latencySampleCount: 0, unmeasuredDurationCount: 0,
      shortCallCount: 0, longCallCount: 0, longCallMaxMs: null,
      coldStartSuspectedCount: 0, coldStartSuspectedMaxMs: null,
      byHost: {},
    }));
  });

  it('bounds telemetry windows and timeline buckets to safe positive ranges', async () => {
    mockAggregate.mockResolvedValue([]);

    const beforeRequest = Date.now();
    await request(app)
      .get('/api/telemetry/timeline')
      .query({ hours: 999999, bucketMinutes: -20 })
      .expect(200);
    const afterRequest = Date.now();

    const pipeline = mockAggregate.mock.calls[0][0];
    const cutoff = pipeline[0].$match.timestamp.$gte.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(beforeRequest - 720 * 3600000);
    expect(cutoff).toBeLessThanOrEqual(afterRequest - 720 * 3600000);
    expect(pipeline[1].$group._id.bucket.$dateTrunc.binSize).toBe(1);

    await request(app)
      .get('/api/telemetry/timeline')
      .query({ hours: -20, bucketMinutes: 999999 })
      .expect(200);

    const boundedPipeline = mockAggregate.mock.calls[1][0];
    expect(boundedPipeline[1].$group._id.bucket.$dateTrunc.binSize).toBe(1440);
  });

  it('returns a stable error envelope when telemetry storage fails', async () => {
    mockAggregate.mockRejectedValueOnce(new Error('telemetry unavailable'));

    const response = await request(app)
      .get('/api/telemetry/caller-summary')
      .expect(500);

    expect(response.body).toEqual({
      status: 'error',
      message: 'telemetry unavailable'
    });
  });
});
