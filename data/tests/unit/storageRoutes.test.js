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
  listMetadataProbePaths: jest.fn().mockResolvedValue([])
}));

jest.mock('../../utils/file-operations', () => ({
  formatFileSize: jest.fn(n => `${n} B`)
}));

const storageRoutes = require('../../routes/storage.routes');
const { resolveAllowedPath } = require('../../services/janitorService');
const { rebuildDirectoryRollups } = require('../../services/scanner');
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
  beforeEach(() => jest.clearAllMocks());

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
      expect(res.body.data).toMatchObject({ scan_id: 'scan-media', root: '/mnt/media' });
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
      const app = buildApp({ scanDoc: { _id: 'scan1', config: { roots: ['/mnt/datalake'] } } });
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
      const app = buildApp({ scanDoc: { _id: 'scan-media', config: { roots: ['/mnt/media'] } } });
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
      const app = buildApp({ scanDoc: { _id: 'scan-media', config: { roots: ['/mnt/media'] } } });
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
      const app = buildApp({ scanDoc: { _id: 'scan-media', config: { roots: ['/mnt/media'] } } });
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
      const res = await request(buildApp({ scanDoc: { _id: 'scan1' } }))
        .post('/api/v1/storage/scan/scan1/batch')
        .send({ files: [{ path: '', size: 100 }] });
      expect(res.status).toBe(400);
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
