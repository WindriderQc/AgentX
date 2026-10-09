/**
 * Route tests for export endpoints, on a real temporary report directory and a
 * mocked database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../utils/fileHelpers', () => ({
  formatFilePath: jest.fn(f => f.path || `${f.dirname}/${f.filename}`)
}));

const exportRoutes = require('../../routes/exports.routes');
const exportController = require('../../controllers/exportController');
const store = require('../../services/exportStore');
const { createExportJobs } = require('../../services/exportJobs');
const errorHandler = require('../../middleware/errorHandler');

const NAME = /^export_[a-z]+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[0-9a-f]{6}\.(json|csv)$/;
let dir;
const previousDir = process.env.DATA_EXPORT_DIR;

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const cursorOver = (docs) => {
    let index = 0;
    return {
      next: jest.fn(async () => {
        if (overrides.failAfter !== undefined && index === overrides.failAfter) throw new Error('cursor lost');
        if (overrides.gate) await overrides.gate;
        return index < docs.length ? docs[index++] : null;
      }),
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

async function generate(app, payload) {
  const res = await request(app).post('/api/v1/exports/generate').send(payload).expect(202);
  await exportController.jobs.settled();
  return res.body.data;
}

function content(filename) {
  return fs.readFileSync(path.join(dir, filename), 'utf8');
}

async function list(app = buildApp()) {
  return (await request(app).get('/api/v1/exports').expect(200)).body.data;
}

function writeReport(name, bytes, mtime) {
  fs.writeFileSync(path.join(dir, name), 'x'.repeat(bytes));
  if (mtime) fs.utimesSync(path.join(dir, name), mtime, mtime);
}

describe('Export Routes', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-routes-'));
    process.env.DATA_EXPORT_DIR = dir;
  });
  afterEach(async () => {
    await exportController.jobs.settled();
    for (const job of exportController.jobs.list()) exportController.jobs.forget(job.filename);
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.DATA_EXPORT_DIR;
    else process.env.DATA_EXPORT_DIR = previousDir;
  });

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
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(exportController.jobs.list()).toEqual([]);
    });

    test('rejects query parameter path traversal before file operations', async () => {
      const app = buildApp();
      await request(app).post('/api/v1/exports/generate')
        .query({ type: 'media', format: '/../../review-probe.json' }).expect(400);
      expect(app.locals.db.collection).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('answers 202 at once and the list says when the report is ready', async () => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const app = buildApp({ gate, docs: [{ path: '/safe/a.mp4', filename: 'a.mp4', ext: 'mp4', size: 300 }] });
      const res = await request(app).post('/api/v1/exports/generate').send({ type: 'media', format: 'json' }).expect(202);
      expect(res.body.data).toMatchObject({
        type: 'media', format: 'json', status: 'running', size: null, createdAt: null, recordCount: null, error: null
      });
      expect(res.body.data.filename).toMatch(NAME);

      const running = await list(app);
      expect(running.reports).toHaveLength(1);
      expect(running.reports[0]).toMatchObject({ filename: res.body.data.filename, status: 'running' });
      // A running generation has no downloadable file and cannot be deleted.
      await request(app).get(`/api/v1/exports/${res.body.data.filename}/download`).expect(404);
      await request(app).delete(`/api/v1/exports/${res.body.data.filename}`).expect(409);

      release();
      await exportController.jobs.settled();
      const ready = await list(app);
      expect(ready.reports).toHaveLength(1);
      expect(ready.reports[0]).toMatchObject({
        filename: res.body.data.filename, type: 'media', format: 'json', status: 'ready', recordCount: 1, skippedCount: 0, error: null
      });
      expect(ready.reports[0].size).toBe(fs.statSync(path.join(dir, res.body.data.filename)).size);
      expect(new Date(ready.reports[0].createdAt).getTime()).toBeGreaterThan(0);
      expect(ready.totalSize).toBe(ready.reports[0].size);
      expect(ready.limits).toMatchObject({ maxReports: 20, maxTotalBytes: 1024 ** 3 });
    });

    test('refuses a third generation while two are running', async () => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const app = buildApp({ gate });
      await request(app).post('/api/v1/exports/generate').send({ type: 'media', format: 'json' }).expect(202);
      await request(app).post('/api/v1/exports/generate').send({ type: 'large', format: 'json' }).expect(202);
      const third = await request(app).post('/api/v1/exports/generate').send({ type: 'media', format: 'csv' });
      expect(third.status).toBe(429);
      release();
      await exportController.jobs.settled();
      expect((await list(app)).reports.map(report => report.status)).toEqual(['ready', 'ready']);
    });

    test('a failed generation leaves no file, partial or not, and is listed as failed', async () => {
      const app = buildApp({ failAfter: 1, docs: [
        { path: '/safe/a.mp4', filename: 'a.mp4', ext: 'mp4', size: 300 },
        { path: '/safe/b.mp4', filename: 'b.mp4', ext: 'mp4', size: 200 }
      ] });
      const job = await generate(app, { type: 'media', format: 'json' });
      expect(fs.readdirSync(dir)).toEqual([]);
      const listed = await list(app);
      expect(listed.reports).toEqual([expect.objectContaining({
        filename: job.filename, status: 'failed', error: 'cursor lost', size: null
      })]);
      await request(app).get(`/api/v1/exports/${job.filename}/download`).expect(404);
      // Deleting a failed generation clears it from the list.
      await request(app).delete(`/api/v1/exports/${job.filename}`).expect(200);
      expect((await list(app)).reports).toEqual([]);
    });

    test('two generations at once write two intact, separate reports', async () => {
      const docs = Array.from({ length: 50 }, (_, i) => ({ path: `/safe/${i}.mp4`, filename: `${i}.mp4`, ext: 'mp4', size: i }));
      const app = buildApp({ docs });
      const [first, second] = await Promise.all([
        request(app).post('/api/v1/exports/generate').send({ type: 'media', format: 'json' }).expect(202),
        request(app).post('/api/v1/exports/generate').send({ type: 'media', format: 'json' }).expect(202)
      ]);
      await exportController.jobs.settled();
      expect(first.body.data.filename).not.toBe(second.body.data.filename);
      for (const res of [first, second]) {
        const report = JSON.parse(content(res.body.data.filename));
        expect(report.files).toHaveLength(50);
        expect(report.totalMediaFiles).toBe(50);
      }
      expect(fs.readdirSync(dir).filter(name => name.endsWith('.part'))).toEqual([]);
    });

    test('produces escaped CSV records and neutralizes spreadsheet formulas in text', async () => {
      const app = buildApp({ docs: [
        { path: '/safe/a', filename: 'a"b\nline,one.txt', ext: 'txt', size: -12 },
        { path: '/safe/b', filename: '=1+1', ext: 'txt', size: 2 },
        { path: '/safe/c', filename: '  @SUM(1)', ext: 'txt', size: 3 },
        { path: '/safe/d', filename: '\tcommand', ext: 'txt', size: 4 }
      ] });
      const job = await generate(app, { type: 'media', format: 'csv' });
      expect(job.filename).toMatch(/^export_media_[^/\\]+\.csv$/);
      expect(content(job.filename)).toBe([
        'path,filename,ext,size,sizeFormatted',
        '/safe/a,"a""b\nline,one.txt",txt,-12,0 B',
        "/safe/b,'=1+1,txt,2,2 B",
        "/safe/c,'  @SUM(1),txt,3,3 B",
        "/safe/d,'\tcommand,txt,4,4 B"
      ].join('\n'));
    });

    test('generates a stats report without streaming', async () => {
      const app = buildApp({ count: 7, aggregate: [] });
      const job = await generate(app, { type: 'stats', format: 'json' });
      expect(JSON.parse(content(job.filename))).toMatchObject({ reportType: 'statistics', overview: { totalFiles: 7 } });
      expect((await list(app)).reports[0]).toMatchObject({ status: 'ready', recordCount: 7 });
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
      const job = await generate(app, { type, format: 'json' });
      const report = JSON.parse(content(job.filename));
      expect(report.files.map(f => f.filename)).toEqual(['a.mp4', 'b.mp4']);
      expect(report[totalKey]).toBe(2);
      expect(report.skippedFiles).toBe(0);
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
      const json = await generate(fromDirs, { type: 'summary', format: 'json' });
      expect(JSON.parse(content(json.filename))).toMatchObject({
        reportType: 'summary', totalDirectories: 2, totalFiles: 4, totalSize: 35,
        directories: [
          { directory: '/safe/big', fileCount: 3, totalSize: 30 },
          { directory: '/safe/small', fileCount: 1, totalSize: 5 }
        ]
      });
      expect((await list(fromDirs)).reports[0].recordCount).toBe(4);
      expect(fromDirs.locals.db._col.aggregate).not.toHaveBeenCalled();

      const fromFiles = buildApp({ aggregate: dirs });
      const csv = await generate(fromFiles, { type: 'summary', format: 'csv' });
      expect(content(csv.filename).split('\n')).toEqual([
        'directory,fileCount,totalSize,totalSizeFormatted',
        '/safe/big,3,30,30 B',
        '/safe/small,1,5,5 B'
      ]);
      expect(fromFiles.locals.db._col.aggregate.mock.calls[0][1]).toEqual({ allowDiskUse: true });
    });

    test('writes "No data" for an empty CSV report', async () => {
      const job = await generate(buildApp({ docs: [] }), { type: 'media', format: 'csv' });
      expect(content(job.filename)).toBe('No data\n');
    });

    test('returns 400 for unknown report type', async () => {
      const res = await request(buildApp())
        .post('/api/v1/exports/generate')
        .send({ type: 'badtype' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Unknown report type/);
    });
  });

  describe('retention', () => {
    test('the store keeps at most its count and total size, oldest removed first, never the new report', async () => {
      const names = Array.from({ length: 5 }, (_, i) => `export_media_2026-01-0${i + 1}_00-00-00_00000${i}.json`);
      names.forEach((name, i) => writeReport(name, 100, new Date(Date.UTC(2026, 0, i + 1))));
      writeReport('notes.txt', 100);

      expect(await store.pruneReports(names[4], { maxReports: 3, maxTotalBytes: 10_000 })).toEqual([names[0], names[1]]);
      expect(fs.readdirSync(dir).sort()).toEqual([names[2], names[3], names[4], 'notes.txt'].sort());

      // Size bound: 3 x 100 bytes against 150 leaves the newest only.
      expect(await store.pruneReports(names[4], { maxReports: 3, maxTotalBytes: 150 })).toEqual([names[2], names[3]]);
      // A report alone over the bound is kept: it is the one just generated.
      expect(await store.pruneReports(names[4], { maxReports: 3, maxTotalBytes: 10 })).toEqual([]);
      expect(fs.readdirSync(dir).sort()).toEqual([names[4], 'notes.txt'].sort());
    });

    test('a new report pushes the oldest out once the job ends', async () => {
      const old = ['export_large_2026-01-01_00-00-00_aaaaaa.json', 'export_large_2026-01-02_00-00-00_bbbbbb.json'];
      old.forEach((name, i) => writeReport(name, 10, new Date(Date.UTC(2026, 0, i + 1))));
      const jobs = createExportJobs({ limits: { maxReports: 2, maxTotalBytes: 10_000 } });
      const { job } = jobs.start('stats', 'json', async (partPath) => { fs.writeFileSync(partPath, '{}'); return { recordCount: 0 }; });
      await jobs.settled();
      expect(job).toMatchObject({ status: 'ready', size: 2, removed: [old[0]] });
      expect(fs.readdirSync(dir).sort()).toEqual([old[1], job.filename].sort());
    });

    test('a .part file left by a crash is removed by the next list, a running one is not', async () => {
      writeReport('export_full_2026-01-01_00-00-00_aaaaaa.json.part', 10);
      writeReport('unrelated.part', 10);
      expect((await list()).reports).toEqual([]);
      expect(fs.readdirSync(dir)).toEqual(['unrelated.part']);
    });
  });

  describe('GET /api/v1/exports', () => {
    test('lists only reports the exporter created, newest first, with size and creation time', async () => {
      writeReport('export_full_2026-01-01_00-00-00_aaaaaa.json', 2048, new Date('2026-01-01T00:00:00Z'));
      writeReport('export_stats_2026-02-01_00-00-00_bbbbbb.csv', 10, new Date('2026-02-01T00:00:00Z'));
      writeReport('passwd', 5);
      fs.mkdirSync(path.join(dir, 'export_full_2026-03-01_00-00-00_cccccc.json'));
      const data = await list();
      expect(data.reports).toEqual([
        expect.objectContaining({ filename: 'export_stats_2026-02-01_00-00-00_bbbbbb.csv', type: 'stats', format: 'csv',
          status: 'ready', size: 10, createdAt: '2026-02-01T00:00:00.000Z' }),
        expect.objectContaining({ filename: 'export_full_2026-01-01_00-00-00_aaaaaa.json', type: 'full', format: 'json',
          status: 'ready', size: 2048, createdAt: '2026-01-01T00:00:00.000Z' })
      ]);
      expect(data.reports[0]).not.toHaveProperty('path');
      expect(data.totalSize).toBe(2058);
    });

    test('an absent directory is an empty list', async () => {
      process.env.DATA_EXPORT_DIR = path.join(dir, 'missing');
      expect((await list()).reports).toEqual([]);
    });
  });

  describe('GET /api/v1/exports/:filename/download', () => {
    test('streams a report with its type and a safe attachment name', async () => {
      writeReport('export_summary_2026-01-01_00-00-00_aaaaaa.csv', 0);
      fs.writeFileSync(path.join(dir, 'export_summary_2026-01-01_00-00-00_aaaaaa.csv'), 'a,b\n1,2\n');
      const res = await request(buildApp()).get('/api/v1/exports/export_summary_2026-01-01_00-00-00_aaaaaa.csv/download').expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe('attachment; filename="export_summary_2026-01-01_00-00-00_aaaaaa.csv"');
      expect(res.headers['content-length']).toBe('8');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.text).toBe('a,b\n1,2\n');

      fs.writeFileSync(path.join(dir, 'export_full_2026-01-01_00-00-00_bbbbbb.json'), '{}');
      const json = await request(buildApp()).get('/api/v1/exports/export_full_2026-01-01_00-00-00_bbbbbb.json/download').expect(200);
      expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    });

    test.each([
      '..%2F..%2Fetc%2Fpasswd',
      '%2e%2e%2fexport_full_2026-01-01_00-00-00_aaaaaa.json',
      'export_full_2026-01-01_00-00-00_aaaaaa.json%00.txt',
      'export_full_2026-01-01_00-00-00_aaaaaa.json.part',
      'secret.json',
      'export_full_2026-01-01_00-00-00_aaaaaa.exe',
      'export_full_2026-01-01_00-00-00_AAAAAA.json',
      `export_full_2026-01-01_00-00-00_aaaaaa.json${'a'.repeat(200)}`
    ])('refuses %s', async (name) => {
      fs.writeFileSync(path.join(dir, 'secret.json'), 'secret');
      writeReport('export_full_2026-01-01_00-00-00_aaaaaa.json.part', 5);
      const res = await request(buildApp()).get(`/api/v1/exports/${name}/download`);
      expect(res.status).toBe(400);
      expect(res.text).not.toContain('secret');
    });

    test('a path with a real slash never reaches the handler', async () => {
      const res = await request(buildApp()).get('/api/v1/exports/../../etc/passwd/download');
      expect([400, 404]).toContain(res.status);
    });

    test('404 for a missing report, and a symbolic link is not followed', async () => {
      await request(buildApp()).get('/api/v1/exports/export_full_2026-01-01_00-00-00_aaaaaa.json/download').expect(404);
      const outside = path.join(os.tmpdir(), `export-outside-${process.pid}.txt`);
      fs.writeFileSync(outside, 'outside the store');
      try {
        fs.symlinkSync(outside, path.join(dir, 'export_full_2026-01-01_00-00-00_bbbbbb.json'));
        const res = await request(buildApp()).get('/api/v1/exports/export_full_2026-01-01_00-00-00_bbbbbb.json/download');
        expect(res.status).toBe(404);
        expect((await list()).reports).toEqual([]);
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });

  describe('DELETE /api/v1/exports/:filename', () => {
    test('deletes a report', async () => {
      writeReport('export_full_2026-01-01_00-00-00_aaaaaa.json', 5);
      const res = await request(buildApp()).delete('/api/v1/exports/export_full_2026-01-01_00-00-00_aaaaaa.json').expect(200);
      expect(res.body.status).toBe('success');
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    test.each(['bad%20file!.json', 'notes.txt', '..%2Fnotes.txt', 'export_full_2026-01-01_00-00-00_aaaaaa.json.part'])(
      'returns 400 for %s and deletes nothing', async (name) => {
        writeReport('notes.txt', 5);
        writeReport('export_full_2026-01-01_00-00-00_aaaaaa.json.part', 5);
        const res = await request(buildApp()).delete(`/api/v1/exports/${name}`);
        expect(res.status).toBe(400);
        expect(fs.readdirSync(dir)).toHaveLength(2);
      });

    test('returns 404 for non-existent file', async () => {
      const res = await request(buildApp()).delete('/api/v1/exports/export_full_2026-01-01_00-00-00_aaaaaa.json');
      expect(res.status).toBe(404);
    });
  });
});
