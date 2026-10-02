/**
 * Integration test (REAL MongoDB) for the network_devices `mac` index fix.
 *
 * The mocked unit suite (tests/unit/) can assert the migration logic and upsert
 * op-shapes, but it cannot reproduce the actual E11000 — that needs a real unique
 * index. This suite does: it builds the index, drives the REAL applyScanResults,
 * and proves ≥2 MAC-less devices coexist (and that the legacy non-partial index
 * really did drop the batch).
 *
 * The test launcher supplies its own disposable MongoDB and database name.
 * No personal database or externally configured URI is used.
 */
const { MongoClient } = require('mongodb');
const { ensureIndexes } = require('../../utils/indexes');
const { applyScanResults } = require('../../services/networkAgentService');

const URI = process.env.MONGODB_URI_TEST;
const TEST_DB = URI ? new URL(URI).pathname.slice(1) : '';
const PARTIAL_FILTER = { mac: { $type: 'string', $gt: '' } };

if (!URI || !TEST_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');
const describeIfDb = describe;

describeIfDb('network_devices mac index (integration, real Mongo)', () => {
  let client;
  let db;
  let coll;

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);
    coll = db.collection('network_devices');
  });

  afterAll(async () => {
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  // Each test starts from a clean collection (no leftover docs or indexes).
  beforeEach(async () => {
    try { await coll.drop(); } catch { /* namespace may not exist yet */ }
  });

  const macUniqueSpec = async () => (await coll.indexes()).find((i) => i.name === 'mac_unique');

  test('ensureIndexes builds a PARTIAL mac_unique', async () => {
    await ensureIndexes(db);
    const spec = await macUniqueSpec();
    expect(spec).toBeDefined();
    expect(spec.unique).toBe(true);
    expect(spec.partialFilterExpression).toEqual(PARTIAL_FILTER);
  });

  test('≥2 MAC-less devices land in one ingest (the E11000 the fix prevents)', async () => {
    await ensureIndexes(db);
    const summary = await applyScanResults(db, [
      { ip: '192.0.2.1', mac: '', hostname: 'gateway' },    // L3 device, no MAC
      { ip: '192.0.2.12', mac: '', hostname: 'windows-node' },  // scanning host itself, no MAC
      { ip: '192.0.2.20', mac: '11:22:33:44:55:66', hostname: 'nas' }
    ], { scanSource: 'inttest' });

    expect(summary.discovered).toBe(3);
    expect(await coll.countDocuments({})).toBe(3);
    expect(await coll.countDocuments({ mac: '' })).toBe(2); // both MAC-less devices coexist
  });

  test('re-ingesting the same scan is idempotent (MAC-less upsert keyed by IP)', async () => {
    await ensureIndexes(db);
    const devices = [
      { ip: '192.0.2.1', mac: '' },
      { ip: '192.0.2.12', mac: '' }
    ];
    await applyScanResults(db, devices, { scanSource: 'inttest' });
    await applyScanResults(db, devices, { scanSource: 'inttest' });
    expect(await coll.countDocuments({})).toBe(2); // no duplicate MAC-less docs created
  });

  test('uniqueness is still enforced for real MACs', async () => {
    await ensureIndexes(db);
    await coll.insertOne({ ip: '10.0.0.1', mac: 'AA:BB:CC:DD:EE:FF' });
    await expect(
      coll.insertOne({ ip: '10.0.0.2', mac: 'AA:BB:CC:DD:EE:FF' })
    ).rejects.toThrow(/E11000/i);
  });

  test('legacy non-partial index drops the batch; migration repairs it', async () => {
    // Recreate the pre-fix state: a plain (non-partial) unique index on mac.
    await coll.createIndex({ mac: 1 }, { name: 'mac_unique', unique: true });

    // Pre-fix behavior: the 2nd MAC-less device collides → ordered bulkWrite throws.
    await expect(applyScanResults(db, [
      { ip: '192.0.2.1', mac: '' },
      { ip: '192.0.2.12', mac: '' }
    ], { scanSource: 'inttest' })).rejects.toThrow(/E11000/i);

    // Migration drops the legacy index and rebuilds it partial.
    await ensureIndexes(db);
    expect((await macUniqueSpec()).partialFilterExpression).toEqual(PARTIAL_FILTER);

    // Same ingest now lands fully.
    await coll.deleteMany({});
    const summary = await applyScanResults(db, [
      { ip: '192.0.2.1', mac: '' },
      { ip: '192.0.2.12', mac: '' }
    ], { scanSource: 'inttest' });
    expect(summary.discovered).toBe(2);
    expect(await coll.countDocuments({ mac: '' })).toBe(2);
  });
});
