/**
 * Integration test (REAL MongoDB) for the /api/v1/hardware route family:
 * collector ingest, latest snapshot per host, per-host failure state, bounded
 * history and the configurable TTL index. Uses the launcher's disposable MongoDB.
 */
const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { ensureIndexes } = require('../../utils/indexes');
const hardware = require('../../services/hardwareTelemetryService');
const responseEnvelope = require('../../middleware/responseEnvelope');
const errorHandler = require('../../middleware/errorHandler');

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');
const TEST_DB = `${BASE_DB}_hw`;

const gpu = (index, overrides = {}) => ({
  index,
  name: 'Synthetic GPU',
  uuid: `GPU-synthetic-${index}`,
  busId: `00000000:0${index + 1}:00.0`,
  utilizationPct: 40 + index,
  memoryUtilizationPct: 10,
  memoryUsedMiB: 1000,
  memoryTotalMiB: 24576,
  temperatureC: 55,
  powerDrawW: 120.5,
  powerLimitW: 350,
  smClockMHz: 1500,
  smClockMaxMHz: 2100,
  pcieGen: 4,
  pcieGenMax: 4,
  pcieWidth: 16,
  pcieWidthMax: 16,
  throttleReasonsActive: '0x0000000000000000',
  throttleReasons: [],
  ...overrides
});

describe('hardware telemetry (integration, real Mongo)', () => {
  let client;
  let db;
  let app;
  const previousTtl = process.env.DATA_HARDWARE_HISTORY_TTL_DAYS;

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);
    app = express();
    app.use(express.json());
    app.use(responseEnvelope);
    app.locals.db = db;
    app.use('/api/v1/hardware', require('../../routes/hardware.routes'));
    app.use(errorHandler);
  });

  afterAll(async () => {
    if (previousTtl === undefined) delete process.env.DATA_HARDWARE_HISTORY_TTL_DAYS;
    else process.env.DATA_HARDWARE_HISTORY_TTL_DAYS = previousTtl;
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  beforeEach(async () => {
    for (const name of [hardware.COLLECTORS, hardware.HOSTS, hardware.SAMPLES]) {
      try { await db.collection(name).drop(); } catch { /* namespace may not exist yet */ }
    }
  });

  test('ensureIndexes creates a 7-day TTL by default and applies a changed setting in place', async () => {
    delete process.env.DATA_HARDWARE_HISTORY_TTL_DAYS;
    await ensureIndexes(db);
    let ttl = (await db.collection(hardware.SAMPLES).indexes()).find(ix => ix.name === hardware.TTL_INDEX_NAME);
    expect(ttl).toMatchObject({ key: { sampledAt: 1 }, expireAfterSeconds: 7 * 86400 });

    process.env.DATA_HARDWARE_HISTORY_TTL_DAYS = '2';
    await ensureIndexes(db);
    ttl = (await db.collection(hardware.SAMPLES).indexes()).find(ix => ix.name === hardware.TTL_INDEX_NAME);
    expect(ttl.expireAfterSeconds).toBe(2 * 86400);
    const hostIndex = (await db.collection(hardware.HOSTS).indexes()).find(ix => ix.name === 'hardware_host_id_unique');
    expect(hostIndex).toMatchObject({ unique: true });
  });

  test('ingests one cycle, keeps a failing host visible and serves latest and history', async () => {
    await ensureIndexes(db);
    const collector = {
      collectorId: 'gpu-agent-test',
      hostname: 'core-host',
      platform: 'linux',
      agentVersion: 'gpu-test',
      intervalMs: 30000,
      hosts: [
        { id: 'gpu-a', name: 'GPU A', ollamaUrl: 'http://gpu-a.example:11434' },
        { id: 'gpu-b', name: 'GPU B', ollamaUrl: 'http://gpu-b.example:11434' }
      ]
    };
    await request(app).post('/api/v1/hardware/collector/heartbeat').send(collector).expect(200);

    const sampledAt = new Date().toISOString();
    const ingest = await request(app).post('/api/v1/hardware/samples').send({
      ...collector,
      results: [
        { hostId: 'gpu-a', ok: true, sampledAt, gpus: [gpu(0), gpu(1)] },
        { hostId: 'gpu-b', ok: false, sampledAt, error: 'ssh: connect timed out' }
      ]
    }).expect(200);
    expect(ingest.body).toMatchObject({ ok: true, data: { accepted: 1, failed: 1, gpuSamples: 2 } });

    const latest = await request(app).get('/api/v1/hardware/latest').expect(200);
    expect(latest.body.data).toMatchObject({ total: 2, fresh: 1 });
    const [a, b] = latest.body.data.hosts;
    expect(a).toMatchObject({
      hostId: 'gpu-a', name: 'GPU A', ollamaUrl: 'http://gpu-a.example:11434',
      status: 'ok', freshness: 'fresh', stale: false, gpuCount: 2, consecutiveFailures: 0
    });
    expect(a.gpus[1]).toMatchObject({ index: 1, utilizationPct: 41, pcieWidth: 16 });
    expect(b).toMatchObject({
      hostId: 'gpu-b', status: 'error', freshness: 'no_data', stale: true,
      lastError: 'ssh: connect timed out', consecutiveFailures: 1, gpus: []
    });

    // A later failure keeps the last GPUs and their sample time, so readers see staleness.
    await request(app).post('/api/v1/hardware/samples').send({
      ...collector,
      results: [{ hostId: 'gpu-a', ok: false, error: 'nvidia-smi exited 9' }]
    }).expect(200);
    const afterFailure = await request(app).get('/api/v1/hardware/latest?hostId=gpu-a').expect(200);
    expect(afterFailure.body.data.hosts[0]).toMatchObject({
      status: 'error', consecutiveFailures: 1, gpuCount: 2, lastSampleAt: sampledAt
    });

    const history = await request(app).get('/api/v1/hardware/history?hostId=gpu-a&gpuIndex=1&limit=5').expect(200);
    expect(history.body.data.samples).toHaveLength(1);
    expect(history.body.data.samples[0]).toMatchObject({ hostId: 'gpu-a', index: 1, utilizationPct: 41 });

    const collectors = await request(app).get('/api/v1/hardware/collectors').expect(200);
    expect(collectors.body.data).toMatchObject({ active: 1 });
    expect(collectors.body.data.collectors[0].hosts).toHaveLength(2);
  });

  test('an old sample reads as stale instead of current', async () => {
    const oldAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await request(app).post('/api/v1/hardware/samples').send({
      collectorId: 'gpu-agent-test', intervalMs: 30000,
      results: [{ hostId: 'gpu-a', ok: true, sampledAt: oldAt, gpus: [gpu(0)] }]
    }).expect(200);
    const latest = await request(app).get('/api/v1/hardware/latest').expect(200);
    expect(latest.body.data.hosts[0]).toMatchObject({ freshness: 'stale', stale: true, staleAfterMs: 90000 });
    expect(latest.body.data.hosts[0].ageMs).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
  });

  test('rejects malformed collector identity and oversized batches', async () => {
    await request(app).post('/api/v1/hardware/samples').send({ collectorId: '../x', results: [] }).expect(400);
    const results = Array.from({ length: hardware.MAX_HOSTS + 1 }, (_, i) => ({ hostId: `h${i}`, ok: false }));
    await request(app).post('/api/v1/hardware/samples').send({ collectorId: 'gpu-agent-test', results }).expect(400);
    await request(app).get('/api/v1/hardware/history').expect(400);
  });
});
