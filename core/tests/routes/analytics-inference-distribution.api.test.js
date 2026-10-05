'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../models/InferenceLog', () => ({
  aggregate: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../src/services/costCalculator', () => ({
  resolvePricing: jest.fn()
}));

const InferenceLog = require('../../models/InferenceLog');
const router = require('../../routes/analytics-inference');

function app() {
  const instance = express();
  instance.use('/api/analytics/inference', router);
  return instance;
}

const group = (key, calls) => ({
  _id: key,
  calls,
  success: calls,
  inputTokens__count: calls,
  inputTokens__max: 40000,
  inputTokens__pct: [30000, 38000, 39000, 40000],
});

describe('GET /api/analytics/inference/distribution', () => {
  let server;

  beforeAll((done) => {
    server = app().listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    InferenceLog.aggregate.mockResolvedValue([{ totals: [{ calls: 3 }], groups: [] }]);
  });

  test('covers the default window when no from/to is given', async () => {
    const res = await request(server).get('/api/analytics/inference/distribution');

    expect(res.status).toBe(200);
    expect(res.body.data.window.key).toBe('7d');
    expect(res.body.data.groupBy).toEqual(['consumerContract']);
    expect(res.body.data.retentionDays).toBe(30);
    const [pipeline] = InferenceLog.aggregate.mock.calls[0];
    const { timestamp } = pipeline[0].$match;
    expect(timestamp.$lte - timestamp.$gte).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('applies the log filters and an explicit time range', async () => {
    const res = await request(server).get('/api/analytics/inference/distribution')
      .query({
        consumerContract: 'openclaw-pipeline-runtime-v1',
        status: 'success,timeout',
        from: '2026-09-04T00:00:00Z',
        to: '2026-10-04T00:00:00Z',
        groupBy: 'model,host',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.window.key).toBeNull();
    expect(res.body.data.filters.consumerContract).toBe('openclaw-pipeline-runtime-v1');
    const [pipeline] = InferenceLog.aggregate.mock.calls[0];
    expect(pipeline[0].$match).toEqual({
      consumerContract: 'openclaw-pipeline-runtime-v1',
      status: { $in: ['success', 'timeout'] },
      timestamp: { $gte: new Date('2026-09-04T00:00:00Z'), $lte: new Date('2026-10-04T00:00:00Z') },
    });
    expect(Object.keys(pipeline[1].$project)).toEqual(expect.arrayContaining(['model', 'host']));
  });

  test('filters on a fallback reason and groups by its stable code', async () => {
    InferenceLog.aggregate.mockResolvedValue([{ totals: [{ calls: 2 }], groups: [
      group({ taskType: 'quick_chat', fallbackReason: 'task_fallback_primary_busy' }, 2)
    ] }]);
    const res = await request(server).get('/api/analytics/inference/distribution')
      .query({ fallbackReason: 'task_fallback_primary_busy', groupBy: 'taskType,fallbackReason' });

    expect(res.status).toBe(200);
    const [pipeline] = InferenceLog.aggregate.mock.calls[0];
    expect(pipeline[0].$match.fallbackReason).toBe('task_fallback_primary_busy');
    expect(res.body.data.groups[0].key).toEqual({ taskType: 'quick_chat', fallbackReason: 'task_fallback_primary_busy' });
  });

  test('sanitizes group labels through the inference log read projection', async () => {
    InferenceLog.aggregate.mockResolvedValue([{
      totals: [{ calls: 5 }],
      groups: [
        group({ model: 'model-a', host: 'http://ollama-a.test:11434/' }, 3),
        group({ model: 'payload with spaces', host: 'unknown' }, 2),
      ],
    }]);

    const res = await request(server).get('/api/analytics/inference/distribution?groupBy=model,host');

    expect(res.status).toBe(200);
    expect(res.body.data.groups.map(row => row.key)).toEqual([
      { model: 'model-a', host: 'http://ollama-a.test:11434' },
      { model: 'unknown', host: 'unknown' },
    ]);
    expect(res.body.data.groups[0].metrics.inputTokens).toEqual({
      count: 3, p50: 30000, p90: 38000, p95: 39000, p99: 40000, max: 40000,
    });
  });

  test.each([
    ['groupBy=callerDetail', /groupBy accepts/],
    ['groupBy=model,host,taskType', /groupBy accepts/],
    ['limit=0', /limit must be/],
    ['status=cancelled', /status must contain/],
    ['from=yesterday', /from must be/],
  ])('rejects %s', async (query, message) => {
    const res = await request(server).get(`/api/analytics/inference/distribution?${query}`);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(message);
    expect(InferenceLog.aggregate).not.toHaveBeenCalled();
  });
});
