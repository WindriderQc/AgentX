const request = require('supertest');
const express = require('express');
const { ObjectId } = require('mongodb');

jest.mock('../../services/networkScanner', () => ({
  scanNetwork: jest.fn(),
  enrichDevice: jest.fn(),
  parseNmapOutput: jest.fn()
}));

const networkScanner = require('../../services/networkScanner');
const networkRoutes = require('../../routes/network.routes');

// ─── DB mock ───────────────────────────────────────────────
// A cursor that supports the chains the code uses: find().sort().limit().toArray()
// and find().toArray().
function makeCursor(data = []) {
  const cursor = {
    sort: jest.fn(() => cursor),
    limit: jest.fn(() => cursor),
    toArray: jest.fn().mockResolvedValue(data)
  };
  return cursor;
}

function makeCollection(overrides = {}) {
  return {
    bulkWrite: jest.fn().mockResolvedValue({}),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    updateOne: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue(null),
    findOneAndUpdate: jest.fn().mockResolvedValue(null),
    find: jest.fn(() => makeCursor([])),
    ...overrides
  };
}

// collections: { [name]: overrides } — each name gets its own collection mock.
function buildDb(collections = {}) {
  const built = {};
  const getColl = (name) => {
    if (!built[name]) built[name] = makeCollection(collections[name] || {});
    return built[name];
  };
  return { collection: jest.fn(getColl), coll: getColl };
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/v1/network', networkRoutes);
  app.use((err, req, res, _next) => {
    res.status(500).json({ status: 'error', message: err.message });
  });
  return app;
}

function createMissingDependencyError() {
  const error = new Error('nmap is not installed on the host. Install nmap to use network scanning.');
  error.code = 'DEPENDENCY_MISSING';
  error.dependency = 'nmap';
  return error;
}

// A scanner doc that counts as "active" (lastSeen = now).
function activeScannerDoc() {
  return { scannerId: 's1', hostname: 'windows-node', lastSeen: new Date() };
}

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.NETWORK_AGENT_TOKEN;
  delete process.env.NODE_ENV;
});

describe('POST /api/v1/network/scan', () => {
  test('returns 400 for an invalid scan target', async () => {
    const res = await request(buildApp(buildDb()))
      .post('/api/v1/network/scan')
      .send({ target: '--top-ports 10' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid target format/);
    expect(networkScanner.scanNetwork).not.toHaveBeenCalled();
  });

  test.each([
    '0.0.0.0/0', '10.0.0.0/8', '192.0.2.0/15', '192.0.2.0/33', '999.1.1.1/24', '192.0.2.256', '192.0.2.0/24/24'
  ])('returns 400 for out-of-range target %s without queueing or scanning', async (target) => {
    const db = buildDb({
      network_scanners: { findOne: jest.fn().mockResolvedValue(activeScannerDoc()) }
    });

    const res = await request(buildApp(db)).post('/api/v1/network/scan').send({ target });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid target format/);
    expect(networkScanner.scanNetwork).not.toHaveBeenCalled();
    expect(db.coll('network_scan_requests').insertOne).not.toHaveBeenCalled();
  });

  test.each(['192.0.2.0/16', '192.0.2.7/32', '192.0.2.7'])('accepts target %s', async (target) => {
    networkScanner.scanNetwork.mockResolvedValue([]);
    const res = await request(buildApp(buildDb())).post('/api/v1/network/scan').send({ target });
    expect(res.status).toBe(200);
    expect(networkScanner.scanNetwork).toHaveBeenCalledWith(target);
  });

  test('in-container fallback returns scan totals when no agent is active', async () => {
    const db = buildDb();
    networkScanner.scanNetwork.mockResolvedValue([
      { ip: '192.0.2.10', mac: 'AA:BB:CC:DD:EE:FF', hostname: 'printer', vendor: 'HP' }
    ]);

    const res = await request(buildApp(db))
      .post('/api/v1/network/scan')
      .send({ target: '192.0.2.0/24' });

    expect(res.status).toBe(200);
    expect(res.body.data.discovered).toBe(1);
    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.mode).toBe('in-container');
    expect(db.coll('network_devices').bulkWrite).toHaveBeenCalledTimes(1);
  });

  test('enqueues a job (202) when a scanner agent is active', async () => {
    const db = buildDb({
      network_scanners: { findOne: jest.fn().mockResolvedValue(activeScannerDoc()) }
    });

    const res = await request(buildApp(db))
      .post('/api/v1/network/scan')
      .send({ target: '192.0.2.0/24' });

    expect(res.status).toBe(202);
    expect(res.body.data.mode).toBe('agent');
    expect(res.body.data.jobId).toBeTruthy();
    expect(networkScanner.scanNetwork).not.toHaveBeenCalled();
    expect(db.coll('network_scan_requests').insertOne).toHaveBeenCalledTimes(1);
  });

  test('returns 503 when nmap is missing and no agent is active', async () => {
    networkScanner.scanNetwork.mockRejectedValue(createMissingDependencyError());

    const res = await request(buildApp(buildDb()))
      .post('/api/v1/network/scan')
      .send({ target: '192.0.2.0/24' });

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/Scan unavailable/);
    expect(res.body.message).toMatch(/nmap is not installed/);
  });
});

