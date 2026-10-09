/**
 * Route tests for storage scanner endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../services/janitorService', () => ({
  resolveAllowedPath: jest.fn()
}));

jest.mock('../../services/scanner', () => ({
  Scanner: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    run: jest.fn().mockResolvedValue(),
    stop: jest.fn()
  })),
  rebuildDirectoryRollups: jest.fn().mockResolvedValue(1),
  pruneStaleFiles: jest.requireActual('../../services/scanner').pruneStaleFiles,
  pruneSkippedMessage: jest.requireActual('../../services/scanner').pruneSkippedMessage
}));

jest.mock('../../services/storageAgentService', () => ({
  listScanners: jest.fn().mockResolvedValue([]),
  sourceRegistry: jest.fn(() => ({ media: { canonicalRoot: '/mnt/media' } })),
  enqueueScan: jest.fn(),
  registerScanner: jest.fn().mockResolvedValue('scanner-1'),
  claimNextScan: jest.fn().mockResolvedValue(null),
  findOverlappingScan: jest.fn().mockResolvedValue(null),
  expireStaleScans: jest.fn().mockResolvedValue({ running: 0, queued: 0 }),
  touchScanHeartbeat: jest.fn().mockResolvedValue(true),
  listMetadataProbePaths: jest.fn().mockResolvedValue([])
}));

jest.mock('../../utils/file-operations', () => ({
  formatFileSize: jest.fn(n => `${n} B`)
}));

const storageRoutes = require('../../routes/storage.routes');
const { resolveAllowedPath } = require('../../services/janitorService');
const { Scanner, rebuildDirectoryRollups } = require('../../services/scanner');
const storageAgentService = require('../../services/storageAgentService');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const makeCol = (name) => ({
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        skip: jest.fn(() => ({
          limit: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue(overrides.scans || [])
          }))
        }))
      }))
    })),
    findOne: jest.fn().mockResolvedValue(overrides.scanDoc || null),
    countDocuments: jest.fn().mockResolvedValue(overrides.count || 0),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 2, modifiedCount: 1 }),
    aggregate: jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue(overrides.aggregate || [])
    }))
  });

  const collections = {};
  app.locals.db = {
    collection: jest.fn((name) => {
      if (!collections[name]) collections[name] = makeCol(name);
      return collections[name];
    }),
    _collections: collections,
    _makeCol: makeCol
  };

  app.use('/api/v1/storage', storageRoutes);
  app.use(errorHandler);
  return app;
}

describe('Storage Scanner Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storageAgentService.findOverlappingScan.mockResolvedValue(null);
    storageAgentService.touchScanHeartbeat.mockResolvedValue(true);
  });

  // ── POST /scan ──

  describe('POST /api/v1/storage/scan', () => {
    test('returns 400 when roots is missing', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/roots/i);
    });

    test('returns 400 when roots is empty array', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: [] });
      expect(res.status).toBe(400);
    });

    test('returns 403 for blocked path', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: false, reason: 'Blocked by safety policy' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/etc/passwd'] });
      expect(res.status).toBe(403);
    });

    test('returns 400 for non-existent path', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: false, reason: 'Path does not exist' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/nonexistent'] });
      expect(res.status).toBe(400);
    });

    test('starts scan for valid root', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/datalake/media' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/mnt/datalake/media'] });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.scan_id).toBeTruthy();
      expect(res.body.data.roots).toEqual(['/mnt/datalake/media']);
      expect(res.body.data.batch_size).toBe(1000);
    });

    test('refuses a scan whose root overlaps a queued or running scan', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/media/Videos' });
      storageAgentService.findOverlappingScan.mockResolvedValue({ _id: 'scan-media', status: 'running' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/mnt/media/Videos'] });
      expect(res.status).toBe(409);
      expect(res.body.data.scan_id).toBe('scan-media');
      expect(storageAgentService.findOverlappingScan).toHaveBeenCalledWith(expect.any(Object), ['/mnt/media/Videos']);
      expect(Scanner).not.toHaveBeenCalled();
    });

    test.each([['abc'], [0], [-5], [1.5], [10001], [{}]])('rejects batch_size %p', async batchSize => {
      resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/datalake/media' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/mnt/datalake/media'], batch_size: batchSize });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/batch_size/);
      expect(Scanner).not.toHaveBeenCalled();
    });

    test.each([
      [{ extensions: 'mp4' }],
      [{ exclude_extensions: [1, 2] }],
      [{ extensions: [''] }],
      [{ extensions: Array.from({ length: 201 }, (_, index) => `e${index}`) }]
    ])('rejects malformed extension filters %#', async filters => {
      resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/datalake/media' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/mnt/datalake/media'], ...filters });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/extensions/);
      expect(Scanner).not.toHaveBeenCalled();
    });

    test('passes a validated batch size and extension lists to the scanner', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/datalake/media' });
      await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/mnt/datalake/media'], batch_size: '250', extensions: ['mp4'] })
        .expect(200);
      const run = Scanner.mock.results[0].value.run;
      expect(run).toHaveBeenCalledWith(expect.objectContaining({
        batchSize: 250, includeExt: ['mp4'], excludeExt: []
      }));
    });

    test('marks a crashed in-container scan failed so its roots are not blocked', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/datalake/media' });
      Scanner.mockImplementationOnce(() => ({
        on: jest.fn(), stop: jest.fn(), run: jest.fn().mockRejectedValue(new Error('disk gone'))
      }));
      const app = buildApp();
      await request(app).post('/api/v1/storage/scan').send({ roots: ['/mnt/datalake/media'] }).expect(200);
      await new Promise(resolve => setImmediate(resolve));
      expect(app.locals.db._collections.nas_scans.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ status: { $in: ['running', 'hashing'] } }),
        { $set: expect.objectContaining({ status: 'failed', last_error: 'disk gone' }) }
      );
    });
  });

  describe('cleanupStaleScans', () => {
    test('stops in-container scans in any phase and expires silent external scans', async () => {
      const app = buildApp();
      storageAgentService.expireStaleScans.mockResolvedValueOnce({ running: 1, queued: 0 });
      await require('../../controllers/storageController').cleanupStaleScans(app.locals.db);
      expect(app.locals.db._collections.nas_scans.updateMany).toHaveBeenCalledWith(
        { status: { $in: ['running', 'hashing'] }, 'config.external': { $ne: true } },
        { $set: expect.objectContaining({ status: 'stopped' }) }
      );
      expect(storageAgentService.expireStaleScans).toHaveBeenCalledWith(app.locals.db);
    });
  });

  // ── GET /scans ──

  describe('GET /api/v1/storage/scans', () => {
    test('returns scan list with pagination', async () => {
      const scans = [{ _id: 'scan1', status: 'complete', started_at: new Date(), finished_at: new Date() }];
      const res = await request(buildApp({ scans, count: 1 }))
        .get('/api/v1/storage/scans')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.scans).toHaveLength(1);
      expect(res.body.data.pagination).toBeDefined();
      expect(res.body.data.pagination.page).toBe(1);
    });

    test('respects limit and skip params', async () => {
      const app = buildApp();
      await request(app).get('/api/v1/storage/scans?limit=5&skip=10').expect(200);
      expect(app.locals.db.collection).toHaveBeenCalledWith('nas_scans');
    });

    test.each([
      ['page=abc&limit=xyz', 1, 10, 0],
      ['page=-3&limit=0', 1, 10, 0],
      ['page=3&limit=5000', 3, 100, 200],
      ['page=999999999&limit=10', 100000, 10, 999990]
    ])('defaults and bounds paging for %s', async (query, page, limit, skip) => {
      const app = buildApp();
      const col = app.locals.db.collection('nas_scans');
      const limitFn = jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) }));
      const skipFn = jest.fn(() => ({ limit: limitFn }));
      col.find = jest.fn(() => ({ sort: jest.fn(() => ({ skip: skipFn })) }));
      const res = await request(app).get(`/api/v1/storage/scans?${query}`).expect(200);
      expect(skipFn).toHaveBeenCalledWith(skip);
      expect(limitFn).toHaveBeenCalledWith(limit);
      expect(res.body.data.pagination).toMatchObject({ page, limit });
    });

    test('expires silent external scans before listing', async () => {
      await request(buildApp()).get('/api/v1/storage/scans').expect(200);
      expect(storageAgentService.expireStaleScans).toHaveBeenCalled();
    });
  });

  // ── GET /status/:scan_id ──

  describe('GET /api/v1/storage/status/:scan_id', () => {
    test('returns 404 for unknown scan', async () => {
      const res = await request(buildApp({ scanDoc: null }))
        .get('/api/v1/storage/status/unknown123')
        .expect(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    test('returns scan status', async () => {
      const scanDoc = { _id: 'abc', status: 'running', counts: { files_processed: 50 }, started_at: new Date() };
      const res = await request(buildApp({ scanDoc }))
        .get('/api/v1/storage/status/abc')
        .expect(200);
      expect(res.body.data.status).toBe('running');
      expect(res.body.data.counts.files_processed).toBe(50);
    });
  });

  // ── POST /stop/:scan_id ──

  describe('POST /api/v1/storage/stop/:scan_id', () => {
    test('returns 404 when scan is not running', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/stop/nonexistent')
        .expect(404);
      expect(res.body.message).toMatch(/not running/i);
    });
  });

  // ── GET /summary ──

  describe('GET /api/v1/storage/summary', () => {
    test('returns storage summary', async () => {
      const app = buildApp({
        aggregate: [{ totalFiles: 100, totalSize: 1048576, hashedFiles: 50 }]
      });
      const res = await request(app)
        .get('/api/v1/storage/summary')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('totalFiles');
      expect(res.body.data).toHaveProperty('duplicates');
      expect(res.body.data.duplicates.completeness).toBe('lower-bound');
      expect(res.body.data.evidenceLimitations).toMatchObject({
        verifiedDuplicatesAreLowerBound: true,
        candidateBytesAreNotSavings: true,
        progressiveLargeGroups: true
      });
      expect(res.body.data.scope).toMatchObject({
        mediaContainsDatalakePhysically: true,
        mediaIndexExcludesNestedDatalake: true,
        portfolioTotalsDoubleCountDatalake: false
      });
    });

    test('uses the latest hashing scan budget after a metadata-only refresh', async () => {
      const app = buildApp({
        aggregate: [{ totalFiles: 100, totalSize: 1048576, hashedFiles: 50 }]
      });
      const scans = app.locals.db.collection('nas_scans');
      scans.findOne
        .mockResolvedValueOnce({
          _id: 'metadata-scan', status: 'complete',
          config: { roots: ['/mnt/datalake'], hash_mode: 'none', hash_max_bytes: 50_000 }
        })
        .mockResolvedValueOnce({
          _id: 'hashing-scan', status: 'complete',
          config: {
            roots: ['/mnt/datalake'], hash_mode: 'candidates',
            hash_max_files: 500, hash_max_bytes: 10_000
          }
        });

      const res = await request(app)
        .get('/api/v1/storage/summary?root=%2Fmnt%2Fdatalake')
        .expect(200);

      expect(scans.findOne).toHaveBeenNthCalledWith(
        2,
        {
          'config.roots': '/mnt/datalake',
          'config.hash_mode': { $in: ['all', 'candidates'] },
          status: 'complete'
        },
        { sort: { started_at: -1 } }
      );
      expect(res.body.data.lastScan.hashing).toMatchObject({ mode: 'none', maxBytes: 50000 });
      expect(res.body.data.lastHashingScan).toMatchObject({
        id: 'hashing-scan',
        hashing: { mode: 'candidates', maxFiles: 500, maxBytes: 10000 }
      });
      expect(res.body.data.evidenceLimitations).toMatchObject({
        hashBudgetBytes: 10000,
        hashBudgetSourceScanId: 'hashing-scan'
      });
    });
  });

  // ── GET /directory-count ──

  describe('GET /api/v1/storage/directory-count', () => {
    test('returns count', async () => {
      const res = await request(buildApp({ count: 42 }))
        .get('/api/v1/storage/directory-count')
        .expect(200);
      expect(res.body.data.count).toBe(42);
    });
  });

  describe('Native storage agent routes', () => {
    test('lists registered agents and canonical sources', async () => {
      storageAgentService.listScanners.mockResolvedValue([{ scannerId: 'linux-node', active: true }]);
      const res = await request(buildApp()).get('/api/v1/storage/agents').expect(200);
      expect(res.body.data.active).toBe(1);
      expect(res.body.data.sources.media.canonicalRoot).toBe('/mnt/media');
    });

    test('queues an external read-only scan', async () => {
      storageAgentService.enqueueScan.mockResolvedValue({
        ok: true,
        scan: {
          _id: 'scan-media',
          config: { source: 'media', roots: ['/mnt/media'], hash_mode: 'candidates' }
        }
      });
      const res = await request(buildApp())
        .post('/api/v1/storage/agent-scans')
        .send({ source: 'media', hash_mode: 'candidates' })
        .expect(202);
      expect(res.body.data).toMatchObject({ scan_id: 'scan-media', root: '/mnt/media', coalesced: false });
    });

    test('joins the scan already active for the source instead of queueing a second one', async () => {
      storageAgentService.enqueueScan.mockResolvedValue({
        ok: true,
        coalesced: true,
        scan: {
          _id: 'scan-running', status: 'running',
          config: { source: 'media', roots: ['/mnt/media'], hash_mode: 'candidates' }
        }
      });
      const res = await request(buildApp())
        .post('/api/v1/storage/agent-scans')
        .send({ source: 'media' })
        .expect(202);
      expect(res.body.data).toMatchObject({ scan_id: 'scan-running', coalesced: true });
    });

    test('answers 409 when another kind of scan holds an overlapping root', async () => {
      storageAgentService.enqueueScan.mockResolvedValue({
        ok: false, conflict: true, error: 'scan scan-local is already running on an overlapping root'
      });
      const res = await request(buildApp())
        .post('/api/v1/storage/agent-scans')
        .send({ source: 'media' })
        .expect(409);
      expect(res.body.message).toMatch(/overlapping root/);
    });

    test('heartbeat refreshes the scan it names', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/agent/heartbeat')
        .send({ scannerId: 'linux-node-storage', sources: 'media', scanId: 'scan-live' })
        .expect(200);
      expect(storageAgentService.touchScanHeartbeat).toHaveBeenCalledWith(expect.any(Object), 'scan-live');
      expect(res.body.data.scan_refreshed).toBe(true);
    });

    test('heartbeat reports a scan that is no longer running', async () => {
      storageAgentService.touchScanHeartbeat.mockResolvedValue(false);
      const res = await request(buildApp())
        .post('/api/v1/storage/agent/heartbeat')
        .send({ scannerId: 'linux-node-storage', scanId: 'scan-reaped' })
        .expect(200);
      expect(res.body.data.scan_refreshed).toBe(false);
    });

    test('agent poll heartbeats and returns a claimed scan', async () => {
      storageAgentService.listMetadataProbePaths.mockResolvedValue([
        '/mnt/media/unclassified.bin'
      ]);
      storageAgentService.claimNextScan.mockResolvedValue({
        _id: 'scan-media',
        config: {
          source: 'media', roots: ['/mnt/media'], hash_mode: 'candidates',
          hash_max_files: 100, hash_max_bytes: 1000
        }
      });
      const res = await request(buildApp())
        .get('/api/v1/storage/agent/requests?scannerId=linux-node&sources=media')
        .expect(200);
      expect(res.body.data.scan.scan_id).toBe('scan-media');
      expect(res.body.data.scan.metadata_probe_paths).toEqual([
        '/mnt/media/unclassified.bin'
      ]);
      expect(storageAgentService.registerScanner).toHaveBeenCalled();
      expect(storageAgentService.listMetadataProbePaths).toHaveBeenCalledWith(
        expect.any(Object),
        '/mnt/media'
      );
    });

    test('agent poll does not query metadata candidates without a scan', async () => {
      storageAgentService.claimNextScan.mockResolvedValue(null);
      const res = await request(buildApp())
        .get('/api/v1/storage/agent/requests?scannerId=linux-node&sources=media')
        .expect(200);
      expect(res.body.data.scan).toBeNull();
      expect(storageAgentService.listMetadataProbePaths).not.toHaveBeenCalled();
    });

    test('dedicated LAN heartbeat never claims work', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/agent/heartbeat')
        .send({ scannerId: 'linux-node-storage', hostname: 'linux-node', platform: 'linux',
          agentVersion: 'storage-1.3.0', sources: 'media,datalake' })
        .expect(200);
      expect(res.body.data.scanner_id).toBe('scanner-1');
      expect(res.body.data.scan_refreshed).toBeUndefined();
      expect(storageAgentService.touchScanHeartbeat).not.toHaveBeenCalled();
      expect(storageAgentService.registerScanner).toHaveBeenCalledWith(
        expect.any(Object), expect.objectContaining({ scannerId: 'linux-node-storage',
          agentVersion: 'storage-1.3.0', sources: 'media,datalake' }));
      expect(storageAgentService.claimNextScan).not.toHaveBeenCalled();
    });

    test('production LAN heartbeat needs no credential configuration', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await request(buildApp()).post('/api/v1/storage/agent/heartbeat')
          .send({ scannerId: 'linux-node-storage', sources: 'media,datalake' }).expect(200);
        expect(storageAgentService.registerScanner).toHaveBeenCalled();
      } finally { process.env.NODE_ENV = previous; }
    });

    test('dedicated heartbeat requires scannerId', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/agent/heartbeat')
        .send({ sources: 'media,datalake' })
        .expect(400);

      expect(res.body.message).toMatch(/scannerId/);
      expect(storageAgentService.registerScanner).not.toHaveBeenCalled();
      expect(storageAgentService.claimNextScan).not.toHaveBeenCalled();
    });
  });

  // ── POST /scan/:scan_id/batch ──

  describe('POST /api/v1/storage/scan/:scan_id/batch', () => {
    const runningMediaScan = {
      _id: 'scan-media', status: 'running', config: { external: true, roots: ['/mnt/media'] }
    };

    test('returns 400 when files is missing', async () => {
      const res = await request(buildApp({ scanDoc: { _id: 'x' } }))
        .post('/api/v1/storage/scan/x/batch')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/files/i);
    });

    test('returns 404 for unknown scan', async () => {
      const res = await request(buildApp({ scanDoc: null }))
        .post('/api/v1/storage/scan/unknown/batch')
        .send({ files: [{ path: '/test/file.txt', size: 100 }] });
      expect(res.status).toBe(404);
    });

    test('inserts batch for valid scan', async () => {
      const app = buildApp({ scanDoc: { _id: 'scan1', status: 'running', config: { external: true, roots: ['/mnt/datalake'] } } });
      const res = await request(app)
        .post('/api/v1/storage/scan/scan1/batch')
        .send({
          files: [
            {
              path: '/mnt/datalake/LLMs/blobs/sha256-b2c12d46c1eec7e6536b759f1b6d5f98e254ade8a25c293f0fc01cce9489af69',
              size: 100,
              mtime: 1700000000
            },
            { path: '/mnt/datalake/file2.txt', size: 200, mtime: 1700000000 }
          ]
        });
      expect(res.status).toBe(200);
      expect(res.body.data.batch.received).toBe(2);
      const operations = app.locals.db._collections.nas_files.bulkWrite.mock.calls[0][0];
      expect(operations[0].updateOne.update.$set).toMatchObject({
        category: 'model',
        category_source: 'path-role',
        storage_role: 'llm_model_blob',
        extension_status: 'extensionless_by_design',
        timestamp_quality: 'valid'
      });
    });

    test('passes native-agent file size into semantic classification', async () => {
      const app = buildApp({ scanDoc: runningMediaScan });
      const res = await request(app)
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({
          files: [
            {
              path: '/mnt/media/Videos/Holiday/Family Holiday Example.bin',
              size: 2676326400,
              mtime: 1700000000
            },
            {
              path: '/mnt/media/Videos/Action-cam/GoPro/clip1/clip1',
              size: 130056192,
              mtime: 1700000000
            }
          ]
        });

      expect(res.status).toBe(200);
      const operations = app.locals.db._collections.nas_files.bulkWrite.mock.calls[0][0];
      expect(operations[0].updateOne.update.$set).toMatchObject({
        size: 2676326400,
        category: 'disk_image',
        storage_role: 'virtual_disk_image'
      });
      expect(operations[1].updateOne.update.$set).toMatchObject({
        size: 130056192,
        category: 'media',
        storage_role: 'media_asset',
        extension_status: 'missing_unresolved'
      });
    });

    test('persists allowlisted native content-signature evidence and provenance', async () => {
      const app = buildApp({ scanDoc: runningMediaScan });
      const res = await request(app)
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({
          files: [
            {
              path: '/mnt/media/images/Phones/saved-page',
              size: 317659,
              mtime: 1700000000,
              content_type: 'message/rfc822',
              content_probe_source: 'native-magic-v1'
            },
            {
              path: '/mnt/media/import/camera-clip',
              size: 130056192,
              mtime: 1700000000,
              content_type: 'video/mp2t',
              content_probe_source: 'native-magic-v1'
            }
          ]
        });

      expect(res.status).toBe(200);
      const operation = app.locals.db._collections.nas_files.bulkWrite.mock.calls[0][0][0];
      expect(operation.updateOne.update.$set).toMatchObject({
        category: 'document',
        category_source: 'content-signature',
        storage_role: 'document',
        extension_status: 'missing_unresolved',
        content_type: 'message/rfc822',
        content_type_source: 'content-signature',
        content_probe_source: 'native-magic-v1',
        content_probe_status: 'matched',
        content_probe_fingerprint: '317659:1700000000'
      });
      expect(operation.updateOne.update.$unset).toBeUndefined();

      const transportStream = app.locals.db._collections.nas_files.bulkWrite.mock.calls[0][0][1];
      expect(transportStream.updateOne.update.$set).toMatchObject({
        category: 'media',
        category_source: 'content-signature',
        storage_role: 'media_asset',
        extension_status: 'missing_unresolved',
        content_type: 'video/mp2t',
        content_type_source: 'content-signature',
        content_probe_source: 'native-magic-v1',
        content_probe_status: 'matched',
        content_probe_fingerprint: '130056192:1700000000'
      });
      expect(transportStream.updateOne.update.$unset).toBeUndefined();
    });

    test('does not classify or retain unsupported probe output', async () => {
      const app = buildApp({ scanDoc: runningMediaScan });
      await request(app)
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({
          files: [{
            path: '/mnt/media/opaque',
            size: 8,
            mtime: 1700000000,
            content_type: 'text/plain',
            content_probe_source: 'native-magic-v1'
          }]
        })
        .expect(200);

      const operation = app.locals.db._collections.nas_files.bulkWrite.mock.calls[0][0][0];
      expect(operation.updateOne.update.$set).toMatchObject({
        category: 'unclassified',
        category_source: 'unknown',
        content_probe_status: 'unmatched'
      });
      expect(operation.updateOne.update.$set.content_type).toBeUndefined();
      expect(operation.updateOne.update.$unset).toEqual({
        content_type: '',
        content_type_source: ''
      });
    });

    test('rejects file with empty path', async () => {
      const res = await request(buildApp({ scanDoc: runningMediaScan }))
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({ files: [{ path: '', size: 100 }] });
      expect(res.status).toBe(400);
    });

    test.each([
      ['an in-container scan', { _id: 'scan-media', status: 'running', config: { roots: ['/mnt/media'] } }],
      ['a queued scan', { ...runningMediaScan, status: 'queued' }],
      ['a finished scan', { ...runningMediaScan, status: 'failed' }]
    ])('refuses a batch for %s', async (_label, scanDoc) => {
      const app = buildApp({ scanDoc });
      const res = await request(app)
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({ files: [{ path: '/mnt/media/a.txt', size: 1, mtime: 1700000000 }] });
      expect(res.status).toBe(409);
      expect(app.locals.db._collections.nas_files).toBeUndefined();
    });

    test('drops and counts entries outside the scan roots', async () => {
      const app = buildApp({ scanDoc: runningMediaScan });
      const res = await request(app)
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({
          files: [
            { path: '/mnt/media/keep.txt', size: 1, mtime: 1700000000, source_root: '/mnt/other' },
            { path: '/mnt/media-old/sibling.txt', size: 1, mtime: 1700000000 },
            { path: '/mnt/datalake/other-root.txt', size: 1, mtime: 1700000000 },
            { path: '/mnt/media/../datalake/escape.txt', size: 1, mtime: 1700000000 },
            { path: '/mnt/media', size: 1, mtime: 1700000000 }
          ]
        })
        .expect(200);
      expect(res.body.data.batch).toMatchObject({ received: 5, accepted: 1, rejected: 4, hashes_rejected: 0 });
      const operations = app.locals.db._collections.nas_files.bulkWrite.mock.calls[0][0];
      expect(operations).toHaveLength(1);
      expect(operations[0].updateOne.update.$set).toMatchObject({
        path: '/mnt/media/keep.txt', source_root: '/mnt/media', relative_path: 'keep.txt'
      });
      const [, scanUpdate] = app.locals.db._collections.nas_scans.updateOne.mock.calls[0];
      expect(scanUpdate.$inc).toMatchObject({ 'counts.files_processed': 1, 'counts.rejected': 4 });
      expect(scanUpdate.$set.last_error).toMatch(/4 file\(s\) outside the scan roots/);
    });

    test('writes nothing when every entry is outside the scan roots', async () => {
      const app = buildApp({ scanDoc: runningMediaScan });
      const res = await request(app)
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({ files: [{ path: '/etc/passwd', size: 1 }] })
        .expect(200);
      expect(res.body.data.batch).toMatchObject({ accepted: 0, rejected: 1 });
      expect(app.locals.db._collections.nas_files.bulkWrite).not.toHaveBeenCalled();
    });

    test('keeps the row but drops and counts a malformed sha256', async () => {
      const app = buildApp({ scanDoc: runningMediaScan });
      const valid = 'AB'.repeat(32);
      const res = await request(app)
        .post('/api/v1/storage/scan/scan-media/batch')
        .send({
          files: [
            { path: '/mnt/media/good.bin', size: 5, mtime: 1700000000, sha256: valid },
            { path: '/mnt/media/short.bin', size: 5, mtime: 1700000000, sha256: 'abc123' },
            { path: '/mnt/media/object.bin', size: 5, mtime: 1700000000, sha256: { $ne: null } }
          ]
        })
        .expect(200);
      expect(res.body.data.batch).toMatchObject({ accepted: 3, rejected: 0, hashes_rejected: 2 });
      const operations = app.locals.db._collections.nas_files.bulkWrite.mock.calls[0][0];
      expect(operations[0].updateOne.update.$set.sha256).toBe(valid.toLowerCase());
      expect(operations[1].updateOne.update.$set.sha256).toBeUndefined();
      expect(operations[1].updateOne.update.$set.hash_fingerprint).toBeUndefined();
      expect(operations[2].updateOne.update.$set.sha256).toBeUndefined();
      const [, scanUpdate] = app.locals.db._collections.nas_scans.updateOne.mock.calls[0];
      expect(scanUpdate.$inc['counts.hashes_rejected']).toBe(2);
    });
  });

  // ── PATCH /scan/:scan_id ──

  describe('PATCH /api/v1/storage/scan/:scan_id', () => {
    test('updates scan status', async () => {
      const res = await request(buildApp({ scanDoc: { _id: 'scan1', config: {} } }))
        .patch('/api/v1/storage/scan/scan1')
        .send({ status: 'completed', stats: { total: 100 } });
      expect(res.status).toBe(200);
      expect(res.body.data.scan_id).toBe('scan1');
    });

    test('scopes external directory rollups to the completed root', async () => {
      const app = buildApp({ scanDoc: { _id: 'scan-external',
        config: { external: true, roots: ['/mnt/media'] } } });
      await request(app).patch('/api/v1/storage/scan/scan-external')
        .send({ status: 'completed', stats: { files_seen: 10 } }).expect(200);
      expect(rebuildDirectoryRollups).toHaveBeenCalledWith(
        expect.any(Object), expect.any(Object), ['/mnt/media']);
    });

    test('external completion prunes rows the scan did not see', async () => {
      const app = buildApp({ scanDoc: { _id: 'scan-external',
        config: { external: true, roots: ['/mnt/media'] } } });
      const files = app.locals.db.collection('nas_files');
      files.countDocuments.mockResolvedValue(1);
      files.deleteMany.mockResolvedValue({ deletedCount: 3 });
      const res = await request(app).patch('/api/v1/storage/scan/scan-external')
        .send({ status: 'completed', stats: { files_seen: 10 } }).expect(200);
      expect(files.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ scan_id: { $ne: 'scan-external' } }));
      expect(res.body.data.updated).toMatchObject({ status: 'complete', 'counts.stale_removed': 3 });
    });

    test('external completion keeps the index of a root where the scan indexed nothing', async () => {
      const app = buildApp({ scanDoc: { _id: 'scan-external',
        config: { external: true, roots: ['/mnt/media'] } } });
      const files = app.locals.db.collection('nas_files');
      // Nothing stamped by this scan, yet earlier rows exist: an empty mountpoint.
      files.countDocuments.mockImplementation(async filter => (filter.scan_id ? 0 : 1));
      const res = await request(app).patch('/api/v1/storage/scan/scan-external')
        .send({ status: 'completed', stats: { files_seen: 0 } }).expect(200);
      expect(files.deleteMany).not.toHaveBeenCalled();
      expect(res.body.data.updated).toMatchObject({ status: 'partial', 'counts.stale_removed': 0 });
      expect(res.body.data.updated.last_error).toMatch(/\/mnt\/media/);
    });

    test('repeated terminal update is idempotent after finalization', async () => {
      const finishedAt = new Date('2026-07-18T00:30:00.000Z');
      const app = buildApp({ scanDoc: { _id: 'scan-finalized', status: 'complete',
        finished_at: finishedAt, config: { external: true, roots: ['/mnt/datalake'] } } });
      const res = await request(app).patch('/api/v1/storage/scan/scan-finalized')
        .send({ status: 'completed', stats: { files_seen: 10 } }).expect(200);
      expect(res.body.data).toMatchObject({ scan_id: 'scan-finalized', already_finalized: true,
        updated: { status: 'complete', finished_at: finishedAt.toISOString() } });
      expect(rebuildDirectoryRollups).not.toHaveBeenCalled();
      expect(app.locals.db._collections.nas_files).toBeUndefined();
      expect(app.locals.db._collections.nas_scans.updateOne).not.toHaveBeenCalled();
    });



    test('production external completion preserves finalization without a token', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const app = buildApp({ scanDoc: { _id: 'scan-external', status: 'running',
        config: { external: true, roots: ['/mnt/media'] } } });
      try {
        await request(app).patch('/api/v1/storage/scan/scan-external')
          .send({ status: 'completed' }).expect(200);
        expect(rebuildDirectoryRollups).toHaveBeenCalled();
        expect(app.locals.db._collections.nas_scans.updateOne).toHaveBeenCalled();
      } finally { process.env.NODE_ENV = previous; }
    });

    test.each([
      [{ status: 'done' }, /status/],
      [{ status: 'queued' }, /status/],
      [{ status: { $ne: null } }, /status/],
      [{ status: 'completed', completedAt: 'not-a-date' }, /completedAt/],
      [{ status: 'completed', completedAt: { $date: 1 } }, /completedAt/],
      [{ status: 'completed', stats: 'many' }, /stats/],
      [{ status: 'completed', stats: { files_seen: -1 } }, /files_seen/],
      [{ status: 'completed', stats: { files_seen: '12' } }, /files_seen/],
      [{ status: 'completed', stats: { hashed: null } }, /hashed/]
    ])('rejects malformed update %#', async (body, message) => {
      const app = buildApp({ scanDoc: { _id: 'scan-external', status: 'running',
        config: { external: true, roots: ['/mnt/media'] } } });
      const res = await request(app).patch('/api/v1/storage/scan/scan-external').send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
      expect(app.locals.db._collections.nas_scans).toBeUndefined();
      expect(app.locals.db._collections.nas_files).toBeUndefined();
    });

    test('stores a valid completion date and allowlisted stats', async () => {
      const app = buildApp({ scanDoc: { _id: 'scan1', status: 'running', config: {} } });
      const res = await request(app).patch('/api/v1/storage/scan/scan1')
        .send({ status: 'partial', completedAt: '2026-07-18T00:30:00.000Z', stats: { files_seen: 4, unknown: 'x' } })
        .expect(200);
      expect(res.body.data.updated).toEqual({
        status: 'partial', finished_at: '2026-07-18T00:30:00.000Z', 'counts.files_seen': 4
      });
    });

    test('a late completion never reopens or prunes a scan already failed', async () => {
      const app = buildApp({ scanDoc: { _id: 'scan-reaped', status: 'failed',
        finished_at: new Date('2026-07-18T00:30:00.000Z'),
        config: { external: true, roots: ['/mnt/media'] } } });
      const res = await request(app).patch('/api/v1/storage/scan/scan-reaped')
        .send({ status: 'completed', stats: { files_seen: 10 } });
      expect(res.status).toBe(409);
      expect(app.locals.db._collections.nas_files).toBeUndefined();
      expect(rebuildDirectoryRollups).not.toHaveBeenCalled();
      expect(app.locals.db._collections.nas_scans.updateOne).not.toHaveBeenCalled();
    });

    test('returns 404 for unknown scan', async () => {
      const app = buildApp();
      // Override updateOne to return matchedCount: 0
      const col = app.locals.db.collection('nas_scans');
      col.updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 });
      const res = await request(app)
        .patch('/api/v1/storage/scan/unknown')
        .send({ status: 'completed' });
      expect(res.status).toBe(404);
    });
  });
});
