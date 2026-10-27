'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createScreenCommandPhrases, register } = require('../screen-command-phrases');
const { allowedForFamilyDevice } = require('../family-device');

// The smallest Mongo stand-in: one owner row with an optimistic revision.
function memoryModel() {
  let row = null;
  const matches = query => row && row.ownerId === query.ownerId
    && (typeof query.revision === 'number' ? row.revision === query.revision : row.revision === undefined);
  return {
    rows: () => row,
    findOne: () => ({ lean: async () => row && structuredClone(row) }),
    findOneAndUpdate: (query, update, options) => ({ lean: async () => {
      if (matches(query)) { row = { ...row, ...structuredClone(update.$set) }; return structuredClone(row); }
      if (!row && options.upsert) { row = structuredClone(update.$set); return structuredClone(row); }
      if (row && options.upsert) throw Object.assign(new Error('duplicate'), { code: 11000 });
      return null;
    } })
  };
}
const envelope = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const fail = (res, status, message, code) => res.status(status).json({ ok: false, message, code });
function server(Model = memoryModel()) {
  const app = express(); app.use(express.json());
  const router = express.Router();
  register(router, { service: createScreenCommandPhrases({ Model }), envelope, fail });
  app.use('/api/voice-personas', router);
  return { app, Model };
}
const URL = '/api/voice-personas/private/screen-commands';

test('Core keeps the owner’s phrases with a revision and refuses a stale editor', async () => {
  const { app, Model } = server();
  const empty = await request(app).get(URL).expect(200);
  assert.deepEqual(empty.body.data, { contract: 'agentx.screen-command-phrases/v1', revision: 0, limit: 40, phrases: [] });
  assert.equal(empty.headers['cache-control'], 'private, no-store');
  const saved = await request(app).put(URL).send({ revision: 0, phrases: [{ phrase: ' Plein  pot ', action: 'expand' }] }).expect(200);
  assert.deepEqual(saved.body.data.phrases, [{ phrase: 'Plein pot', action: 'expand' }]);
  assert.equal(saved.body.data.revision, 1);
  assert.equal(Model.rows().ownerId, 'default');
  const stale = await request(app).put(URL).send({ revision: 0, phrases: [] }).expect(409);
  assert.equal(stale.body.code, 'SCREEN_COMMANDS_CONFLICT');
  await request(app).put(URL).send({ revision: 1, phrases: [] }).expect(200);
  assert.deepEqual((await request(app).get(URL)).body.data.phrases, []);
});

test('Core applies the same phrase rules as the editor', async () => {
  const { app, Model } = server();
  for (const body of [{ revision: 0 }, { revision: -1, phrases: [] }, { revision: 0, phrases: [], ownerId: 'other' },
    { revision: 0, phrases: [{ phrase: 'agrandis', action: 'close' }] }, { revision: 0, phrases: [{ phrase: 'dors Nestor', action: 'close' }] },
    { revision: 0, phrases: [{ phrase: 'plein pot', action: 'format-disk' }] }]) {
    const response = await request(app).put(URL).send(body).expect(400);
    assert.equal(response.body.code, 'SCREEN_COMMANDS_INVALID');
  }
  assert.equal(Model.rows(), null);
});

test('an unavailable store says so without exposing the error', async () => {
  const { app } = server({ findOne: () => ({ lean: async () => { throw new Error('mongo down at 10.0.0.1'); } }) });
  const response = await request(app).get(URL).expect(503);
  assert.equal(response.body.code, 'SCREEN_COMMANDS_UNAVAILABLE');
  assert.doesNotMatch(response.body.message, /10\.0\.0\.1/);
});

test('a family-pinned device cannot read or change the owner’s phrases', () => {
  for (const method of ['GET', 'PUT']) assert.equal(allowedForFamilyDevice({ method, path: URL, originalUrl: URL, query: {} }), false);
});
