'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { normalizeRule, registerSecretaryMailRoutes } = require('../secretary-mail-routes');

// Just enough of the Mongoose model surface the routes use.
function memoryModel() {
  let next = 1;
  const rows = [];
  const query = (value) => ({ sort: () => query(value), limit: () => query(value), lean: async () => structuredClone(value) });
  const byId = (id) => rows.find((row) => String(row._id) === String(id));
  return {
    rows,
    find: (filter = {}) => query(rows.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value))),
    countDocuments: async () => rows.length,
    create: async (value) => {
      if (rows.some((row) => row.from === value.from && row.subjectContains === value.subjectContains)) throw Object.assign(new Error('dup'), { code: 11000 });
      const row = { _id: String(next++).padStart(24, '0'), hits: 0, ...value };
      rows.push(row);
      return row;
    },
    findByIdAndUpdate: (id, update) => ({ lean: async () => { const row = byId(id); if (row) Object.assign(row, update.$set); return row ? structuredClone(row) : null; } }),
    findByIdAndDelete: (id) => ({ lean: async () => { const row = byId(id); if (row) rows.splice(rows.indexOf(row), 1); return row || null; } }),
    updateOne: async ({ _id }, update) => { const row = byId(_id); if (row) { row.hits += update.$inc.hits; row.lastHitAt = update.$set.lastHitAt; } }
  };
}

function server({ senders } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.aioOpsSecretaryMail = { contractVersion: 1, senders: senders || (async () => ({ senders: [] })) };
  const router = express.Router();
  const Rule = memoryModel();
  const envelope = (res, data, status = 200) => res.status(status).json({ ok: true, data });
  const fail = (res, status, message, code) => res.status(status).json({ ok: false, message, code });
  registerSecretaryMailRoutes({ app, router, envelope, fail, Rule });
  app.use('/api/secretary', router);
  return { app, Rule };
}

test('a rule names an address or a domain and only a non-action category', () => {
  assert.deepEqual(normalizeRule({ from: ' Notifications@GitHub.com ', category: 'FYI' }),
    { from: 'notifications@github.com', category: 'FYI', subjectContains: '', note: '', enabled: true });
  assert.equal(normalizeRule({ from: 'linkedin.com', category: 'Newsletters' }).from, '@linkedin.com');
  assert.equal(normalizeRule({ from: '@mail.example.ca', category: 'Receipts' }).from, '@mail.example.ca');
  for (const from of ['', 'github', 'a@b', '*@x.com', 'x.com; rm']) {
    assert.throws(() => normalizeRule({ from, category: 'FYI' }), /address .* or a domain/);
  }
  for (const category of ['Urgent', 'Needs Reply', 'Waiting', 'fyi', undefined]) {
    assert.throws(() => normalizeRule({ from: 'x.com', category }), /action categories stay with the Secretary/);
  }
  assert.deepEqual(normalizeRule({ enabled: false }, { partial: true }), { enabled: false });
});

test('the desk creates, lists, edits, counts and deletes rules; the plugin reads only enabled ones', async () => {
  const { app, Rule } = server();
  const created = await request(app).post('/api/secretary/triage-rules').send({ from: 'notifications@github.com', category: 'FYI', note: 'CI' }).expect(201);
  const id = created.body.data.rule.id;
  await request(app).post('/api/secretary/triage-rules').send({ from: 'notifications@github.com', category: 'Review' }).expect(409);
  await request(app).post('/api/secretary/triage-rules').send({ from: 'linkedin.com', category: 'Newsletters', enabled: false }).expect(201);
  await request(app).post('/api/secretary/triage-rules').send({ from: 'bank.example', category: 'Urgent' }).expect(400);

  assert.equal((await request(app).get('/api/secretary/triage-rules').expect(200)).body.data.rules.length, 2);
  const enabled = (await request(app).get('/api/secretary/triage-rules?enabled=true').expect(200)).body.data;
  assert.deepEqual(enabled.rules.map((rule) => rule.from), ['notifications@github.com']);
  assert.deepEqual(enabled.categories, ['Receipts', 'Newsletters', 'FYI', 'Review']);

  const edited = await request(app).patch(`/api/secretary/triage-rules/${id}`).send({ category: 'Newsletters' }).expect(200);
  assert.equal(edited.body.data.rule.category, 'Newsletters');
  assert.equal(edited.body.data.rule.from, 'notifications@github.com');
  await request(app).post(`/api/secretary/triage-rules/${id}/hit`).expect(200);
  assert.equal(Rule.rows[0].hits, 1);
  await request(app).patch('/api/secretary/triage-rules/not-an-id').send({ enabled: false }).expect(404);
  await request(app).delete(`/api/secretary/triage-rules/${id}`).expect(200);
  await request(app).delete(`/api/secretary/triage-rules/${id}`).expect(404);
  assert.equal(Rule.rows.length, 1);
});

test('suggestions mark Review senders an existing rule already covers', async () => {
  const { app } = server({ senders: async () => ({ sampled: 3, senders: [
    { address: 'bot@ci.example', domain: 'ci.example', count: 2 },
    { address: 'news@shop.example', domain: 'shop.example', count: 1 }
  ] }) });
  await request(app).post('/api/secretary/triage-rules').send({ from: '@shop.example', category: 'Newsletters' }).expect(201);
  const data = (await request(app).get('/api/secretary/triage-rules/suggestions').expect(200)).body.data;
  assert.deepEqual(data.senders.map((row) => [row.address, row.ruled]), [['bot@ci.example', false], ['news@shop.example', true]]);
});
