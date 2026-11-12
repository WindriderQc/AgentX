'use strict';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { proof, source } = require('../fixtures/historyPreservationProof');

describe('native preservation owner HTTP contract', () => {
  let app, id, probe;
  const mount = (audience = 'owner') => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, preservationDeps: { audience, control: { probe } },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  const url = key => `/api/secretary/history/${id}/preservation${key ? '/' + key : ''}`;
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic exact source', sourceDate: '2024-01-01T00:00:00Z', source })).entry.id;
    probe = jest.fn(async (copy, input) => proof(copy, input)); app = mount();
  });

  test('POST creates one immutable native receipt; list discovers it, GET rechecks and every route is no-store', async () => {
    const key = randomUUID(), input = { requestId: key, revision: 0, source: 0 };
    const first = await request(app).post(url()).send(input).expect(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.body.data.receipt.snapshot.status).toBe('verified_scope');
    const replay = await request(app).post(url()).send(input).expect(200);
    expect(replay.body.data.replayed).toBe(true); expect(probe).toHaveBeenCalledTimes(2);
    const list = await request(app).get(url()).expect(200);
    expect(list.headers['cache-control']).toBe('private, no-store');
    expect(list.body.data.receipts[0]).toMatchObject({ requestId: key, nativeState: 'not_rechecked' });
    const checked = await request(app).get(url(key)).expect(200);
    expect(checked.headers['cache-control']).toBe('private, no-store');
    expect(checked.body.data.receipt).toMatchObject({ nativeState: 'current', executionAllowed: false, cleanupStatus: 'blocked' });
    expect(probe).toHaveBeenCalledTimes(4);
    await request(app).post(url()).send({ ...input, proof: { verified: true } }).expect(400);
  });

  test('server-selected family scope refuses before native reads regardless of owner-shaped headers', async () => {
    app = mount('family');
    await request(app).post(url()).set('x-agentx-caller', 'owner').send({ requestId: randomUUID(), revision: 0, source: 0 }).expect(403);
    await request(app).get(url()).set('x-agentx-caller', 'owner').expect(403);
    await request(app).get(url(randomUUID())).set('x-agentx-caller', 'owner').expect(403);
    expect(probe).not.toHaveBeenCalled();
  });

  test('the actual pinned-family device boundary covers every preservation route', async () => {
    const guarded = express(); guarded.use(require('cookie-parser')());
    require('../../surfaces/household/family-device').register({ app: guarded, mongoose: require('mongoose'),
      standardJsonParser: express.json(), ownerUnlock: { activeUntil: async () => null },
      envelope: (res, data, status = 200) => res.status(status).json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    await require('mongoose').model('AgentXHouseholdFamilyDevice').createCollection();
    guarded.use(app);
    const cookie = (await request(guarded).post('/api/household/family-device/pin').send({ label: 'Synthetic family screen' }).expect(201)).headers['set-cookie'];
    for (const response of [
      await request(guarded).post(url()).set('Cookie', cookie).send({ requestId: randomUUID(), revision: 0, source: 0 }).expect(403),
      await request(guarded).get(url()).set('Cookie', cookie).expect(403),
      await request(guarded).get(url(randomUUID())).set('Cookie', cookie).expect(403),
    ]) expect(response.body.code).toBe('FAMILY_DEVICE_PINNED');
    expect(probe).not.toHaveBeenCalled();
  });

  test('known erased transport identity returns no snapshot or proof after explicit forgetting', async () => {
    const key = randomUUID();
    await request(app).post(url()).send({ requestId: key, revision: 0, source: 0 }).expect(200);
    await request(app).post(`/api/secretary/history/${id}/review`).send({ state: 'forgotten', revision: 0 }).expect(200);
    const result = await request(app).get(url(key)).expect(200);
    expect(result.body.data).toEqual({ erased: true, requestId: key, executionAllowed: false });
    expect(JSON.stringify(result.body)).not.toContain(source.messageId);
    await request(app).get(url()).expect(404);
  });
});
