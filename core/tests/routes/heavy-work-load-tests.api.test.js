'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const LoadTest = require('../../models/PerformanceLoadTest');
const queue = require('../../src/services/heavyWorkQueueService');
const parser = require('../../src/services/artilleryParser');
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
