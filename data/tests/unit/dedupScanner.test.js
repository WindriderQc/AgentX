/**
 * Unit tests for services/dedupScanner.js
 */
const dedupScanner = require('../../services/dedupScanner');
const {
  buildDedupReport,
  saveReport,
  getReport
} = dedupScanner;

// ── helpers ──────────────────────────────────────────────────

/** Build a minimal mock MongoDB collection with an aggregate pipeline */
function mockCollection(docs = []) {
  return {
    aggregate: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(docs)
    }),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'report-123' }),
    findOne: jest.fn().mockImplementation((filter, opts) => {
      if (opts && opts.sort) return Promise.resolve(docs[0] || null);
      return Promise.resolve(docs.find(d => String(d._id) === String(filter._id)) || null);
    }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 })
  };
}

function mockDb(collectionMap = {}) {
  return {
    collection: jest.fn((name) => collectionMap[name] || mockCollection())
  };
}

test('does not export the retired direct-deletion helper', () => {
  expect(dedupScanner.executeApprovedDeletions).toBeUndefined();
  expect(dedupScanner.generateConfirmationToken).toBeUndefined();
});

// ── buildDedupReport ─────────────────────────────────────────

describe('buildDedupReport', () => {
  test('builds a report from aggregated duplicate groups', async () => {
    const aggResult = [
      {
        _id: 'abc123',
        count: 3,
        size: 1024,
        files: [
          { path: '/mnt/datalake/a/file.txt', dirname: '/mnt/datalake/a', filename: 'file.txt', size: 1024, mtime: 1700000000 },
          { path: '/mnt/datalake/b/file.txt', dirname: '/mnt/datalake/b', filename: 'file.txt', size: 1024, mtime: 1700000100 },
          { path: '/mnt/datalake/c/file.txt', dirname: '/mnt/datalake/c', filename: 'file.txt', size: 1024, mtime: 1700000200 }
        ]
      },
      {
        _id: 'def456',
        count: 2,
        size: 512,
        files: [
          { path: '/mnt/datalake/x/data.bin', dirname: '/mnt/datalake/x', filename: 'data.bin', size: 512, mtime: 1700000000 },
          { path: '/mnt/datalake/y/data.bin', dirname: '/mnt/datalake/y', filename: 'data.bin', size: 512, mtime: 1700000100 }
        ]
      }
    ];

    const nasFiles = mockCollection(aggResult);
    const db = mockDb({ nas_files: nasFiles });

    const report = await buildDedupReport(db);

    expect(report.status).toBe('complete');
    expect(report.summary.total_duplicate_groups).toBe(2);
    expect(report.summary.total_duplicate_files).toBe(5);
    // wasted = 1024*(3-1) + 512*(2-1) = 2048 + 512 = 2560
    expect(report.summary.total_wasted_space).toBe(2560);
    expect(report.summary.top_10_largest).toHaveLength(2);
    expect(report.groups).toHaveLength(2);
    expect(report.groups[0].hash).toBe('abc123');
    expect(report.groups[0].recommended_action).toBe('review_and_delete_duplicates');
  });

  test('returns empty report when no duplicates exist', async () => {
    const nasFiles = mockCollection([]);
    const db = mockDb({ nas_files: nasFiles });

    const report = await buildDedupReport(db);

    expect(report.summary.total_duplicate_groups).toBe(0);
    expect(report.summary.total_wasted_space).toBe(0);
    expect(report.groups).toHaveLength(0);
  });

  test('passes rootPath and extensions to the match stage', async () => {
    const nasFiles = mockCollection([]);
    const db = mockDb({ nas_files: nasFiles });

    await buildDedupReport(db, {
      rootPath: '/mnt/datalake/',
      extensions: ['jpg', 'png']
    });

    const matchArg = nasFiles.aggregate.mock.calls[0][0][0].$match;
    expect(matchArg.ext).toEqual({ $in: ['jpg', 'png'] });
    expect(matchArg.$and).toBeDefined();
    expect(matchArg.$and[0].path.$regex).toMatch(/datalake/);
  });
});

// ── saveReport / getReport ──────────────────────────────────

describe('saveReport', () => {
  test('inserts into dedup_reports and returns ID', async () => {
    const col = mockCollection();
    const db = mockDb({ dedup_reports: col });

    const id = await saveReport(db, { summary: {}, groups: [] });
    expect(id).toBe('report-123');
    expect(col.insertOne).toHaveBeenCalledTimes(1);
  });
});

describe('getReport', () => {
  test('returns latest report when no ID given', async () => {
    const doc = { _id: 'latest', summary: { total_duplicate_groups: 5 } };
    const col = mockCollection([doc]);
    const db = mockDb({ dedup_reports: col });

    const result = await getReport(db, null);
    expect(col.findOne).toHaveBeenCalledWith({}, { sort: { created_at: -1 } });
    expect(result).toEqual(doc);
  });
});
