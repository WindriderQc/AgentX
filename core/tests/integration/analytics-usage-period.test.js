'use strict';

const request = require('supertest');
const express = require('express');
const Period = require('../../models/AnalyticsUsagePeriod');
const Log = require('../../models/InferenceLog');
const router = require('../../routes/analytics-inference');
const { presentationReader } = require('../../src/services/presentationReadService');

const app = express();
app.use(express.json());
app.use('/api/analytics/inference', router);
const endpoint = '/api/analytics/inference';
const HOUR = 3600000;
const row = { host: 'http://192.0.2.1:11434', model: 'local/fixture', status: 'success' };

describe('daily-use reporting boundary', () => {
  beforeEach(async () => { await Period.deleteMany({}); await Log.deleteMany({}); });

  test('unset is explicit; ordinary rolling history stays available', async () => {
    const unset = await request(app).get(`${endpoint}/usage-period`).expect(200);
    expect(unset.body.data).toBeNull();
    await request(app).get(`${endpoint}/summary?window=usage`).expect(409);
    await request(app).get(`${endpoint}/summary?window=24h`).expect(200);
  });

  test('starting and replaying a boundary preserves every log and refuses a different reset', async () => {
    const since = new Date(Date.now() - HOUR).toISOString();
    await Log.create({ ...row, timestamp: new Date(Date.now() - 2 * HOUR) });
    const responses = await Promise.all(Array.from({ length: 3 }, () => request(app)
      .put(`${endpoint}/usage-period`).send({ since })));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    expect(await Period.countDocuments()).toBe(1);
    await request(app).put(`${endpoint}/usage-period`).send({ since: new Date().toISOString() }).expect(409);
    expect(await Log.countDocuments()).toBe(1);
    expect((await request(app).get(`${endpoint}/usage-period`)).body.data).toEqual({ since });
  });

  test.each(['invalid', '2026-01-01', '2026-01-01T12:00:00', new Date(Date.now() + HOUR).toISOString(), null])(
    'invalid or future boundary %s does not write', async since => {
      await request(app).put(`${endpoint}/usage-period`).send({ since }).expect(400);
      expect(await Period.countDocuments()).toBe(0);
    });

  test('overview, recent health, error links and presentation share the boundary; rolling totals keep earlier attempts', async () => {
    const now = Date.now(), since = new Date(now - HOUR / 2).toISOString();
    await Log.insertMany([
      { ...row, status: 'error', timestamp: new Date(now - HOUR) },
      { ...row, timestamp: new Date(now - 10000) },
      { ...row, status: 'error', timestamp: new Date(now - 20000),
        routeDecision: { outcome: { stage: 'admission', code: 'pre_dispatch_error', reasonCode: 'workload_reserved' } } },
      { ...row, status: 'error', error: 'caller_disconnected', timestamp: new Date(now - 30000) }
    ]);
    await request(app).put(`${endpoint}/usage-period`).send({ since }).expect(200);
    const { body: { data: d } } = await request(app).get(`${endpoint}/summary?window=usage`).expect(200);
    expect(d.window).toMatchObject({ key: 'usage', from: since, since });
    expect(d.totals).toMatchObject({ calls: 3, errors: 1, cancellations: 1 });
    expect(d.recent).toMatchObject({ since, calls: 3, errors: 1, admissionRefusals: 1, cancellations: 1, lastErrorAt: null });
    expect(d.failureAnalysis.lastErrorAt).toBeNull();
    expect(d.failureAnalysis.lastRefusalAt).toBe(new Date(now - 20000).toISOString());
    const read = presentationReader.read(d.presentation);
    expect(read.status).toBe('available');
    expect(read.filters).toEqual({ window: 'usage', since });
    expect(read.period.from).toBe(since);
    expect(read.recent.admissionRefusals).toBe(1);
    expect(read.failureAnalysis.lastRefusalAt).toBe(d.failureAnalysis.lastRefusalAt);
    const logs = await request(app).get(`${endpoint}/logs`).query({ from: d.window.from, to: d.window.to }).expect(200);
    expect(logs.body.data.pagination.total).toBe(3);
    const rolling = await request(app).get(`${endpoint}/summary?window=24h`).expect(200);
    expect(rolling.body.data.totals.calls).toBe(4);
    expect(rolling.body.data.recent).toMatchObject({ calls: 3, errors: 1, admissionRefusals: 1 });
    expect(await Log.countDocuments()).toBe(4);
  });

  test('known refusals, unknown failures and cancellations remain distinct in recent health', async () => {
    const timestamp = new Date(Date.now() - 10000);
    await Log.insertMany([
      { ...row, timestamp },
      { ...row, timestamp, status: 'error' },
      { ...row, timestamp, status: 'error', routeDecision: { outcome: { code: 'upstream_error', reasonCode: 'admission_refused' } } },
      { ...row, timestamp, status: 'error', error: 'cancelled' }
    ]);
    const { body: { data: d } } = await request(app).get(`${endpoint}/summary?window=24h`).expect(200);
    expect(d.recent).toMatchObject({ calls: 4, errors: 2, admissionRefusals: 1, unclassified: 1, cancellations: 1,
      lastErrorAt: timestamp.toISOString(), lastRefusalAt: timestamp.toISOString() });
  });

  test('retention bounds chart history and discloses the older reporting start', async () => {
    const since = new Date(Date.now() - 120 * 24 * HOUR).toISOString();
    await request(app).put(`${endpoint}/usage-period`).send({ since }).expect(200);
    const { body: { data: d } } = await request(app).get(`${endpoint}/summary?window=usage`).expect(200);
    expect(d.window.since).toBe(since);
    expect(Date.parse(d.window.from)).toBeGreaterThan(Date.parse(since));
    expect(d.coverage.requestedDays).toBeGreaterThan(119);
    expect(d.bucketHours).toBe(24);
  });
});
