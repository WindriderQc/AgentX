'use strict';

const express = require('express');
const request = require('supertest');
const InferenceLog = require('../../models/InferenceLog');
const telemetry = require('../../routes/inference-telemetry');

// Suite-owned disposable MongoDB; raw inserts preserve malformed historical values.
describe('inference telemetry timeline aggregation', () => {
  const app = express();
  app.use('/api/telemetry', telemetry);
  const start = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 4 * 3600000);
  const base = {
    host: 'http://primary.example.test:11434', model: 'local/test',
    caller: 'proxy', status: 'success', timestamp: start
  };
  const getTimeline = query => request(app).get('/api/telemetry/timeline').query(query || {}).expect(200);
  beforeEach(() => InferenceLog.deleteMany({}));

  test('90-second and two-minute calls remain measured without evidence of a cold start', async () => {
    await InferenceLog.insertMany([
      { ...base, durationMs: 90000, loadMs: 0 },
      { ...base, durationMs: 120000 }
    ]);
    const { body: { data } } = await getTimeline();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      calls: 2, errors: 0, avgLatencyMs: 105000, p95LatencyMs: 120000,
      latencySampleCount: 2, unmeasuredDurationCount: 0,
      shortCallCount: 0, longCallCount: 2, longCallMaxMs: 120000,
      coldStartSuspectedCount: 2, coldStartSuspectedMaxMs: 120000
    });
  });

  test('includes measured errors/timeouts, combines hosts, and honors the existing status filter', async () => {
    await InferenceLog.insertMany([
      { ...base, durationMs: 1000 },
      { ...base, durationMs: 60000 },
      { ...base, durationMs: 90000, status: 'error' },
      { ...base, host: 'http://secondary.example.test:11434', durationMs: 120000, status: 'timeout' }
    ]);
    const { body: { data } } = await getTimeline();
    expect(data[0]).toMatchObject({
      calls: 4, errors: 2, avgLatencyMs: 67750, p95LatencyMs: 120000,
      latencySampleCount: 4, shortCallCount: 1, longCallCount: 3,
      byHost: { [base.host]: 3, 'http://secondary.example.test:11434': 1 }
    });
    for (const [status, calls, errors, avgLatencyMs] of [
      ['success', 2, 0, 30500], ['error', 1, 1, 90000], ['timeout', 1, 1, 120000]
    ]) {
      const { body: { data: filtered } } = await getTimeline({ status });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toMatchObject({ calls, errors, avgLatencyMs, latencySampleCount: calls });
    }
  });

  test('counts invalid and missing durations without turning them into zero-latency observations', async () => {
    const durations = [null, '90000', NaN, Infinity, -Infinity, -5, 0, true];
    await InferenceLog.collection.insertMany([
      { ...base }, ...durations.map(durationMs => ({ ...base, durationMs })),
      { ...base, durationMs: 1000 }
    ]);
    const { body: { data } } = await getTimeline();
    expect(data[0]).toMatchObject({
      calls: 10, errors: 0, avgLatencyMs: 1000, p95LatencyMs: 1000,
      latencySampleCount: 1, unmeasuredDurationCount: 9,
      shortCallCount: 1, longCallCount: 0, longCallMaxMs: null
    });
  });

  test('keeps empty buckets and buckets with only unmeasured calls distinct', async () => {
    await InferenceLog.collection.insertMany([
      { ...base, durationMs: 59999 },
      { ...base, timestamp: new Date(+start + 2 * 3600000) }
    ]);
    const { body: { data } } = await getTimeline();
    expect(data).toHaveLength(3);
    expect(data.map(bucket => bucket.bucket)).toEqual([0, 1, 2].map(i => new Date(+start + i * 3600000).toISOString()));
    expect(data[0]).toMatchObject({ shortCallCount: 1, longCallCount: 0, avgLatencyMs: 59999 });
    expect(data[1]).toMatchObject({
      calls: 0, errors: 0, latencySampleCount: 0, unmeasuredDurationCount: 0,
      avgLatencyMs: null, p95LatencyMs: null, longCallMaxMs: null, byHost: {}
    });
    expect(data[2]).toMatchObject({
      calls: 1, errors: 0, latencySampleCount: 0, unmeasuredDurationCount: 1,
      avgLatencyMs: null, p95LatencyMs: null, longCallMaxMs: null, byHost: { [base.host]: 1 }
    });
  });

  test('returns no invented buckets when no call matches', async () => {
    const { body: { data } } = await getTimeline();
    expect(data).toEqual([]);
  });
});
