'use strict';

const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const request = require('supertest');
const mongoOptions = require('../../../shared/testing/mongoOptions');

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const Attempt = require('../../models/CoverageAttempt');
const Batch = require('../../models/BenchmarkBatch');
const attempts = require('../../src/services/measurementCoverage/coverageAttempts');
const native = require('../../src/services/measurementCoverage/coverageNativeLaunch');
const { followBite } = require('../../src/services/measurementCoverage/coverageLauncher');
const { DEFAULTS } = require('../../src/services/measurementCoverage/coverageSettings');

let mongo;
let id;
let queueId;
let dispatchId;
let intent;
const batchId = '123456789012345678901234';
const settings = { ...DEFAULTS, enabled: true, timeZone: 'UTC' };
const calm = {
  now: () => new Date('2030-01-01T02:00:00Z'),
  getRuntimeActive: async () => ({ workloads: [], inferences: [] }),
  getHouseholdIdle: async () => ({ activeTurns: 0, idleMs: 3600000 }),
  getActiveBatch: async () => false, getActiveProfiles: async () => false
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), mongoOptions);
  await Promise.all([Attempt.init(), Batch.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([Attempt.deleteMany({}), Batch.deleteMany({})]);
  id = randomUUID(); queueId = randomUUID(); dispatchId = randomUUID();
  intent = { kind: 'benchmark', at: '2030-01-01T02:00:00Z', cell: { hostUrl: 'http://127.0.0.1:11434', model: 'fixture:model' },
    body: { requestId: id, prompt_ids: ['prompt-a'], tags: ['coverage', `coverage-${id}`] },
    manifest: { key: `coverage:${id}`, kind: 'benchmark', hosts: ['http://127.0.0.1:11434'],
      startBefore: '2030-01-01T02:01:00Z', executor: { mode: 'coverage', requestId: id } } };
  await attempts.create(id, intent);
  await attempts.update(id, { queueId });
});
afterEach(() => jest.restoreAllMocks());
const body = () => ({ ...intent.body, queueRequestId: queueId, queueDispatchId: dispatchId });
const dispatch = () => ({ queueRequestId: queueId, queueDispatchId: dispatchId });

function harness({ handler, idleDeps = calm, validateIntent = async () => {}, postError } = {}) {
  const queuePost = jest.fn(async () => ({ data: { admitted: true } }));
  const started = handler || jest.fn(async (req, res) => {
    res.locals.coverageMayHaveStarted = true;
    await Batch.collection.insertOne({ _id: new mongoose.Types.ObjectId(batchId), coverage_request_id: id,
      tags: intent.body.tags, status: 'running' });
    res.json({ status: 'success', data: { batch_id: batchId } });
  });
  const app = express();
  app.use(express.json());
  app.post('/api/benchmark/batch', native.batchBoundary(started, {
    attempts, queuePost, settings: { getSettings: async () => settings }, idleDeps, validateIntent
  }));
  const post = jest.fn(async (path, payload) => {
    const response = await request(app).post(path).send(payload);
    if (postError) throw postError;
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response.body);
    return response.body.data;
  });
  return { app, started, queuePost, deps: { attempts, post, queuePost }, post };
}

it('keeps one durable active intent across concurrent ticks and an uncertain insert acknowledgment', async () => {
  const results = await Promise.all([attempts.create(randomUUID(), intent), attempts.create(randomUUID(), intent)]);
  expect(results.map(value => value._id)).toEqual([id, id]);
  expect(await Attempt.countDocuments({ active: true })).toBe(1);
  await Attempt.deleteMany({});
  const save = Attempt.prototype.save;
  jest.spyOn(Attempt.prototype, 'save').mockImplementationOnce(async function (...args) {
    await save.apply(this, args);
    throw new Error('insert acknowledgment lost');
  });
  await expect(attempts.create(id, intent)).rejects.toThrow('acknowledgment lost');
  expect((await attempts.active())._id).toBe(id);
  expect((await attempts.create(randomUUID(), intent))._id).toBe(id);
});