describe('POST /api/v1/network/scan-results (agent ingest)', () => {
  test('ingests a pre-parsed devices[] array, tagging scanSource', async () => {
    const db = buildDb();
    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({
        scannerId: 'windows-node', scanSource: 'windows-node', format: 'devices',
        devices: [{ ip: '192.0.2.20', mac: '11:22:33:44:55:66', hostname: 'nas', vendor: 'Synology' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.discovered).toBe(1);
    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.scanSource).toBe('windows-node');
    expect(db.coll('network_devices').bulkWrite).toHaveBeenCalledTimes(1);
    // scanner heartbeat registered
    expect(db.coll('network_scanners').updateOne).toHaveBeenCalledTimes(1);
  });

  test('ingests ≥2 MAC-less devices in one batch, keying each by IP (partial-index safe)', async () => {
    // nmap reports some hosts without a MAC (the scanning host itself, L3 devices).
    // The upsert stores those as `mac: ''` but must key them by IP so the partial
    // unique index on `mac` lets them coexist — instead of a 2nd `mac: ''` insert
    // triggering E11000 and (ordered bulkWrite) dropping the whole batch.
    const db = buildDb();
    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({
        scannerId: 'windows-node', scanSource: 'windows-node', format: 'devices',
        devices: [
          { ip: '192.0.2.1', mac: '', hostname: 'gateway', vendor: '' },   // MAC-less (L3)
          { ip: '192.0.2.12', mac: '', hostname: 'windows-node', vendor: '' }, // MAC-less (scanning host itself)
          { ip: '192.0.2.20', mac: '11:22:33:44:55:66', hostname: 'nas', vendor: 'Synology' }
        ]
      });

    // Whole batch lands — no per-device dup-key failure surfaces as HTTP 500.
    expect(res.status).toBe(200);
    expect(res.body.data.discovered).toBe(3);

    const coll = db.coll('network_devices');
    expect(coll.bulkWrite).toHaveBeenCalledTimes(1);
    const ops = coll.bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(3);

    // Both MAC-less devices are keyed by IP (NOT a shared `{ mac: '' }` identity),
    // and write `mac: ''`. The partial index excludes empty MACs from uniqueness,
    // so these two `mac: ''` docs do not collide.
    const macless = ops.filter((o) => o.updateOne.update.$set.mac === '');
    expect(macless).toHaveLength(2);
    for (const op of macless) {
      expect(op.updateOne.upsert).toBe(true);
      expect(op.updateOne.filter).toHaveProperty('ip');
      expect(op.updateOne.filter.mac).toEqual({ $in: [null, ''] });
    }
    // ...and they target distinct IPs → distinct documents.
    expect(new Set(macless.map((o) => o.updateOne.filter.ip)).size).toBe(2);

    // The MAC-bearing device is still keyed by its MAC.
    const withMac = ops.find((o) => o.updateOne.update.$set.mac === '11:22:33:44:55:66');
    expect(withMac.updateOne.filter).toEqual({ mac: '11:22:33:44:55:66' });
  });

  test('drops and counts entries whose ip, mac, hostname or vendor is not a plain valid value', async () => {
    const db = buildDb();
    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({
        scannerId: 'windows-node', scanSource: 'windows-node', format: 'devices',
        devices: [
          { ip: '192.0.2.20', mac: '11:22:33:44:55:66', hostname: 'nas', vendor: 'Synology' },
          { ip: '192.0.2.21', mac: { $ne: '' } },          // operator object as mac
          { ip: { $gt: '' }, mac: '' },                    // operator object as ip
          { ip: '-iL /etc/hosts' },                        // nmap option as ip
          { ip: '192.0.2.300' },                           // octet out of range
          { ip: '192.0.2.22', mac: 'not-a-mac' },
          { ip: '192.0.2.23', hostname: { $where: '1' } },
          { ip: '192.0.2.24', vendor: ['x'] },
          null,
          'device'
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ discovered: 1, updated: 1, rejected: 9 });
    const ops = db.coll('network_devices').bulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.filter).toEqual({ mac: '11:22:33:44:55:66' });
  });

  test('keeps a MAC as posted and cuts an over-long hostname or vendor', async () => {
    const db = buildDb();
    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({
        scannerId: 'x', scanSource: 'x', format: 'devices',
        devices: [{ ip: '192.0.2.20', mac: 'aa-bb-cc-dd-ee-ff', hostname: 'h'.repeat(400), vendor: 'v'.repeat(400) }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.rejected).toBe(0);
    const { filter, update } = db.coll('network_devices').bulkWrite.mock.calls[0][0][0].updateOne;
    expect(filter).toEqual({ mac: 'aa-bb-cc-dd-ee-ff' });
    expect(update.$set.hostname).toHaveLength(253);
    expect(update.$set.vendor).toHaveLength(128);
  });

  // What the owner records about a device (PATCH /devices/:id) must survive
  // every later sweep: a sweep only rewrites what the collector observed.
  test('a sweep never writes the name, known flag, type, location or notes of an existing device', async () => {
    const db = buildDb();
    await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({
        scannerId: 'x', scanSource: 'x', format: 'devices', pruneMissing: true,
        devices: [{ ip: '192.0.2.20', mac: 'AA:BB:CC:DD:EE:FF', hostname: 'h', vendor: 'v' }, { ip: '192.0.2.21' }]
      })
      .expect(200);

    const ownerFields = ['alias', 'notes', 'location', 'knownAt', 'hardware', 'hardware.type'];
    for (const { updateOne } of db.coll('network_devices').bulkWrite.mock.calls[0][0]) {
      expect(Object.keys(updateOne.update).sort()).toEqual(['$set', '$setOnInsert']);
      expect(Object.keys(updateOne.update.$set).sort())
        .toEqual(['hostname', 'ip', 'lastScanAt', 'lastSeen', 'mac', 'scanSource', 'status', 'vendor']);
      for (const field of ownerFields) expect(updateOne.update.$set).not.toHaveProperty([field]);
      // Only a device seen for the first time gets empty defaults.
      expect(updateOne.update.$setOnInsert).toEqual({ firstSeen: expect.any(Date), alias: '', notes: '' });
    }
  });

  test('pruneMissing marks offline only this source\'s devices missing from a non-empty result', async () => {
    const db = buildDb({
      network_devices: {
        find: jest.fn(() => makeCursor([
          { _id: 'seen', ip: '192.0.2.20', status: 'online', scanSource: 'x' },
          { _id: 'gone', ip: '192.0.2.99', status: 'online', scanSource: 'x' }
        ]))
      }
    });
    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({ scannerId: 'x', scanSource: 'x', format: 'devices', pruneMissing: true, devices: [{ ip: '192.0.2.20' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.markedOffline).toBe(1);
    expect(res.body.data.pruneSkipped).toBeUndefined();
    const coll = db.coll('network_devices');
    expect(coll.find).toHaveBeenCalledWith({ status: 'online', scanSource: 'x' });
    expect(coll.bulkWrite.mock.calls[1][0]).toEqual([
      { updateOne: { filter: { _id: 'gone' }, update: { $set: { status: 'offline' } } } }
    ]);
  });

  test.each([
    ['an empty result', []],
    ['a result with only invalid entries', [{ ip: { $gt: '' } }]]
  ])('pruneMissing leaves every device untouched on %s', async (_label, devices) => {
    const db = buildDb({
      network_devices: {
        find: jest.fn(() => makeCursor([{ _id: 'd1', ip: '192.0.2.20', status: 'online', scanSource: 'x' }]))
      }
    });
    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({ scannerId: 'x', scanSource: 'x', format: 'devices', pruneMissing: true, devices });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ discovered: 0, markedOffline: 0, pruneSkipped: 'no valid device reported' });
    expect(db.coll('network_devices').bulkWrite).not.toHaveBeenCalled();
    expect(db.coll('network_devices').find).not.toHaveBeenCalled();
  });

  test('400 on nmap XML that does not parse, leaving devices, heartbeat and the request untouched', async () => {
    const db = buildDb();
    const parseError = new Error('Invalid nmap XML: Unclosed root tag');
    parseError.code = 'NMAP_XML_INVALID';
    networkScanner.parseNmapOutput.mockRejectedValue(parseError);

    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({
        scannerId: 'linux-node', scanSource: 'linux-node', format: 'nmap-xml', xml: '<nmaprun><host>',
        pruneMissing: true, requestId: new ObjectId().toString()
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid nmap XML/);
    expect(db.coll('network_devices').bulkWrite).not.toHaveBeenCalled();
    expect(db.coll('network_devices').find).not.toHaveBeenCalled();
    expect(db.coll('network_scanners').updateOne).not.toHaveBeenCalled();
    expect(db.coll('network_scan_requests').updateOne).not.toHaveBeenCalled();
  });

  test('parses agent-posted nmap XML (reusing parseNmapOutput)', async () => {
    const db = buildDb();
    networkScanner.parseNmapOutput.mockResolvedValue([
      { ip: '192.0.2.30', mac: 'AA:AA:AA:BB:BB:BB', hostname: '', vendor: '' }
    ]);

    const res = await request(buildApp(db))
      .post('/api/v1/network/scan-results')
      .send({ scannerId: 'linux-node', scanSource: 'linux-node', format: 'nmap-xml', xml: '<nmaprun></nmaprun>' });

    expect(res.status).toBe(200);
    expect(networkScanner.parseNmapOutput).toHaveBeenCalledWith('<nmaprun></nmaprun>');
    expect(res.body.data.discovered).toBe(1);
    expect(db.coll('network_devices').bulkWrite).toHaveBeenCalledTimes(1);
  });

  test('400 when format=nmap-xml without xml', async () => {
    const res = await request(buildApp(buildDb()))
      .post('/api/v1/network/scan-results')
      .send({ scannerId: 'x', format: 'nmap-xml' });
    expect(res.status).toBe(400);
  });

  test.each(['test', 'production'])('LAN collector works without a token in %s', async mode => {
    process.env.NODE_ENV = mode;
    process.env.NETWORK_AGENT_TOKEN = 'obsolete-setting';
    const res = await request(buildApp(buildDb()))
      .post('/api/v1/network/scan-results')
      .send({ scannerId: 'x', scanSource: 'x', format: 'devices', devices: [] });
    expect(res.status).toBe(200);
  });

});

describe('GET /api/v1/network/scan-requests (agent poll)', () => {
  test('400 without scannerId', async () => {
    const res = await request(buildApp(buildDb())).get('/api/v1/network/scan-requests');
    expect(res.status).toBe(400);
  });

  test('heartbeats the scanner and returns pending requests', async () => {
    const db = buildDb({
      network_scan_requests: {
        find: jest.fn(() => makeCursor([
          { _id: new ObjectId(), target: '192.0.2.0/24', requestedAt: new Date(), source: 'ui', completedBy: [] }
        ]))
      }
    });

    const res = await request(buildApp(db))
      .get('/api/v1/network/scan-requests')
      .query({ scannerId: 'windows-node', hostname: 'windows-node', cidr: '192.0.2.0/24' });

    expect(res.status).toBe(200);
    expect(res.body.data.requests).toHaveLength(1);
    expect(res.body.data.requests[0].target).toBe('192.0.2.0/24');
    expect(db.coll('network_scanners').updateOne).toHaveBeenCalledTimes(1); // heartbeat
  });
});

describe('GET /api/v1/network/agents', () => {
  test('lists scanners with a derived active flag', async () => {
    const db = buildDb({
      network_scanners: { find: jest.fn(() => makeCursor([activeScannerDoc()])) }
    });

    const res = await request(buildApp(db)).get('/api/v1/network/agents');
    expect(res.status).toBe(200);
    expect(res.body.data.scanners).toHaveLength(1);
    expect(res.body.data.scanners[0].active).toBe(true);
    expect(res.body.data.active).toBe(1);
  });

  test('marks a stale scanner inactive', async () => {
    const stale = { scannerId: 's-old', lastSeen: new Date(Date.now() - 10 * 60 * 1000) };
    const db = buildDb({
      network_scanners: { find: jest.fn(() => makeCursor([stale])) }
    });

    const res = await request(buildApp(db)).get('/api/v1/network/agents');
    expect(res.body.data.scanners[0].active).toBe(false);
    expect(res.body.data.active).toBe(0);
  });
});

describe('GET /api/v1/network/scan-requests/:id (job status)', () => {
  test('returns the job status', async () => {
    const id = new ObjectId();
    const db = buildDb({
      network_scan_requests: {
        findOne: jest.fn().mockResolvedValue({
          _id: id, target: '192.0.2.0/24', status: 'done', source: 'ui',
          requestedAt: new Date(), completedBy: ['windows-node'],
          results: [{ scannerId: 'windows-node', discovered: 5 }]
        })
      }
    });

    const res = await request(buildApp(db)).get(`/api/v1/network/scan-requests/${id.toString()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.done).toBe(true);
    expect(res.body.data.results[0].discovered).toBe(5);
  });

  test('404 for an unknown job', async () => {
    const res = await request(buildApp(buildDb())).get(`/api/v1/network/scan-requests/${new ObjectId().toString()}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/network/devices/:id/enrich', () => {
  test('returns 503 when nmap is missing', async () => {
    const db = buildDb({
      network_devices: {
        findOne: jest.fn().mockResolvedValue({
          _id: 'device-1', mac: 'AA:BB:CC:DD:EE:FF', ip: '192.0.2.10', status: 'online'
        })
      }
    });
    networkScanner.enrichDevice.mockRejectedValue(createMissingDependencyError());

    const res = await request(buildApp(db))
      .post('/api/v1/network/devices/AA:BB:CC:DD:EE:FF/enrich');

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/Enrichment unavailable/);
    expect(res.body.message).toMatch(/nmap is not installed/);
  });

  test('returns 400 when the stored address is not an IPv4 address', async () => {
    const db = buildDb({
      network_devices: {
        findOne: jest.fn().mockResolvedValue({ _id: 'device-1', mac: 'AA:BB:CC:DD:EE:FF', ip: '-iL', status: 'online' })
      }
    });
    const targetError = new Error('Device has no valid IPv4 address to enrich');
    targetError.code = 'INVALID_TARGET';
    networkScanner.enrichDevice.mockRejectedValue(targetError);

    const res = await request(buildApp(db)).post('/api/v1/network/devices/AA:BB:CC:DD:EE:FF/enrich');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no valid IPv4 address/);
    expect(db.coll('network_devices').updateOne).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/network/devices', () => {
  test('returns discovered devices', async () => {
    const devices = [
      { _id: 'd1', ip: '192.0.2.10', mac: 'AA:BB:CC:DD:EE:FF', status: 'online' },
      { _id: 'd2', ip: '192.0.2.11', mac: '11:22:33:44:55:66', status: 'offline' }
    ];
    const db = buildDb({
      network_devices: { find: jest.fn(() => makeCursor(devices)) }
    });

    const res = await request(buildApp(db)).get('/api/v1/network/devices').expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.results).toBe(2);
    expect(res.body.data.devices).toHaveLength(2);
  });

  test('returns empty list when no devices', async () => {
    const res = await request(buildApp(buildDb())).get('/api/v1/network/devices').expect(200);
    expect(res.body.results).toBe(0);
    expect(res.body.data.devices).toHaveLength(0);
    expect(res.body.data.summary).toMatchObject({ total: 0, online: 0, recent: 0, historical: 0, never_confirmed: 0 });
  });

  test('derives online/recent/historical from the last sighting and reports the windows', async () => {
    const now = Date.now();
    const devices = [
      { _id: 'a', ip: '192.0.2.10', status: 'online', lastSeen: new Date(now - 60000), scanSource: 'linux-node' },
      { _id: 'b', ip: '192.0.2.11', status: 'online', lastSeen: new Date(now - 30 * 24 * 60 * 60 * 1000), scanSource: 'retired-node' },
      { _id: 'c', ip: '192.0.2.12', status: 'offline' }
    ];
    const db = buildDb({ network_devices: { find: jest.fn(() => makeCursor(devices)) } });
    const res = await request(buildApp(db)).get('/api/v1/network/devices').expect(200);
    expect(res.body.data.devices.map((d) => d.observation.state)).toEqual(['online', 'historical', 'never_confirmed']);
    expect(res.body.data.devices[1].observation).toMatchObject({ reportedStatus: 'online', source: 'retired-node' });
    expect(res.body.data.summary).toMatchObject({ total: 3, online: 1, historical: 1, never_confirmed: 1, reportedOnline: 2 });
    expect(typeof res.body.data.summary.referenceTime).toBe('string');
    expect(res.body.data.summary.onlineTtlMs).toBeGreaterThan(0);
  });
});

describe('PATCH /api/v1/network/devices/:id', () => {
  test('updates device metadata', async () => {
    const device = { _id: 'd1', ip: '192.0.2.10', alias: 'Printer' };
    const db = buildDb({
      network_devices: { findOneAndUpdate: jest.fn().mockResolvedValue(device) }
    });

    const res = await request(buildApp(db))
      .patch('/api/v1/network/devices/AA:BB:CC:DD:EE:FF')
      .send({ alias: 'Printer', notes: 'Office floor 2' })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data.device.alias).toBe('Printer');
  });

  test('stores the type under hardware.type, the location and the notes, each on its own field', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'd1' });
    const app = buildApp(buildDb({ network_devices: { findOneAndUpdate } }));

    await request(app).patch('/api/v1/network/devices/AA:BB:CC:DD:EE:FF')
      .send({ type: 'printer', location: 'Office', notes: 'Second tray' }).expect(200);
    expect(findOneAndUpdate.mock.calls[0][0]).toEqual({ mac: 'AA:BB:CC:DD:EE:FF' });
    expect(findOneAndUpdate.mock.calls[0][1]).toEqual({ $set: { 'hardware.type': 'printer', location: 'Office', notes: 'Second tray' } });
  });

  test('returns 404 when device not found', async () => {
    const db = buildDb({
      network_devices: { findOneAndUpdate: jest.fn().mockResolvedValue(null) }
    });

    const res = await request(buildApp(db))
      .patch('/api/v1/network/devices/AA:BB:CC:DD:EE:FF')
      .send({ alias: 'Unknown' })
      .expect(404);

    expect(res.body.message).toMatch(/not found/i);
  });

  test('marks a device known and clears the mark', async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'd1' });
    const app = buildApp(buildDb({ network_devices: { findOneAndUpdate } }));

    await request(app).patch('/api/v1/network/devices/AA:BB:CC:DD:EE:FF').send({ known: true }).expect(200);
    expect(findOneAndUpdate.mock.calls[0][1].$set.knownAt).toBeInstanceOf(Date);

    await request(app).patch('/api/v1/network/devices/AA:BB:CC:DD:EE:FF').send({ known: false }).expect(200);
    expect(findOneAndUpdate.mock.calls[1][1]).toEqual({ $unset: { knownAt: '' } });
  });

  test('rejects a non-boolean known flag and an empty update', async () => {
    const app = buildApp(buildDb());
    await request(app).patch('/api/v1/network/devices/AA:BB:CC:DD:EE:FF').send({ known: 'yes' }).expect(400);
    await request(app).patch('/api/v1/network/devices/AA:BB:CC:DD:EE:FF').send({}).expect(400);
  });
});
