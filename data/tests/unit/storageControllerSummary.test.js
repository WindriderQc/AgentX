const { getSummary } = require('../../controllers/storageController');

function completedHashScan() {
  return {
    _id: 'completed-candidate-scan',
    status: 'complete',
    started_at: '2026-07-19T01:00:00.000Z',
    finished_at: '2026-07-19T01:02:00.000Z',
    counts: { hashed: 50, hash_bytes: 2000 },
    config: { hash_mode: 'candidates', hash_max_files: 100, hash_max_bytes: 1000 }
  };
}

describe('storage summary verification outlook', () => {
  test('uses the latest successful hashing scan and reports both capacity constraints', async () => {
    const scans = {
      findOne: jest.fn(async query => {
        if (query.status === 'complete') return completedHashScan();
        return completedHashScan();
      })
    };
    const aggregateRows = [
      [{ totalFiles: 100, totalSize: 10000, hashedFiles: 20, hashedBytes: 2000, categorizedFiles: 90 }],
      [{ groups: 1, wasted: 100 }],
      [{
        totals: [{ groups: 4, files: 120, candidateBytes: 7000, filesToHash: 80, bytesToHash: 5000 }],
        oversized: [{ groups: 0, files: 0, bytesToHash: 0 }]
      }]
    ];
    const files = {
      aggregate: jest.fn(() => ({ toArray: async () => aggregateRows.shift() }))
    };
    const req = {
      query: { root: '/mnt/datalake' },
      app: { locals: { db: { collection: name => (name === 'nas_files' ? files : scans) } } }
    };
    const res = { json: jest.fn() };
    const next = jest.fn();

    await getSummary(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const data = res.json.mock.calls[0][0].data;
    expect(scans.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete', 'config.hash_mode': { $in: ['all', 'candidates'] } }),
      expect.any(Object)
    );
    expect(data.lastHashingScan).toMatchObject({ id: 'completed-candidate-scan', status: 'complete' });
    expect(data.duplicateCandidates).toMatchObject({ filesToHash: 80, bytesToHash: 5000 });
    expect(data.metadataFirst).toMatchObject({
      status: 'measured',
      indexedFiles: 100,
      indexedBytes: 10000,
      organizationReviewAvailable: true,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false
    });
    expect(data.verificationQueue).toMatchObject({
      status: 'prioritized',
      ordering: ['potential_duplicate_bytes_desc', 'file_size_desc'],
      groups: 4,
      potentialDuplicateBytes: 7000,
      potentialDuplicateBytesAreNotSavings: true,
      exactDuplicateProofRequired: true,
      filesystemMutationAllowed: false
    });
    expect(data.verificationOutlook).toMatchObject({
      status: 'measured',
      lastCompletedRun: {
        hashedFiles: 50,
        hashedBytes: 2000,
        durationSeconds: 120,
        estimatedComparableRunsLowerBound: 3
      },
      configuredCapacity: {
        maxFiles: 100,
        maxBytes: 1000,
        estimatedRunsLowerBound: 5
      }
    });
  });

  test('fails closed instead of inventing pace without a completed hashing scan', async () => {
    const scans = { findOne: jest.fn(async () => null) };
    const aggregateRows = [
      [{ totalFiles: 2, totalSize: 20, hashedFiles: 0, hashedBytes: 0, categorizedFiles: 0 }],
      [],
      [{ totals: [{ groups: 1, files: 2, candidateBytes: 10, filesToHash: 2, bytesToHash: 20 }], oversized: [] }]
    ];
    const files = {
      aggregate: jest.fn(() => ({ toArray: async () => aggregateRows.shift() }))
    };
    const req = {
      query: { root: '/mnt/media' },
      app: { locals: { db: { collection: name => (name === 'nas_files' ? files : scans) } } }
    };
    const res = { json: jest.fn() };

    await getSummary(req, res, jest.fn());

    expect(res.json.mock.calls[0][0].data.verificationOutlook).toMatchObject({
      status: 'unavailable',
      filesToHash: 2,
      bytesToHash: 20,
      lastCompletedRun: null,
      configuredCapacity: null
    });
  });
});