it('recovers a started batch after HTTP response loss, then reads its terminal receipt without another POST', async () => {
  const h = harness({ postError: new Error('HTTP reply lost after start') });
  const first = await native.launch(id, dispatch(), h.deps);
  expect(first).toMatchObject({ requestId: id, nativeId: batchId, terminal: false, runningConfirmed: true });
  expect((await attempts.get(id)).nativeId).toBe(batchId);
  // A fresh consumer reads Mongo; no in-memory execution state is required.
  await native.launch(id, dispatch(), { ...h.deps, attempts: { ...attempts } });
  expect(h.post).toHaveBeenCalledTimes(1);
  expect(h.started).toHaveBeenCalledTimes(1);
  await Batch.collection.updateOne({ coverage_request_id: id }, { $set: { status: 'completed' } });
  expect(await native.observe(id)).toMatchObject({ nativeId: batchId, terminal: true, state: 'completed' });
  expect(h.post).toHaveBeenCalledTimes(1);
});

it('never replaces a dispatch whose fence write committed but whose acknowledgment was lost', async () => {
  const h = harness();
  const begin = attempts.beginPost;
  jest.spyOn(attempts, 'beginPost').mockImplementationOnce(async (...args) => {
    await begin(...args); throw new Error('fence acknowledgment lost');
  });
  await expect(native.launch(id, dispatch(), h.deps)).rejects.toThrow('acknowledgment lost');
  expect(await native.launch(id, dispatch(), h.deps)).toMatchObject({ uncertain: true, terminal: false });
  expect(h.post).not.toHaveBeenCalled();
  expect((await attempts.active())._id).toBe(id);
});

it('may continue the same intent after a write failed before any durable dispatch fence', async () => {
  const h = harness();
  jest.spyOn(attempts, 'beginPost').mockRejectedValueOnce(new Error('write failed before commit'));
  await expect(native.launch(id, dispatch(), h.deps)).rejects.toThrow('before commit');
  expect(h.post).not.toHaveBeenCalled();
  await native.launch(id, dispatch(), h.deps);
  expect(h.started).toHaveBeenCalledTimes(1);
});

it('a restart between the batch fence and its effect leaves unknown, with no TTL or replacement', async () => {
  const h = harness();
  await attempts.beginPost(id, queueId, dispatchId);
  await attempts.beginNative(id, queueId, dispatchId);
  expect((await request(h.app).post('/api/benchmark/batch').send(body())).status).toBe(409);
  expect(await native.launch(id, dispatch(), h.deps)).toMatchObject({ uncertain: true });
  expect(h.started).not.toHaveBeenCalled();
  expect(h.post).not.toHaveBeenCalled();
});

it.each([409, 422, 503])('persists and publishes a proven native pre-start refusal (HTTP %s) before replying', async status => {
  const h = harness({ handler: jest.fn(async (_req, res) => res.status(status).json({ status: 'error', code: 'FIXTURE_REFUSED', error: 'native refused before start' })) });
  const result = await native.launch(id, dispatch(), h.deps);
  expect(result).toMatchObject({ state: 'failed', terminal: true, launchReceipt: { outcome: 'not-started', requestId: queueId } });
  const publication = h.queuePost.mock.calls.find(([path]) => path.endsWith('/refused'));
  expect(publication).toEqual([`/api/cluster/schedule/work-queue/${queueId}/refused`, {
    dispatchId, code: 'FIXTURE_REFUSED', reason: 'native refused before start'
  }]);
  expect((await attempts.get(id)).launchReceipt).toEqual(result.launchReceipt);
});

it('retains a refusal when Core receipt publication fails, and exposes it for original-identity recovery', async () => {
  const h = harness({ handler: jest.fn(async (_req, res) => res.status(422).json({ status: 'error', error: 'judge unavailable' })) });
  h.queuePost.mockImplementation(async path => { if (path.endsWith('/refused')) throw new Error('receipt acknowledgment lost'); return {}; });
  expect(await native.launch(id, dispatch(), h.deps)).toMatchObject({ launchReceipt: { outcome: 'not-started' } });
  await native.launch(id, dispatch(), h.deps);
  expect(h.post).toHaveBeenCalledTimes(1);
});

it.each([
  ['busy', { ...calm, getRuntimeActive: async () => ({ workloads: [{ admissionId: 'foreign-owner' }], inferences: [] }) }],
  ['unknown inference', { ...calm, getRuntimeActive: async () => ({ workloads: [], inferences: [{ state: 'UNKNOWN' }] }) }],
  ['window closed', { ...calm, now: () => new Date('2030-01-01T12:00:00Z') }]
])('preserves the %s gate at the native boundary', async (_name, idleDeps) => {
  const h = harness({ idleDeps });
  expect(await native.launch(id, dispatch(), h.deps)).toMatchObject({ state: 'failed', launchReceipt: { outcome: 'not-started' } });
  expect(h.started).not.toHaveBeenCalled();
});

