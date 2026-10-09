/**
 * Integration test (REAL MongoDB) for Data's activity log: each event type is
 * produced by the fact it describes, transitions are reported once, and a
 * restart (a fresh watch over the same database) replays nothing.
 * Uses the launcher's disposable MongoDB.
 */
const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const { ensureIndexes } = require('../../utils/indexes');
const activityLog = require('../../services/activityLog');
const activityEvents = require('../../services/activityEvents');
const activityWatch = require('../../services/activityWatch');
const storageAgentService = require('../../services/storageAgentService');
const janitorRunner = require('../../services/janitorRunner');
const responseEnvelope = require('../../middleware/responseEnvelope');
const errorHandler = require('../../middleware/errorHandler');

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');
const TEST_DB = `${BASE_DB}_activity`;
const MINUTE = 60_000;

describe('activity log (integration, real Mongo)', () => {
  let client;
  let db;
  let app;

  const events = (type) => db.collection('appevents').find(type ? { type } : {}).sort({ timestamp: 1, _id: 1 }).toArray();
  const types = async () => (await events()).map(event => event.type);
  const later = (minutes) => new Date(Date.now() + minutes * MINUTE);
  const longAgo = () => new Date(Date.now() - 60 * MINUTE);

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
    app.use('/api/v1/network', require('../../routes/network.routes'));
    app.use('/api/v1/hardware', require('../../routes/hardware.routes'));
    app.use('/api/v1/events', require('../../routes/events.routes'));
    app.use(errorHandler);
  });

  afterAll(async () => {
    if (db) { try { await db.dropDatabase(); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  beforeEach(async () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    activityEvents._resetFeedRuns();
    for (const name of ['appevents', 'activity_state', 'nas_scans', 'nas_files', 'nas_directories', 'storage_scanners',
      'network_scanners', 'network_devices', 'hardware_collectors', 'hardware_hosts', 'hardware_gpu_samples',
      'janitor_runs', 'janitor_profiles', 'storage_trend_snapshots']) {
      await db.collection(name).deleteMany({});
    }
  });

  const storageHeartbeat = (scannerId = 'storage-test') => request(app).post('/api/v1/storage/agent/heartbeat')
    .send({ scannerId, hostname: 'nas-host', sources: 'media' }).expect(200);

  test('indexes: the 30-day TTL is kept and reads by type are indexed', async () => {
    const indexes = await db.collection('appevents').indexes();
    expect(indexes.find(index => index.name === 'ttl_30d')).toMatchObject({ key: { timestamp: 1 }, expireAfterSeconds: 2592000 });
    expect(indexes.find(index => index.name === 'type_timestamp')).toMatchObject({ key: { type: 1, timestamp: -1 } });
  });

  test('a storage scan is logged queued, started and finished complete with its headline counts', async () => {
    await storageHeartbeat();
    const queued = await request(app).post('/api/v1/storage/agent-scans').send({ source: 'media' }).expect(202);
    const scanId = queued.body.data.scan_id;
    // A second request joins the same scan: it is not queued twice.
    await request(app).post('/api/v1/storage/agent-scans').send({ source: 'media' }).expect(202);
    await request(app).get('/api/v1/storage/agent/requests').query({ scannerId: 'storage-test', sources: 'media' }).expect(200);
    await request(app).post(`/api/v1/storage/scan/${scanId}/batch`).send({ files: [
      { path: '/mnt/media/Movies/a.mkv', size: 100, mtime: 1700000000 },
      { path: '/mnt/media/Movies/b.mkv', size: 200, mtime: 1700000001 },
      { path: '/mnt/media/Music/c.flac', size: 30, mtime: 1700000002 }
    ] }).expect(200);
    await request(app).patch(`/api/v1/storage/scan/${scanId}`)
      .send({ status: 'completed', stats: { files_seen: 3, files_processed: 3 }, completedAt: new Date().toISOString() }).expect(200);
    // A repeated completion is answered "already finalized" and logs nothing more.
    await request(app).patch(`/api/v1/storage/scan/${scanId}`).send({ status: 'completed' }).expect(200);

    expect(await types()).toEqual(['collector.first_seen', 'storage.scan_queued', 'storage.scan_started', 'storage.scan_finished']);
    const [queuedEvent] = await events('storage.scan_queued');
    expect(queuedEvent).toMatchObject({ severity: 'info', meta: { scanId, source: 'media', external: true, roots: ['/mnt/media'] } });
    expect((await events('storage.scan_started'))[0]).toMatchObject({
      message: 'Storage scan of /mnt/media started by collector storage-test.', meta: { scanId, scannerId: 'storage-test' }
    });
    const [finished] = await events('storage.scan_finished');
    expect(finished).toMatchObject({
      severity: 'info',
      message: 'Storage scan of /mnt/media ended complete: 3 files seen.',
      meta: { scanId, outcome: 'complete', reason: null, counts: { files_seen: 3, files_processed: 3, inserted: 3, stale_removed: 0, directories: 2 } }
    });
    expect(finished.meta.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(finished)).not.toContain('a.mkv');
  });

  test('a scan that kept a stale index ends partial with the reason, and a failed scan is an error', async () => {
    await db.collection('nas_files').insertOne({ path: '/mnt/media/old.mkv', dirname: '/mnt/media', source_root: '/mnt/media', size: 1, scan_id: 'earlier' });
    const running = (id) => ({
      _id: id, type: 'external-storage-agent', status: 'running', started_at: new Date(), last_heartbeat_at: new Date(),
      counts: {}, config: { external: true, source: 'media', roots: ['/mnt/media'] }
    });
    await db.collection('nas_scans').insertOne(running('scan-partial'));
    await request(app).patch('/api/v1/storage/scan/scan-partial').send({ status: 'completed', stats: { files_seen: 0 } }).expect(200);
    await db.collection('nas_scans').insertOne(running('scan-failed'));
    await request(app).patch('/api/v1/storage/scan/scan-failed').send({ status: 'failed' }).expect(200);
    // A late report on an ended scan is refused and logs nothing.
    await request(app).patch('/api/v1/storage/scan/scan-failed').send({ status: 'completed' }).expect(409);

    const finished = await events('storage.scan_finished');
    expect(finished).toHaveLength(2);
    expect(finished[0]).toMatchObject({
      severity: 'warning',
      message: 'Storage scan of /mnt/media ended partial: Scan indexed no file under /mnt/media; existing index rows were kept.',
      meta: { scanId: 'scan-partial', outcome: 'partial', reason: 'Scan indexed no file under /mnt/media; existing index rows were kept' }
    });
    expect(finished[1]).toMatchObject({ severity: 'error', meta: { scanId: 'scan-failed', outcome: 'failed' } });
    expect(await db.collection('storage_trend_snapshots').countDocuments()).toBe(0);
  });

  test('the reaper logs each scan it fails, once', async () => {
    const old = new Date(Date.now() - 20 * MINUTE);
    await db.collection('nas_scans').insertMany([
      { _id: 'silent', type: 'external-storage-agent', status: 'running', started_at: old, last_heartbeat_at: old, claimed_by: 'storage-test',
        counts: { files_processed: 12 }, config: { external: true, source: 'media', roots: ['/mnt/media'] } },
      { _id: 'unclaimed', type: 'external-storage-agent', status: 'queued', requested_at: new Date(Date.now() - 7 * 60 * MINUTE), started_at: null,
        counts: {}, config: { external: true, source: 'datalake', roots: ['/mnt/datalake'] } }
    ]);
    await request(app).get('/api/v1/storage/scans').expect(200);
    await request(app).get('/api/v1/storage/scans').expect(200);
    await activityWatch.sweep(db);

    const expired = await events('storage.scan_expired');
    expect(expired.map(event => event.meta.scanId).sort()).toEqual(['silent', 'unclaimed']);
    const silent = expired.find(event => event.meta.scanId === 'silent');
    expect(silent).toMatchObject({ severity: 'error', meta: { outcome: 'failed', wasQueued: false, claimedBy: 'storage-test', counts: { files_processed: 12 } } });
    expect(silent.message).toMatch(/failed by the reaper: No heartbeat or batch/);
    expect(expired.find(event => event.meta.scanId === 'unclaimed').meta.wasQueued).toBe(true);
  });

  test('the watch alone reaps a dead scan when nobody asks for scans', async () => {
    const old = new Date(Date.now() - 20 * MINUTE);
    await db.collection('nas_scans').insertOne({ _id: 'dead', type: 'external-storage-agent', status: 'running', started_at: old,
      last_heartbeat_at: old, counts: {}, config: { external: true, source: 'media', roots: ['/mnt/media'] } });
    expect(await activityWatch.sweep(db)).toMatchObject({ scansExpired: 1 });
    expect((await db.collection('nas_scans').findOne({ _id: 'dead' })).status).toBe('failed');
    expect(await events('storage.scan_expired')).toHaveLength(1);
  });

  test('each kind of collector is announced once, on its first report only', async () => {
    await storageHeartbeat();
    await storageHeartbeat();
    await request(app).get('/api/v1/network/scan-requests').query({ scannerId: 'network-test', hostname: 'lan-host' }).expect(200);
    await request(app).get('/api/v1/network/scan-requests').query({ scannerId: 'network-test' }).expect(200);
    const gpuCollector = { collectorId: 'gpu-test', hostname: 'gpu-host', intervalMs: 30000, hosts: [{ id: 'gpu-a', name: 'GPU A' }] };
    await request(app).post('/api/v1/hardware/collector/heartbeat').send(gpuCollector).expect(200);
    await request(app).post('/api/v1/hardware/samples').send({ ...gpuCollector, results: [] }).expect(200);

    const first = await events('collector.first_seen');
    expect(first.map(event => [event.meta.kind, event.meta.collectorId, event.meta.hostname])).toEqual([
      ['storage', 'storage-test', 'nas-host'], ['network', 'network-test', 'lan-host'], ['gpu', 'gpu-test', 'gpu-host']
    ]);
    expect(first[0].message).toBe('The storage collector storage-test reported for the first time.');
    expect(await types()).toHaveLength(3);
  });

  test('a collector gone silent is logged once, a restart replays nothing, and its return is logged', async () => {
    await storageHeartbeat();
    const boot = longAgo();
    // Four minutes of silence is a reboot, not an event.
    expect((await activityWatch.sweep(db, later(4), boot)).collectorsSilent).toBe(0);
    expect((await activityWatch.sweep(db, later(6), boot)).collectorsSilent).toBe(1);
    expect((await activityWatch.sweep(db, later(7), boot)).collectorsSilent).toBe(0);
    // Data restarts while the collector is still away: a new watch, the same database.
    expect((await activityWatch.sweep(db, later(30), later(8))).collectorsSilent).toBe(0);

    const [silent] = await events('collector.silent');
    expect(silent).toMatchObject({ severity: 'warning', meta: { kind: 'storage', collectorId: 'storage-test', hostname: 'nas-host' } });
    expect(silent.message).toBe('The storage collector storage-test has not reported for 6 minutes.');
    expect(silent.meta.silentForSeconds).toBeGreaterThanOrEqual(359);

    await storageHeartbeat();
    await storageHeartbeat();
    expect(await types()).toEqual(['collector.first_seen', 'collector.silent', 'collector.back']);
    expect((await events('collector.back'))[0].message).toBe('The storage collector storage-test is reporting again.');
  });

  test('a restart is not a silence: the wait is counted from the start of Data', async () => {
    await storageHeartbeat();
    await db.collection('storage_scanners').updateOne({ scannerId: 'storage-test' }, { $set: { lastSeen: longAgo() } });
    const boot = new Date();
    // Data was down for an hour and has just started: it could not have heard anyone.
    expect((await activityWatch.sweep(db, new Date(boot.getTime() + MINUTE), boot)).collectorsSilent).toBe(0);
    expect((await activityWatch.sweep(db, new Date(boot.getTime() + 6 * MINUTE), boot)).collectorsSilent).toBe(1);
  });

  test('a collector already registered and already silent before the log existed is not announced', async () => {
    await db.collection('storage_scanners').insertOne({ scannerId: 'old-timer', hostname: 'retired', sources: ['media'], firstSeen: longAgo(), lastSeen: longAgo() });
    await db.collection('network_scanners').insertOne({ scannerId: 'known-net', firstSeen: longAgo(), lastSeen: new Date() });
    expect((await activityWatch.sweep(db, later(6), longAgo())).collectorsSilent).toBe(0);
    // A known collector that keeps reporting is not "first seen" either.
    await request(app).get('/api/v1/network/scan-requests').query({ scannerId: 'known-net' }).expect(200);
    expect(await types()).toEqual([]);
    expect(await db.collection('activity_state').findOne({ _id: 'collector:storage:old-timer' })).toBeNull();
    // If it ever reports again it is simply active: no "back" without a "silent".
    await storageHeartbeat('old-timer');
    expect(await types()).toEqual([]);
  });

  test('a GPU host going stale and coming back is logged once each', async () => {
    const collector = { collectorId: 'gpu-test', hostname: 'gpu-host', intervalMs: 30000, hosts: [{ id: 'gpu-a', name: 'GPU A' }, { id: 'gpu-b', name: 'GPU B' }] };
    const cycle = (aOk) => request(app).post('/api/v1/hardware/samples').send({ ...collector, results: [
      aOk ? { hostId: 'gpu-a', ok: true, sampledAt: new Date().toISOString(), gpus: [{ index: 0, name: 'Synthetic GPU' }] }
        : { hostId: 'gpu-a', ok: false, sampledAt: new Date().toISOString(), error: 'ssh: connect timed out' },
      // gpu-b never gave a sample: it has nothing to go stale.
      { hostId: 'gpu-b', ok: false, sampledAt: new Date().toISOString(), error: 'unreachable' }
    ] }).expect(200);
    await cycle(true);
    await cycle(true);
    await cycle(false);
    const boot = longAgo();
    expect((await activityWatch.sweep(db, later(4), boot)).gpuHostsStale).toBe(0);
    expect((await activityWatch.sweep(db, later(6), boot)).gpuHostsStale).toBe(1);
    expect((await activityWatch.sweep(db, later(7), boot)).gpuHostsStale).toBe(0);
    expect((await activityWatch.sweep(db, later(30), later(8))).gpuHostsStale).toBe(0);

    const [stale] = await events('gpu.host_stale');
    expect(stale).toMatchObject({
      severity: 'warning',
      message: 'GPU host GPU A has had no successful sample for 6 minutes: ssh: connect timed out.',
      meta: { hostId: 'gpu-a', name: 'GPU A', collectorId: 'gpu-test', lastError: 'ssh: connect timed out', consecutiveFailures: 1 }
    });
    await cycle(true);
    await cycle(true);
    const recovered = await events('gpu.host_recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ severity: 'info', message: 'GPU host GPU A is sampled again.', meta: { hostId: 'gpu-a' } });
    expect((await events()).filter(event => event.meta.hostId === 'gpu-b')).toEqual([]);
  });

  test('a network device is logged the first time it is seen, not on every sweep', async () => {
    const sweep = (devices) => request(app).post('/api/v1/network/scan-results')
      .send({ scannerId: 'network-test', devices, pruneMissing: true }).expect(200);
    const printer = { ip: '192.0.2.10', mac: 'AA:BB:CC:00:00:10', hostname: 'printer', vendor: 'Synthetic Printers' };
    const noMac = { ip: '192.0.2.11', mac: '', hostname: '', vendor: '' };
    await sweep([printer, noMac]);
    await sweep([printer, noMac]);
    await sweep([{ ...printer, ip: '192.0.2.99' }, noMac, { ip: '192.0.2.12', mac: 'AA:BB:CC:00:00:12', hostname: 'tv', vendor: '' }]);

    const seen = await events('network.device_first_seen');
    expect(seen.map(event => event.meta.ip)).toEqual(['192.0.2.10', '192.0.2.11', '192.0.2.12']);
    expect(seen[0]).toMatchObject({
      severity: 'info',
      message: 'Network device 192.0.2.10 (AA:BB:CC:00:00:10) seen for the first time: printer, Synthetic Printers.',
      meta: { count: 1, scanSource: 'network-test', ip: '192.0.2.10', mac: 'AA:BB:CC:00:00:10', vendor: 'Synthetic Printers', hostname: 'printer' }
    });
    expect(seen[1]).toMatchObject({ message: 'Network device 192.0.2.11 seen for the first time.', meta: { mac: null, vendor: null } });
  });

  test('a first sweep of a large network is one summary event, bounded', async () => {
    const devices = Array.from({ length: 60 }, (_, i) => ({
      ip: `192.0.2.${i + 1}`, mac: `AA:BB:CC:00:01:${String(i).padStart(2, '0')}`, hostname: `host-${i}`, vendor: 'Synthetic'
    }));
    await request(app).post('/api/v1/network/scan-results').send({ scannerId: 'network-test', devices }).expect(200);
    const seen = await events('network.device_first_seen');
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe('60 network devices were seen for the first time by network-test.');
    expect(seen[0].meta).toMatchObject({ count: 60, devicesOmitted: 35 });
    expect(seen[0].meta.devices).toHaveLength(25);
    expect(Buffer.byteLength(JSON.stringify(seen[0].meta))).toBeLessThanOrEqual(activityLog.MAX_META_BYTES);
  });

  test('a janitor run that ends is logged with its outcome', async () => {
    janitorRunner._reset();
    const profile = await db.collection('janitor_profiles').insertOne({
      name: 'Synthetic profile', roots: ['/nonexistent-agentx-activity-test-root'], policies: [],
      extensions: { include: [], exclude: [] }, hashMode: 'none', schedule: { enabled: false }, aiTriage: false
    });
    const result = await janitorRunner.runProfile(db, String(profile.insertedId));
    expect(result.ok).toBe(false);
    const [finished] = await events('janitor.run_finished');
    expect(finished).toMatchObject({
      severity: 'error',
      meta: { runId: String(result.run_id), profileName: 'Synthetic profile', status: 'failed', proposedActions: 0 }
    });
    expect(finished.message).toMatch(/^Janitor run of profile "Synthetic profile" ended failed: roots: /);
    expect(await db.collection('nas_scans').countDocuments()).toBe(0);

    // The sentence of a run that completed, from its stored document.
    const run = await db.collection('janitor_runs').insertOne({
      profile_id: profile.insertedId, profile_name: 'Synthetic profile', status: 'complete', scan_id: 'scan-1',
      started_at: new Date(Date.now() - 90_000), finished_at: new Date(), proposed_actions: [{}, {}], proposed_actions_omitted: 3, error: null
    });
    await activityEvents.janitorRunFinished(db, run.insertedId);
    expect((await events('janitor.run_finished'))[1]).toMatchObject({
      severity: 'info', message: 'Janitor run of profile "Synthetic profile" ended complete: 2 proposed actions.',
      meta: { status: 'complete', proposedActions: 2, proposedActionsOmitted: 3, durationSeconds: 90 }
    });
  });

  test('a live feed is logged when it starts to fail and when it recovers, never per failed fetch', async () => {
    const iss = { id: 'iss', label: 'ISS position', intervalMs: 10_000 };
    const down = new Error('ISS position failed: 503 Service Unavailable');
    await activityEvents.feedRun(db, iss, null);
    await activityEvents.feedRun(db, iss, down);
    await activityEvents.feedRun(db, iss, down);
    expect(await types()).toEqual([]);
    for (let i = 0; i < 10; i++) await activityEvents.feedRun(db, iss, down);
    expect(await types()).toEqual(['livedata.feed_failing']);
    expect((await events('livedata.feed_failing'))[0]).toMatchObject({
      severity: 'warning', message: 'Live feed ISS position is failing: ISS position failed: 503 Service Unavailable.',
      meta: { feedId: 'iss', consecutiveFailures: 3 }
    });

    // Data restarts while the feed is still down: nothing is said again.
    activityEvents._resetFeedRuns();
    for (let i = 0; i < 5; i++) await activityEvents.feedRun(db, iss, down);
    expect(await types()).toEqual(['livedata.feed_failing']);

    await activityEvents.feedRun(db, iss, null);
    await activityEvents.feedRun(db, iss, null);
    expect(await types()).toEqual(['livedata.feed_failing', 'livedata.feed_recovered']);

    // A feed fetched every 15 minutes is failing at its first failed run.
    await activityEvents.feedRun(db, { id: 'pressure', label: 'Pressure', intervalMs: 900_000 }, new Error('no key'));
    expect((await events('livedata.feed_failing')).map(event => event.meta.feedId)).toEqual(['iss', 'pressure']);
  });

  test('the MQTT monitor link is logged lost and restored, not at each start', async () => {
    const detail = { broker: 'broker.example:1883', everConnected: true };
    await activityEvents.mqttMonitorState(db, 'connected', { ...detail, everConnected: false });
    expect(await types()).toEqual([]);
    await activityEvents.mqttMonitorState(db, 'disconnected', { ...detail, error: 'connect ECONNREFUSED' });
    // Data restarts with the broker still away, then the broker returns.
    await activityEvents.mqttMonitorState(db, 'disconnected', { ...detail, everConnected: false });
    await activityEvents.mqttMonitorState(db, 'connected', detail);
    // Data restarts with the broker healthy.
    await activityEvents.mqttMonitorState(db, 'connected', { ...detail, everConnected: false });

    expect(await types()).toEqual(['mqtt.monitor_disconnected', 'mqtt.monitor_connected']);
    expect((await events('mqtt.monitor_disconnected'))[0]).toMatchObject({
      severity: 'warning', message: 'The MQTT monitor lost its connection to broker.example:1883.',
      meta: { broker: 'broker.example:1883', error: 'connect ECONNREFUSED' }
    });
  });

  test('a log that cannot be written never breaks the operation it describes', async () => {
    const broken = {
      collection: (name) => {
        if (name === 'appevents' || name === 'activity_state') throw new Error('log store down');
        return db.collection(name);
      }
    };
    await expect(storageAgentService.registerScanner(broken, { scannerId: 'storage-test', sources: 'media' })).resolves.toBe('storage-test');
    const queued = await storageAgentService.enqueueScan(broken, { source: 'media' });
    expect(queued.ok).toBe(true);
    expect(await storageAgentService.claimNextScan(broken, 'storage-test', ['media'])).toMatchObject({ _id: queued.scan._id, status: 'running' });
    await expect(activityWatch.sweep(broken, later(6), longAgo())).resolves.toMatchObject({ collectorsSilent: 0 });
    expect(await db.collection('appevents').countDocuments()).toBe(0);
  });

  test('GET /events filters by type prefix, severity and time, with bounded paging', async () => {
    const base = Date.parse('2026-10-01T00:00:00Z');
    const rows = [
      ['storage.scan_queued', 'info'], ['storage.scan_started', 'info'], ['storage.scan_finished', 'warning'],
      ['storage.scan_expired', 'error'], ['collector.silent', 'warning'], ['gpu.host_stale', 'warning']
    ];
    for (const [index, [type, severity]] of rows.entries()) {
      await activityLog.record(db, { type, severity, message: `Event ${index}.`, meta: { index }, at: new Date(base + index * 3600_000) });
    }
    const get = (query) => request(app).get('/api/v1/events').query(query);

    const all = (await get({}).expect(200)).body.data;
    expect(all.pagination).toEqual({ total: 6, page: 1, limit: 50, pages: 1 });
    expect(all.events[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{24}$/), type: 'gpu.host_stale', severity: 'warning',
      message: 'Event 5.', meta: { index: 5 }, at: '2026-10-01T05:00:00.000Z'
    });

    expect((await get({ type: 'storage' }).expect(200)).body.data.events.map(event => event.type))
      .toEqual(['storage.scan_expired', 'storage.scan_finished', 'storage.scan_started', 'storage.scan_queued']);
    expect((await get({ type: 'storage.scan_f' }).expect(200)).body.data.events).toHaveLength(1);
    expect((await get({ type: 'storageX' }).expect(400)).body.message).toMatch(/type must be/);
    expect((await get({ severity: 'warning' }).expect(200)).body.data.pagination.total).toBe(3);
    expect((await get({ type: 'storage', severity: 'error' }).expect(200)).body.data.events.map(event => event.type)).toEqual(['storage.scan_expired']);

    const windowed = (await get({ since: '2026-10-01T01:00:00Z', until: '2026-10-01T03:00:00Z' }).expect(200)).body.data;
    expect(windowed.events.map(event => event.meta.index)).toEqual([3, 2, 1]);
    expect(windowed.filters).toEqual({ since: '2026-10-01T01:00:00.000Z', until: '2026-10-01T03:00:00.000Z' });

    const paged = (await get({ limit: 4, page: 2 }).expect(200)).body.data;
    expect(paged.events.map(event => event.meta.index)).toEqual([1, 0]);
    expect(paged.pagination).toEqual({ total: 6, page: 2, limit: 4, pages: 2 });
    expect((await get({ limit: 'many', page: 'first' }).expect(200)).body.data.pagination).toMatchObject({ page: 1, limit: 50 });
    expect((await get({ limit: 100000 }).expect(200)).body.data.pagination.limit).toBe(200);
  });

  test('POST /events stores a validated external event and nothing else', async () => {
    const created = await request(app).post('/api/v1/events')
      .send({ type: 'external.core_watch', severity: 'warning', message: 'Core noticed something.', meta: { device: '192.0.2.10' } }).expect(201);
    expect(created.body.data).toMatchObject({ type: 'external.core_watch', severity: 'warning', meta: { device: '192.0.2.10' } });
    await request(app).post('/api/v1/events').send({ type: 'collector.silent', message: 'forged' }).expect(400);
    await request(app).post('/api/v1/events').send({ message: 'm', meta: { $where: '1' }, extra: true }).expect(400);
    expect(await types()).toEqual(['external.core_watch']);
  });
});
