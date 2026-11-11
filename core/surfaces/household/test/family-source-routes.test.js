'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { registerNativeConsumers } = require('../native-consumers');
const { registerFamilySources } = require('../family-source-routes');
const envelope = (res, data) => res.json({ status: 'success', data });
const fail = (res, status, message, code, details) => res.status(status).json({ status: 'error', message, code, details });
function fixture(deps = {}) {
  const app = express();
  app.use(require('cookie-parser')());
  require('../family-device').register({ app,
    mongoose: { models: { AgentXHouseholdFamilyDevice: { findOneAndUpdate: () => ({ lean: async () => ({ label: 'Fixture' }) }) } } },
    ownerUnlock: { activeUntil: async () => null }, standardJsonParser: express.json(), envelope, fail });
  registerFamilySources(app, { standardJsonParser: express.json(), envelope, fail }, deps);
  app.all('/api/consumers/nestor/v1/sources{/:tail}', () => assert.fail('Owner handler must not run'));
  return app;
}
const cookie = 'agentx_family_device=fixture-source';
test('native consumer mount registers the dedicated family routes', async () => {
  const app = express();
  registerNativeConsumers(app, { express, standardJsonParser: express.json(), envelope, fail,
    createPersonaSession: () => (_req, res) => res.end(), registerBrowserSessionControls: () => {} });
  const res = await request(app).get('/api/family/sources').expect(200);
  assert.equal(res.body.data.audience, 'household');
});
test('family transport fixes audience and rejects private, malformed and injected arguments before I/O', async () => {
  let reads = 0;
  const app = fixture({ livingSources: { ambient: { weather: async () => {
    reads++; return { fetchedAt: new Date().toISOString(), temperatureC: 1, private: 'private-sentinel' };
  } } } });
  const catalogue = await request(app).get('/api/family/sources').set('Cookie', cookie).expect(200);
  assert.equal(catalogue.headers['cache-control'], 'no-store');
  assert.deepEqual(catalogue.body.data.sources.map(row => row.source), ['weather', 'agentx']);
  for (const input of [{ source: null }, { source: '__proto__' }, { source: 'secretary' }, { source: 'comptable' },
    { source: 'weather', audience: 'owner' }, JSON.parse('{"source":"weather","__proto__":{"audience":"owner"}}'),
    { source: 'weather', url: '/api/consumers/nestor/v1/sources/read' }, { source: 'agentx', section: 'private' }]) {
    await request(app).post('/api/family/sources/read').set('Cookie', cookie).set('Content-Type', 'application/json').send(JSON.stringify(input))
      .expect(res => assert.equal(res.status, 400, JSON.stringify(input)));
  }
  await request(app).get('/api/family/sources?audience=owner').expect(400);
  assert.equal(reads, 0);
  const result = await request(app).post('/api/family/sources/read').set('Cookie', cookie).send({ source: 'weather' }).expect(200);
  assert.equal(result.body.data.audience, 'household');
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /private-sentinel/);
  for (const path of ['/api/consumers/nestor/v1/sources', '/api/consumers/nestor/v1/sources/read']) {
    await request(app).get(path).set('Cookie', cookie).expect(403);
    await request(app).post(path).set('Cookie', cookie).send({ source: 'weather' }).expect(403);
  }
});
test('SOURCE_CHANGED preserves a recoverable restart and provider errors stay sanitized', async () => {
  const app = fixture({ livingSources: { ambient: { weather: async () => ({ fetchedAt: new Date().toISOString() }) } } });
  const changed = await request(app).post('/api/family/sources/read').send({ source: 'weather', expectedHash: '0'.repeat(64) }).expect(409);
  assert.equal(changed.body.code, 'SOURCE_CHANGED');
  assert.equal(changed.body.details.retry.offset, 0);
  assert.equal(Object.hasOwn(changed.body.details.retry, 'expectedHash'), false);
  await request(app).post('/api/family/sources/read').send(changed.body.details.retry).expect(200);
  const service = require('../../../src/services/livingSourceService');
  const original = service.forAudience;
  service.forAudience = () => { throw Error('private-provider-sentinel'); };
  try {
    const failed = await request(app).get('/api/family/sources').expect(503);
    assert.equal(failed.body.code, 'SOURCE_READ_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(failed.body), /private-provider-sentinel/);
  } finally { service.forAudience = original; }
});

test('shared AgentX route exposes reachability, not provider records or private diagnostics', async () => {
  const app = fixture({ livingSources: { reportsClient: {
    fetchBenchmarkAnalyticsSummary: async () => ({ private: 'private-report-sentinel' }),
    fetchRagStatus: async () => { throw Error('private-rag-sentinel'); }
  } } });
  const result = await request(app).post('/api/family/sources/read').set('Cookie', cookie)
    .send({ source: 'agentx' }).expect(200);
  assert.equal(result.body.data.audience, 'household');
  assert.equal(result.body.data.source, 'agentx');
  assert.doesNotMatch(JSON.stringify(result.body), /private-report-sentinel|private-rag-sentinel/);
});
