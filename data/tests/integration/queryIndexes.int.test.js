/**
 * Integration test (REAL MongoDB) for the indexes behind the live-feed, file
 * browser, scan prune and scan request queries: ensureIndexes builds them on
 * collections that already hold rows and indexes, and the planner uses them.
 *
 * The test launcher supplies its own disposable MongoDB and database name.
 */
jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { MongoClient } = require('mongodb');
const { ensureIndexes } = require('../../utils/indexes');
const { log } = require('../../utils/logger');

const URI = process.env.MONGODB_URI_TEST;
const TEST_DB = URI ? new URL(URI).pathname.slice(1) : '';

if (!URI || !TEST_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');

// The index a winning plan reads, or null for a collection scan.
function usedIndex(plan) {
  if (!plan) return null;
  if (plan.indexName) return plan.indexName;
  for (const child of [plan.inputStage, plan.queryPlan, ...(plan.inputStages || [])]) {
    const name = usedIndex(child);
    if (name) return name;
  }
  return null;
}

function hasStage(plan, stage) {
  if (!plan) return false;
  if (plan.stage === stage) return true;
  return [plan.inputStage, plan.queryPlan, ...(plan.inputStages || [])].some(child => hasStage(child, stage));
}

describe('query indexes (integration, real Mongo)', () => {
  let client;
  let db;

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);

    // Existing data and the indexes of an earlier version, before this start.
    await db.collection('livedata_points').insertMany(Array.from({ length: 600 }, (_, i) => ({
      feedId: ['satellites', 'aqi', 'sensors'][i % 3], ts: new Date(Date.UTC(2026, 0, 1) + i * 60000), payload: { i }
    })));
    await db.collection('nas_files').createIndex({ path: 1 }, { name: 'path_unique', unique: true });
    await db.collection('nas_files').insertMany(Array.from({ length: 900 }, (_, i) => ({
      path: `/mnt/synthetic/${i % 3 ? 'media' : 'docs'}/dir-${i % 30}/file-${i}.bin`,
      dirname: `/mnt/synthetic/${i % 3 ? 'media' : 'docs'}/dir-${i % 30}`,
      filename: `file-${i}.bin`, ext: 'bin', category: ['video', 'image', 'document'][i % 3],
      size: i * 10, mtime: 1700000000 + i, scan_id: i < 880 ? 'scan-new' : 'scan-old'
    })));
    await db.collection('network_scan_requests').createIndex({ requestedAt: -1 }, { name: 'requested_at_desc' });
    await db.collection('network_scan_requests').insertMany([
      { target: '192.0.2.0/24', status: 'done', requestedAt: new Date(Date.now() - 3 * 86400000) },
      { target: '192.0.2.0/24', status: 'pending', requestedAt: new Date() }
    ]);

    await ensureIndexes(db);
  });

  afterAll(async () => {
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  const winning = async (cursor) => (await cursor.explain('queryPlanner')).queryPlanner.winningPlan;

  test('every index is created on the existing collections, and again on a second start', async () => {
    expect(log.mock.calls.filter(([message]) => /Failed to create/.test(message))).toEqual([]);
    await ensureIndexes(db);
    expect(log.mock.calls.filter(([message]) => /Failed to create/.test(message))).toEqual([]);

    const names = async (collection) => (await db.collection(collection).indexes()).map(index => index.name);
    expect(await names('livedata_points')).toContain('feed_ts_desc');
    expect(await names('nas_files')).toEqual(expect.arrayContaining(['path_unique', 'mtime_desc', 'category_mtime', 'scan_path']));
    expect(await names('dedup_report_details')).toContain('report_ordinal');
    const ttl = (await db.collection('network_scan_requests').indexes()).find(index => index.name === 'ttl_1d');
    expect(ttl).toMatchObject({ key: { requestedAt: 1 }, expireAfterSeconds: 86400 });
    expect(await names('network_scan_requests')).toContain('requested_at_desc');
  });

  test('live feed latest, history and prune read the feed/time index without sorting in memory', async () => {
    const points = db.collection('livedata_points');
    const latest = await winning(points.find({ feedId: 'aqi' }).sort({ ts: -1 }).limit(1));
    const history = await winning(points.find({ feedId: 'aqi', ts: { $gte: new Date(Date.UTC(2026, 0, 1, 2)) } }).sort({ ts: 1 }).limit(50));
    const prune = await winning(points.find({ feedId: 'aqi', ts: { $lt: new Date(Date.UTC(2026, 0, 1, 2)) } }));
    for (const plan of [latest, history, prune]) {
      expect(usedIndex(plan)).toBe('feed_ts_desc');
      expect(hasStage(plan, 'SORT')).toBe(false);
    }
  });

  test('the file browser default page and its category filter read an index in order', async () => {
    const files = db.collection('nas_files');
    const page = await winning(files.find({}).sort({ mtime: -1 }).skip(0).limit(100));
    expect(usedIndex(page)).toBe('mtime_desc');
    expect(hasStage(page, 'SORT')).toBe(false);
    const byCategory = await winning(files.find({ category: 'video' }).sort({ mtime: -1 }).limit(100));
    expect(usedIndex(byCategory)).toBe('category_mtime');
    expect(hasStage(byCategory, 'SORT')).toBe(false);
  });

  test('the scan prune probe reads the scan/path index', async () => {
    const files = db.collection('nas_files');
    const scope = { path: { $regex: '^/mnt/synthetic/docs(?:[\\/]|$)' } };
    const probe = await winning(files.find({ ...scope, scan_id: 'scan-new' }).limit(1));
    expect(usedIndex(probe)).toBe('scan_path');
    expect(hasStage(probe, 'COLLSCAN')).toBe(false);
  });
});
