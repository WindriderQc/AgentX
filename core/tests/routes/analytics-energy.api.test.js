'use strict';

const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/analytics-energy');

function answer(data) { return { response: { ok: true, status: 200 }, body: { status: 'success', data } }; }

describe('energy analytics API', () => {
  test('requires an instance-owned device mapping', async () => {
    const app = express(); app.use('/api/analytics/energy', createRouter({ env: {} }));
    const response = await request(app).get('/api/analytics/energy');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('ENERGY_NOT_CONFIGURED');
  });

  test('joins Data history with inference telemetry', async () => {
    const history = { bucket: 'minute', bucketSeconds: 60, measures: {
      power: { points: [{ ts: '2026-10-22T12:00:00Z', median: 150 }, { ts: '2026-10-22T12:01:00Z', median: 220 }] },
      current: { points: [] }, voltage: { points: [] }, energy: { points: [] }
    } };
    const fetchData = jest.fn(path => Promise.resolve(answer(path.endsWith('/live') ? { measures: {} } : history)));
    const app = express(); app.use('/api/analytics/energy', createRouter({ env: { ENERGY_IOT_DEVICE_ID: 'cluster-powerbar' }, fetchData,
      findInferences: async () => [], countInferences: async () => 0, readOperations: async () => [] }));
    const response = await request(app).get('/api/analytics/energy?window=6h');
    expect(response.status).toBe(200);
    expect(response.body.data.deviceId).toBe('cluster-powerbar');
    expect(response.body.data.window).toBe('6h');
    expect(fetchData).toHaveBeenCalledTimes(2);
  });
});
