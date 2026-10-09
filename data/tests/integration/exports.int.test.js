/**
 * Integration test (REAL MongoDB) for reports: generation as a job over real
 * collections, the list, the download, traversal attempts and the retention
 * bound. Reports are written to a temporary directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const exportController = require('../../controllers/exportController');
const store = require('../../services/exportStore');
const responseEnvelope = require('../../middleware/responseEnvelope');
const errorHandler = require('../../middleware/errorHandler');

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');
const TEST_DB = `${BASE_DB}_exports`;

describe('reports (integration, real Mongo)', () => {
  let client;
  let db;
  let app;
  let dir;
  const previousDir = process.env.DATA_EXPORT_DIR;

  async function generate(payload) {
    const res = await request(app).post('/api/v1/exports/generate').send(payload).expect(202);
    await exportController.jobs.settled();
    return res.body.data.filename;
  }
  const list = async () => (await request(app).get('/api/v1/exports').expect(200)).body.data;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-int-'));
    process.env.DATA_EXPORT_DIR = dir;
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);
    await db.collection('nas_files').insertMany(Array.from({ length: 250 }, (_, i) => ({
      path: `/mnt/media/Folder ${i % 5}/file-${String(i).padStart(3, '0')}.${i % 2 ? 'mkv' : 'txt'}`,
      dirname: `/mnt/media/Folder ${i % 5}`, filename: `file-${String(i).padStart(3, '0')}.${i % 2 ? 'mkv' : 'txt'}`,
      ext: i % 2 ? 'mkv' : 'txt', size: 1000 + i, mtime: 1700000000 + i, source_root: '/mnt/media'
    })));
    app = express();
    app.use(express.json());
    app.use(responseEnvelope);
    app.locals.db = db;
    app.use('/api/v1/exports', require('../../routes/exports.routes'));
    app.use(errorHandler);
  });

  afterAll(async () => {
    await exportController.jobs.settled();
    if (previousDir === undefined) delete process.env.DATA_EXPORT_DIR;
    else process.env.DATA_EXPORT_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  test('a full report is generated as a job, listed ready and downloaded intact', async () => {
    const filename = await generate({ type: 'full', format: 'json' });
    const listed = (await list()).reports.find(report => report.filename === filename);
    expect(listed).toMatchObject({ type: 'full', format: 'json', status: 'ready', recordCount: 250, skippedCount: 0, error: null });

    const download = await request(app).get(`/api/v1/exports/${filename}/download`).buffer(true).parse((res, done) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${filename}"`);
    expect(download.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(Number(download.headers['content-length'])).toBe(listed.size);
    expect(download.body.length).toBe(listed.size);
    const report = JSON.parse(download.body.toString('utf8'));
    expect(report).toMatchObject({ reportType: 'full', totalFiles: 250, skippedFiles: 0 });
    expect(report.files).toHaveLength(250);
    expect(report.files[0]).toMatchObject({ dirname: '/mnt/media/Folder 0', filename: 'file-000.txt', size: 1000 });
  });

  test('media as CSV and stats as JSON are generated from the same index', async () => {
    const csv = await generate({ type: 'media', format: 'csv' });
    const text = (await request(app).get(`/api/v1/exports/${csv}/download`).expect(200)).text;
    expect(text.split('\n')).toHaveLength(126);
    expect(text.split('\n')[0]).toBe('path,filename,ext,size,sizeFormatted');
    const stats = await generate({ type: 'stats', format: 'json' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, stats), 'utf8')).overview.totalFiles).toBe(250);
  });

  test('nothing outside the reports the exporter created can be downloaded or deleted', async () => {
    fs.writeFileSync(path.join(dir, 'private.json'), '{"secret":true}');
    fs.writeFileSync(path.join(os.tmpdir(), `outside-${process.pid}.json`), '{"secret":true}');
    try {
      for (const name of ['private.json', '..%2Fprivate.json', `..%2F${`outside-${process.pid}.json`}`, '%2Fetc%2Fpasswd', '..', '.']) {
        const download = await request(app).get(`/api/v1/exports/${name}/download`);
        expect([name, download.status === 400 || download.status === 404]).toEqual([name, true]);
        expect(download.text || '').not.toContain('secret');
        const removal = await request(app).delete(`/api/v1/exports/${name}`);
        expect([name, removal.status === 400 || removal.status === 404]).toEqual([name, true]);
      }
      expect(fs.existsSync(path.join(dir, 'private.json'))).toBe(true);
      expect((await list()).reports.map(report => report.filename)).not.toContain('private.json');
    } finally {
      fs.rmSync(path.join(os.tmpdir(), `outside-${process.pid}.json`), { force: true });
    }
  });

  test('the store never holds more than its bound: the oldest report leaves when a new one arrives', async () => {
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name));
    const old = 'export_stats_2020-01-01_00-00-00_000000.json';
    fs.writeFileSync(path.join(dir, old), '{}');
    fs.utimesSync(path.join(dir, old), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    let newest;
    for (let i = 0; i < store.MAX_REPORTS; i++) newest = await generate({ type: 'stats', format: 'json' });

    const data = await list();
    expect(data.reports).toHaveLength(store.MAX_REPORTS);
    expect(data.reports.every(report => report.status === 'ready')).toBe(true);
    expect(data.reports.map(report => report.filename)).toContain(newest);
    expect(data.reports.map(report => report.filename)).not.toContain(old);
    expect(data.totalSize).toBeLessThanOrEqual(store.MAX_TOTAL_BYTES);
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.part'))).toEqual([]);
  });
});
