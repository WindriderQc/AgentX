'use strict';
const express = require('express');
const request = require('supertest');
const parsers = require('../../src/middleware/productRequestParsers');
test('the image reference envelope has its own bound without widening other routes', async () => {
  const app = express();
  parsers(app, express);
  app.post(['/api/images/operations', '/api/other'], (req, res) => res.json({ received: req.body.reference.length }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type }));
  const body = { reference: 'A'.repeat(6 * 1024 * 1024) };
  expect((await request(app).post('/api/images/operations').send(body)).body.received).toBe(body.reference.length);
  expect((await request(app).post('/api/other').send(body)).status).toBe(413);
  expect((await request(app).post('/api/images/operations').send({ reference: 'A'.repeat(9 * 1024 * 1024) })).status).toBe(413);
});
