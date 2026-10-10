/**
 * Integration test (REAL MongoDB) for the IoT store: indexes and retention,
 * minute writes, the hourly rollup (idempotent, catching up), the one-off
 * backfill of the old raw sensor points, history reads, the HTTP API and the
 * activity log's no-replay rule. Uses the launcher's disposable MongoDB.
 */
const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { ensureIndexes } = require('../../utils/indexes');
const responseEnvelope = require('../../middleware/responseEnvelope');
const errorHandler = require('../../middleware/errorHandler');
const iot = require('../../services/iot');
const store = require('../../services/iot/bucketStore');
const backfill = require('../../services/iot/backfill');
const { summarize } = require('../../services/iot/buckets');

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');
const TEST_DB = `${BASE_DB}_iot`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEVICE = 'SYN_01';

describe('IoT store (integration, real Mongo)', () => {
  let client;
  let db;
  let app;

  /** A minute bucket of twelve readings around `value`, starting at `ms`. */
  const minuteBucket = (ms, value, measure = 'temperature', device = DEVICE) => ({
    device, measure, ts: new Date(ms),
    ...summarize(Array.from({ length: 12 }, (_, i) => ({ at: ms + i * 5000, value: value + (i % 3) - 1 })))
  });
  const minutes = (filter = {}) => db.collection(store.MINUTES).find(filter).sort({ ts: 1, measure: 1 }).toArray();
  const hours = (filter = {}) => db.collection(store.HOURS).find(filter).sort({ ts: 1, measure: 1 }).toArray();
  const events = () => db.collection('appevents').find({ type: /^iot\./ }).sort({ timestamp: 1, _id: 1 }).toArray();
  const strip = (docs) => docs.map(({ _id, ...rest }) => rest);

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    db = client.db(TEST_DB);
    await ensureIndexes(db);
    app = express();
    app.use(express.json());
    app.use(responseEnvelope);
    app.locals.db = db;
    app.use('/api/v1/iot', require('../../routes/iot.routes'));
    app.use(errorHandler);
  });

  afterAll(async () => {
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  beforeEach(async () => {
    for (const name of [store.MINUTES, store.HOURS, store.STATE, 'iot_devices', 'livedata_points', 'appevents', 'activity_state']) {
      await db.collection(name).deleteMany({});
    }
    iot._reset();
  });

  describe('indexes and retention', () => {
    test('minute buckets expire after 90 days and are unique per device, measure and minute; hour buckets never expire', async () => {
      const minuteIndexes = await db.collection(store.MINUTES).indexes();
      expect(minuteIndexes.find((index) => index.name === 'ttl_90d')).toMatchObject({ key: { ts: 1 }, expireAfterSeconds: 90 * 86400 });
      expect(minuteIndexes.find((index) => index.name === 'device_measure_ts_unique')).toMatchObject({ key: { device: 1, measure: 1, ts: 1 }, unique: true });
      const hourIndexes = await db.collection(store.HOURS).indexes();
      expect(hourIndexes.find((index) => index.name === 'device_measure_ts_unique')).toMatchObject({ unique: true });
      expect(hourIndexes.some((index) => index.expireAfterSeconds !== undefined)).toBe(false);
    });

    test('a history read uses the device, measure and time index', async () => {
      const plan = await db.collection(store.MINUTES)
        .find({ device: DEVICE, measure: { $in: ['temperature'] }, ts: { $gte: new Date(0), $lt: new Date() } }).explain('queryPlanner');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('device_measure_ts_unique');
    });
  });

  describe('minute writes', () => {
    const T = Date.UTC(2026, 0, 5, 10, 0, 0);

    test('a bucket is stored with its fields; a later part of the same minute is merged, not duplicated', async () => {
      const first = { device: DEVICE, measure: 'temperature', ts: new Date(T), ...summarize([20, 21, 22, 23].map((value, i) => ({ at: T + i * 5000, value }))) };
      await store.writeMinuteBuckets(db, [first]);
      expect(strip(await minutes())).toEqual([{ ...first, parts: 1 }]);

      const late = { device: DEVICE, measure: 'temperature', ts: new Date(T), ...summarize([{ at: T + 50_000, value: 30 }, { at: T + 55_000, value: 10 }]) };
      await store.writeMinuteBuckets(db, [late]);
      const [merged] = await minutes();
      expect(merged).toMatchObject({
        count: 6, min: 10, max: 30, mean: 21, median: 21.5, parts: 2,
        first: new Date(T), last: new Date(T + 55_000)
      });
      expect(await db.collection(store.MINUTES).countDocuments()).toBe(1);
    });

    test('negative and integer values survive the merge arithmetic', async () => {
      const bucket = (values, offset) => ({ device: DEVICE, measure: 'wifi_rssi', ts: new Date(T), ...summarize(values.map((value, i) => ({ at: T + offset + i * 1000, value }))) });
      await store.writeMinuteBuckets(db, [bucket([-73, -75], 0)]);
      await store.writeMinuteBuckets(db, [bucket([-70], 10_000)]);
      expect((await minutes())[0]).toMatchObject({ count: 3, min: -75, max: -70, mean: -72.666667, median: -74 });
    });
  });

  describe('hourly rollup', () => {
    const H = Date.UTC(2026, 0, 5, 10, 0, 0);
    const fillHour = (hourMs, value, count = 60) => store.writeMinuteBuckets(db,
      Array.from({ length: count }, (_, i) => minuteBucket(hourMs + i * MINUTE, value + (i % 5))));

    test('writes closed hours only, with median of minute medians, weighted mean and true extremes', async () => {
      await fillHour(H, 20);
      await fillHour(H + HOUR, 30, 10); // the open hour
      const result = await store.runRollup(db, new Date(H + HOUR + 10 * MINUTE));
      expect(result).toMatchObject({ hours: 1, buckets: 1, more: false });
      const [hour, ...rest] = await hours();
      expect(rest).toEqual([]);
      expect(hour).toMatchObject({
        device: DEVICE, measure: 'temperature', ts: new Date(H), minutes: 60,
        count: 720, min: 19, max: 25, mean: 22, median: 22,
        first: new Date(H), last: new Date(H + 59 * MINUTE + 55_000)
      });
      expect(hour.partial).toBeUndefined();
    });

    test('an hour closed for less than five minutes waits', async () => {
      await fillHour(H, 20);
      expect((await store.runRollup(db, new Date(H + HOUR + 4 * MINUTE))).hours).toBe(0);
      expect(await hours()).toEqual([]);
      expect((await store.runRollup(db, new Date(H + HOUR + 5 * MINUTE))).hours).toBe(1);
    });

    test('is idempotent: running it again changes nothing', async () => {
      await fillHour(H, 20);
      await fillHour(H + HOUR, 21);
      const now = new Date(H + 3 * HOUR);
      expect((await store.runRollup(db, now)).hours).toBe(2);
      const before = await hours();
      expect((await store.runRollup(db, now)).hours).toBe(0);
      await db.collection(store.STATE).deleteMany({});
      expect((await store.runRollup(db, now)).hours).toBe(2);
      expect(await hours()).toEqual(before);
      expect(before).toHaveLength(2);
    });

    test('catches up after downtime, skipping the stretch without data, within its per-run bound', async () => {
      await fillHour(H, 20, 30);
      await fillHour(H + HOUR, 21, 30);
      await fillHour(H + 20 * DAY, 25, 30);
      await fillHour(H + 20 * DAY + HOUR, 26, 30);
      const now = new Date(H + 21 * DAY);
      const first = await store.runRollup(db, now, { maxHours: 3 });
      expect(first).toMatchObject({ hours: 3, more: true, through: new Date(H + 20 * DAY + HOUR) });
      const second = await store.runRollup(db, now, { maxHours: 3 });
      expect(second).toMatchObject({ hours: 1, more: false, through: new Date(Math.floor((now.getTime() - 5 * MINUTE) / HOUR) * HOUR) });
      expect((await hours()).map((hour) => hour.ts.getTime())).toEqual([H, H + HOUR, H + 20 * DAY, H + 20 * DAY + HOUR]);
      expect((await hours())[0].minutes).toBe(30);
    });

    test('several devices and measures in one hour', async () => {
      await store.writeMinuteBuckets(db, [
        minuteBucket(H, 20), minuteBucket(H, 1013, 'pressure'), minuteBucket(H + MINUTE, 5, 'temperature', 'SYN_02')
      ]);
      await store.runRollup(db, new Date(H + 2 * HOUR));
      expect((await hours()).map((hour) => `${hour.device}/${hour.measure}`).sort()).toEqual(['SYN_01/pressure', 'SYN_01/temperature', 'SYN_02/temperature']);
    });

    test('an hour about to leave the minute tier is marked partial and never replaces a stored hour', async () => {
      const now = new Date(H + 89 * DAY);
      await store.writeMinuteBuckets(db, [minuteBucket(H + 30 * MINUTE, 20), minuteBucket(H + HOUR + MINUTE, 50)]);
      const complete = { device: DEVICE, measure: 'temperature', ts: new Date(H), count: 720, min: 1, max: 9, mean: 5, median: 5, first: new Date(H), last: new Date(H + HOUR - 1), minutes: 60 };
      await db.collection(store.HOURS).insertOne({ ...complete });
      await store.runRollup(db, now);
      const [kept, created] = await hours();
      expect(kept).toMatchObject(complete);
      expect(kept.partial).toBeUndefined();
      expect(created).toMatchObject({ ts: new Date(H + HOUR), minutes: 1, partial: true });
    });
  });

  describe('backfill of the old raw sensor points', () => {
    const T = Date.UTC(2026, 0, 5, 10, 58, 0);
    const raw = (ms, measure, value, device = DEVICE) => ({ feedId: 'sensors', ts: new Date(ms), payload: { topic: `sensors/${device}/${measure}`, value } });

    async function seedRaw() {
      const docs = [];
      // Four minutes of readings every 5 s, across an hour boundary.
      for (let i = 0; i < 48; i++) {
        docs.push(raw(T + i * 5000, 'temperature', 20 + (i % 4)), raw(T + i * 5000, 'pressure', 1013));
      }
      docs.push(
        { feedId: 'sensors', ts: new Date(T), payload: { topic: 'sensors/SYN_01/availability', value: 'online' } },
        { feedId: 'sensors', ts: new Date(T), payload: { topic: 'sensors/garage', temp: 21.5 } },
        { feedId: 'sensors', latest: true, key: 'sensors/SYN_01/temperature', ts: new Date(T), payload: { topic: 'sensors/SYN_01/temperature', value: 99 } },
        { feedId: 'air_quality', ts: new Date(T), payload: { pm2_5: 4 } }
      );
      await db.collection('livedata_points').insertMany(docs);
    }

    test('turns raw points into minute buckets, removes them, and leaves everything else', async () => {
      await seedRaw();
      const state = await backfill.run(db);
      expect(state).toMatchObject({ state: 'done', points: 96, skipped: 2, buckets: 8, removed: 98, windows: 2 });
      const stored = await minutes({ measure: 'temperature' });
      expect(stored.map((bucket) => [bucket.ts.getTime(), bucket.count])).toEqual([[T, 12], [T + MINUTE, 12], [T + 2 * MINUTE, 12], [T + 3 * MINUTE, 12]]);
      expect(stored[0]).toMatchObject({ min: 20, max: 23, mean: 21.5, median: 21.5, first: new Date(T), last: new Date(T + 55_000), parts: 1 });
      expect(strip(await db.collection('livedata_points').find({}).sort({ feedId: 1 }).toArray()).map((doc) => [doc.feedId, doc.latest === true]))
        .toEqual([['air_quality', false], ['sensors', true]]);
    });

    test('is idempotent: a second run does nothing, even with new raw points', async () => {
      await seedRaw();
      await backfill.run(db);
      const before = await minutes();
      await db.collection('livedata_points').insertOne(raw(T + DAY, 'temperature', 5));
      const again = await backfill.run(db);
      expect(again).toMatchObject({ state: 'done', points: 96, windows: 2 });
      expect(await minutes()).toEqual(before);
    });

    test('interrupted between hours, it resumes where it stopped', async () => {
      await seedRaw();
      let polls = 0;
      const stopped = await backfill.run(db, { shouldStop: () => ++polls > 1 });
      expect(stopped).toMatchObject({ state: 'running', windows: 1, points: 48 });
      expect(await db.collection('livedata_points').countDocuments(backfill.RAW_FILTER)).toBe(48);
      const done = await backfill.run(db);
      expect(done).toMatchObject({ state: 'done', windows: 2, points: 96, buckets: 8 });
      expect(await minutes()).toHaveLength(8);
    });

    test('interrupted inside an hour, a complete bucket is not replaced by what is left', async () => {
      await seedRaw();
      // As if a first run had written the buckets and died while deleting.
      const complete = await (async () => {
        const all = await db.collection('livedata_points').find({ ...backfill.RAW_FILTER, 'payload.topic': 'sensors/SYN_01/temperature', ts: { $lt: new Date(T + MINUTE) } }).toArray();
        return { device: DEVICE, measure: 'temperature', ts: new Date(T), ...summarize(all.map((doc) => ({ at: doc.ts.getTime(), value: doc.payload.value }))) };
      })();
      await store.insertMinuteBucketsIfAbsent(db, [complete]);
      await db.collection('livedata_points').deleteMany({ ...backfill.RAW_FILTER, ts: { $lt: new Date(T + 30_000) } });
      const state = await backfill.run(db);
      expect(state.state).toBe('done');
      expect((await minutes({ measure: 'temperature' }))[0]).toMatchObject({ ts: new Date(T), count: 12, parts: 1 });
    });

    test('a live bucket of the same minute is kept, and the rollup redoes the backfilled hours', async () => {
      await seedRaw();
      await store.writeMinuteBuckets(db, [minuteBucket(T + 3 * MINUTE, 70)]);
      await store.runRollup(db, new Date(T + DAY));
      expect((await hours({ measure: 'temperature' })).map((hour) => hour.count)).toEqual([12]);
      await backfill.run(db);
      expect((await minutes({ measure: 'temperature', ts: new Date(T + 3 * MINUTE) }))[0]).toMatchObject({ count: 12, max: 71 });
      await store.runRollup(db, new Date(T + DAY));
      expect((await hours({ measure: 'temperature' })).map((hour) => [hour.ts.getTime(), hour.count])).toEqual([
        [Date.UTC(2026, 0, 5, 10), 24], [Date.UTC(2026, 0, 5, 11), 24]
      ]);
    });

    test('the service runs it once at startup maintenance and registers the devices it finds', async () => {
      await seedRaw();
      const service = iot.createIot({ now: () => new Date(T + DAY) });
      await service.ready(db);
      const result = await service.maintain();
      expect(result.backfill.state).toBe('done');
      expect(result.rollup.hours).toBe(2);
      const device = await service.getDevice(db, DEVICE);
      expect(device).toMatchObject({ firstSeenAt: new Date(T).toISOString(), lastSeenAt: new Date(T + 235_000).toISOString() });
      expect(device.measures.map((measure) => measure.key).sort()).toEqual(['pressure', 'temperature']);
      expect((await service.status(db)).backfill).toMatchObject({ state: 'done', points: 96, removed: 98 });
      expect(await events()).toEqual([]);
    });
  });

  describe('HTTP API', () => {
    const say = (topic, payload, packet) => iot.handleMessage(topic, Buffer.from(String(payload)), packet);

    async function knownDevice() {
      await iot.ready(db);
      say('sensors/SYN_01/temperature', '21.5');
      say('sensors/SYN_01/pressure', '1013.2');
      say('sensors/SYN_01/availability', 'online');
    }

    test('status before anything was heard', async () => {
      const res = await request(app).get('/api/v1/iot/status').expect(200);
      expect(res.body).toMatchObject({
        ok: true,
        data: {
          consumer: { running: false, connected: false, connection: 'mqtt-monitor' },
          devices: { tracked: 0, limit: 100, online: 0, offline: 0, stale: 0, unknown: 0 },
          readings: { accepted: 0, refused: 0, refusedByReason: {}, lastAt: null },
          buckets: { written: 0, open: 0, pendingRetry: 0 },
          rollup: null, backfill: null,
          settings: { minuteRetentionDays: 90, staleAfterSeconds: 300, liveRingSize: 60 }
        }
      });
    });

    test('devices: list, read, strict patch that survives a restart', async () => {
      await knownDevice();
      const list = await request(app).get('/api/v1/iot/devices').expect(200);
      expect(list.body.data).toMatchObject({ count: 1, devices: [{ id: DEVICE, status: 'online', availability: { state: 'online' } }] });
      expect(list.body.data.devices[0].measures.map((measure) => [measure.key, measure.unit, measure.value])).toEqual([
        ['temperature', '°C', 21.5], ['pressure', 'hPa', 1013.2]
      ]);

      await request(app).patch(`/api/v1/iot/devices/${DEVICE}`).send({ displayName: 'Greenhouse', status: 'offline' }).expect(400);
      await request(app).patch(`/api/v1/iot/devices/${DEVICE}`).send({ displayName: 7 }).expect(400);
      await request(app).patch('/api/v1/iot/devices/SYN_99').send({ displayName: 'x' }).expect(404);
      const patched = await request(app).patch(`/api/v1/iot/devices/${DEVICE}`)
        .send({ displayName: 'Greenhouse', location: 'Garden', notes: 'Synthetic note' }).expect(200);
      expect(patched.body.data).toMatchObject({ id: DEVICE, displayName: 'Greenhouse', location: 'Garden', notes: 'Synthetic note', status: 'online' });

      // The periodic write must not erase the owner's fields, and a restart reads them back.
      await iot.tick();
      await iot.stop();
      iot._reset();
      const read = await request(app).get(`/api/v1/iot/devices/${DEVICE}`).expect(200);
      expect(read.body.data).toMatchObject({ displayName: 'Greenhouse', location: 'Garden', notes: 'Synthetic note', availability: { state: 'online' } });
      expect(read.body.data.measures.find((measure) => measure.key === 'temperature').value).toBe(21.5);
      await request(app).get('/api/v1/iot/devices/SYN_99').expect(404);
      await request(app).get('/api/v1/iot/devices/bad%20name').expect(404);
    });

    test('live readings come from memory only', async () => {
      await knownDevice();
      say('sensors/SYN_01/temperature', '21.7');
      const res = await request(app).get(`/api/v1/iot/devices/${DEVICE}/live?measure=temperature`).expect(200);
      expect(res.body.data).toMatchObject({ device: DEVICE, status: 'online', ringSize: 60 });
      expect(res.body.data.measures.temperature.points.map((point) => point.value)).toEqual([21.5, 21.7]);
      expect(res.body.data.measures.temperature.unit).toBe('°C');
      await request(app).get(`/api/v1/iot/devices/${DEVICE}/live?measure=nope`).expect(400);
      expect(await db.collection(store.MINUTES).countDocuments()).toBe(0);
    });

    test('history: minute buckets, re-bucketing, hours with the open hour marked, several measures', async () => {
      await knownDevice();
      const hourNow = Math.floor(Date.now() / HOUR) * HOUR;
      const start = hourNow - 3 * HOUR;
      const buckets = [];
      for (let ms = start; ms < hourNow + 10 * MINUTE; ms += MINUTE) {
        buckets.push(minuteBucket(ms, 20 + ((ms / MINUTE) % 10)), minuteBucket(ms, 1000, 'pressure'));
      }
      await store.writeMinuteBuckets(db, buckets);
      await store.runRollup(db, new Date());
      const base = `/api/v1/iot/devices/${DEVICE}/history`;
      const from = new Date(start).toISOString();
      const to = new Date(hourNow + 10 * MINUTE).toISOString();

      const minute = await request(app).get(base).query({ measure: 'temperature', from, to, resolution: 'minute' }).expect(200);
      expect(minute.body.data).toMatchObject({ device: DEVICE, resolution: 'minute', bucket: 'minute', bucketSeconds: 60, source: 'minute', from, to });
      expect(Object.keys(minute.body.data.measures)).toEqual(['temperature']);
      const points = minute.body.data.measures.temperature.points;
      expect(points).toHaveLength(190);
      expect(points[0]).toEqual({
        ts: from, count: 12, min: points[0].median - 1, max: points[0].median + 1, mean: points[0].median, median: points[0].median,
        first: from, last: new Date(start + 55_000).toISOString(), buckets: 1
      });

      const five = await request(app).get(base).query({ measure: 'temperature', from, to, resolution: '5min' }).expect(200);
      const fivePoints = five.body.data.measures.temperature.points;
      expect(five.body.data).toMatchObject({ bucket: '5min', bucketSeconds: 300, source: 'minute' });
      expect(fivePoints).toHaveLength(38);
      const firstFive = points.slice(0, 5);
      expect(fivePoints[0]).toMatchObject({
        ts: from, count: 60, buckets: 5,
        min: Math.min(...firstFive.map((point) => point.min)), max: Math.max(...firstFive.map((point) => point.max)),
        mean: firstFive.reduce((sum, point) => sum + point.mean, 0) / 5,
        median: [...firstFive.map((point) => point.median)].sort((a, b) => a - b)[2]
      });

      const hourly = await request(app).get(base).query({ from, to, resolution: 'hour' }).expect(200);
      expect(hourly.body.data).toMatchObject({ bucket: 'hour', bucketSeconds: 3600, source: 'hour' });
      expect(Object.keys(hourly.body.data.measures).sort()).toEqual(['pressure', 'temperature']);
      const hourPoints = hourly.body.data.measures.temperature.points;
      expect(hourPoints.map((point) => [point.ts, point.count, point.buckets, point.partial === true])).toEqual([
        [new Date(start).toISOString(), 720, 1, false],
        [new Date(start + HOUR).toISOString(), 720, 1, false],
        [new Date(start + 2 * HOUR).toISOString(), 720, 1, false],
        [new Date(hourNow).toISOString(), 120, 1, true]
      ]);
      expect(hourly.body.data.measures.pressure.points[0]).toMatchObject({ count: 720, median: 1000, mean: 1000, min: 999, max: 1001 });
      expect(hourly.body.data.measures.pressure.unit).toBe('hPa');

      const day = await request(app).get(base).query({ measure: 'temperature', from, to, resolution: 'day' }).expect(200);
      const dayPoints = day.body.data.measures.temperature.points;
      expect(dayPoints.reduce((sum, point) => sum + point.count, 0)).toBe(190 * 12);
      expect(dayPoints.at(-1).partial).toBe(true);

      const auto = await request(app).get(base).query({ measure: 'temperature' }).expect(200);
      expect(auto.body.data).toMatchObject({ resolution: 'auto', bucket: 'minute' });
      const week = await request(app).get(base).query({ measure: 'temperature', from: new Date(Date.now() - 7 * DAY).toISOString() }).expect(200);
      expect(week.body.data).toMatchObject({ resolution: 'auto', bucket: '30min', bucketSeconds: 1800 });
      expect(week.body.data.measures.temperature.points.length).toBeLessThanOrEqual(8);

      const empty = await request(app).get(base).query({ measure: 'pressure', from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' }).expect(200);
      expect(empty.body.data).toMatchObject({ bucket: 'hour', measures: { pressure: { points: [] } } });

      await request(app).get(base).query({ measure: 'humidity' }).expect(400);
      await request(app).get(base).query({ resolution: 'second' }).expect(400);
      await request(app).get(base).query({ from: 'x' }).expect(400);
      await request(app).get(base).query({ from: '2020-01-01T00:00:00Z', resolution: 'minute' }).expect(400);
      await request(app).get('/api/v1/iot/devices/SYN_99/history').expect(404);
    });

    test('commands: validated, refused at once without a broker, and logged', async () => {
      await knownDevice();
      const base = `/api/v1/iot/devices/${DEVICE}/commands`;
      await request(app).post(base).send({ command: 'io_on' }).expect(400);
      await request(app).post(base).send({ command: 'io_on', gpio: 500 }).expect(400);
      await request(app).post(base).send({ command: 'configIOs', gpio: 2 }).expect(400);
      await request(app).post('/api/v1/iot/devices/SYN_99/commands').send({ command: 'reboot' }).expect(404);
      const refused = await request(app).post(base).send({ command: 'io_on', gpio: 4 }).expect(503);
      expect(refused.body).toMatchObject({ ok: false, error: expect.stringMatching(/not (configured|connected)/) });
      const logged = (await events()).filter((event) => event.type.startsWith('iot.command'));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ type: 'iot.command_failed', severity: 'warning', meta: { deviceId: DEVICE, command: 'io_on', gpio: 4, topic: 'esp32/SYN_01/io/on' } });
    });

    test('a sent command is logged with its topic', async () => {
      const service = iot.createIot({ monitor: { status: () => ({}), publish: async (message) => ({ ...message, publishedAt: new Date().toISOString() }) } });
      await service.ready(db);
      service.handleMessage('esp32/alive/SYN_01', Buffer.from('{}'));
      await service.sendCommand(db, DEVICE, { command: 'reboot' });
      const logged = (await events()).filter((event) => event.type.startsWith('iot.command'));
      expect(logged).toMatchObject([{ type: 'iot.command_sent', severity: 'info', meta: { command: 'reboot', gpio: null, topic: 'esp32/SYN_01/reboot' } }]);
    });
  });

  describe('activity log', () => {
    const T = Date.UTC(2026, 0, 5, 10, 0, 0);
    const monitor = { status: () => ({ configured: true, connected: true, connectedAt: new Date(T).toISOString() }), addListener: () => () => {} };

    async function boot(clock) {
      const service = iot.createIot({ now: () => new Date(clock.ms), monitor });
      await service.ready(db);
      const say = (topic, payload, packet) => service.handleMessage(topic, Buffer.from(String(payload)), packet);
      return { service, say };
    }
    const types = async () => (await events()).map((event) => event.type);

    test('first seen, online, offline, online again: one event per transition', async () => {
      const clock = { ms: T };
      const { service, say } = await boot(clock);
      say('sensors/SYN_01/temperature', '21');
      say('sensors/SYN_01/availability', 'online');
      say('sensors/SYN_01/availability', 'online');
      say('sensors/SYN_01/availability', 'offline');
      say('sensors/SYN_01/availability', 'offline', { retain: true });
      say('sensors/SYN_01/availability', 'online');
      await service.stop();
      expect(await types()).toEqual(['iot.device_first_seen', 'iot.device_online', 'iot.device_offline', 'iot.device_online']);
      const [first, , offline] = await events();
      expect(first).toMatchObject({ severity: 'info', message: 'IoT device SYN_01 was seen for the first time.', meta: { deviceId: DEVICE } });
      expect(offline).toMatchObject({ severity: 'warning', meta: { deviceId: DEVICE, previous: 'online', learnedFromRetained: false } });
    });

    test('a restart, and the broker replaying its retained state, report nothing twice', async () => {
      const clock = { ms: T };
      const first = await boot(clock);
      first.say('sensors/SYN_01/availability', 'online');
      first.say('homeassistant/device/SYN_02/config', '{"device":{"name":"SYN_02"}}', { retain: true });
      first.say('sensors/SYN_02/availability', 'offline', { retain: true });
      await first.service.stop();
      expect(await types()).toEqual(['iot.device_first_seen', 'iot.device_online', 'iot.device_first_seen']);

      clock.ms = T + HOUR;
      const second = await boot(clock);
      second.say('sensors/SYN_01/availability', 'online', { retain: true });
      second.say('sensors/SYN_02/availability', 'offline', { retain: true });
      second.say('sensors/SYN_01/temperature', '21');
      await second.service.stop();
      expect(await types()).toHaveLength(3);
      expect((await second.service.getDevice(db, DEVICE)).availability).toEqual({ state: 'online', since: new Date(T).toISOString() });
    });

    test('a device that went offline while Data was down is reported when the broker says so', async () => {
      const clock = { ms: T };
      const first = await boot(clock);
      first.say('sensors/SYN_01/availability', 'online');
      await first.service.stop();
      clock.ms = T + HOUR;
      const second = await boot(clock);
      second.say('sensors/SYN_01/availability', 'offline', { retain: true });
      await second.service.stop();
      expect((await types()).at(-1)).toBe('iot.device_offline');
      expect((await events()).at(-1).meta).toMatchObject({ previous: 'online', learnedFromRetained: true });
    });

    test('stale then recovered, once each, and not again after a restart', async () => {
      const clock = { ms: T };
      const first = await boot(clock);
      await first.service.start(db, { mqttMonitor: monitor, env: { NODE_ENV: 'test' } });
      first.say('sensors/SYN_01/availability', 'online');
      const registry = await first.service.ready(db);
      clock.ms = T + 6 * MINUTE;
      registry.sweepStale(new Date(clock.ms));
      registry.sweepStale(new Date(clock.ms + 1000));
      await first.service.stop();
      expect(await types()).toEqual(['iot.device_first_seen', 'iot.device_online', 'iot.device_stale']);
      expect((await events()).at(-1)).toMatchObject({ severity: 'warning', meta: { deviceId: DEVICE, silentForSeconds: 360 } });

      // Restart while stale: still stale, no second event; the next message recovers it.
      clock.ms = T + 30 * MINUTE;
      const second = await boot(clock);
      expect((await second.service.getDevice(db, DEVICE)).status).toBe('stale');
      second.say('sensors/SYN_01/availability', 'online', { retain: true });
      (await second.service.ready(db)).sweepStale(new Date(clock.ms + 10 * MINUTE));
      second.say('esp32/alive/SYN_01', '{}');
      second.say('esp32/alive/SYN_01', '{}');
      await second.service.stop();
      expect(await types()).toEqual(['iot.device_first_seen', 'iot.device_online', 'iot.device_stale', 'iot.device_recovered']);
      expect((await second.service.getDevice(db, DEVICE)).status).toBe('online');
    });

    test('ticks write closed minutes and the registry to MongoDB', async () => {
      const clock = { ms: T };
      const { service, say } = await boot(clock);
      for (let i = 0; i < 12; i++) { clock.ms = T + i * 5000; say('sensors/SYN_01/temperature', String(20 + (i % 2))); }
      clock.ms = T + 66_000;
      await service.tick();
      expect(strip(await minutes())).toEqual([{
        device: DEVICE, measure: 'temperature', ts: new Date(T), count: 12, min: 20, max: 21, mean: 20.5, median: 20.5,
        first: new Date(T), last: new Date(T + 55_000), parts: 1
      }]);
      const stored = await db.collection('iot_devices').findOne({ _id: DEVICE });
      expect(stored).toMatchObject({ lastSeenAt: new Date(T + 55_000), displayName: null, measures: [{ key: 'temperature', unit: '°C', value: 21 }] });
      await service.stop();
    });
  });
});
