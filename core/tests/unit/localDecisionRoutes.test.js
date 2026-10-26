'use strict';

const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/local-decisions');
const { createLocalDecisionService } = require('../../src/services/decisions/localDecisionService');

function appFor(service) {
  const app = express();
  app.use('/api/decisions', createRouter(service));
  return app;
}

it('exposes discovery without evaluating a model, with no-store responses', async () => {
  const service = { catalog: () => ({ policies: [] }), evaluate: jest.fn() };
  const res = await request(appFor(service)).get('/api/decisions');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.body).toMatchObject({ ok: true, data: { policies: [] } });
  expect(service.evaluate).not.toHaveBeenCalled();
});

it('returns an advisory result and supplies a cancellation signal', async () => {
  const service = { evaluate: jest.fn(async () => ({ choice: 'review', actionsExecuted: false })) };
  const res = await request(appFor(service)).post('/api/decisions/evaluate')
    .send({ policy: 'notification-triage', state: 'Something changed.' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ok: true, data: { choice: 'review', actionsExecuted: false } });
  expect(service.evaluate.mock.calls[0][1].signal.aborted).toBe(false);
});

it('rejects caller target overrides through the real validation without touching the runtime', async () => {
  const execute = jest.fn();
  const service = createLocalDecisionService({ runtimeServices: { inference: { execute } } });
  const res = await request(appFor(service)).post('/api/decisions/evaluate')
    .send({ policy: 'notification-triage', state: 'Text', model: 'override' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('DECISION_INPUT_INVALID');
  expect(execute).not.toHaveBeenCalled();
});

it('preserves native refusal codes without exposing error payloads', async () => {
  const service = { evaluate: async () => { throw Object.assign(new Error('private source content'), {
    code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 409
  }); } };
  const res = await request(appFor(service)).post('/api/decisions/evaluate').send({});
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('BENCHMARK_CLAIM_ACTIVE');
  expect(JSON.stringify(res.body)).not.toContain('private source content');
  expect(res.headers['cache-control']).toBe('private, no-store');
});

it('bounds the HTTP body before invoking the model', async () => {
  const service = { evaluate: jest.fn() };
  const res = await request(appFor(service)).post('/api/decisions/evaluate').send({ state: 'x'.repeat(25000) });
  expect(res.status).toBe(413);
  expect(service.evaluate).not.toHaveBeenCalled();
});

it('translates a deadline into a stable timeout code without retry', async () => {
  const service = { evaluate: jest.fn(async () => { throw new DOMException('private state', 'TimeoutError'); }) };
  const res = await request(appFor(service)).post('/api/decisions/evaluate').send({});
  expect(res.status).toBe(504);
  expect(res.body.code).toBe('DECISION_TIMEOUT');
  expect(service.evaluate).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(res.body)).not.toContain('private state');
});
