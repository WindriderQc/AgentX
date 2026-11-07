'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const LoadTest = require('../../models/PerformanceLoadTest');
const queue = require('../../src/services/heavyWorkQueueService');
const parser = require('../../src/services/artilleryParser');
const { main: operatorCli } = require('../../../integrations/operations/heavy-work-queue.cjs');
const app = express();
app.use(express.json());
app.use('/queue', require('../../routes/heavy-work-queue'));
app.use('/performance', require('../../routes/performance-data'));

const actor = 'synthetic-executor';
const raw_report = {
  aggregate: {
    duration: 60000,
    counters: { 'http.requests': 100, 'vusers.created': 10, 'vusers.completed': 10, 'http.codes.200': 100 },
    rates: { 'http.request_rate': { mean: 1.67, max: 3 } },
    summaries: { 'http.response_time': { min: 1, max: 50, median: 10, p95: 40, p99: 48 } }
  }
};
const loadTest = { name: 'Synthetic load', scenario: 'synthetic-load', timestamp: '2026-01-02T03:04:05-05:00', raw_report };
async function begun(key = 'synthetic-load') {
  const created = await queue.submit({ key, title: 'Synthetic load fixture', kind: 'diagnostic',
    hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 5,
    executor: { mode: 'operator', receiptRef: 'synthetic-receipt.json' } }, actor);
  const ready = await queue.reserve(created.id, { expectedRevision: created.revision,
    start: new Date(Date.now() - 1000).toISOString() }, actor);
  return queue.begin(ready.id, { expectedRevision: ready.revision }, actor);
}
const receipt = job => ({ expectedRevision: job.revision, dispatchId: job.dispatchId, state: 'completed',
  receiptRef: job.executor.receiptRef, receiptSha256: 'a'.repeat(64),
  confirmation: 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED', loadTest });
const finish = (job, body = receipt(job), by = actor) => request(app).post(`/queue/${job.id}/operator-finish`)
  .set('x-service-caller', by).send(body);

beforeEach(async () => {
  await Promise.all([Queue.deleteMany({}), Archive.deleteMany({}), Runtime.deleteMany({}), LoadTest.deleteMany({})]);
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
});
afterEach(() => jest.restoreAllMocks());

it('records only after terminal release, shares the import parser, preserves test time and feeds the Performance table', async () => {
  const job = await begun();
  const parse = jest.spyOn(parser, 'parseArtilleryReport');
  const response = await finish(job).expect(200);
  const done = await queue.get(job.id);
  expect(done.state).toBe('completed');
  expect(done.releaseReceipt).toMatchObject({ authority: 'operator-attestation', receiptSha256: 'a'.repeat(64),
    loadTestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(done.releaseReceipt.raw_report).toBeUndefined();
  expect(response.body.data.loadTest.queueJobId).toBe(job.id);
  const saved = await LoadTest.findOne({ queueJobId: job.id });
  expect(saved.timestamp.toISOString()).toBe('2026-01-02T08:04:05.000Z');
  expect(saved.imported_at.getTime()).toBeGreaterThan(saved.timestamp.getTime());
  expect(saved.summary.requests_completed).toBe(100);
  expect(saved.latency.p95).toBe(40);
  expect(parse).toHaveBeenCalledWith(raw_report);

  const listed = await request(app).get('/performance/load-tests').expect(200);
  expect(listed.body.data.tests).toHaveLength(1);
  const item = listed.body.data.tests[0];
  expect(item).toMatchObject({ queueJobId: job.id, timestamp: '2026-01-02T08:04:05.000Z' });
  expect(item.raw_report).toBeUndefined();
  // Run the existing browser renderer with the API result, without a live Core.
  const rows = [];
  const tbody = { innerHTML: '', appendChild: row => rows.push(row) };
  const context = { PerformanceDashboard: {}, escapeHtml: value => String(value), document: {
    getElementById: () => tbody,
    createElement: () => ({ dataset: {}, querySelector: () => ({ addEventListener() {} }) })
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/performance-loadtests.js'), 'utf8'), context);
  context.PerformanceDashboard.renderLoadTestsTable(listed.body.data.tests);
  expect(rows).toHaveLength(1);
  expect(rows[0].dataset.testId).toBe(item._id);
  expect(rows[0].innerHTML).toContain('synthetic-load');
  expect(rows[0].innerHTML).toContain('40ms');
});

it('deduplicates concurrent deliveries and stale-revision replay by job identity', async () => {
  const job = await begun();
  const responses = await Promise.all(Array.from({ length: 5 }, () => finish(job)));
  expect(responses.map(answer => answer.status)).toEqual([200, 200, 200, 200, 200]);
  expect(new Set(responses.map(answer => answer.body.data.loadTest.id)).size).toBe(1);
  expect(await LoadTest.countDocuments()).toBe(1);
  const done = await queue.get(job.id);
  expect(done.events.filter(event => event.action === 'operator-finished')).toHaveLength(1);
  const original = await LoadTest.findOne().lean();
  await finish(job).expect(200);
  expect((await queue.get(job.id)).revision).toBe(done.revision);
  expect(await LoadTest.findOne().lean()).toEqual(original);
});

it('keeps identical reports from distinct job identities as separate tests', async () => {
  const first = await begun('synthetic-first');
  await finish(first).expect(200);
  const second = await begun('synthetic-second');
  await finish(second).expect(200);
  expect(await LoadTest.countDocuments()).toBe(2);
  expect((await LoadTest.find().distinct('queueJobId')).sort()).toEqual([first.id, second.id].sort());
});

it('a report never grants completion for an unstarted job or a different executor', async () => {
  const job = await begun();
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': job.id }, { $set: { 'jobs.$.state': 'reserved' } });
  await finish(job).expect(409);
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': job.id }, { $set: {
    'jobs.$.state': 'dispatching', 'jobs.$.executor.mode': 'island'
  } });
  await finish(job).expect(409);
  expect(await LoadTest.countDocuments()).toBe(0);
});

it('repairs a lost projection write after termination and archive without changing the receipt or rerunning the job', async () => {
  const job = await begun();
  jest.spyOn(LoadTest, 'findOneAndUpdate').mockRejectedValueOnce(new Error('Synthetic write unavailable'));
  await finish(job).expect(503);
  const done = await queue.get(job.id);
  expect(done.state).toBe('completed');
  expect(await LoadTest.countDocuments()).toBe(0);
  await queue.archive(actor);
  expect((await queue.get(job.id)).archived).toBe(true);
  const retried = await finish(job).expect(200);
  expect(retried.body.data.releaseReceipt).toEqual(done.releaseReceipt);
  expect(await LoadTest.countDocuments()).toBe(1);
  expect((await queue.get(job.id)).revision).toBe(done.revision);
});

it('reconciles a terminal queue write whose acknowledgment was lost', async () => {
  const job = await begun();
  const update = Queue.updateOne.bind(Queue);
  jest.spyOn(Queue, 'updateOne').mockImplementationOnce(async (...args) => {
    await update(...args);
    throw new Error('Synthetic queue acknowledgment lost after commit');
  });
  await finish(job).expect(200);
  const done = await queue.get(job.id);
  expect(done.state).toBe('completed');
  expect(done.events.filter(event => event.action === 'operator-finished')).toHaveLength(1);
  expect(await LoadTest.countDocuments()).toBe(1);
  await finish(job).expect(200);
  expect((await queue.get(job.id)).revision).toBe(done.revision);
});

it('never records a result when the terminal queue write fails before commit', async () => {
  const job = await begun();
  jest.spyOn(Queue, 'updateOne').mockRejectedValueOnce(new Error('Synthetic queue write refused'));
  await finish(job).expect(503);
  expect((await queue.get(job.id)).state).toBe('dispatching');
  expect(await LoadTest.countDocuments()).toBe(0);
  await finish(job).expect(200);
  expect(await LoadTest.countDocuments()).toBe(1);
});

it('preserves the saved result when its write acknowledgment is lost and deliveries resume concurrently after archive', async () => {
  const job = await begun();
  const upsert = LoadTest.findOneAndUpdate.bind(LoadTest);
  jest.spyOn(LoadTest, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await upsert(...args);
    throw new Error('Synthetic result acknowledgment lost after commit');
  });
  await finish(job).expect(503);
  const done = await queue.get(job.id);
  const saved = await LoadTest.findOne().lean();
  expect(saved.queueJobId).toBe(job.id);
  await queue.archive(actor);
  const resumed = await Promise.all(Array.from({ length: 4 }, () => finish(job)));
  expect(resumed.map(result => result.status)).toEqual([200, 200, 200, 200]);
  expect(new Set(resumed.map(result => result.body.data.loadTest.id))).toEqual(new Set([String(saved._id)]));
  expect(await LoadTest.countDocuments()).toBe(1);
  expect(await LoadTest.findOne().lean()).toEqual(saved);
  expect((await queue.get(job.id)).releaseReceipt).toEqual(done.releaseReceipt);
  expect((await queue.get(job.id)).revision).toBe(done.revision);
});

it('can retry index creation after a failure without finalizing the queue twice', async () => {
  const job = await begun();
  jest.spyOn(LoadTest.collection, 'createIndex').mockRejectedValueOnce(new Error('Synthetic index write unavailable'));
  await finish(job).expect(503);
  const done = await queue.get(job.id);
  expect(done.state).toBe('completed');
  expect(await LoadTest.countDocuments()).toBe(0);
  await finish(job).expect(200);
  expect(await LoadTest.countDocuments()).toBe(1);
  expect((await queue.get(job.id)).revision).toBe(done.revision);
});

it.each(['lost-response', 'failed-result-write'])
('replays the original CLI command through Core after %s and archive', async failure => {
  const job = await begun();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'load-test-replay-'));
  const file = path.join(directory, 'synthetic-receipt.json');
  fs.writeFileSync(file, JSON.stringify({ contract: 'agentx.operator-heavy-work/v1', queueRequestId: job.id,
    dispatchId: job.dispatchId, actor, receiptRef: job.executor.receiptRef,
    state: 'completed', runtimeReleased: true, loadTest }));
  const args = ['finish-operator', '--core', 'http://127.0.0.1:3180', '--actor', actor,
    '--id', job.id, '--revision', String(job.revision), '--file', file];
  let lostResponse = failure === 'lost-response';
  if (failure === 'failed-result-write') {
    jest.spyOn(LoadTest, 'findOneAndUpdate').mockRejectedValueOnce(new Error('Synthetic result write unavailable'));
  }
  // Transport calls the real routers on this disposable test database. No
  // installed service, native executor or inference is contacted.
  const deps = { fetchImpl: async (url, options) => {
    const route = new URL(url).pathname.replace('/api/cluster/schedule/work-queue', '/queue');
    let call = request(app)[options.method.toLowerCase()](route).set(options.headers);
    if (options.body) call = call.send(JSON.parse(options.body));
    const response = await call;
    if (lostResponse && route.endsWith('/operator-finish')) {
      lostResponse = false;
      expect(response.status).toBe(200);
      throw new Error('Synthetic HTTP finish response lost');
    }
    return { ok: response.status < 400, status: response.status, json: async () => response.body };
  } };
  try {
    await expect(operatorCli(args, deps)).rejects.toThrow();
    const done = await queue.get(job.id);
    expect(done.state).toBe('completed');
    const saved = await LoadTest.findOne().lean();
    expect(Boolean(saved)).toBe(failure === 'lost-response');
    await queue.archive(actor);
    const results = await Promise.all(Array.from({ length: 3 }, () => operatorCli(args, deps)));
    expect(new Set(results.map(result => result.loadTest.id)).size).toBe(1);
    expect(await LoadTest.countDocuments()).toBe(1);
    if (saved) expect(await LoadTest.findOne().lean()).toEqual(saved);
    const replayed = await queue.get(job.id);
    expect(replayed.revision).toBe(done.revision);
    expect(replayed.releaseReceipt).toEqual(done.releaseReceipt);
    expect(replayed.events.filter(event => event.action === 'operator-finished')).toHaveLength(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['actor', 'dispatchId', 'receiptRef', 'receiptSha256', 'confirmation', 'state', 'report'])
('refuses a changed %s after completion', async field => {
  const job = await begun();
  await finish(job).expect(200);
  const body = receipt(job);
  if (field === 'report') body.loadTest = { ...loadTest, name: 'Changed fixture' };
  else if (field !== 'actor') body[field] = field === 'state' ? 'failed' : 'different';
  const result = await finish(job, body, field === 'actor' ? 'another-executor' : actor);
  expect([400, 409]).toContain(result.status);
  expect(await LoadTest.countDocuments()).toBe(1);
  expect((await LoadTest.findOne()).name).toBe(loadTest.name);
});

it.each([
  { raw_report: {} },
  { raw_report: { aggregate: { counters: {}, summaries: {}, rates: { 'http.request_rate': { mean: 'invalid' } } } } },
  { timestamp: undefined }, { timestamp: '2026-01-02' }, { timestamp: 'invalid' }, { name: '' }
])('refuses invalid report data before terminal state or result storage: %j', async invalid => {
  const job = await begun();
  await finish(job, { ...receipt(job), loadTest: { ...loadTest, ...invalid } }).expect(400);
  expect((await queue.get(job.id)).state).toBe('dispatching');
  expect(await LoadTest.countDocuments()).toBe(0);
});

it('refuses held or unavailable native release evidence and stale revisions before storing a result', async () => {
  const job = await begun();
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: {
    inferences: [{ host: job.hosts[0], state: 'UNKNOWN' }]
  } });
  await finish(job).expect(409);
  await Runtime.deleteMany({});
  await finish(job).expect(503);
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  await finish(job, { ...receipt(job), expectedRevision: job.revision + 1 }).expect(409);
  expect((await queue.get(job.id)).state).toBe('dispatching');
  expect(await LoadTest.countDocuments()).toBe(0);
});

it('keeps manual imports independent and uses the same parser for both paths', async () => {
  const parse = jest.spyOn(parser, 'parseArtilleryReport');
  await request(app).post('/performance/load-tests').send(loadTest).expect(201);
  await request(app).post('/performance/load-tests').send(loadTest).expect(201);
  await request(app).post('/performance/load-tests').send({ name: 'Invalid', raw_report: {} }).expect(400);
  const job = await begun();
  await finish(job).expect(200);
  expect(parse).toHaveBeenCalledTimes(3);
  const all = await request(app).get('/performance/load-tests?scenario=synthetic-load').expect(200);
  expect(all.body.data.count).toBe(3);
  expect(await LoadTest.countDocuments({ queueJobId: { $exists: false } })).toBe(2);
  expect(new Set(all.body.data.tests.map(item => JSON.stringify(item.summary))).size).toBe(1);
});
