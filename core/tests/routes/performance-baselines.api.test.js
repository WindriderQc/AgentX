'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../models/PerformanceSnapshot');
jest.mock('../../models/PerformanceLoadTest');
jest.mock('../../models/PerformanceBaseline');
jest.mock('../../src/services/artilleryParser', () => ({}));

const PerformanceSnapshot = require('../../models/PerformanceSnapshot');
const PerformanceBaseline = require('../../models/PerformanceBaseline');
const router = require('../../routes/performance-data');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/performance', router);
  return instance;
}

describe('POST /api/performance/baselines', () => {
  let saved;

  beforeEach(() => {
    jest.clearAllMocks();
    saved = null;
    PerformanceBaseline.mockImplementation(function construct(doc) {
      Object.assign(this, doc);
      this.save = jest.fn(async () => { saved = doc; });
    });
  });

  test('samples the baseline from measured production traffic over the chosen window', async () => {
    PerformanceSnapshot.getAggregatedMetrics = jest.fn().mockResolvedValue({
      total_requests: 7200, error_rate: 0.5, avg_latency: 120, avg_p95: 340
    });

    const res = await request(app()).post('/api/performance/baselines').send({ name: 'Release 2', hours: 2 });

    expect(res.status).toBe(201);
    expect(saved.source).toBe('production_sample');
    expect(saved.metrics).toEqual({ avg_response_time: 120, p95_latency: 340, error_rate: 0.5, throughput_rps: 1 });
    const [from, to] = PerformanceSnapshot.getAggregatedMetrics.mock.calls[0];
    expect(to - from).toBeCloseTo(2 * 3600 * 1000, -3);
  });

  test('refuses a window with no measured traffic instead of saving zeros', async () => {
    PerformanceSnapshot.getAggregatedMetrics = jest.fn().mockResolvedValue({
      total_requests: 0, error_rate: 0, avg_latency: null, avg_p95: null
    });

    const res = await request(app()).post('/api/performance/baselines').send({ name: 'Empty' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/No measured production traffic/);
    expect(saved).toBeNull();
  });

  test('does not build a production baseline from a synthetic load test', async () => {
    const res = await request(app()).post('/api/performance/baselines').send({ name: 'From test', loadTestId: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/production traffic/);
    expect(saved).toBeNull();
  });
});

describe('GET /api/performance/baseline-compare', () => {
  test('returns numeric throughput so the page can format it', async () => {
    PerformanceBaseline.getActive = jest.fn().mockResolvedValue({
      name: 'Release 2',
      created_at: new Date('2026-10-01T00:00:00Z'),
      metrics: { avg_response_time: 100, p95_latency: 300, error_rate: 0.5, throughput_rps: 1 }
    });
    PerformanceSnapshot.getAggregatedMetrics = jest.fn().mockResolvedValue({
      total_requests: 3600, error_rate: 0.5, avg_latency: 110, avg_p95: 320
    });

    const res = await request(app()).get('/api/performance/baseline-compare?hours=1');

    expect(res.status).toBe(200);
    const body = res.body.data || res.body;
    expect(body.current.throughput_rps).toBe(1);
    expect(body.baseline.created_at).toBe('2026-10-01T00:00:00.000Z');
  });
});
