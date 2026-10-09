'use strict';
const express = require('express');
const request = require('supertest');
const parsers = require('../../src/middleware/productRequestParsers');
test('the image reference envelope has its own bound without widening other routes', async () => {
  const app = express();
  parsers(app, express);
  const household = '/api/voice-personas/private/sessions/11111111-1111-4111-8111-111111111111/images';
  app.post(['/api/images/operations', household, '/api/voice-personas/family/sessions/family-session/images', '/api/other'], (req, res) => res.json({ received: req.body.reference.length }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type }));
  const body = { reference: 'A'.repeat(6 * 1024 * 1024) };
  expect((await request(app).post('/api/images/operations').send(body)).body.received).toBe(body.reference.length);
  expect((await request(app).post(household).send(body)).body.received).toBe(body.reference.length);
  expect((await request(app).post('/api/voice-personas/family/sessions/family-session/images').send(body)).status).toBe(413);
  expect((await request(app).post('/api/other').send(body)).status).toBe(413);
  expect((await request(app).post('/api/images/operations').send({ reference: 'A'.repeat(9 * 1024 * 1024) })).status).toBe(413);
});
