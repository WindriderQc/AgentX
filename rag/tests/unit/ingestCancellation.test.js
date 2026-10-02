jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
  Schema: class { index() {} },
  model: jest.fn(() => ({ create: jest.fn().mockResolvedValue({}) })),
}));
jest.mock('../../src/services/ingestWorker', () => ({
  ...jest.requireActual('../../src/services/ingestWorker'),
  runIngestScan: jest.fn(),
}));
jest.mock('../../src/services/buddyRagEvents', () => ({
  ingestStart: jest.fn(), ingestProgress: jest.fn(), clearProgress: jest.fn(),
  ingestDone: jest.fn(), ingestFailed: jest.fn(),
}));

const express = require('express');
const path = require('path');
const supertest = require('supertest');
const { startTestHttpHarness } = require('../../../shared/testing/httpHarness');
const { runIngestScan, IngestWorker } = require('../../src/services/ingestWorker');
const manager = require('../../src/services/ingestJobManager');
const events = require('../../src/services/buddyRagEvents');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', require('../../routes/rag'));
  harness = await startTestHttpHarness(app, supertest, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
beforeEach(() => { manager._reset(); jest.clearAllMocks(); runIngestScan.mockReset(); });

test.each(['success', 'document failure'])('cancellation drains the real worker document before restart: %s', async outcome => {
  const document = deferred();
  const entered = deferred();
  const scans = [];
  let active = 0, peak = 0;
  const collection = { updateOne: jest.fn().mockResolvedValue({}) };
  const ingestDocument = jest.fn(async () => {
    active++; peak = Math.max(peak, active); entered.resolve();
    try { return await document.promise; } finally { active--; }
  });
  runIngestScan.mockImplementation(options => {
    const worker = new IngestWorker({
      roots: ['/data/imports/docs'], db: { collection: () => collection }, ingestDocument,
      fileSystem: {
        realpath: async value => path.resolve(value),
        stat: async () => ({ isDirectory: () => true, isFile: () => true, size: 10 }),
        readFile: async () => 'Synthetic document',
      },
    });
    worker.getCandidateRecords = async () => [1, 2].map(id => ({
      _id: String(id), path: `/data/imports/docs/${id}.md`, ext: 'md', size: 10,
    }));
    const scan = worker.run(options);
    scans.push(scan);
    return scan;
  });
  const first = await harness.request.post('/api/rag/ingest-scan').send({}).expect(202);
  const id = first.body.data.jobId;
  await entered.promise;
  try {
    await harness.request.delete('/api/rag/ingest-scan/' + id).expect(200);
    const next = await harness.request.post('/api/rag/ingest-scan').send({});
    expect(peak).toBe(1);
    expect(next.status).toBe(409);
    const pending = await harness.request.get('/api/rag/ingest-scan/' + id).expect(200);
    expect(pending.body.data).toMatchObject({ status: 'cancelled', completedAt: null });
    await harness.request.delete('/api/rag/ingest-scan/' + id).expect(400);
  } finally {
    if (outcome === 'success') document.resolve({ documentId: 'synthetic', chunkCount: 1 });
    else document.reject(new Error('Synthetic ingestion failure'));
    await Promise.all(scans);
  }
  const finished = await harness.request.get('/api/rag/ingest-scan/' + id).expect(200);
  expect(finished.body.data.status).toBe('cancelled');
  expect(finished.body.data.completedAt).not.toBeNull();
  expect(finished.body.data.summary).toMatchObject({ processed: 1, failed: outcome === 'success' ? 0 : 1 });
  expect(finished.body.data.progress).toEqual({ processed: 1, total: 2, errors: outcome === 'success' ? 0 : 1 });
  expect(ingestDocument).toHaveBeenCalledTimes(1);
  expect(collection.updateOne).toHaveBeenCalledTimes(1);
  expect(events.ingestProgress).toHaveBeenCalledTimes(1); // Initial total only.
  expect(events.ingestDone).not.toHaveBeenCalled();
  expect(events.ingestFailed).not.toHaveBeenCalled();
  runIngestScan.mockResolvedValue({ processed: 0, results: [] });
  await harness.request.post('/api/rag/ingest-scan').send({}).expect(202);
});

test('a late scan rejection preserves cancellation and permits another scan', async () => {
  const scan = deferred();
  runIngestScan.mockReturnValue(scan.promise);
  const first = await harness.request.post('/api/rag/ingest-scan').send({}).expect(202);
  const id = first.body.data.jobId;
  await harness.request.delete('/api/rag/ingest-scan/' + id).expect(200);
  scan.reject(new Error('Late scan failure'));
  const finished = await harness.request.get('/api/rag/ingest-scan/' + id).expect(200);
  expect(finished.body.data).toMatchObject({ status: 'cancelled', error: 'Late scan failure' });
  expect(finished.body.data.completedAt).not.toBeNull();
  expect(events.ingestFailed).not.toHaveBeenCalled();
  runIngestScan.mockResolvedValue({ processed: 0, results: [] });
  await harness.request.post('/api/rag/ingest-scan').send({}).expect(202);
});

test.each(['completed', 'failed', 'cancelled'])('late callbacks cannot rewrite %s or release the next scan', status => {
  const { jobId } = manager.createJob();
  if (status === 'cancelled') manager.cancelJob(jobId);
  if (status === 'failed') manager.failJob(jobId, 'Initial failure');
  else manager.completeJob(jobId, { processed: 1 });
  const snapshot = JSON.parse(JSON.stringify(manager.getJob(jobId)));
  const next = manager.createJob();
  jest.clearAllMocks();
  manager.updateProgress(jobId, { processed: 99 });
  manager.failJob(jobId, 'Late error');
  manager.completeJob(jobId, { processed: 99 });
  expect(manager.getJob(jobId)).toEqual(snapshot);
  expect(manager.getActiveJobId()).toBe(next.jobId);
  expect(events.ingestProgress).not.toHaveBeenCalled();
  expect(events.ingestDone).not.toHaveBeenCalled();
  expect(events.ingestFailed).not.toHaveBeenCalled();
});
