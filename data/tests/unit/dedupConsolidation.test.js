/**
 * Regression tests for the dedup consolidation.
 *
 * Proves the single SHA256-group dedup engine (dedupScanner.aggregateDuplicateGroups)
 * builds the exact MongoDB pipelines required by the retained report, browser,
 * and Janitor strategy consumers, and that fileBrowserController.findDuplicates
 * preserves its response shape.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../utils/file-operations', () => ({
  formatFileSize: jest.fn(n => `${n} B`)
}));

jest.mock('../../utils/fileHelpers', () => ({
  formatFilePath: jest.fn(f => f.path || `${f.dirname}/${f.filename}`)
}));

jest.mock('../../services/janitorService', () => ({
  resolveAllowedPath: jest.fn(),
  validatePath: jest.fn()
}));

const dedupScanner = require('../../services/dedupScanner');
const FileBrowserController = require('../../controllers/fileBrowserController');

/** Capture the pipeline + options passed to aggregate on nas_files. */
function captureDb(aggResult = []) {
  const calls = [];
  const nasFiles = {
    aggregate: jest.fn((pipeline, opts) => {
      calls.push({ pipeline, opts });
      return { toArray: jest.fn().mockResolvedValue(aggResult) };
    }),
    countDocuments: jest.fn().mockResolvedValue(5)
  };
  const db = { collection: jest.fn(() => nasFiles) };
  return { db, calls, nasFiles };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

describe('aggregateDuplicateGroups — pipeline parity', () => {
  test('findDuplicates hash branch builds the legacy pipeline shape', async () => {
    const { db, calls } = captureDb([]);

    await dedupScanner.aggregateDuplicateGroups(db, { sizeField: 'totalSize', limit: 100 });

    const { pipeline, opts } = calls[0];
    // $match on sha256 existence
    expect(pipeline[0].$match).toMatchObject({ sha256: { $exists: true, $ne: null } });
    expect(pipeline[0].$match.$expr).toBeDefined();
    // $group keyed by sha256, files push path/dirname/filename/mtime, group size = totalSize
    const group = pipeline[1].$group;
    expect(group._id).toBe('$sha256');
    expect(group.totalSize).toEqual({ $first: '$size' });
    const push = group.files.$push;
    expect(push).toEqual({ path: '$path', dirname: '$dirname', filename: '$filename', mtime: '$mtime' });
    // count>1 filter, sort by totalSize desc, limit 100
    expect(pipeline[2].$match).toEqual({ count: { $gt: 1 } });
    expect(pipeline[3].$sort).toEqual({ totalSize: -1 });
    expect(pipeline[4].$limit).toBe(100);
    expect(opts).toEqual({ allowDiskUse: true });
  });

  test('buildDedupReport branch excludes /keys/ and includes size per file', async () => {
    const { db, calls } = captureDb([]);

    await dedupScanner.aggregateDuplicateGroups(db, {
      rootPath: '/mnt/datalake/',
      extensions: ['jpg'],
      excludeKeys: true,
      includeSizePerFile: true,
      sizeField: 'size'
    });

    const match = calls[0].pipeline[0].$match;
    expect(match.ext).toEqual({ $in: ['jpg'] });
    expect(match.$and).toBeDefined();
    expect(match.$and[1].path.$not).toBeDefined(); // /keys/ exclusion
    const push = calls[0].pipeline[1].$group.files.$push;
    expect(push.size).toBe('$size');
    expect(calls[0].pipeline[3].$sort).toEqual({ size: -1 });
  });

  test('no /keys/ exclusion when excludeKeys is false (API findDuplicates default)', async () => {
    const { db, calls } = captureDb([]);
    await dedupScanner.aggregateDuplicateGroups(db, { sizeField: 'totalSize', limit: 100 });
    const match = calls[0].pipeline[0].$match;
    expect(match.$and).toBeUndefined();
    expect(match.path).toBeUndefined();
  });

  test('shared-drive strategy groups across both canonical roots without widening scope', async () => {
    const { db, calls } = captureDb([]);
    await dedupScanner.aggregateDuplicateGroups(db, {
      rootPaths: ['/mnt/media', '/mnt/datalake'],
      excludeKeys: true,
      includeContextPerFile: true,
      sizeField: 'size'
    });

    const match = calls[0].pipeline[0].$match;
    expect(match.$and[0].$or).toEqual([
      { path: { $regex: '^/mnt/media(?:[\\/]|$)' } },
      { path: { $regex: '^/mnt/datalake(?:[\\/]|$)' } }
    ]);
    expect(match.$and[1].path.$not).toBeDefined();
    expect(calls[0].pipeline[1].$group.files.$push.storageRole).toBe('$storage_role');
  });
});

describe('findDuplicates — output parity through the shared engine', () => {
  test('formats sha256 groups identically to the legacy response shape', async () => {
    const groups = [
      {
        _id: 'hash1', count: 3, totalSize: 1000,
        files: [
          { path: '/a/x', dirname: '/a', filename: 'x', mtime: 1 },
          { path: '/b/x', dirname: '/b', filename: 'x', mtime: 2 },
          { path: '/c/x', dirname: '/c', filename: 'x', mtime: 3 }
        ]
      }
    ];
    const { db } = captureDb(groups);
    const req = { app: { locals: { db } }, query: { method: 'hash' } };
    const res = mockRes();
    await FileBrowserController.findDuplicates(req, res, () => {});

    expect(res.body.data.method).toBe('sha256');
    expect(res.body.data.duplicates[0]).toEqual({
      sha256: 'hash1', size: 1000, sizeFormatted: '1000 B',
      count: 3, wastedSpace: 2000, wastedSpaceFormatted: '2000 B',
      locations: groups[0].files
    });
    expect(res.body.data.summary.totalWastedSpace).toBe(2000);
  });
});
