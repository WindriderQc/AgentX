/**
 * Route tests for export endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(),
  stat: jest.fn().mockResolvedValue({ size: 1024 }),
  unlink: jest.fn().mockResolvedValue()
}));

jest.mock('../../utils/file-operations', () => ({
  formatFileSize: jest.fn(n => `${n} B`),
  ensureDir: jest.fn().mockResolvedValue(),
  listFilesWithMeta: jest.fn().mockResolvedValue([
    { name: 'export_full_2026-01-01_00-00.json', size: 2048, modified: new Date() }
  ]),
  validateFilename: jest.fn(f => /^[a-zA-Z0-9._-]+$/.test(f)),
  exists: jest.fn().mockReturnValue(true)
}));

jest.mock('../../utils/fileHelpers', () => ({
  formatFilePath: jest.fn(f => f.path || `${f.dirname}/${f.filename}`)
}));

const exportRoutes = require('../../routes/exports.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const toArrayFn = jest.fn().mockResolvedValue(overrides.docs || []);
  const hasNextFn = jest.fn().mockResolvedValueOnce(false);
  const col = {
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({ toArray: toArrayFn })),
        toArray: toArrayFn
      })),
      toArray: toArrayFn,
      hasNext: hasNextFn,
      next: jest.fn()
    })),
    countDocuments: jest.fn().mockResolvedValue(overrides.count || 0),
    aggregate: jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue(overrides.aggregate || [])
    }))
  };

  app.locals.db = { collection: jest.fn(() => col), _col: col };
  app.use('/api/v1/exports', exportRoutes);
  app.use(errorHandler);
  return app;
}

describe('Export Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('POST /api/v1/exports/generate', () => {
    test.each([
      { type: 'media', format: '/../../review-probe.json' },
      { type: 'media', format: 'xml' },
      { type: 'media', format: '' },
      { type: 'media', format: null },
      { type: 'media', format: ['csv'] },
      { type: 'media', format: {} },
      { type: '../media', format: 'json' },
      { type: '', format: 'json' },
      { type: null, format: 'json' },
      { type: {}, format: 'json' },
      { type: 'full', format: 'csv' }
    ])('rejects unsupported input %j before database or file operations', async (payload) => {
      const app = buildApp();
      await request(app).post('/api/v1/exports/generate').send(payload).expect(400);
      expect(app.locals.db.collection).not.toHaveBeenCalled();
      expect(require('../../utils/file-operations').ensureDir).not.toHaveBeenCalled();
      expect(require('fs/promises').writeFile).not.toHaveBeenCalled();
      expect(require('fs/promises').stat).not.toHaveBeenCalled();
    });

    test('rejects query parameter path traversal before file operations', async () => {
      const app = buildApp();
      await request(app).post('/api/v1/exports/generate')
        .query({ type: 'media', format: '/../../review-probe.json' }).expect(400);
      expect(app.locals.db.collection).not.toHaveBeenCalled();
      expect(require('../../utils/file-operations').ensureDir).not.toHaveBeenCalled();
    });

    test('produces escaped CSV records and neutralizes spreadsheet formulas in text', async () => {
      const app = buildApp({ docs: [
        { path: '/safe/a', filename: 'a"b\nline,one.txt', ext: 'txt', size: -12 },
        { path: '/safe/b', filename: '=1+1', ext: 'txt', size: 2 },
        { path: '/safe/c', filename: '  @SUM(1)', ext: 'txt', size: 3 },
        { path: '/safe/d', filename: '\tcommand', ext: 'txt', size: 4 }
      ] });
      await request(app).post('/api/v1/exports/generate')
        .send({ type: 'media', format: 'csv' }).expect(200);
      const [target, content] = require('fs/promises').writeFile.mock.calls[0];
      expect(target).toMatch(/[/\\]exports[/\\]export_media_[^/\\]+\.csv$/);
      expect(content).toBe([
        'path,filename,ext,size,sizeFormatted',
        '/safe/a,"a""b\nline,one.txt",txt,-12,\'-12 B',
        "/safe/b,'=1+1,txt,2,2 B",
        "/safe/c,'  @SUM(1),txt,3,3 B",
        "/safe/d,'\tcommand,txt,4,4 B"
      ].join('\n'));
    });

    test('generates a summary report', async () => {
      const app = buildApp({ docs: [] });
      const res = await request(app)
        .post('/api/v1/exports/generate')
        .send({ type: 'summary', format: 'json' })
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.filename).toMatch(/export_summary/);
    });

    test('returns 400 for unknown report type', async () => {
      const res = await request(buildApp())
        .post('/api/v1/exports/generate')
        .send({ type: 'badtype' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unknown report type/);
    });
  });

  describe('GET /api/v1/exports', () => {
    test('lists export files', async () => {
      const res = await request(buildApp())
        .get('/api/v1/exports')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('DELETE /api/v1/exports/:filename', () => {
    test('deletes an export file', async () => {
      const res = await request(buildApp())
        .delete('/api/v1/exports/export_full_2026-01-01.json')
        .expect(200);
      expect(res.body.status).toBe('success');
    });

    test('returns 400 for invalid filename', async () => {
      const fileOps = require('../../utils/file-operations');
      fileOps.validateFilename.mockReturnValueOnce(false);
      const res = await request(buildApp())
        .delete('/api/v1/exports/bad%20file!.json');
      expect(res.status).toBe(400);
    });

    test('returns 404 for non-existent file', async () => {
      const fileOps = require('../../utils/file-operations');
      fileOps.validateFilename.mockReturnValueOnce(true);
      fileOps.exists.mockReturnValueOnce(false);
      const res = await request(buildApp())
        .delete('/api/v1/exports/missing-file.json');
      expect(res.status).toBe(404);
    });
  });
});
