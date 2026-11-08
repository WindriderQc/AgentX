'use strict';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { archive } = require('../fixtures/historySourceArchive');

describe('historical source review HTTP -> native archive -> Core receipt', () => {
  let fixture, app, id;
  const mount = (audience = 'owner') => {
    const instance = express(); instance.use(express.json());
    const router = express.Router();
    registerSecretaryHistoryRoutes({ router, sourceReviewDeps: { audience, mail: fixture.mail },
      envelope: (res, data) => res.json({ status: 'success', data }),
      fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) });
    instance.use('/api/secretary', router); return instance;
  };
  const url = key => `/api/secretary/history/${id}/source-review${key ? '/' + key : ''}`;
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({}); fixture = await archive({ body: 'Synthetic short text <img src=x onerror=alert(1)>' });
    id = (await history.record({ kind: 'fact', text: 'Historical assertion to review', sourceDate: '2024-01-01T00:00:00Z', source: fixture.source })).entry.id;
    app = mount();
  });
  afterEach(async () => fixture.cleanup());

  test('the actual routes serve each native text part and replay exactly one human review receipt', async () => {
    const key = randomUUID();
    let response = await request(app).post(url()).send({ requestId: key, revision: 0 }).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    let review = response.body.data.review;
    const priorCalls = fixture.calls;
    await request(app).post(url()).send({ requestId: key, revision: 0 }).expect(200);
    expect(fixture.calls).toBe(priorCalls);
    for (const part of review.sources[0].parts.filter(part => part.readable)) {
      response = await request(app).get(url(key) + '/page').query({ source: 0, part: part.partIndex, offset: 0 }).expect(200);
      review = response.body.data.review;
      expect(response.body.data.page.body).toContain(part.mimeType === 'text/plain' ? 'Synthetic short text' : 'Other text');
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    const intent = { snapshotHash: review.snapshotHash, revision: 0, decision: 'reviewed_scope', reason: 'Only these displayed texts were reviewed.' };
    const first = (await request(app).post(url(key) + '/decision').send(intent).expect(200)).body.data;
    const replay = (await request(app).post(url(key) + '/decision').send(intent).expect(200)).body.data;
    expect(replay).toMatchObject({ replayed: true, receipt: first.receipt });
    const referenced = (await request(app).post(url(key) + '/decision').send({ intentHash: first.receipt.intentHash }).expect(200)).body.data;
    expect(referenced).toMatchObject({ replayed: true, receipt: first.receipt });
    expect(first.receipt).toMatchObject({ authenticatedPerson: null, executionAllowed: false });
    expect((await request(app).get(`/api/secretary/history/${id}`).expect(200)).body.data.entry)
      .toMatchObject({ reviewState: 'candidate', assertionState: 'unknown', sourceReview: { decision: { decision: 'reviewed_scope' } } });
    await request(app).post(url(key) + '/decision').send({ ...intent, reason: 'Changed intent' }).expect(409);
    await request(app).post(url(key) + '/decision').send({ ...intent, verified: true }).expect(400);
  });

  test('family domain cannot borrow owner headers and is refused before native source access', async () => {
    app = mount('family');
    await request(app).post(url()).set('x-agentx-caller', 'owner').send({ requestId: randomUUID(), revision: 0 }).expect(403);
    expect(fixture.calls).toBe(0);
    expect((await Entry.findById(id).lean()).sourceReviews).toHaveLength(0);
  });

  test('the real pinned-family device middleware blocks all new owner routes before the native reader', async () => {
    const key = randomUUID();
    const review = (await request(app).post(url()).send({ requestId: key, revision: 0 }).expect(200)).body.data.review;
    const guarded = express(); guarded.use(require('cookie-parser')());
    require('../../surfaces/household/family-device').register({ app: guarded, mongoose: require('mongoose'),
      standardJsonParser: express.json(), ownerUnlock: { activeUntil: async () => null },
      envelope: (res, data, status = 200) => res.status(status).json({ status: 'success', data }),
      fail: (res, status, message, code) => res.status(status).json({ status: 'error', message, code }) });
    await require('mongoose').model('AgentXHouseholdFamilyDevice').createCollection();
    guarded.use(app);
    const cookie = (await request(guarded).post('/api/household/family-device/pin').send({ label: 'Synthetic family tablet' }).expect(201)).headers['set-cookie'];
    const calls = fixture.calls;
    const denied = response => expect(response.body.code).toBe('FAMILY_DEVICE_PINNED');
    denied(await request(guarded).post(url()).set('Cookie', cookie).set('x-agentx-caller', 'owner').send({ requestId: randomUUID(), revision: 0 }).expect(403));
    denied(await request(guarded).get(url(key)).set('Cookie', cookie).expect(403));
    denied(await request(guarded).get(url(key) + '/page').set('Cookie', cookie).query({ source: 0, part: review.sources[0].parts[0].partIndex, offset: 0 }).expect(403));
    denied(await request(guarded).post(url(key) + '/decision').set('Cookie', cookie).send({ intentHash: 'a'.repeat(64) }).expect(403));
    expect(fixture.calls).toBe(calls);
    expect((await Entry.findById(id).lean()).sourceReviews[0].decisionIntent).toBeNull();
  });

  test('a lost/unknown read or erasure never returns an old source page', async () => {
    const key = randomUUID();
    const review = (await request(app).post(url()).send({ requestId: key, revision: 0 }).expect(200)).body.data.review;
    await request(app).post(`/api/secretary/history/${id}/review`).send({ state: 'forgotten', revision: 0 }).expect(200);
    const response = await request(app).get(url(key) + '/page').query({ source: 0, part: review.sources[0].parts[0].partIndex, offset: 0 }).expect(404);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic short text');
    const erased = (await request(app).get(url(key)).expect(200)).body.data;
    expect(erased).toEqual({ erased: true, requestId: key, executionAllowed: false });
    await request(app).post(url(key) + '/decision').send({ revision: 0, snapshotHash: review.snapshotHash, decision: 'reviewed_scope', reason: 'A stale request' }).expect(404);
  });
});
