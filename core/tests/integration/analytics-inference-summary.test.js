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

  test('consumer coverage reconciles legacy missing contracts and the filtered log drilldown', async () => {
    const base = { model: 'local/test', host: 'http://192.0.2.1:11434', status: 'success', caller: 'proxy' };
    await InferenceLog.insertMany([
      base, { ...base, consumerContract: '' }, { ...base, consumerContract: 'unknown', caller: 'embedding' },
      { ...base, consumerContract: 'desktop-runtime-v1' },
      { ...base, consumerContract: 'core-ops-watch-v1', taskType: 'ops_watch' }
    ]);
    const { body: { data: d } } = await request(server).get('/api/analytics/inference/summary?window=24h').expect(200);
    expect(d.attribution).toMatchObject({ calls: 5, identifiedCalls: 2, missingCalls: 3, identifiedPct: 40,
      missingByCaller: [{ caller: 'proxy', calls: 2 }, { caller: 'embedding', calls: 1 }] });
    expect(d.observedAt).toBe(d.window.to);
    expect(d.ttlMs).toBe(300000);
    for (const [flag, total] of [['true', 3], ['false', 2]]) {
      const res = await request(server).get('/api/analytics/inference/logs').query({
        consumerContractMissing: flag, from: d.window.from, to: d.window.to
      }).expect(200);
      expect(res.body.data.pagination.total).toBe(total);
      expect(res.body.data.items).toHaveLength(total);
      expect(res.body.data.filters.consumerContractMissing).toBe(flag);
    }
    await request(server).get('/api/analytics/inference/logs?consumerContractMissing=maybe').expect(400);
    await request(server).get('/api/analytics/inference/logs?consumerContractMissing=true&consumerContract=desktop-runtime-v1').expect(400);
  });

  test('empty activity leaves the attribution percentage unobserved', async () => {
    const { body: { data: d } } = await request(server).get('/api/analytics/inference/summary?window=24h').expect(200);
    expect(d.attribution).toMatchObject({ calls: 0, identifiedCalls: 0, missingCalls: 0, identifiedPct: null });
  });

  test('unmeasured duration is unknown rather than a zero-latency call', async () => {
    await InferenceLog.create({ model: 'local/legacy', host: 'http://192.0.2.1:11434', durationMs: 0 });
    const res = await request(server).get('/api/analytics/inference/summary?window=7d');
    expect(res.body.data.totals).toMatchObject({ calls: 1, timedCalls: 0, avgLatencyMs: null });
    expect(res.body.data.byModel[0].avgLatencyMs).toBeNull();
    expect(res.body.data.bucketHours).toBe(24);
  });

  test('explains retained admission refusals without turning retries into failed user requests', async () => {
    const base = { model: 'local/brain', host: 'http://192.0.2.1:11434', status: 'error', durationMs: 25 };
    const refused = (cause, consumerContract) => ({ ...base, consumerContract, admissionWaitMs: 5,
      routeDecision: { outcome: { stage: 'unknown', code: 'unknown' } },
      retry: { attempts: 1, history: [{ attempt: 1, cause, delayMs: 0 }] },
    });
    await InferenceLog.insertMany([
      ...Array.from({ length: 7 }, () => refused('workload_reserved', 'desktop-gateway-v1')),
      ...Array.from({ length: 3 }, () => refused('inference_recovery_required', 'desktop-gateway-v1')),
      refused('workload_reserved', 'native-runtime-v1'),
      { ...base, error: 'caller_disconnected', consumerContract: 'desktop-gateway-v1' },
      { ...base, status: 'success', retry: { attempts: 2, history: [{ attempt: 1, cause: 'workload_reserved', delayMs: 2000 }] } },
    ]);
    const { body: { data: d } } = await request(server).get('/api/analytics/inference/summary?window=24h').expect(200);
    expect(d.totals).toMatchObject({ calls: 13, errors: 11, cancellations: 1 });
    expect(d.failureAnalysis).toMatchObject({ admissionRefusals: 11, unclassified: 0, byReason: [
      { reason: 'workload_reserved', calls: 8 }, { reason: 'inference_recovery_required', calls: 3 },
    ] });
    expect(d.failureAnalysis.basis).toMatch(/not counts of failed user requests/);
    expect(d.topErrors).toHaveLength(3);
    expect(d.topErrors[0]).toMatchObject({ reason: 'workload_reserved', consumerContract: 'desktop-gateway-v1', calls: 7, avgLatencyMs: 25 });
    expect(d.topErrors.reduce((n, row) => n + row.calls, 0)).toBe(11);
  });

  test('terminal route evidence wins; earlier retries, malformed fields and raw messages cannot invent a cause', async () => {
    const secret = 'PRIVATE_PROVIDER_BODY /secret/path user@example.test';
    const base = { model: 'local/brain', host: 'http://192.0.2.1:11434', status: 'error', error: secret,
      admissionWaitMs: 5, retry: { attempts: 2, history: [{ attempt: 1, cause: 'workload_reserved', delayMs: 2000 }] } };
    await InferenceLog.insertMany([
      base,
      { ...base, routeDecision: { outcome: { stage: 'execution', code: 'upstream_error', reasonCode: 'connection_failure' } } },
      { ...base, routeDecision: { outcome: { code: secret, reasonCode: secret } }, retry: { attempts: 2, history: 'invalid' } },
      { ...base, retry: { attempts: 2, history: [{ attempt: 2, cause: secret, delayMs: 0 }] } },
      { ...base, hostGateWaitMs: 10, retry: { attempts: 2, history: [{ attempt: 2, cause: 'workload_reserved', delayMs: 0 }] } },
      { ...base, status: 'timeout' },
      { ...base, routeDecision: { outcome: { stage: 'admission', code: 'pre_dispatch_error', reasonCode: 'inference_recovery_required' } } },
    ]);
    const { body: { data: d } } = await request(server).get('/api/analytics/inference/summary?window=24h').expect(200);
    expect(JSON.stringify(d)).not.toContain(secret);
    expect(d.failureAnalysis).toMatchObject({ admissionRefusals: 1, unclassified: 4 });
    expect(d.failureAnalysis.byReason).toEqual(expect.arrayContaining([
      { reason: 'connection_failure', calls: 1 }, { reason: 'upstream_timeout', calls: 1 },
    ]));
    expect(d.failureAnalysis.byReason.reduce((n, row) => n + row.calls, 0)).toBe(d.totals.errors);
  });

  test('all error causes reconcile beyond the ten displayed cause/consumer/model groups', async () => {
    await InferenceLog.insertMany(Array.from({ length: 14 }, (_, i) => ({
      model: `local/model-${i}`, host: 'http://192.0.2.1:11434', status: 'error',
      routeDecision: { outcome: { code: 'pre_dispatch_error', reasonCode: 'workload_reserved' } },
    })));
    const { body: { data: d } } = await request(server).get('/api/analytics/inference/summary?window=24h').expect(200);
    expect(d.topErrors).toHaveLength(10);
    expect(d.failureAnalysis.admissionRefusals).toBe(14);
    expect(d.failureAnalysis.byReason).toEqual([{ reason: 'workload_reserved', calls: 14 }]);
  });
});
