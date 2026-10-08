/**
 * Unit tests for services/dedupScanner.js
 */
const dedupScanner = require('../../services/dedupScanner');
const {
  REPORT_DETAIL_COLLECTION,
  REPORT_GROUPS_MAX_LIMIT,
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
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    find: jest.fn(() => ({ sort: () => ({ toArray: async () => [] }) }))
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

  test('never groups zero-byte files, which all share one hash', async () => {
    const nasFiles = mockCollection([]);
    await buildDedupReport(mockDb({ nas_files: nasFiles }), { rootPath: '/mnt/datalake/' });
    expect(nasFiles.aggregate.mock.calls[0][0][0].$match.size).toEqual({ $gt: 0 });
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
  test('stores the groups in chunked detail documents and a bounded report document', async () => {
    const reports = mockCollection();
    const details = mockCollection();
    const db = mockDb({ dedup_reports: reports, dedup_report_details: details });
    const groups = Array.from({ length: 250 }, (_, i) => ({ hash: `h${i}`, count: 2, files: [] }));
    const report = { summary: { total_duplicate_groups: 250 }, groups };

    const id = await saveReport(db, report);

    const chunks = details.insertMany.mock.calls[0][0];
    expect(chunks.map(c => [c.ordinal, c.first, c.last, c.groups.length])).toEqual([
      [0, 0, 99, 100], [1, 100, 199, 100], [2, 200, 249, 50]
    ]);
    expect(chunks.every(c => c.reportId === id)).toBe(true);
    const stored = reports.insertOne.mock.calls[0][0];
    expect(stored._id).toBe(id);
    expect(stored.groups).toEqual([]);
    expect(stored.summary).toEqual({ total_duplicate_groups: 250 });
    expect(stored.detailStorage).toEqual({
      schemaVersion: 1, collection: REPORT_DETAIL_COLLECTION, chunks: 3, groups: 250
    });
    // The caller's report is left untouched.
    expect(report.groups).toHaveLength(250);
  });

  test('starts a new chunk before one exceeds the byte budget', async () => {
    const details = mockCollection();
    const db = mockDb({ dedup_reports: mockCollection(), dedup_report_details: details });
    const big = 'x'.repeat(3 * 1024 * 1024);
    await saveReport(db, { groups: [{ hash: 'a', pad: big }, { hash: 'b', pad: big }, { hash: 'c' }] });
    expect(details.insertMany.mock.calls[0][0].map(c => c.groups.length)).toEqual([1, 2]);
  });

  test('a report without groups writes no detail document', async () => {
    const reports = mockCollection();
    const details = mockCollection();
    await saveReport(mockDb({ dedup_reports: reports, dedup_report_details: details }), { summary: {}, groups: [] });
    expect(details.insertMany).not.toHaveBeenCalled();
    expect(reports.insertOne.mock.calls[0][0].detailStorage.chunks).toBe(0);
  });

  test('removes its detail documents when the report document cannot be written', async () => {
    const reports = mockCollection();
    reports.insertOne.mockRejectedValue(new Error('write failed'));
    const details = mockCollection();
    const db = mockDb({ dedup_reports: reports, dedup_report_details: details });
    await expect(saveReport(db, { groups: [{ hash: 'a' }] })).rejects.toThrow('write failed');
    expect(details.deleteMany).toHaveBeenCalledWith({ reportId: details.insertMany.mock.calls[0][0][0].reportId });
  });
});

describe('getReport', () => {
  test('returns latest report when no ID given', async () => {
    const doc = { _id: 'latest', summary: { total_duplicate_groups: 5 } };
    const col = mockCollection([doc]);
    const db = mockDb({ dedup_reports: col });

    const result = await getReport(db, null);
    expect(col.findOne).toHaveBeenCalledWith({}, { sort: { created_at: -1 } });
    expect(result).toEqual({ ...doc, groups: [], groups_page: { offset: 0, limit: 100, returned: 0, total: 0 } });
  });

  test('pages the groups of a report saved before chunking', async () => {
    const groups = Array.from({ length: 150 }, (_, i) => ({ hash: `h${i}` }));
    const db = mockDb({ dedup_reports: mockCollection([{ _id: 'old', groups }]) });

    const first = await getReport(db, null);
    expect(first.groups).toHaveLength(100);
    expect(first.groups_page).toEqual({ offset: 0, limit: 100, returned: 100, total: 150 });
    const rest = await getReport(db, null, { groupOffset: '100', groupLimit: '5000' });
    expect(rest.groups.map(g => g.hash)).toEqual(groups.slice(100).map(g => g.hash));
    expect(rest.groups_page).toEqual({ offset: 100, limit: REPORT_GROUPS_MAX_LIMIT, returned: 50, total: 150 });
    expect((await getReport(db, null, { groupOffset: -4, groupLimit: -1 })).groups_page)
      .toMatchObject({ offset: 0, limit: 1, returned: 1 });
  });

  test('reads only the chunks that hold the requested groups', async () => {
    const reports = mockCollection();
    const details = mockCollection();
    const db = mockDb({ dedup_reports: reports, dedup_report_details: details });
    const groups = Array.from({ length: 250 }, (_, i) => ({ hash: `h${i}` }));
    await saveReport(db, { created_at: new Date(), groups });
    const stored = reports.insertOne.mock.calls[0][0];
    const chunks = details.insertMany.mock.calls[0][0];
    reports.findOne.mockResolvedValue(stored);
    details.find.mockImplementation(filter => ({
      sort: () => ({
        toArray: async () => chunks.filter(c => c.first < filter.first.$lt && c.last >= filter.last.$gte)
      })
    }));

    const page = await getReport(db, null, { groupOffset: 95, groupLimit: 10 });
    expect(details.find).toHaveBeenCalledWith({ reportId: stored._id, first: { $lt: 105 }, last: { $gte: 95 } });
    expect(page.groups.map(g => g.hash)).toEqual(groups.slice(95, 105).map(g => g.hash));
    expect(page.groups_page).toEqual({ offset: 95, limit: 10, returned: 10, total: 250 });

    const beyond = await getReport(db, null, { groupOffset: 250 });
    expect(beyond.groups).toEqual([]);
    expect(beyond.groups_page).toEqual({ offset: 250, limit: 100, returned: 0, total: 250 });

    details.find.mockImplementation(() => ({ sort: () => ({ toArray: async () => [] }) }));
    await expect(getReport(db, null)).rejects.toThrow(/incomplete: expected 100, found 0/);
  });
});