it('does not turn a post-boundary error or empty native lookup into proven no-start', async () => {
  const h = harness({ handler: jest.fn(async (_req, res) => {
    res.locals.coverageMayHaveStarted = true;
    return res.status(503).json({ status: 'error', error: 'handoff uncertain' });
  }) });
  expect(await native.launch(id, dispatch(), h.deps)).toMatchObject({ uncertain: true, terminal: false });
  await native.launch(id, dispatch(), h.deps);
  expect(h.started).toHaveBeenCalledTimes(1);
  expect(h.queuePost.mock.calls.some(([path]) => path.endsWith('/refused'))).toBe(false);
  expect((await attempts.get(id)).launchReceipt).toBeUndefined();
});

it('enforces unique native request identity and refuses a foreign payload without consuming the original', async () => {
  const h = harness();
  await attempts.beginPost(id, queueId, dispatchId);
  expect((await request(h.app).post('/api/benchmark/batch').send({ ...body(), prompt_ids: ['foreign'] })).status).toBe(503);
  expect((await attempts.get(id)).nativeDispatchedAt).toBeUndefined();
  expect(h.started).not.toHaveBeenCalled();
  expect((await request(h.app).post('/api/benchmark/batch').send(body())).status).toBe(200);
  await expect(Batch.collection.insertOne({ coverage_request_id: id })).rejects.toMatchObject({ code: 11000 });
  expect(h.started).toHaveBeenCalledTimes(1);
});

it('refuses a mismatched native receipt and never calls it completion', async () => {
  await attempts.beginPost(id, queueId, dispatchId);
  await expect(native.observe(id, { findBatches: async () => [{ _id: batchId, coverage_request_id: randomUUID(), tags: intent.body.tags, status: 'completed' }] }))
    .rejects.toThrow('Foreign');
});

it('reads a running/uncertain Core identity even after its estimated window and never submits a replacement', async () => {
  const current = await attempts.get(id);
  const queue = { getHeavyWork: jest.fn(async () => ({ id: queueId, state: 'uncertain', startBefore: intent.manifest.startBefore })),
    submitHeavyWork: jest.fn(), runHeavyWork: jest.fn(), cancelHeavyWork: jest.fn() };
  expect(await followBite(current, { attempts, queue, allowStart: true, now: () => new Date('2040-01-01') }))
    .toMatchObject({ requestId: id, state: 'uncertain', terminal: false, notStarted: false });
  expect(queue.submitHeavyWork).not.toHaveBeenCalled();
  expect(queue.runHeavyWork).not.toHaveBeenCalled();
  expect(queue.cancelHeavyWork).not.toHaveBeenCalled();
  expect((await attempts.active())._id).toBe(id);
});

it.each([false, true])('keeps native refusal write uncertainty explicit (write committed=%s)', async committed => {
  const h = harness({ handler: jest.fn(async (_req, res) => res.status(422).json({ status: 'error', error: 'judge unavailable' })) });
  const update = attempts.update;
  jest.spyOn(attempts, 'update').mockImplementation(async (key, fields) => {
    if (fields.launchReceipt) {
      if (committed) await update(key, fields);
      throw new Error('refusal write outcome uncertain');
    }
    return update(key, fields);
  });
  const result = await native.launch(id, dispatch(), h.deps);
  if (committed) expect(result).toMatchObject({ launchReceipt: { outcome: 'not-started' } });
  else expect(result).toMatchObject({ uncertain: true, terminal: false });
  await native.launch(id, dispatch(), h.deps);
  expect(h.post).toHaveBeenCalledTimes(1);
  expect(h.started).toHaveBeenCalledTimes(1);
  expect(h.queuePost.mock.calls.some(([path]) => path.endsWith('/refused'))).toBe(false);
});

it('does not bypass the changed judge qualification gate at the native boundary', async () => {
  const h = harness({ validateIntent: async () => { throw Object.assign(new Error('original judge changed'), {
    notStarted: true, code: 'COVERAGE_INTENT_CHANGED'
  }); } });
  expect(await native.launch(id, dispatch(), h.deps)).toMatchObject({ launchReceipt: { code: 'COVERAGE_INTENT_CHANGED' } });
  expect(h.started).not.toHaveBeenCalled();
});
