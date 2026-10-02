const storageAgentService = require('../../services/storageAgentService');

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
    const scans = { insertOne: jest.fn().mockResolvedValue({ insertedId: 'scan-1' }) };
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
    const scans = { insertOne: jest.fn().mockResolvedValue({ insertedId: 'scan-1' }) };
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
