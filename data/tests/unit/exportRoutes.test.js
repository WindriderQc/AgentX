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

// Streamed reports write through createWriteStream; capture them in memory
// so tests never touch the real exports directory.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const { Writable } = jest.requireActual('stream');
  return {
    ...actual,
    createWriteStream: jest.fn(() => {
      const ws = new Writable({ write(chunk, encoding, cb) { ws.content += String(chunk); cb(); } });
      ws.content = '';
      process.nextTick(() => ws.emit('open'));
      return ws;
    })
  };
});

function lastStream() {
  const { createWriteStream } = require('fs');
  const index = createWriteStream.mock.calls.length - 1;
  return { target: createWriteStream.mock.calls[index][0], options: createWriteStream.mock.calls[index][1],
    content: createWriteStream.mock.results[index].value.content };
}

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

  const cursorOver = (docs) => {
    let index = 0;
    return {
      next: jest.fn(async () => (index < docs.length ? docs[index++] : null)),
      close: jest.fn().mockResolvedValue(),
      toArray: jest.fn().mockResolvedValue(docs)
    };
  };
  const col = {
    find: jest.fn(() => ({ sort: jest.fn(() => cursorOver(overrides.docs || [])) })),
    findOne: jest.fn().mockResolvedValue(overrides.hasDirectories ? { _id: 'dir' } : null),
    countDocuments: jest.fn().mockResolvedValue(overrides.count || 0),
    aggregate: jest.fn(() => cursorOver(overrides.aggregate || []))
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
      const { target, content } = lastStream();
      expect(require('fs/promises').writeFile).not.toHaveBeenCalled();
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

    test('gives same-type exports distinct names and creates files exclusively', async () => {
      const app = buildApp({ docs: [] });
      const first = await request(app).post('/api/v1/exports/generate')
        .send({ type: 'summary', format: 'json' }).expect(200);
      const second = await request(app).post('/api/v1/exports/generate')
        .send({ type: 'summary', format: 'json' }).expect(200);
      expect(first.body.data.filename).toMatch(/^export_summary_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.json$/);
      expect(second.body.data.filename).not.toBe(first.body.data.filename);
      expect(lastStream().options).toEqual({ flags: 'wx' });
      await request(app).post('/api/v1/exports/generate')
        .send({ type: 'stats', format: 'json' }).expect(200);
      expect(require('fs/promises').writeFile.mock.calls[0][2]).toEqual({ flag: 'wx' });
    });

    test('returns 409 instead of overwriting an existing export', async () => {
      const fsp = require('fs/promises');
      fsp.writeFile.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));
      const res = await request(buildApp({ docs: [] })).post('/api/v1/exports/generate')
        .send({ type: 'stats', format: 'json' });
      expect(res.status).toBe(409);
      expect(fsp.stat).not.toHaveBeenCalled();
    });

    test.each([
      ['media', 'totalMediaFiles'],
      ['large', 'totalLargeFiles']
    ])('streams the %s report row by row instead of loading it', async (type, totalKey) => {
      const docs = [
        { path: '/safe/a.mp4', filename: 'a.mp4', ext: 'mp4', size: 300 },
        { path: '/safe/b.mp4', filename: 'b.mp4', ext: 'mp4', size: 200 }
      ];
      const app = buildApp({ docs });
      const res = await request(app).post('/api/v1/exports/generate')
        .send({ type, format: 'json' }).expect(200);
      const report = JSON.parse(lastStream().content);
      expect(report.files.map(f => f.filename)).toEqual(['a.mp4', 'b.mp4']);
      expect(report[totalKey]).toBe(2);
      expect(report.skippedFiles).toBe(0);
      expect(res.body.data).toMatchObject({ recordCount: 2, skippedCount: 0 });
      const cursor = app.locals.db._col.find.mock.results[0].value.sort.mock.results[0].value;
      expect(cursor.toArray).not.toHaveBeenCalled();
      expect(cursor.close).toHaveBeenCalled();
    });

    test('streams the summary from directories, or aggregates files when none exist', async () => {
      const dirs = [
        { path: '/safe/big', file_count: 3, total_size: 30 },
        { path: '/safe/small', file_count: 1, total_size: 5 }
      ];
      const fromDirs = buildApp({ docs: dirs, hasDirectories: true });
      const res = await request(fromDirs).post('/api/v1/exports/generate')
        .send({ type: 'summary', format: 'json' }).expect(200);
      expect(JSON.parse(lastStream().content)).toMatchObject({
        reportType: 'summary', totalDirectories: 2, totalFiles: 4, totalSize: 35,
        directories: [
          { directory: '/safe/big', fileCount: 3, totalSize: 30, totalSizeFormatted: '30 B' },
          { directory: '/safe/small', fileCount: 1, totalSize: 5, totalSizeFormatted: '5 B' }
        ]
      });
      expect(res.body.data.recordCount).toBe(4);
      expect(fromDirs.locals.db._col.aggregate).not.toHaveBeenCalled();

      const fromFiles = buildApp({ aggregate: dirs });
      await request(fromFiles).post('/api/v1/exports/generate')
        .send({ type: 'summary', format: 'csv' }).expect(200);
      expect(lastStream().content).toBe([
        'directory,fileCount,totalSize,totalSizeFormatted',
        '/safe/big,3,30,30 B',
        '/safe/small,1,5,5 B'
      ].join('\n'));
      expect(fromFiles.locals.db._col.aggregate.mock.calls[0][1]).toEqual({ allowDiskUse: true });
    });

    test('writes "No data" for an empty CSV report', async () => {
      await request(buildApp({ docs: [] })).post('/api/v1/exports/generate')
        .send({ type: 'media', format: 'csv' }).expect(200);
      expect(lastStream().content).toBe('No data\n');
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
