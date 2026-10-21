'use strict';

const express = require('express');
const request = require('supertest');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { registerSecretarySouvenirRoutes } = require('../../surfaces/household/secretary-souvenirs');
const { forSpace, operatePersonal } = require('../../src/services/memoryNoteService');

const input = { kind: 'fact', text: 'Synthetic move to a new street', actor: 'Synthetic neighbour',
  sourceDate: '2014-06-02T10:00:00-04:00', people: ['Synthetic neighbour'], places: ['Synthetic street'],
  source: { system: 'gmail', threadId: 'thread01', messageId: 'message01', sourceSha256: 'a'.repeat(64),
    findingId: 'f'.repeat(64), direction: 'received' } };
const app = express();
app.use(express.json());
const router = express.Router();
const deps = { router, envelope: (res, data) => res.json({ status: 'success', data }),
  fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) };
registerSecretaryHistoryRoutes(deps);
registerSecretarySouvenirRoutes(deps);
app.use('/api/secretary', router);

async function keep() {
  const { entry } = await history.record(input);
  const kept = await history.keepAsSouvenir(entry.id, { revision: 0 });
  return { entry, id: kept.souvenirNoteId };
}

describe('owner corrections of a kept souvenir', () => {
  beforeAll(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); }
  });
  beforeEach(async () => { await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({}); });

  test('corrects date, people and places with a revision fence and keeps the sources', async () => {
    const { id } = await keep();
    const before = (await request(app).get(`/api/secretary/souvenirs/${id}`).expect(200)).body.data.souvenir;
    expect(before).toMatchObject({ revision: 0, eventDatePrecision: 'unknown', people: ['Synthetic neighbour'] });
    const edited = await request(app).post(`/api/secretary/souvenirs/${id}`)
      .send({ revision: 0, eventDate: '2014-07-01', people: ['Synthetic neighbour', 'Synthetic friend'], places: ['Synthetic town'] }).expect(200);
    expect(edited.body.data).toMatchObject({ changed: true, souvenir: { revision: 1, eventDate: '2014-07-01', eventDatePrecision: 'day',
      people: ['Synthetic neighbour', 'Synthetic friend'], places: ['Synthetic town'], sourceRefs: before.sourceRefs } });
    await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 0, eventDate: '2015-01-01' }).expect(409);
    await request(app).post(`/api/secretary/souvenirs/${id}`).send({ eventDate: '2015-01-01' }).expect(400);
    const note = await MemoryNote.findById(id).lean();
    expect(note).toMatchObject({ revision: 1, eventDate: '2014-07-01', status: 'active', expiresAt: null });
  });

  test('an unchanged correction keeps the revision; clearing the date makes it unknown', async () => {
    const { id } = await keep();
    const same = await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 0, places: ['Synthetic street'] }).expect(200);
    expect(same.body.data).toMatchObject({ changed: false, souvenir: { revision: 0 } });
    await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 0, eventDate: '2014-07-01' }).expect(200);
    const cleared = await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 1, eventDate: '' }).expect(200);
    expect(cleared.body.data.souvenir).toMatchObject({ revision: 2, eventDate: '', eventDatePrecision: 'unknown' });
    await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 2, eventDate: '2014-02-30' }).expect(400);
    await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 2, people: Array.from({ length: 21 }, (_, n) => `P${n}`) }).expect(400);
  });

  test('the history list shows the souvenir as corrected', async () => {
    const { entry, id } = await keep();
    await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 0, eventDate: '2014-07-01', text: 'Synthetic move, corrected' }).expect(200);
    const listed = (await request(app).get('/api/secretary/history').expect(200)).body.data.entries.find(e => e.id === entry.id);
    expect(listed.souvenir).toMatchObject({ id, revision: 1, eventDate: '2014-07-01', text: 'Synthetic move, corrected' });
  });

  test('only active owner souvenirs can be corrected, and Nestor has no route to it', async () => {
    const { id } = await keep();
    const family = forSpace({ audience: 'household', scopeId: 'personal', packIds: ['personal_operator'] });
    await expect(family.editSouvenir(id, { revision: 0, eventDate: '2014-07-01' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(operatePersonal({ operation: 'editSouvenir', id, revision: 0 })).rejects.toMatchObject({ statusCode: 400 });
    const fact = await operatePersonal({ operation: 'remember', text: 'Synthetic plain fact' });
    await request(app).post(`/api/secretary/souvenirs/${fact.id}`).send({ revision: 0, eventDate: '2014-07-01' }).expect(404);
    await request(app).get(`/api/secretary/souvenirs/${fact.id}`).expect(404);
    await operatePersonal({ operation: 'forget', id });
    await request(app).post(`/api/secretary/souvenirs/${id}`).send({ revision: 0, eventDate: '2014-07-01' }).expect(404);
    await request(app).get('/api/secretary/souvenirs/not-an-id').expect(404);
  });
});
