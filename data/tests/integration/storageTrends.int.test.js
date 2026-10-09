/**
 * Integration test (REAL MongoDB) for storage growth trends: the snapshot a
 * complete scan writes from the directory rollups, same-day replacement,
 * scans that must not write one, the indexes and the bounded trends read.
 * Uses the launcher's disposable MongoDB.
 */
const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { ensureIndexes } = require('../../utils/indexes');
const storageTrends = require('../../services/storageTrends');
const { scanEnded } = require('../../services/storageScanLifecycle');
const { rebuildDirectoryRollups } = require('../../services/scanner');
const responseEnvelope = require('../../middleware/responseEnvelope');
const errorHandler = require('../../middleware/errorHandler');

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');
const TEST_DB = `${BASE_DB}_trends`;
const ROOT = '/mnt/media';

describe('storage trends (integration, real Mongo)', () => {
  let client;
  let db;
  let app;
  let scanSeq = 0;

  const snapshots = () => db.collection('storage_trend_snapshots').find({}).sort({ root: 1, day: 1 }).toArray();
  const today = () => new Date().toISOString().slice(0, 10);

  async function runningScan(root = ROOT, source = 'media') {
    const id = `scan-${++scanSeq}`;
    await db.collection('nas_scans').insertOne({
      _id: id, type: 'external-storage-agent', status: 'running', started_at: new Date(), last_heartbeat_at: new Date(),
      counts: {}, config: { external: true, source, roots: [root] }
    });
    return id;
  }

  async function completeScan(files, { root = ROOT, source = 'media', status = 'completed' } = {}) {
    const id = await runningScan(root, source);
    if (files.length) {
      await request(app).post(`/api/v1/storage/scan/${id}/batch`)
        .send({ files: files.map(([path, size]) => ({ path, size, mtime: 1700000000 })) }).expect(200);
    }
    const res = await request(app).patch(`/api/v1/storage/scan/${id}`)
      .send({ status, stats: { files_seen: files.length }, completedAt: new Date().toISOString() }).expect(200);
    return { id, updated: res.body.data.updated };
  }

  const LIBRARY = [
    ['/mnt/media/Movies/Action/a.mkv', 100],
    ['/mnt/media/Movies/Action/Extras/trailer.mkv', 10],
    ['/mnt/media/Movies/Drama/b.mkv', 200],
    ['/mnt/media/Movies/c.mkv', 50],
    ['/mnt/media/Music/d.flac', 30],
    ['/mnt/media/Série été/é.mkv', 7],
    ['/mnt/media/root.txt', 5]
  ];

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);
    await ensureIndexes(db);
    app = express();
    app.use(express.json());
    app.use(responseEnvelope);
    app.locals.db = db;
    app.use('/api/v1/storage', require('../../routes/storage.routes'));
    app.use(errorHandler);
  });

  afterAll(async () => {
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  beforeEach(async () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    for (const name of ['storage_trend_snapshots', 'nas_scans', 'nas_files', 'nas_directories', 'appevents', 'activity_state']) {
      await db.collection(name).deleteMany({});
    }
  });

  test('indexes: one snapshot per root and day, kept 800 days', async () => {
    const indexes = await db.collection('storage_trend_snapshots').indexes();
    expect(indexes.find(index => index.name === 'root_day_unique')).toMatchObject({ key: { root: 1, day: 1 }, unique: true });
    expect(indexes.find(index => index.name === 'ttl_800d')).toMatchObject({ key: { at: 1 }, expireAfterSeconds: 800 * 86400 });
    await db.collection('storage_trend_snapshots').insertOne({ root: ROOT, day: '2026-01-01', at: new Date() });
    await expect(db.collection('storage_trend_snapshots').insertOne({ root: ROOT, day: '2026-01-01', at: new Date() }))
      .rejects.toMatchObject({ code: 11000 });
  });

  test('a complete scan writes one snapshot of its root from the rollups', async () => {
    // Another root's rows and rollups must not be counted in this one.
    await db.collection('nas_files').insertOne({ path: '/mnt/media-archive/x.bin', dirname: '/mnt/media-archive', source_root: '/mnt/media-archive', size: 999 });
    await db.collection('nas_directories').insertOne({ path: '/mnt/media-archive', file_count: 1, total_size: 999 });
    const { id } = await completeScan(LIBRARY);

    const stored = await snapshots();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      root: ROOT, day: today(), scan_id: id, source: 'media', files: 7, bytes: 402, top_level_folders: 3, second_level: true
    });
    expect(stored[0].at).toBeInstanceOf(Date);
    expect(stored[0].folders).toEqual([
      { key: 'Movies', name: 'Movies', parent: null, depth: 1, kind: 'folder', files: 4, bytes: 360 },
      { key: 'Music', name: 'Music', parent: null, depth: 1, kind: 'folder', files: 1, bytes: 30 },
      { key: 'Série été', name: 'Série été', parent: null, depth: 1, kind: 'folder', files: 1, bytes: 7 },
      { key: '/files', name: null, parent: null, depth: 1, kind: 'files', files: 1, bytes: 5 },
      // Extras is counted inside Action: the second level is the last one stored.
      { key: 'Movies/Drama', name: 'Drama', parent: 'Movies', depth: 2, kind: 'folder', files: 1, bytes: 200 },
      { key: 'Movies/Action', name: 'Action', parent: 'Movies', depth: 2, kind: 'folder', files: 2, bytes: 110 },
      { key: 'Movies//files', name: null, parent: 'Movies', depth: 2, kind: 'files', files: 1, bytes: 50 }
    ]);
    // The snapshot agrees with the index it was taken from.
    const indexed = await db.collection('nas_files').aggregate([
      { $match: { source_root: ROOT } }, { $group: { _id: null, files: { $sum: 1 }, bytes: { $sum: '$size' } } }
    ]).toArray();
    expect(indexed[0]).toMatchObject({ files: stored[0].files, bytes: stored[0].bytes });
  });

  test('a second complete scan the same day replaces the snapshot', async () => {
    await completeScan(LIBRARY);
    const second = await completeScan([...LIBRARY.slice(1), ['/mnt/media/Music/new.flac', 1000]]);
    const stored = await snapshots();
    expect(stored).toHaveLength(1);
    // a.mkv was not seen by the second scan and was pruned from the index.
    expect(stored[0]).toMatchObject({ scan_id: second.id, files: 7, bytes: 1302 });
    expect(stored[0].folders.find(folder => folder.key === 'Music')).toMatchObject({ files: 2, bytes: 1030 });
    expect(stored[0].folders.find(folder => folder.key === 'Movies/Action')).toMatchObject({ files: 1, bytes: 10 });
  });

  test('a scan that kept a stale index, a partial, a failed or a stopped scan writes nothing', async () => {
    const first = await completeScan(LIBRARY);
    // The mount is empty: the scan indexes nothing, the prune guard keeps the rows.
    const guarded = await completeScan([]);
    expect(guarded.updated).toMatchObject({ status: 'partial', last_error: expect.stringMatching(/existing index rows were kept/) });
    await completeScan(LIBRARY.slice(0, 2), { status: 'partial' });
    await completeScan(LIBRARY.slice(0, 1), { status: 'failed' });
    await completeScan(LIBRARY.slice(0, 1), { status: 'stopped' });

    const stored = await snapshots();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ scan_id: first.id, files: 7, bytes: 402 });
  });

  test('an in-container scan writes a snapshot only when it saw every file and rebuilt the rollups', async () => {
    await db.collection('nas_files').insertMany(LIBRARY.map(([path, size]) => ({
      path, dirname: path.slice(0, path.lastIndexOf('/')), source_root: ROOT, size, scan_id: 'local'
    })));
    await rebuildDirectoryRollups(db.collection('nas_files'), db.collection('nas_directories'), [ROOT]);
    const scan = { _id: 'local', status: 'complete', config: { roots: [ROOT] }, counts: { files_seen: 7 }, started_at: new Date(), finished_at: new Date() };

    expect(await scanEnded(db, scan, { rollupsRebuilt: true, filtered: true })).toEqual([]);
    expect(await scanEnded(db, scan, { rollupsRebuilt: false, filtered: false })).toEqual([]);
    expect(await scanEnded(db, { ...scan, status: 'partial' })).toEqual([]);
    expect(await scanEnded(db, { ...scan, status: 'stopped' })).toEqual([]);
    expect(await snapshots()).toEqual([]);

    const written = await scanEnded(db, scan, { rollupsRebuilt: true, filtered: false });
    expect(written).toHaveLength(1);
    expect((await snapshots())[0]).toMatchObject({ root: ROOT, scan_id: 'local', source: null, files: 7, bytes: 402 });
    // Every end was logged, whatever became of the snapshot.
    expect(await db.collection('appevents').countDocuments({ type: 'storage.scan_finished' })).toBe(5);
  });

  test('a snapshot that cannot be written does not fail the scan', async () => {
    const id = await runningScan();
    await request(app).post(`/api/v1/storage/scan/${id}/batch`).send({ files: [{ path: '/mnt/media/a.txt', size: 1, mtime: 1 }] }).expect(200);
    const spy = jest.spyOn(storageTrends, 'recordSnapshots').mockRejectedValueOnce(new Error('snapshot store down'));
    try {
      await request(app).patch(`/api/v1/storage/scan/${id}`).send({ status: 'completed' }).expect(200);
    } finally { spy.mockRestore(); }
    expect((await db.collection('nas_scans').findOne({ _id: id })).status).toBe('complete');
    expect(await snapshots()).toEqual([]);
  });

  describe('GET /storage/trends', () => {
    const get = (query) => request(app).get('/api/v1/storage/trends').query(query);
    const group = (top, second, files, bytes) => ({ _id: { top, second }, files, bytes });

    async function seed(root, day, groups) {
      const built = storageTrends.buildFolders(groups);
      await db.collection('storage_trend_snapshots').insertOne({
        root, day, at: new Date(`${day}T06:00:00.000Z`), scan_id: `seed-${day}`, source: 'media',
        files: built.files, bytes: built.bytes, top_level_folders: built.topLevelFolders, second_level: built.secondLevel, folders: built.folders
      });
    }

    beforeEach(async () => {
      await seed(ROOT, '2026-09-01', [group('Movies', 'Action', 10, 1000), group('Music', null, 5, 500), group(null, null, 1, 10)]);
      await seed(ROOT, '2026-09-15', [group('Movies', 'Action', 12, 1300), group('Music', null, 5, 500), group(null, null, 1, 10)]);
      await seed(ROOT, '2026-10-01', [group('Movies', 'Action', 12, 1300), group('Movies', 'Drama', 4, 900), group('Music', null, 4, 450),
        group('Photos', '2026', 30, 300), group(null, null, 1, 10)]);
      await seed('/mnt/datalake', '2026-10-01', [group('raw', null, 100, 9000)]);
    });

    test('without a root: the roots that have snapshots, and no series', async () => {
      const { data } = (await get({}).expect(200)).body;
      expect(data.roots).toEqual([
        { root: '/mnt/datalake', snapshots: 1, firstDay: '2026-10-01', lastDay: '2026-10-01', lastAt: '2026-10-01T06:00:00.000Z', files: 100, bytes: 9000 },
        { root: ROOT, snapshots: 3, firstDay: '2026-09-01', lastDay: '2026-10-01', lastAt: '2026-10-01T06:00:00.000Z', files: 51, bytes: 2960 }
      ]);
      expect(data).toMatchObject({ root: null, folder: null, snapshots: 0, totals: [], folders: [], growth: null, scanHistory: null });
      expect(data.limits).toMatchObject({ maxWindowDays: 800, retentionDays: 800, maxFolderSeries: 42, maxTopFolders: 40 });
    });

    test('the totals series, the folder series of the newest snapshot and the growth summary', async () => {
      const { data } = (await get({ root: `${ROOT}/`, from: '2026-09-01', to: '2026-10-08' }).expect(200)).body;
      expect(data).toMatchObject({ root: ROOT, folder: null, window: { from: '2026-09-01', to: '2026-10-08', days: 38 }, snapshots: 3 });
      expect(data.totals).toEqual([
        { day: '2026-09-01', at: '2026-09-01T06:00:00.000Z', scanId: 'seed-2026-09-01', files: 16, bytes: 1510 },
        { day: '2026-09-15', at: '2026-09-15T06:00:00.000Z', scanId: 'seed-2026-09-15', files: 18, bytes: 1810 },
        { day: '2026-10-01', at: '2026-10-01T06:00:00.000Z', scanId: 'seed-2026-10-01', files: 51, bytes: 2960 }
      ]);
      expect(data.folders.map(folder => [folder.key, folder.kind, folder.points.length])).toEqual([
        ['Movies', 'folder', 3], ['Music', 'folder', 3], ['Photos', 'folder', 1], ['/files', 'files', 3]
      ]);
      expect(data.folders[0]).toEqual({
        key: 'Movies', name: 'Movies', parent: null, depth: 1, kind: 'folder',
        points: [
          { day: '2026-09-01', files: 10, bytes: 1000 }, { day: '2026-09-15', files: 12, bytes: 1300 }, { day: '2026-10-01', files: 16, bytes: 2200 }
        ]
      });
      expect(data.growth).toEqual({
        from: { day: '2026-09-01', files: 16, bytes: 1510 }, to: { day: '2026-10-01', files: 51, bytes: 2960 },
        days: 30, filesAdded: 35, bytesAdded: 1450,
        folders: [
          { key: 'Movies', name: 'Movies', parent: null, depth: 1, kind: 'folder', fromBytes: 1000, toBytes: 2200, bytesAdded: 1200, filesAdded: 6 },
          { key: 'Photos', name: 'Photos', parent: null, depth: 1, kind: 'folder', fromBytes: 0, toBytes: 300, bytesAdded: 300, filesAdded: 30 }
        ]
      });
    });

    test('one folder: its series, its children and its own growth', async () => {
      const { data } = (await get({ root: ROOT, folder: 'Movies', from: '2026-09-01', to: '2026-10-08' }).expect(200)).body;
      expect(data.folder).toBe('Movies');
      expect(data.folders.map(folder => [folder.key, folder.points.map(item => item.bytes)])).toEqual([
        ['Movies', [1000, 1300, 2200]], ['Movies/Action', [1000, 1300, 1300]], ['Movies/Drama', [900]]
      ]);
      expect(data.growth).toMatchObject({ filesAdded: 6, bytesAdded: 1200 });
      expect(data.growth.folders.map(folder => [folder.key, folder.bytesAdded])).toEqual([['Movies/Drama', 900], ['Movies/Action', 300]]);

      const leaf = (await get({ root: ROOT, folder: 'Movies/Drama', from: '2026-09-01', to: '2026-10-08' }).expect(200)).body.data;
      expect(leaf.folders.map(folder => folder.key)).toEqual(['Movies/Drama']);
      const unknown = (await get({ root: ROOT, folder: 'Nope', from: '2026-09-01', to: '2026-10-08' }).expect(200)).body.data;
      expect(unknown.folders).toEqual([]);
      expect(unknown.totals).toHaveLength(3);
    });

    test('the window and the number of folder series are bounded', async () => {
      const narrow = (await get({ root: ROOT, from: '2026-09-10', to: '2026-09-20', limit: 1 }).expect(200)).body.data;
      expect(narrow.totals.map(item => item.day)).toEqual(['2026-09-15']);
      expect(narrow.folders.map(folder => folder.key)).toEqual(['Movies']);
      expect(narrow.growth).toBeNull();

      const empty = (await get({ root: '/mnt/unknown' }).expect(200)).body.data;
      expect(empty).toMatchObject({ root: '/mnt/unknown', snapshots: 0, totals: [], folders: [], growth: null });

      for (const query of [
        { root: 'relative' }, { root: ROOT, from: '2024-01-01', to: '2026-10-08' }, { root: ROOT, from: '2026-10-08', to: '2026-10-01' },
        { root: ROOT, from: 'x' }, { root: ROOT, limit: 500 }, { folder: 'Movies' }, { root: ROOT, folder: 'a'.repeat(601) },
        { 'root[$ne]': 'x' }, { root: ROOT, 'folder[$gt]': '' }
      ]) {
        const res = await get(query);
        expect([query, res.status]).toEqual([query, 400]);
        expect(res.body.status).toBe('error');
      }
    });

    test('scan history is offered apart from the totals: completed collector scans, files only', async () => {
      const scan = (id, day, status, filesSeen, extra = {}) => ({
        _id: id, status, finished_at: new Date(`${day}T05:00:00.000Z`), counts: { files_seen: filesSeen },
        config: { external: true, source: 'media', roots: [ROOT] }, ...extra
      });
      await db.collection('nas_scans').insertMany([
        scan('h1', '2026-08-30', 'complete', 14),
        scan('h2', '2026-09-01', 'complete', 15, { finished_at: new Date('2026-09-01T02:00:00.000Z') }),
        scan('h3', '2026-09-01', 'complete', 16),
        scan('h4', '2026-09-02', 'partial', 0),
        scan('h5', '2026-09-03', 'failed', 3),
        scan('h6', '2026-09-04', 'complete', 99, { config: { external: true, source: 'datalake', roots: ['/mnt/datalake'] } }),
        scan('h7', '2026-09-05', 'complete', 17, { config: { roots: [ROOT] } }),
        { _id: 'h8', status: 'complete', finished_at: new Date('2026-09-06T05:00:00.000Z'), counts: {}, config: { external: true, roots: [ROOT] } }
      ]);
      const { data } = (await get({ root: ROOT, from: '2026-09-01', to: '2026-10-08' }).expect(200)).body;
      expect(data.scanHistory).toMatchObject({ measure: 'files_seen', comparableWithTotals: false });
      expect(data.scanHistory.points).toEqual([{ day: '2026-09-01', at: '2026-09-01T05:00:00.000Z', scanId: 'h3', files: 16 }]);
      expect(data.scanHistory.points[0]).not.toHaveProperty('bytes');
      // The totals series holds snapshots only.
      expect(data.totals.map(item => item.scanId)).toEqual(['seed-2026-09-01', 'seed-2026-09-15', 'seed-2026-10-01']);
    });
  });
});
