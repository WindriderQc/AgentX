const storageAgentService = require('../../services/storageAgentService');

function scansCollection(active = []) {
  return {
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'scan-1' }),
    find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(active) })),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    findOneAndUpdate: jest.fn().mockResolvedValue(null)
  };
}

function dbWith(scans) {
  const scanners = { findOne: jest.fn().mockResolvedValue({ scannerId: 'linux-node' }) };
  return { collection: jest.fn(name => name === 'storage_scanners' ? scanners : scans) };
}

describe('storageAgentService', () => {
  const originalSources = process.env.STORAGE_AGENT_SOURCES;

  afterEach(() => {
    if (originalSources === undefined) delete process.env.STORAGE_AGENT_SOURCES;
    else process.env.STORAGE_AGENT_SOURCES = originalSources;
  });

  test('default shared-drive sources are evidence-only', () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    expect(storageAgentService.sourceRegistry()).toEqual({
      media: { canonicalRoot: '/mnt/media', executionCapable: false },
      datalake: { canonicalRoot: '/mnt/datalake', executionCapable: false }
    });
  });

  test('external hash budgets are bounded before a scan is queued', async () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    const scanners = { findOne: jest.fn().mockResolvedValue({ scannerId: 'linux-node' }) };
    const scans = scansCollection();
    const db = {
      collection: jest.fn(name => name === 'storage_scanners' ? scanners : scans)
    };

    const result = await storageAgentService.enqueueScan(db, {
      source: 'media',
      hashMode: 'all',
      hashMaxFiles: Number.POSITIVE_INFINITY,
      hashMaxBytes: Number.POSITIVE_INFINITY
    });

    expect(result.ok).toBe(true);
    expect(result.scan.config).toMatchObject({
      execution_capable: false,
      hash_max_files: 5000,
      hash_max_bytes: 50 * 1024 * 1024 * 1024
    });
    expect(scans.insertOne).toHaveBeenCalledWith(result.scan);
  });

  test('large finite hash budgets are capped', async () => {
    const scanners = { findOne: jest.fn().mockResolvedValue({ scannerId: 'linux-node' }) };
    const scans = scansCollection();
    const db = {
      collection: jest.fn(name => name === 'storage_scanners' ? scanners : scans)
    };

    const result = await storageAgentService.enqueueScan(db, {
      source: 'datalake',
      hashMaxFiles: 999999,
      hashMaxBytes: 9999999999999
    });

    expect(result.scan.config.hash_max_files).toBe(storageAgentService.MAX_HASH_FILES);
    expect(result.scan.config.hash_max_bytes).toBe(storageAgentService.MAX_HASH_BYTES);
  });

  test('a second request for a source joins its queued or running scan', async () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    const existing = { _id: 'scan-live', status: 'running',
      config: { external: true, source: 'media', roots: ['/mnt/media'] } };
    const scans = scansCollection([existing]);

    const result = await storageAgentService.enqueueScan(dbWith(scans), { source: 'media' });

    expect(result).toEqual({ ok: true, coalesced: true, scan: existing });
    expect(scans.find).toHaveBeenCalledWith({ status: { $in: ['queued', 'running', 'hashing'] } });
    expect(scans.insertOne).not.toHaveBeenCalled();
  });

  test('an overlapping in-container scan refuses the external request', async () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    const scans = scansCollection([
      { _id: 'scan-local', status: 'hashing', config: { roots: ['/mnt/media/Videos'] } }
    ]);

    const result = await storageAgentService.enqueueScan(dbWith(scans), { source: 'media' });

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(result.error).toMatch(/scan-local/);
    expect(scans.insertOne).not.toHaveBeenCalled();
  });

  test('scans on other roots do not block a request', async () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    const scans = scansCollection([
      { _id: 'scan-datalake', status: 'running', config: { external: true, source: 'datalake', roots: ['/mnt/datalake'] } },
      { _id: 'scan-sibling', status: 'running', config: { roots: ['/mnt/media-old'] } },
      { _id: 'scan-legacy', status: 'running', roots: ['/srv/files/'] }
    ]);

    const result = await storageAgentService.enqueueScan(dbWith(scans), { source: 'media' });

    expect(result.ok).toBe(true);
    expect(result.coalesced).toBeUndefined();
    expect(scans.insertOne).toHaveBeenCalledWith(result.scan);
  });

  test('overlap covers equal, parent and child roots, including legacy records', async () => {
    const scans = scansCollection([{ _id: 'scan-legacy', status: 'running', roots: ['/srv/files/'] }]);
    const db = dbWith(scans);
    await expect(storageAgentService.findOverlappingScan(db, ['/srv/files'])).resolves.toMatchObject({ _id: 'scan-legacy' });
    await expect(storageAgentService.findOverlappingScan(db, ['/srv'])).resolves.toMatchObject({ _id: 'scan-legacy' });
    await expect(storageAgentService.findOverlappingScan(db, ['/srv/files/a/b'])).resolves.toMatchObject({ _id: 'scan-legacy' });
    await expect(storageAgentService.findOverlappingScan(db, ['/srv/files2', '/mnt/x'])).resolves.toBeNull();
  });

  test('silent running and unclaimed queued external scans are failed without touching files', async () => {
    const scans = scansCollection();
    scans.updateMany
      .mockResolvedValueOnce({ modifiedCount: 2 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    const db = dbWith(scans);
    const now = new Date('2026-10-08T12:00:00.000Z');

    await expect(storageAgentService.expireStaleScans(db, now)).resolves.toEqual({ running: 2, queued: 1 });

    const runningCutoff = new Date(now.getTime() - storageAgentService.RUNNING_STALE_MS);
    const queuedCutoff = new Date(now.getTime() - storageAgentService.QUEUED_STALE_MS);
    expect(scans.updateMany).toHaveBeenNthCalledWith(1, {
      status: 'running',
      'config.external': true,
      $nor: [
        { last_heartbeat_at: { $gte: runningCutoff } },
        { last_batch_at: { $gte: runningCutoff } },
        { started_at: { $gte: runningCutoff } }
      ]
    }, { $set: { status: 'failed', finished_at: now, last_error: expect.stringMatching(/No heartbeat or batch.*10 minutes/) } });
    expect(scans.updateMany).toHaveBeenNthCalledWith(2, {
      status: 'queued', 'config.external': true, requested_at: { $lt: queuedCutoff }
    }, { $set: { status: 'failed', finished_at: now, last_error: expect.stringMatching(/claimed.*6 hours/) } });
    expect(db.collection).not.toHaveBeenCalledWith('nas_files');
  });

  test('stale scans are expired before a claim and before a new request', async () => {
    delete process.env.STORAGE_AGENT_SOURCES;
    const scans = scansCollection();
    const db = dbWith(scans);
    await storageAgentService.claimNextScan(db, 'linux-node', ['media']);
    expect(scans.updateMany).toHaveBeenCalledTimes(2);
    expect(scans.updateMany.mock.invocationCallOrder[1])
      .toBeLessThan(scans.findOneAndUpdate.mock.invocationCallOrder[0]);
    await storageAgentService.enqueueScan(db, { source: 'media' });
    expect(scans.updateMany).toHaveBeenCalledTimes(4);
    expect(scans.updateMany.mock.invocationCallOrder[3])
      .toBeLessThan(scans.find.mock.invocationCallOrder[0]);
  });

  test('a heartbeat refreshes only the running external scan it names', async () => {
    const scans = scansCollection();
    const db = dbWith(scans);
    await expect(storageAgentService.touchScanHeartbeat(db, 'scan-live')).resolves.toBe(true);
    expect(scans.updateOne).toHaveBeenCalledWith(
      { _id: 'scan-live', status: 'running', 'config.external': true },
      { $set: { last_heartbeat_at: expect.any(Date) } }
    );

    scans.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(storageAgentService.touchScanHeartbeat(db, 'scan-done')).resolves.toBe(false);
    scans.updateOne.mockClear();
    await expect(storageAgentService.touchScanHeartbeat(db, { $ne: null })).resolves.toBe(false);
    await expect(storageAgentService.touchScanHeartbeat(db, '')).resolves.toBe(false);
    expect(scans.updateOne).not.toHaveBeenCalled();
  });

  test('metadata probe candidates are exact-root scoped, prioritized, and bounded', async () => {
    const toArray = jest.fn()
      .mockResolvedValueOnce([
        { path: '/mnt/media/unclassified' },
        { path: '/mnt/media-old/not-in-root' }
      ])
      .mockResolvedValueOnce([
        { path: '/mnt/media/path-classified-extensionless' },
        { path: '/mnt/media-old/still-not-in-root' }
      ])
      .mockResolvedValueOnce([
        { path: '/mnt/media/already-signature-derived' },
        { path: '' }
      ]);
    const limit = jest.fn(() => ({ toArray }));
    const project = jest.fn(() => ({ limit }));
    const sort = jest.fn(() => ({ project }));
    const find = jest.fn(() => ({ sort }));
    const db = { collection: jest.fn(() => ({ find })) };

    await expect(storageAgentService.listMetadataProbePaths(
      db,
      '/mnt/media/',
      Number.MAX_SAFE_INTEGER
    )).resolves.toEqual([
      { path: '/mnt/media/unclassified' },
      { path: '/mnt/media/path-classified-extensionless' },
      { path: '/mnt/media/already-signature-derived' }
    ].map(document => document.path));
    expect(find).toHaveBeenNthCalledWith(1, {
      path: { $regex: '^/mnt/media(?:/|$)' },
      category: 'unclassified'
    });
    expect(find).toHaveBeenNthCalledWith(2, {
      path: { $regex: '^/mnt/media(?:/|$)' },
      category: { $ne: 'unclassified' },
      extension_status: 'missing_unresolved',
      content_probe_status: { $exists: false }
    });
    expect(find).toHaveBeenNthCalledWith(3, {
      path: { $regex: '^/mnt/media(?:/|$)' },
      content_type_source: 'content-signature',
      category: { $ne: 'unclassified' }
    });
    expect(sort).toHaveBeenCalledTimes(3);
    expect(sort).toHaveBeenCalledWith({ path: 1 });
    expect(project).toHaveBeenCalledTimes(3);
    expect(project).toHaveBeenCalledWith({ _id: 0, path: 1 });
    expect(limit).toHaveBeenNthCalledWith(1, storageAgentService.MAX_METADATA_PROBE_PATHS);
    expect(limit).toHaveBeenNthCalledWith(2, storageAgentService.MAX_METADATA_PROBE_PATHS - 1);
    expect(limit).toHaveBeenNthCalledWith(3, storageAgentService.MAX_METADATA_PROBE_PATHS - 2);
  });

  test('metadata probe candidates require a canonical root', async () => {
    const db = { collection: jest.fn() };
    await expect(storageAgentService.listMetadataProbePaths(db, '')).resolves.toEqual([]);
    expect(db.collection).not.toHaveBeenCalled();
  });
});
