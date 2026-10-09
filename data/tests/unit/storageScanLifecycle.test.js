/**
 * The in-container scan path hands every end of scan to the scan lifecycle,
 * with what a growth snapshot needs to know; the restart repair logs the scans
 * it stops.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));
jest.mock('../../services/janitorService', () => ({
  resolveAllowedPath: jest.fn(async (root) => ({ ok: true, realPath: root }))
}));
jest.mock('../../services/scanner', () => ({
  Scanner: jest.fn(),
  rebuildDirectoryRollups: jest.fn(),
  pruneStaleFiles: jest.fn(),
  pruneSkippedMessage: jest.fn()
}));
jest.mock('../../services/storageAgentService', () => ({
  findOverlappingScan: jest.fn().mockResolvedValue(null),
  expireStaleScans: jest.fn().mockResolvedValue({ running: 0, queued: 0 })
}));
jest.mock('../../services/activityEvents', () => ({
  scanStarted: jest.fn().mockResolvedValue(null),
  scanFinished: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../services/storageTrends', () => ({
  snapshotEligible: jest.requireActual('../../services/storageTrends').snapshotEligible,
  recordSnapshots: jest.fn().mockResolvedValue([{ root: '/mnt/media' }])
}));

const { Scanner } = require('../../services/scanner');
const activityEvents = require('../../services/activityEvents');
const storageTrends = require('../../services/storageTrends');
const lifecycle = require('../../services/storageScanLifecycle');
const storageRoutes = require('../../routes/storage.routes');

function buildApp(scans) {
  const app = express();
  app.use(express.json());
  app.locals.db = { collection: jest.fn(() => scans) };
  app.use('/api/v1/storage', storageRoutes);
  return app;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('in-container scan lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  async function startScan(run) {
    const handlers = {};
    Scanner.mockImplementation(() => ({ on: jest.fn((name, handler) => { handlers[name] = handler; }), run, stop: jest.fn() }));
    const scans = { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    const res = await request(buildApp(scans)).post('/api/v1/storage/scan').send({ roots: ['/mnt/media'] }).expect(200);
    return { handlers, scans, scanId: res.body.data.scan_id };
  }

  test('a started scan is logged, and its end is logged and snapshotted when complete and unfiltered', async () => {
    const { handlers, scanId } = await startScan(jest.fn().mockResolvedValue());
    expect(activityEvents.scanStarted).toHaveBeenCalledWith(expect.anything(), { _id: scanId, config: { roots: ['/mnt/media'] } });

    const finishedAt = new Date();
    handlers.done({ status: 'complete', counts: { files_seen: 4 }, finished_at: finishedAt, last_error: null, rollups_rebuilt: true, filtered: false });
    await flush();
    const ended = expect.objectContaining({ _id: scanId, status: 'complete', counts: { files_seen: 4 }, config: { roots: ['/mnt/media'] } });
    expect(activityEvents.scanFinished).toHaveBeenCalledWith(expect.anything(), ended);
    expect(storageTrends.recordSnapshots).toHaveBeenCalledWith(expect.anything(), ended);
  });

  test.each([
    ['an extension filter', { status: 'complete', rollups_rebuilt: true, filtered: true }],
    ['rollups that failed to rebuild', { status: 'complete', rollups_rebuilt: false, filtered: false }],
    ['a partial scan', { status: 'partial', last_error: 'Scan had 2 error(s); existing index rows were kept', rollups_rebuilt: true, filtered: false }],
    ['a stopped scan', { status: 'stopped', rollups_rebuilt: true, filtered: false }],
    ['a scanner that says nothing about its rollups', { status: 'complete' }]
  ])('%s is logged but writes no snapshot', async (_name, done) => {
    const { handlers } = await startScan(jest.fn().mockResolvedValue());
    handlers.done(done);
    await flush();
    expect(activityEvents.scanFinished).toHaveBeenCalledTimes(1);
    expect(storageTrends.recordSnapshots).not.toHaveBeenCalled();
  });

  test('a scan that crashes is marked failed and logged as such', async () => {
    const { scans, scanId } = await startScan(jest.fn().mockRejectedValue(new Error('disk vanished')));
    await flush();
    await flush();
    expect(scans.updateOne).toHaveBeenCalledWith(
      { _id: scanId, status: { $in: ['running', 'hashing'] } },
      { $set: { status: 'failed', finished_at: expect.any(Date), last_error: 'disk vanished' } }
    );
    expect(activityEvents.scanFinished).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ _id: scanId, status: 'failed', last_error: 'disk vanished' }));
    expect(storageTrends.recordSnapshots).not.toHaveBeenCalled();
  });

  test('a snapshot failure is swallowed by the lifecycle', async () => {
    storageTrends.recordSnapshots.mockRejectedValueOnce(new Error('store down'));
    await expect(lifecycle.scanEnded({}, { _id: 's', status: 'complete', config: { roots: ['/mnt/media'] } })).resolves.toEqual([]);
  });

  test('the restart repair logs each in-container scan it stops', async () => {
    const stopped = [{ _id: 'local-1', status: 'stopped', config: { roots: ['/mnt/media'] } }];
    const scans = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      find: jest.fn(() => ({ limit: () => ({ toArray: async () => stopped }) }))
    };
    await lifecycle.cleanupStaleScans({ collection: () => scans });
    expect(scans.updateMany).toHaveBeenCalledWith(
      { status: { $in: ['running', 'hashing'] }, 'config.external': { $ne: true } },
      { $set: { status: 'stopped', finished_at: expect.any(Date) } }
    );
    expect(activityEvents.scanFinished).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ _id: 'local-1', status: 'stopped', last_error: lifecycle.RESTART_REASON }));
  });
});
