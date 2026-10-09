'use strict';

const express = require('express');
const request = require('supertest');
const Queue = require('../../models/HeavyWorkQueue');
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const router = require('../../routes/heavy-work-queue');
const { createBrowserOriginGuard } = require('../../../shared/browserOriginGuard');
const app = express();
app.use(createBrowserOriginGuard({ allowedOrigins: ['http://localhost:3180'] }));
app.use(express.json());
app.use('/queue', router);
const input = { key: 'synthetic-api', title: 'Synthetic API fixture', kind: 'profiler', hosts: ['http://127.0.0.1:11434'],
  estimatedMinutes: 5, source: { type: 'coding', ref: 'fixture' }, executor: { hostId: 'fixture-host' } };

beforeEach(async () => { await Queue.deleteMany({}); });
afterEach(() => jest.restoreAllMocks());

it('preserves private no-store receipts and native caller attribution', async () => {
  const created = await request(app).post('/queue').set('x-service-caller', 'synthetic-session').send(input).expect(200);
  expect(created.headers['cache-control']).toBe('private, no-store');
  expect(created.body.data.events[0].actor).toBe('synthetic-session');
  const replay = await request(app).post('/queue').send(input).expect(200);
  expect(replay.body.data.id).toBe(created.body.data.id);
  const list = await request(app).get('/queue').expect(200);
  expect(list.body.data).toMatchObject({ authority: 'core.heavy-work-queue', count: 1 });
});

it('refuses cross-site browser writes before creating a queue record', async () => {
  await request(app).post('/queue').set('sec-fetch-site', 'cross-site').send(input).expect(403);
  expect(await Queue.countDocuments()).toBe(0);
});

it('refuses stale edits and cannot manufacture a completion through record', async () => {
  const job = await queue.submit(input, 'test');
  const ready = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date(Date.now() - 1000).toISOString() }, 'test');
  jest.spyOn(evidence, 'preDispatch').mockResolvedValue();
  const launched = await request(app).post(`/queue/${job.id}/begin`).send({ expectedRevision: ready.revision }).expect(200);
  await request(app).post(`/queue/${job.id}/begin`).send({ expectedRevision: ready.revision }).expect(409);
  await request(app).post(`/queue/${job.id}/record`).send({ dispatchId: launched.body.data.dispatchId, state: 'completed', operationId: 'fixture-op' }).expect(400);
  expect((await queue.get(job.id)).state).toBe('dispatching');
});

it('surfaces executor mismatch without a dispatch mark', async () => {
  const job = await queue.submit(input, 'test');
  jest.spyOn(evidence, 'preDispatch').mockRejectedValue(Object.assign(new Error('Synthetic host mismatch'), { statusCode: 409 }));
  await request(app).post(`/queue/${job.id}/begin`).send({ expectedRevision: job.revision }).expect(409);
  expect((await queue.get(job.id)).state).toBe('requested');
});
