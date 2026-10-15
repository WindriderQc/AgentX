'use strict';
const express = require('express');
const request = require('supertest');
const InferenceLog = require('../../models/InferenceLog');
const router = require('../../routes/analytics-inference');

// Runs against the suite-owned disposable MongoDB, never a configured model.
describe('inference summary aggregation', () => {
  let server;
  beforeAll(done => {
    const app = express();
    app.use('/api/analytics/inference', router);
    server = app.listen(0, '127.0.0.1', done);
  });
  afterAll(done => { server.close(done); });
  beforeEach(() => InferenceLog.deleteMany({}));

  test('hourly totals reconcile with outcomes, full model totals and observed timings', async () => {
    const timestamp = new Date(Date.now() - 3600000);
    const rows = Array.from({ length: 45 }, (_, i) => ({
      model: `local/model-${i}`, host: 'http://192.0.2.1:11434', timestamp,
      caller: 'proxy', status: i === 0 ? 'error' : i === 1 ? 'timeout' : 'success',
      error: i === 1 ? 'caller_disconnected' : null,
      tokensIn: 100, tokensOut: 50, durationMs: i === 44 ? 0 : 1000
    }));
    await InferenceLog.insertMany(rows);
    const res = await request(server).get('/api/analytics/inference/summary?window=24h');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals).toMatchObject({ calls: 45, errors: 1, cancellations: 1, nonSuccesses: 2, timedCalls: 44, avgLatencyMs: 1000 });
    expect(d.byModel).toHaveLength(40);
    expect(d.local.calls).toBe(45);
    expect(d.coverage).toMatchObject({ modelCount: 45, listedModelCalls: 40 });
    expect(d.byBucket).toHaveLength(1);
    expect(d.byBucket[0]).toMatchObject({ calls: 45, errors: 1, cancellations: 1, timedCalls: 44, avgLatencyMs: 1000 });
    expect(d.byBucket[0].date).toBe(new Date(Math.floor(+timestamp / 3600000) * 3600000).toISOString());
    expect(d.byBucket.reduce((sum, row) => sum + row.calls, 0)).toBe(d.totals.calls);
  });

  test('unmeasured duration is unknown rather than a zero-latency call', async () => {
    await InferenceLog.create({ model: 'local/legacy', host: 'http://192.0.2.1:11434', durationMs: 0 });
    const res = await request(server).get('/api/analytics/inference/summary?window=7d');
    expect(res.body.data.totals).toMatchObject({ calls: 1, timedCalls: 0, avgLatencyMs: null });
    expect(res.body.data.byModel[0].avgLatencyMs).toBeNull();
    expect(res.body.data.bucketHours).toBe(24);
  });
});
