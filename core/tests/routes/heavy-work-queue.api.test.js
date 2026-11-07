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
  expect(list.body.data.summary).toMatchObject({ total: 1, counts: { automatic_queue: 0, action_required: 1 } });
  const shown = await request(app).get(`/queue/${created.body.data.id}`).expect(200);
  expect(shown.body.data.presentation).toMatchObject({ phase: 'action_required', nextAction: { code: 'plan_slot', actor: 'operator' } });
  expect((await queue.get(created.body.data.id)).presentation).toBeUndefined();
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

it('runs a reserved Profiler request now only with its current revision', async () => {
  const job = await queue.submit(input, 'test');
  const ready = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date(Date.now() - 1000).toISOString() }, 'test');
  jest.spyOn(evidence, 'preDispatch').mockResolvedValue();
  await request(app).post(`/queue/${job.id}/run`).send({}).expect(400);
  await request(app).post(`/queue/${job.id}/run`).send({ expectedRevision: ready.revision + 1 }).expect(409);
  expect((await queue.get(job.id)).state).toBe('reserved');
});

it('receives a real preparation preflight refusal through the CLI and lets the next image reserve both hosts', async () => {
  const Runtime = require('../../models/RuntimeCoordination');
  const { runJob } = require('../../../integrations/operations/heavy-work-queue.cjs');
  const { ACTIONS } = require('../../../scripts/maintenance-benchmark.cjs');
  const { ActionError } = require('../../../scripts/maintenance-actions.cjs');
  const host = 'http://127.0.0.1:11434', judgeHost = 'http://127.0.0.1:11435';
  const params = { host, model: 'synthetic:candidate', categories: ['coding'], levels: [1], repeats: 1,
    judgeHost, judgeModel: 'synthetic:judge' };
  await Runtime.deleteMany({});
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  const job = await queue.submit({ ...input, key: 'refused-preparation-api', kind: 'benchmark', hosts: [host, judgeHost],
    executor: { prepare: true, request: params } }, 'fixture');
  const ready = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date(Date.now() - 1000).toISOString() }, 'fixture');
  const calls = [];
  const client = async (suffix, body) => {
    const pending = request(app)[body === undefined ? 'get' : 'post'](`/queue${suffix}`).set('x-service-caller', 'fixture');
    const response = await (body === undefined ? pending : pending.send(body)).expect(200);
    return response.body.data;
  };
  await expect(runJob(ready, client, { actor: 'fixture', benchmarkExecutor: () => ACTIONS['benchmark-batch-prepare']({
    ActionError, receiptsDir: require('node:os').tmpdir(), benchmark: 'http://127.0.0.1:3181',
    options: { actor: 'fixture', host, model: params.model, categories: 'coding', levels: '1',
      'judge-host': judgeHost, 'judge-model': params.judgeModel },
    http: async url => {
      const route = new URL(url).pathname;
      calls.push(route);
      if (route === '/api/tags') return { ok: true, json: { models: [{ name: params.model }, { name: params.judgeModel }] } };
      const data = route.endsWith('/readiness') ? { hosts: [{ hostUrl: host }, { hostUrl: judgeHost }] }
        : route.endsWith('/prompts') ? { prompts: [{ _id: '000000000000000000000001', category: 'coding', level: 1 }] }
          : { ready: false, issues: ['Synthetic profile not qualified'], checks: {} };
      return { ok: true, status: 200, json: { status: 'success', data } };
    }
  }) })).rejects.toMatchObject({ outcome: 'refused', queueId: job.id });
  const terminal = await client(`/${job.id}`);
  expect(terminal).toMatchObject({ state: 'failed', preparationRefusal: { code: 'PREFLIGHT_NOT_READY' },
    releaseReceipt: { authority: 'operator-preparation-refusal' } });
  const image = await queue.submit({ ...input, key: 'image-after-refusal-api', kind: 'image', hosts: [host, judgeHost],
    executor: { actionKey: 'synthetic-next-image', prompt: 'Synthetic image fixture' } }, 'fixture');
  await expect(queue.reserve(image.id, { expectedRevision: image.revision, start: new Date().toISOString() }, 'fixture'))
    .resolves.toMatchObject({ state: 'reserved' });
  expect(calls).not.toContain('/api/benchmark/batch');
});
