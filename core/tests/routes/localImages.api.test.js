'use strict';
const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/local-images');
const { registerLegacyHumanAccess } = require('../../src/middleware/legacyHumanAccess');
test('human LAN image APIs are direct and still report unavailable native generation', async () => {
  const app = express(); app.use(express.json());
  registerLegacyHumanAccess({ app });
  app.use('/api/images', createRouter());
  const response = await request(app).post('/api/images/operations').send({}).expect(503);
  expect(response.body.code).toBe('LOCAL_IMAGE_ERROR');
  expect(response.headers['set-cookie']).toBeUndefined();
  const listed = await request(app).get('/api/images/operations').expect(200);
  expect(Array.isArray(listed.body.operations)).toBe(true);
});
test('trusted local callers receive a persisted pending receipt, not a fabricated result', async () => {
  const app = express(); app.use(express.json());
  const accept = jest.fn(async () => ({ id: 'operation', state: 'accepted' }));
  app.use('/api/images', createRouter({ accept }));
  const result = await request(app).post('/api/images/operations').send({ actionKey: 'synthetic' }).expect(202);
  expect(result.body.operation).toEqual({ id: 'operation', state: 'accepted' });
});
test('the atelier reads the stored draft without submitting a generation', async () => {
  const app = express(); const draft = jest.fn(async () => ({ prompt: 'Two robots', seed: 42, profile: 'quick' })), accept = jest.fn();
  app.use('/api/images', createRouter({ draft, accept }));
  const result = await request(app).get('/api/images/operations/synthetic/draft').expect(200);
  expect(result.body.draft).toMatchObject({ prompt: 'Two robots', seed: 42 });
  expect(accept).not.toHaveBeenCalled();
});
test('workshop disclosures read their presentation provider without generating or recovering', async () => {
  const images = { accept: jest.fn(), recover: jest.fn() };
  const workshop = { overview: jest.fn(() => ({ worker: { label: 'Synthetic host' }, profiles: [] })),
    details: jest.fn(async id => ({ id, recipe: { steps: 40 } })) };
  const app = express(); app.use('/api/images', createRouter(images, workshop));
  const overview = await request(app).get('/api/images/workshop').expect(200);
  expect(overview.headers['cache-control']).toBe('private, no-store');
  const receipt = await request(app).get('/api/images/operations/synthetic/details').expect(200);
  expect(receipt.body.details.recipe.steps).toBe(40);
  expect(workshop.details).toHaveBeenCalledWith('synthetic');
  expect(images.accept).not.toHaveBeenCalled(); expect(images.recover).not.toHaveBeenCalled();
});

test('manual recipe exports are private attachments and preserve exact graph bytes', async () => {
  const images = { accept: jest.fn(), recover: jest.fn(), get: jest.fn(), list: jest.fn() };
  const bytes = Buffer.from('{"recorded":"graph"}');
  const exports = { manifest: jest.fn(async () => ({ schemaVersion: 1, parts: [{ name: 'graph.json' }] })),
    part: jest.fn(async () => ({ bytes, mimeType: 'application/json', filename: 'graph.json' })) };
  const app = express(); app.use('/api/images', createRouter(images, {}, exports));
  const manifest = await request(app).get('/api/images/operations/synthetic/export').expect(200);
  expect(manifest.body).toMatchObject({ schemaVersion: 1, parts: [{ name: 'graph.json' }] });
  expect(manifest.headers['content-disposition']).toBe('attachment; filename="image-recipe.json"');
  expect(manifest.headers['cache-control']).toBe('private, no-store');
  expect(manifest.headers['x-content-type-options']).toBe('nosniff');
  const graph = await request(app).get('/api/images/operations/synthetic/export/parts/graph.json').expect(200);
  expect(Buffer.from(graph.text)).toEqual(bytes);
  expect(graph.headers['content-disposition']).toBe('attachment; filename="graph.json"');
  expect(graph.headers['cache-control']).toBe('private, no-store');
  expect(graph.headers['x-content-type-options']).toBe('nosniff');
  expect(exports.part).toHaveBeenCalledWith('synthetic', 'graph.json');
  for (const effect of Object.values(images)) expect(effect).not.toHaveBeenCalled();
});
test.each([409, 503])('unavailable export returns %s JSON without attachment headers or a fallback', async statusCode => {
  const exports = { manifest: jest.fn(async () => { throw Object.assign(new Error('Fixture export refused'), { statusCode }); }) };
  const app = express(); app.use('/api/images', createRouter({}, {}, exports));
  const result = await request(app).get('/api/images/operations/synthetic/export').expect(statusCode);
  expect(result.body).toMatchObject({ ok: false, code: 'LOCAL_IMAGE_ERROR', message: 'Fixture export refused' });
  expect(result.headers['content-disposition']).toBeUndefined();
  expect(result.headers['cache-control']).toBe('private, no-store');
});
