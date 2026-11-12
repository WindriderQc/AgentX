'use strict';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { source } = require('../fixtures/historyPreservationProof');

describe('owner native historical decision HTTP and Python contract', () => {
  let app, id;
  const mount = (audience = 'owner') => {
    const app = express(), router = express.Router(); app.use(express.json({ limit: '512kb' }));
    registerSecretaryHistoryRoutes({ router, decisionStateDeps: { audience },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  const url = suffix => `/api/secretary/history/${id}/decision-state${suffix || ''}`;
  const projection = async () => (await history.list({ source: 'gmail', state: '' })).entries.find(entry => entry.id === id);
  const check = async extra => ({ entry: await projection(), observationId: randomUUID(), ...extra });
  beforeAll(async () => { await Entry.createCollection(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic quotation: é 🧭 “yes”', sourceDate: '2024-01-01T00:00:00Z', source })).entry.id;
    app = mount();
  });

  test('GET and POST are private/no-store; Core compares the exact supplied projection without writing it', async () => {
    const before = await Entry.findById(id).lean();
    const got = await request(app).get(url()).expect(200), input = await check({ expected: got.body.data.fingerprint });
    const result = await request(app).post(url('/check')).send(input).expect(200);
    for (const res of [got, result]) expect(res.headers['cache-control']).toBe('private, no-store');
    expect(result.body.data).toMatchObject({ observationId: input.observationId, status: 'observed_match', entryMatches: true,
      executionAllowed: false, cleanupStatus: 'blocked' });
    const forged = await request(app).post(url('/check')).send({ ...input, entry: { ...input.entry, reviewState: 'resolved' } }).expect(200);
    expect(forged.body.data.entryMatches).toBe(false);
    expect(forged.body.data.snapshot.reviewState).toBe('candidate');
    expect(await Entry.findById(id).lean()).toEqual(before);
  });

  test('a stale projection and fingerprint expose a committed owner change', async () => {
    const input = await check(), first = await request(app).post(url('/check')).send(input).expect(200);
    await history.review(id, { revision: 0, state: 'dismissed', reason: 'Synthetic owner correction' });
    const next = await request(app).post(url('/check')).send({ ...input, expected: first.body.data.fingerprint }).expect(200);
    expect(next.body.data).toMatchObject({ status: 'changed', entryMatches: false });
    expect(next.body.data.snapshot).toMatchObject({ entryRevision: 1, reviewState: 'dismissed' });
  });

  test('client proofs, repeated query parameters, missing observation identity and oversized projections refuse', async () => {
    await request(app).get(url() + '?expected=' + 'a'.repeat(64) + '&expected=' + 'b'.repeat(64)).expect(400);
    await request(app).get(url() + '?verified=true').expect(400);
    const input = await check();
    await request(app).post(url('/check')).send({ ...input, verified: true }).expect(400);
    await request(app).post(url('/check')).send({ entry: input.entry }).expect(400);
    await request(app).post(url('/check')).send({ ...input, observationId: [input.observationId] }).expect(400);
    await request(app).post(url('/check')).send({ ...input, entry: { text: 'x'.repeat(256 * 1024) } }).expect(413);
  });

  test('server-selected family scope and actual pinned-family middleware refuse both routes', async () => {
    const input = await check();
    const family = mount('family');
    await request(family).get(url()).set('x-agentx-caller', 'owner').expect(403);
    await request(family).post(url('/check')).set('x-agentx-caller', 'owner').send(input).expect(403);
    const guarded = express(); guarded.use(require('cookie-parser')());
    require('../../surfaces/household/family-device').register({ app: guarded, mongoose: require('mongoose'),
      standardJsonParser: express.json(), ownerUnlock: { activeUntil: async () => null },
      envelope: (res, data, status = 200) => res.status(status).json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    await require('mongoose').model('AgentXHouseholdFamilyDevice').createCollection(); guarded.use(app);
    const cookie = (await request(guarded).post('/api/household/family-device/pin').send({ label: 'Synthetic family screen' }).expect(201)).headers['set-cookie'];
    await request(guarded).get(url()).set('Cookie', cookie).expect(403);
    await request(guarded).post(url('/check')).set('Cookie', cookie).send(input).expect(403);
  });

  test('forgotten entries return no old decision on either route', async () => {
    const input = await check(); await history.review(id, { state: 'forgotten', revision: 0 });
    for (const response of [await request(app).get(url()).expect(404),
      await request(app).post(url('/check')).send(input).expect(404)]) {
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(JSON.stringify(response.body)).not.toContain(source.messageId);
    }
  });

  test('the actual Python consumer validates Core/Mongo replies and never treats a later owner decision as current', async () => {
    // Full projections can contain JSON numbers whose spellings differ across
    // languages. Core compares them; Python hashes only the bounded snapshot.
    await Entry.updateOne({ _id: id }, { $set: { context: { revision: 1, inputHash: 'f'.repeat(64), importId: 'synthetic-number-context',
      timeline: { title: 'Synthetic é numeric context', confidence: 1e-7, distance: 1e25 },
      sources: [{ id: 'synthetic-document', confidence: 1e-7, body: 'SOURCE_BODY_MUST_NOT_LEAVE' }] } } });
    const entry = await projection();
    expect(JSON.stringify(entry)).not.toContain('SOURCE_BODY_MUST_NOT_LEAVE');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const run = input => new Promise((resolve, reject) => {
      const child = spawn('python3', ['-c', `import json,sys\nfrom native_history_decisions import observe\nx=json.load(sys.stdin)\nprint(json.dumps(observe(x['core'],x['entry'],expected=x.get('expected'))))`],
        { env: { ...process.env, PYTHONPATH: path.resolve(__dirname, '../../../integrations/secretary') }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ core: `http://127.0.0.1:${server.address().port}`, ...input }));
    });
    try {
      const first = await run({ entry }); expect(first.stderr).toBe(''); expect(first.code).toBe(0);
      const native = JSON.parse(first.stdout); expect(native.entryId).toBe(id);
      const repeat = await run({ entry, expected: native.fingerprint }); expect(repeat.code).toBe(0);
      const repeated = JSON.parse(repeat.stdout);
      expect(repeated.fingerprint).toBe(native.fingerprint);
      expect(repeated.observationId).not.toBe(native.observationId);
      await history.review(id, { revision: 0, state: 'dismissed', reason: 'Synthetic concurrent owner decision' });
      const changed = await run({ entry, expected: native.fingerprint });
      expect(changed.code).toBe(1); expect(changed.stderr).toContain('did not confirm'); expect(changed.stdout).toBe('');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
