'use strict';

const express = require('express');
const request = require('supertest');
const Entry = require('../../models/PersonalHistoryEntry');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');

const source = n => ({ kind: 'action', text: `Synthetic historical action ${n}`, sourceDate: '2024-01-01T00:00:00Z',
  source: { system: 'gmail', messageId: `message${n}`, threadId: 'thread01', sourceSha256: 'a'.repeat(64),
    findingId: String(n).repeat(64), direction: 'received' } });
const app = express();
app.use(express.json());
const router = express.Router();
registerSecretaryHistoryRoutes({ router,
  envelope: (res, data) => res.json({ status: 'success', data }),
  fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) });
app.use('/api/secretary', router);

describe('historical review HTTP ownership', () => {
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); });
  beforeEach(() => Entry.deleteMany({}));

  test('validates all imported rows before writing and retries the same batch safely', async () => {
    await request(app).post('/api/secretary/history/import').send({ entries: [source(1), { text: 'invalid' }] }).expect(400);
    expect(await Entry.countDocuments()).toBe(0);
    const first = await request(app).post('/api/secretary/history/import').send({ entries: [source(1), source(2)] }).expect(200);
    const second = await request(app).post('/api/secretary/history/import').send({ entries: [source(1), source(2)] }).expect(200);
    expect(first.body.data.results.map(r => r.entry.id)).toEqual(second.body.data.results.map(r => r.entry.id));
    expect(await Entry.countDocuments()).toBe(2);
  });

  test('retaining an action keeps it pending until an explicit revision-fenced resolution', async () => {
    const saved = await request(app).post('/api/secretary/history/import').send({ entries: [source(1)] }).expect(200);
    const id = saved.body.data.results[0].entry.id;
    await request(app).post(`/api/secretary/history/${id}/review`).send({ state: 'retained', revision: 0, reason: 'Synthetic ongoing follow-up' }).expect(200);
    expect((await request(app).get('/api/secretary/history?state=pending').expect(200)).body.data.total).toBe(1);
    await request(app).post(`/api/secretary/history/${id}/review`).send({ state: 'resolved', revision: 0, reason: 'Stale request' }).expect(409);
    await request(app).post(`/api/secretary/history/${id}/review`).send({ state: 'resolved', revision: 1, reason: 'Synthetic completion evidence checked' }).expect(200);
    expect((await request(app).get('/api/secretary/history?state=pending').expect(200)).body.data.total).toBe(0);
  });
});
