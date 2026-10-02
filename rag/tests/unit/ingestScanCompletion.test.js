jest.mock('../../models/IngestJob', () => ({ create: jest.fn() }));
jest.mock('../../config/logger', () => ({ warn: jest.fn() }));
jest.mock('../../src/services/ingestJobManager', () => ({
  getJob: jest.fn(),
  completeJob: jest.fn()
}));

const IngestJob = require('../../models/IngestJob');
const logger = require('../../config/logger');
const jobManager = require('../../src/services/ingestJobManager');
const { completeIngestScan } = require('../../src/services/ingestScanCompletion');

let job;
const summary = () => ({
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:04.000Z',
  totalCandidates: 2,
  processed: 2,
  ingested: 1,
  updated: 1,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  results: [
    { status: 'ingested', chunkCount: 2, path: '/private/one.pdf', text: 'private text' },
    { status: 'updated', chunkCount: 3, path: '/private/two.pdf' }
  ]
});

beforeEach(() => {
  jest.clearAllMocks();
  job = { status: 'running', completedAt: null };
  jobManager.getJob.mockReturnValue(job);
  jobManager.completeJob.mockImplementation(() => {
    if (job.status !== 'cancelled') job.status = 'completed';
    job.completedAt = '2026-01-01T00:00:04.000Z';
  });
  IngestJob.create.mockResolvedValue({});
});

test('a completed scan with changed content records one path-free freshness receipt', async () => {
  await completeIngestScan('scan-1', summary());

  expect(jobManager.completeJob).toHaveBeenCalledWith('scan-1', expect.objectContaining({
    ingested: 1, updated: 1, failed: 0
  }));
  expect(IngestJob.create).toHaveBeenCalledWith({
    jobId: 'scan-1', source: 'ingest-scan', status: 'success',
    chunksCreated: 5, totalTimeMs: 4000
  });
  expect(JSON.stringify(IngestJob.create.mock.calls[0][0])).not.toMatch(/private|path|text/);
});

test.each([
  ['unchanged', { ingested: 0, updated: 0, unchanged: 2 }],
  ['partial failure', { failed: 1 }],
  ['incomplete', { processed: 1 }]
])('%s scans do not advance corpus freshness', async (_name, changes) => {
  await completeIngestScan('scan-2', { ...summary(), ...changes });
  expect(jobManager.completeJob).toHaveBeenCalled();
  expect(IngestJob.create).not.toHaveBeenCalled();
});

test('a cancelled scan does not advance freshness even after a document write', async () => {
  job.status = 'cancelled';
  await completeIngestScan('scan-3', summary());
  expect(IngestJob.create).not.toHaveBeenCalled();
});

test('receipt failure leaves the completed scan intact and logs the evidence gap', async () => {
  IngestJob.create.mockRejectedValue(new Error('database unavailable'));
  await expect(completeIngestScan('scan-4', summary())).resolves.toBeUndefined();
  expect(job.status).toBe('completed');
  expect(logger.warn).toHaveBeenCalledWith('Ingest scan freshness receipt failed:', 'database unavailable');
});
