/**
 * Integration test (REAL MongoDB) for GET /api/v1/hardware/occupancy (#365):
 * per-GPU busy share, VRAM, power and throttled time over a window, with
 * missed samples reported as missing rather than idle.
 */
const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const hardware = require('../../services/hardwareTelemetryService');
const responseEnvelope = require('../../middleware/responseEnvelope');
const errorHandler = require('../../middleware/errorHandler');

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');
const TEST_DB = `${BASE_DB}_hwocc`;

const T0 = Date.parse('2026-10-01T00:00:00Z');
const MIN = 60_000;
const at = ms => new Date(T0 + ms).toISOString();
const collector = {
  collectorId: 'gpu-agent-test', hostname: 'core-host', intervalMs: 30_000,
  hosts: [
    { id: 'gpu-a', name: 'GPU A', ollamaUrl: 'http://gpu-a.example:11434' },
    { id: 'gpu-b', name: 'GPU B', ollamaUrl: 'http://gpu-b.example:11434' },
  ],
};
const gpu = (index, overrides = {}) => ({
  index, name: 'Synthetic GPU', uuid: `GPU-a-${index}`, busId: `00000000:0${index + 1}:00.0`,
  memoryTotalMiB: 24576, powerLimitW: 350, throttleReasonsActive: '0x0000000000000000', throttleReasons: [],
  ...overrides,
});
const cycle = (ms, gpus, hostId = 'gpu-a') => hardware.ingestSamples(db, {
  ...collector, results: [{ hostId, ok: true, sampledAt: at(ms), gpus }],
});

let client;
let db;
let app;

describe('GPU occupancy (integration, real Mongo)', () => {
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

    // GPU B was last seen before the window and has no sample in it.
    await cycle(-2 * 60 * MIN, [gpu(0, { uuid: 'GPU-b-0', utilizationPct: 0 })], 'gpu-b');
    // GPU A: 30 minutes sampled every 30 s, the collector down for 20 minutes,
    // then 10 more minutes. GPU 0 works for the first 15 minutes; GPU 1 at 50 %
    // for the first 30, power-capped for its first 5.
    for (let k = 1; k <= 60; k += 1) {
      await cycle(k * 30_000, [
        gpu(0, { utilizationPct: k <= 30 ? 80 : 0, memoryUsedMiB: 20_000, powerDrawW: 300 }),
        gpu(1, { utilizationPct: 50, memoryUsedMiB: 8_000, powerDrawW: 200,
          ...(k <= 10 && { throttleReasonsActive: '0x0000000000000004', throttleReasons: ['sw_power_cap'] }) }),
      ]);
    }
    for (let k = 1; k <= 20; k += 1) {
      await cycle(50 * MIN + k * 30_000, [
        // At rest the driver still raises the power cap on GPU 0: not throttling.
        // GPU 1 is at rest but thermally limited for 2 minutes: that counts.
        gpu(0, { utilizationPct: 0, memoryUsedMiB: 1_000, powerDrawW: 50,
          throttleReasonsActive: '0x0000000000000004', throttleReasons: ['sw_power_cap'] }),
        gpu(1, { utilizationPct: 0, memoryUsedMiB: 1_000, powerDrawW: 50,
          ...(k <= 4 && { throttleReasonsActive: '0x0000000000000020', throttleReasons: ['sw_thermal'] }) }),
      ]);
    }
  });

  afterAll(async () => {
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  const read = query => request(app).get('/api/v1/hardware/occupancy')
    .query({ from: at(0), to: at(60 * MIN), ...query });

  test('a missed stretch is missing, not idle; shares are of the time observed', async () => {
    const res = await read().expect(200);
    const data = res.body.data;
    expect(data).toMatchObject({ windowMs: 60 * MIN, busyAtPct: 10 });
    const [a, b] = data.hosts;
    expect(a).toMatchObject({ hostId: 'gpu-a', name: 'GPU A', ollamaUrl: 'http://gpu-a.example:11434', intervalMs: 30_000 });
    const [gpu0, gpu1] = a.gpus;

    expect(gpu0).toMatchObject({
      index: 0, uuid: 'GPU-a-0', samples: 80,
      observedMs: 40 * MIN, missingMs: 20 * MIN, coverage: 0.667,
      busy: { ms: 15 * MIN, share: 0.375 },
      utilizationPct: { mean: 30 },
      memoryUsedMiB: { max: 20_000 },
      memoryTotalMiB: 24576,
      powerW: { mean: 237.5, max: 300, limit: 350 },
      throttled: { observedMs: 40 * MIN, ms: 0, share: 0, powerCapMs: 0 },
    });
    expect(gpu0.memoryUsedMiB.p95).toBeGreaterThan(19_000);

    expect(gpu1).toMatchObject({
      index: 1, samples: 80, busy: { ms: 30 * MIN, share: 0.75 }, utilizationPct: { mean: 37.5 },
      throttled: { ms: 7 * MIN, share: 0.175, powerCapMs: 5 * MIN, thermalMs: 2 * MIN, hardwareMs: 0 },
    });

    // Known but unsampled in the window: zero coverage, no values.
    expect(b).toMatchObject({ hostId: 'gpu-b' });
    expect(b.gpus).toEqual([expect.objectContaining({
      uuid: 'GPU-b-0', samples: 0, observedMs: 0, missingMs: 60 * MIN, coverage: 0,
      busy: { ms: 0, share: null }, utilizationPct: { mean: null, p50: null, p95: null },
    })]);
  });

  test('the busy threshold and host filter apply', async () => {
    const res = await read({ busyAtPct: 60, hostId: 'gpu-a' }).expect(200);
    expect(res.body.data.hosts.map(host => host.hostId)).toEqual(['gpu-a']);
    const [gpu0, gpu1] = res.body.data.hosts[0].gpus;
    expect(gpu0.busy.ms).toBe(15 * MIN);
    expect(gpu1.busy.ms).toBe(0);
  });

  test('rejects an inverted or oversized window and a bad threshold', async () => {
    await request(app).get('/api/v1/hardware/occupancy').query({ from: at(10), to: at(0) }).expect(400);
    await request(app).get('/api/v1/hardware/occupancy').query({ from: at(-91 * 24 * 60 * MIN), to: at(0) }).expect(400);
    await read({ busyAtPct: 0 }).expect(400);
    await read({ hostId: '../x' }).expect(400);
  });
});
