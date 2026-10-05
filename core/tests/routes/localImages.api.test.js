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
