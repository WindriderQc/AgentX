'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/image-lab');
let dir, app, sources;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-intent-api-'));
  fs.mkdirSync(path.join(dir, 'lab-resources/ready/recipes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lab-resources/ready/recipes/scenes.json'), JSON.stringify({ id: 'scenes', schemaVersion: 1,
    records: [{ id: 'synthetic', width: 1024, height: 1024, seed: 42, steps: 25, parents: [] }], maxRuns: [] }));
  sources = jest.fn(() => { throw new Error('must not inspect shared resources'); });
  app = express(); app.use('/images/labo', createRouter({ data: () => dir, sources }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
test('catalogue selection produces a private attachment without any admission or persistence', async () => {
  const c = (await request(app).get('/images/labo/api/recipes/scenes').expect(200)).body.catalogue;
  const response = await request(app).post('/images/labo/api/intents').send({
    labSelection: { catalogueId: 'scenes', catalogueSha256: c.sha256, kind: 'record', entryId: 'synthetic' },
    prompt: 'A lake', width: 4096, height: 4096, seed: 7
  }).expect(200);
  expect(response.body).toMatchObject({ state: 'prepared_only', automaticDispatch: false, evidence: { parameters: { steps: 25, cfg: null } } });
  expect(response.headers).toMatchObject({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'content-disposition': 'attachment; filename="image-lab-intent.json"' });
  expect(sources).not.toHaveBeenCalled();
  expect(fs.readdirSync(dir)).toEqual(['lab-resources']);
});
test('unknown catalogues and invalid/stale selections report refusal with no fallback attachment', async () => {
  await request(app).get('/images/labo/api/recipes/unknown').expect(400);
  await request(app).post('/images/labo/api/intents').send({}).expect(400);
  const result = await request(app).post('/images/labo/api/intents').send({
    labSelection: { catalogueId: 'scenes', catalogueSha256: '0'.repeat(64), kind: 'record', entryId: 'synthetic' }
  }).expect(409);
  expect(result.headers['content-disposition']).toBeUndefined(); expect(sources).not.toHaveBeenCalled();
});
