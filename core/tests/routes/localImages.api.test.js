'use strict';
const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/local-images');
const { registerParentalAccess } = require('../../src/middleware/parentalAccess');
test('the family ingress can neither generate nor read private operation receipts', async () => {
  const app = express(); app.use(express.json());
  registerParentalAccess({ app, express, env: { AGENTX_PARENTAL_CODE: 'synthetic-code' } });
  const images = { accept: jest.fn(), list: jest.fn() };
  app.use('/api/images', createRouter(images));
  await request(app).post('/api/images/operations').set('X-AgentX-Entry', 'household').send({}).expect(401);
  await request(app).get('/api/images/operations').set('X-AgentX-Entry', 'household').expect(401);
  expect(images.accept).not.toHaveBeenCalled(); expect(images.list).not.toHaveBeenCalled();
});
test('trusted local callers receive a persisted pending receipt, not a fabricated result', async () => {
  const app = express(); app.use(express.json());
  const accept = jest.fn(async () => ({ id: 'operation', state: 'accepted' }));
  app.use('/api/images', createRouter({ accept }));
  const result = await request(app).post('/api/images/operations').send({ actionKey: 'synthetic' }).expect(202);
  expect(result.body.operation).toEqual({ id: 'operation', state: 'accepted' });
});
