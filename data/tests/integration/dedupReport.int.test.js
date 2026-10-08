/**
 * Integration test (REAL MongoDB) for dedup report storage and grouping.
 *
 * A mocked collection cannot show MongoDB's 16 MB document limit or run the
 * grouping aggregation. This suite saves a report whose groups exceed that
 * limit, reads it back page by page, and groups real rows to show that
 * zero-byte files never form a duplicate group.
 *
 * The test launcher supplies its own disposable MongoDB and database name.
 */
jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { MongoClient } = require('mongodb');
const { ensureIndexes } = require('../../utils/indexes');
const dedupScanner = require('../../services/dedupScanner');

const URI = process.env.MONGODB_URI_TEST;
const TEST_DB = URI ? new URL(URI).pathname.slice(1) : '';

if (!URI || !TEST_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');

describe('dedup report (integration, real Mongo)', () => {
  let client;
  let db;

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);
    await ensureIndexes(db);
  });

  afterAll(async () => {
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  test('a report larger than one 16 MB document is saved and read back in pages', async () => {
    // 300 groups of about 70 kB each: about 21 MB of groups.
    const pad = 'p'.repeat(1000);
    const groups = Array.from({ length: 300 }, (_, g) => ({
      hash: `hash-${g}`, count: 70, file_size: 10, wasted_space: 690,
      files: Array.from({ length: 70 }, (_, f) => ({ path: `/mnt/synthetic/${g}/${f}/${pad}`, size: 10, mtime: 1 }))
    }));
    expect(Buffer.byteLength(JSON.stringify(groups))).toBeGreaterThan(16 * 1024 * 1024);
    await expect(db.collection('dedup_oversized_probe').insertOne({ groups })).rejects.toThrow();

    const reportId = await dedupScanner.saveReport(db, {
      created_at: new Date(), status: 'complete', summary: { total_duplicate_groups: 300 }, groups
    });

    const stored = await db.collection('dedup_reports').findOne({ _id: reportId });
    expect(stored.groups).toEqual([]);
    expect(stored.detailStorage).toMatchObject({ groups: 300 });
    expect(await db.collection('dedup_report_details').countDocuments({ reportId })).toBe(stored.detailStorage.chunks);

    const seen = [];
    for (let offset = 0; ; offset += 120) {
      const page = await dedupScanner.getReport(db, String(reportId), { groupOffset: offset, groupLimit: 120 });
      expect(page.summary).toEqual({ total_duplicate_groups: 300 });
      expect(page.groups_page).toEqual({ offset, limit: 120, returned: page.groups.length, total: 300 });
      seen.push(...page.groups.map(group => group.hash));
      if (offset + 120 >= 300) break;
    }
    expect(seen).toEqual(groups.map(group => group.hash));

    const latest = await dedupScanner.getReport(db, null);
    expect(String(latest._id)).toBe(String(reportId));
    expect(latest.groups).toHaveLength(100);
    expect(latest.groups[0].files).toHaveLength(70);
  });

  test('zero-byte files never form a duplicate group', async () => {
    const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const row = (path, size, sha256) => ({
      path, dirname: '/mnt/synthetic/z', filename: path.split('/').pop(), size, mtime: 5,
      sha256, hash_fingerprint: `${size}:5`
    });
    await db.collection('nas_files').insertMany([
      ...Array.from({ length: 40 }, (_, i) => row(`/mnt/synthetic/z/empty-${i}`, 0, EMPTY_SHA256)),
      row('/mnt/synthetic/z/a.bin', 2048, 'f'.repeat(64)),
      row('/mnt/synthetic/z/b.bin', 2048, 'f'.repeat(64))
    ]);

    const report = await dedupScanner.buildDedupReport(db, { rootPath: '/mnt/synthetic/z' });
    expect(report.groups.map(group => [group.hash, group.count])).toEqual([['f'.repeat(64), 2]]);
    expect(report.summary).toMatchObject({ total_duplicate_groups: 1, total_duplicate_files: 2, total_wasted_space: 2048 });
  });
});
