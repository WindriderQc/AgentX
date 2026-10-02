/**
 * Route tests for file browser endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../utils/file-operations', () => ({
  formatFileSize: jest.fn(n => `${n} B`)
}));

jest.mock('../../utils/fileHelpers', () => ({
  formatFilePath: jest.fn(f => f.path || `${f.dirname}/${f.filename}`)
}));

jest.mock('../../services/janitorService', () => ({
  resolveAllowedPath: jest.fn()
}));

jest.mock('../../services/scanner', () => ({
  Scanner: jest.fn()
}));

jest.mock('../../services/vaultInventoryService', () => ({
  buildVaultInventory: jest.fn().mockResolvedValue({
    readOnly: true,
    contentRead: false,
    pathsIncluded: false,
    filesystemMutationAllowed: false,
    totals: { files: 4, bytes: 1024 }
  })
}));

const storageRoutes = require('../../routes/storage.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const toArrayResult = jest.fn().mockResolvedValue(overrides.docs || []);
  const limitFn = jest.fn(() => ({ toArray: toArrayResult }));
  const skipFn = jest.fn(() => ({ limit: limitFn }));
  const sortFn = jest.fn(() => ({ skip: skipFn, limit: limitFn }));

  const makeCol = () => ({
    find: jest.fn(() => ({
      sort: sortFn,
      limit: limitFn,
      toArray: toArrayResult
    })),
    findOne: jest.fn().mockResolvedValue(overrides.doc || null),
    countDocuments: jest.fn().mockResolvedValue(overrides.count || 0),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    findOneAndUpdate: jest.fn().mockResolvedValue(overrides.doc || { _id: 'f1', path: '/test.txt' }),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'new1' }),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 1, insertedIds: { 0: 'new1' } }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    aggregate: jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue(overrides.aggregate || [{}])
    }))
  });

  const collections = {};
  app.locals.db = {
    collection: jest.fn((name) => {
      if (!collections[name]) collections[name] = makeCol();
      return collections[name];
    })
  };

  app.use('/api/v1/storage', storageRoutes);
  app.use(errorHandler);
  return app;
}

describe('File Browser Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── GET /files/browse ──

  describe('GET /api/v1/storage/files/vault-inventory', () => {
    test('returns aggregate read-only vault metadata', async () => {
      const response = await request(buildApp())
        .get('/api/v1/storage/files/vault-inventory')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'success',
        data: {
          readOnly: true,
          contentRead: false,
          pathsIncluded: false,
          filesystemMutationAllowed: false
        }
      });
    });
  });

  describe('GET /api/v1/storage/files/browse', () => {
    test('returns files with pagination', async () => {
      const docs = [
        { path: '/mnt/nas/photo.jpg', filename: 'photo.jpg', dirname: '/mnt/nas', size: 1024, mtime: Date.now() / 1000 }
      ];
      const app = buildApp({ docs, count: 1 });
      const res = await request(app)
        .get('/api/v1/storage/files/browse')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.files).toHaveLength(1);
      expect(res.body.data.pagination).toBeDefined();
      expect(res.body.data.pagination.total).toBe(1);
    });

    test('accepts search, ext, dirname filters', async () => {
      const app = buildApp({ docs: [], count: 0 });
      const res = await request(app)
        .get('/api/v1/storage/files/browse?search=test&ext=pdf&dirname=/mnt')
        .expect(200);
      expect(res.body.data.files).toHaveLength(0);
    });

    test('searches folder names only when requested and keeps root and hash filters', async () => {
      const app = buildApp();
      const query = { root: '/mnt/photos', category: 'media', search: 'Camping (Rivière)', hasHash: 'false' };
      await request(app).get('/api/v1/storage/files/browse').query(query).expect(200);
      const files = app.locals.db.collection('nas_files');
      const defaultFilter = files.countDocuments.mock.calls[0][0];
      expect(defaultFilter.filename).toEqual({ $regex: 'Camping \\(Rivière\\)', $options: 'i' });
      expect(defaultFilter.$and).toBeUndefined();

      await request(app).get('/api/v1/storage/files/browse')
        .query({ ...query, includeDirname: 'true' }).expect(200);
      const filter = files.countDocuments.mock.calls[1][0];
      expect(filter.path.$regex).toBe('^/mnt/photos(?:[\\/]|$)');
      expect(filter.category).toBe('media');
      expect(filter.filename).toBeUndefined();
      expect(filter.$and).toEqual([{ $or: [
        { filename: { $regex: 'Camping \\(Rivière\\)', $options: 'i' } },
        { dirname: { $regex: 'Camping \\(Rivière\\)', $options: 'i' } }
      ] }]);
      expect(filter.$or).toEqual([{ sha256: { $exists: false } }, { sha256: null }]);
    });

    test('scopes root and accepts metadata drill-down filters', async () => {
      const app = buildApp({ docs: [], count: 0 });
      await request(app)
        .get('/api/v1/storage/files/browse')
        .query({
          root: '/mnt/datalake',
          category: 'unclassified',
          storageRole: 'general',
          extensionStatus: 'missing_unresolved',
          timestampQuality: 'legacy_or_suspect',
          topLevel: 'CloudBackup'
        })
        .expect(200);

      const files = app.locals.db.collection('nas_files');
      const filter = files.countDocuments.mock.calls[0][0];
      expect(filter).toMatchObject({
        category: 'unclassified',
        storage_role: 'general',
        extension_status: 'missing_unresolved',
        timestamp_quality: 'legacy_or_suspect',
        top_level: 'CloudBackup'
      });
      expect(filter.path.$regex).toBe('^/mnt/datalake(?:[\\/]|$)');
    });

    test('rejects unknown categories instead of silently returning all files', async () => {
      const res = await request(buildApp())
        .get('/api/v1/storage/files/browse?category=not-a-category')
        .expect(400);
      expect(res.body.message).toMatch(/unknown file category/i);
    });

    test('accepts page and limit params', async () => {
      const res = await request(buildApp())
        .get('/api/v1/storage/files/browse?page=2&limit=50')
        .expect(200);
      expect(res.body.data.pagination.page).toBe(2);
      expect(res.body.data.pagination.limit).toBe(50);
    });
  });

  // ── GET /files/tree ──

  describe('GET /api/v1/storage/files/tree', () => {
    test('returns directory tree', async () => {
      const docs = [
        { path: '/mnt/nas', file_count: 10, total_size: 5000, largest_file: 'big.zip' }
      ];
      const app = buildApp({ docs });
      const res = await request(app)
        .get('/api/v1/storage/files/tree')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.tree).toBeDefined();
    });

    test('respects root query param', async () => {
      const res = await request(buildApp())
        .get('/api/v1/storage/files/tree?root=/mnt/nas/photos')
        .expect(200);
      expect(res.body.data.tree).toBeDefined();
    });
  });

  // ── GET /files/stats ──

  describe('GET /api/v1/storage/files/stats', () => {
    test('returns file stats', async () => {
      const aggregate = [{
        byExtension: [{ _id: 'jpg', count: 50, size: 10240 }],
        byCategory: [{ _id: 'media', count: 50, size: 10240 }],
        byStorageRole: [{ _id: 'media_asset', count: 50, size: 10240 }],
        byExtensionStatus: [{ _id: 'present', count: 50, size: 10240 }],
        byTimestampQuality: [{ _id: 'valid', count: 50, size: 10240 }],
        byTopLevel: [{ _id: 'Movies', count: 50, size: 10240 }],
        bySize: [],
        total: [{
          count: 100, totalSize: 50000, avgSize: 500,
          extensionlessByDesign: 10, missingExtensionUnresolved: 2,
          legacyOrSuspectTimestamp: 3, futureSuspectTimestamp: 1
        }]
      }];
      const res = await request(buildApp({ aggregate }))
        .get('/api/v1/storage/files/stats')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.total).toBeDefined();
      expect(res.body.data.byExtension).toBeDefined();
      expect(res.body.data.byStorageRole[0]).toMatchObject({ role: 'media_asset', count: 50 });
      expect(res.body.data.byExtensionStatus[0]).toMatchObject({ status: 'present' });
      expect(res.body.data.byTimestampQuality[0]).toMatchObject({ quality: 'valid' });
      expect(res.body.data.byTopLevel[0]).toMatchObject({ name: 'Movies' });
      expect(res.body.data.sizeCategories).toBeDefined();
    });

    test('applies root and metadata filters before aggregating stats', async () => {
      const app = buildApp({ aggregate: [{}] });
      await request(app)
        .get('/api/v1/storage/files/stats')
        .query({
          root: '/mnt/datalake',
          category: 'unclassified',
          extensionStatus: 'missing_unresolved'
        })
        .expect(200);

      const files = app.locals.db.collection('nas_files');
      const pipeline = files.aggregate.mock.calls[0][0];
      expect(pipeline[0].$match).toMatchObject({
        category: 'unclassified',
        extension_status: 'missing_unresolved'
      });
      expect(pipeline[0].$match.path.$regex).toBe('^/mnt/datalake(?:[\\/]|$)');
    });
  });

  // ── GET /files/duplicates ──

  describe('GET /api/v1/storage/files/duplicates', () => {
    test('returns unverified candidates when no current hashes exist', async () => {
      const app = buildApp({ count: 0, aggregate: [] });
      const res = await request(app)
        .get('/api/v1/storage/files/duplicates')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.method).toBe('same-name-size-candidates');
      expect(res.body.data.verified).toBe(false);
      expect(res.body.data.duplicates).toBeDefined();
    });

    test('respects limit param', async () => {
      const res = await request(buildApp({ count: 0, aggregate: [] }))
        .get('/api/v1/storage/files/duplicates?limit=5')
        .expect(200);
      expect(res.body.data.duplicates).toBeDefined();
    });

    test('forces hash method with method=hash', async () => {
      const res = await request(buildApp({ count: 100, aggregate: [] }))
        .get('/api/v1/storage/files/duplicates?method=hash')
        .expect(200);
      expect(res.body.data.method).toBe('sha256');
    });
  });

  // ── GET /files/cleanup-recommendations ──

  describe('GET /api/v1/storage/files/cleanup-recommendations', () => {
    test('returns recommendations', async () => {
      const res = await request(buildApp({ docs: [], aggregate: [] }))
        .get('/api/v1/storage/files/cleanup-recommendations')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.recommendations).toHaveLength(6);
      expect(res.body.data.recommendations.map(r => r.type))
        .toEqual([
          'large_files_review', 'old_files_review', 'verified_duplicates',
          'duplicate_candidates', 'zero_byte_files', 'root_clutter'
        ]);
    });
  });

  // ── PATCH /files/:id ──

  describe('PATCH /api/v1/storage/files/:id', () => {
    test('updates file metadata', async () => {
      const res = await request(buildApp({ doc: { _id: 'f1', path: '/test.txt' } }))
        .patch('/api/v1/storage/files/507f1f77bcf86cd799439011')
        .send({ tags: ['backup'] });
      expect(res.status).toBe(200);
    });
  });

  describe('retired Datalake Janitor routes', () => {
    test.each([
      ['post', '/api/v1/storage/janitor/suggest-deletions'],
      ['post', '/api/v1/storage/janitor/mark-for-deletion'],
      ['get', '/api/v1/storage/janitor/pending-deletions'],
      ['delete', '/api/v1/storage/janitor/confirm-deletion/507f1f77bcf86cd799439011']
    ])('%s %s is not exposed', async (method, route) => {
      await request(buildApp())[method](route)
        .send({ confirm: true, strategy: 'keep_oldest', files: [{ path: '/a.txt' }] })
        .expect(404);
    });
  });
});

const fileBrowserController = require('../../controllers/fileBrowserController');

describe('browseFiles category filter', () => {
  test('?category=document filters the persisted category field', async () => {
    let captured;
    const app = express();
    app.use(express.json());
    app.locals.db = {
      collection: jest.fn(() => ({
        find: jest.fn((filter) => {
          captured = filter;
          return { sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [] }) }) }) };
        }),
        countDocuments: jest.fn(async () => 0)
      }))
    };
    app.get('/files/browse', fileBrowserController.browseFiles);

    const res = await request(app).get('/files/browse?category=document');
    expect(res.status).toBe(200);
    expect(captured.category).toBe('document');
  });

  test('unknown category is rejected instead of widening the query', async () => {
    const app = express();
    app.use(express.json());
    app.locals.db = {
      collection: jest.fn(() => ({
        find: jest.fn(() => ({
          sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [] }) }) })
        })),
        countDocuments: jest.fn(async () => 0)
      }))
    };
    app.get('/files/browse', fileBrowserController.browseFiles);

    const res = await request(app).get('/files/browse?category=nonsense');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown file category/i);
  });

  test('?ext=pdf takes precedence over category', async () => {
    let captured;
    const app = express();
    app.use(express.json());
    app.locals.db = {
      collection: jest.fn(() => ({
        find: jest.fn((filter) => {
          captured = filter;
          return { sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [] }) }) }) };
        }),
        countDocuments: jest.fn(async () => 0)
      }))
    };
    app.get('/files/browse', fileBrowserController.browseFiles);

    const res = await request(app).get('/files/browse?ext=pdf&category=media');
    expect(res.status).toBe(200);
    expect(captured.ext).toBe('pdf');
  });
});
