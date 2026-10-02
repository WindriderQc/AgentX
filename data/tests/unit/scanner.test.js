const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { Scanner, rebuildDirectoryRollups } = require('../../services/scanner');
const candidateHasher = require('../../services/candidateHasher');

function asyncCursor(items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    }
  };
}

describe('scanner directory rollups', () => {
  test('rebuildDirectoryRollups refreshes nas_directories from aggregate rows', async () => {
    const filesCol = {
      aggregate: jest.fn(() => asyncCursor([
        { path: '/mnt/datalake', file_count: 2, total_size: 30, largest_file: '/mnt/datalake/a.bin', largest_file_size: 20 },
        { path: '/mnt/datalake/sub', file_count: 1, total_size: 5, largest_file: '/mnt/datalake/sub/c.txt', largest_file_size: 5 }
      ]))
    };
    const dirsCol = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      bulkWrite: jest.fn().mockResolvedValue({ modifiedCount: 0, upsertedCount: 2 })
    };

    const count = await rebuildDirectoryRollups(filesCol, dirsCol);

    expect(count).toBe(2);
    expect(filesCol.aggregate).toHaveBeenCalledWith(expect.any(Array), { allowDiskUse: true });
    expect(dirsCol.deleteMany).toHaveBeenCalledWith({ rollup_at: { $ne: expect.any(Date) } });
    expect(dirsCol.bulkWrite).toHaveBeenCalledTimes(1);
    expect(dirsCol.bulkWrite.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { path: '/mnt/datalake' },
          upsert: true
        })
      }),
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: { path: '/mnt/datalake/sub' },
          upsert: true
        })
      })
    ]);
  });

  test('rebuildDirectoryRollups scopes aggregation and stale cleanup to requested roots', async () => {
    const filesCol = { aggregate: jest.fn(() => asyncCursor([])) };
    const dirsCol = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      bulkWrite: jest.fn()
    };

    await rebuildDirectoryRollups(filesCol, dirsCol, ['/mnt/media']);

    const pipeline = filesCol.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { source_root: '/mnt/media' } });
    expect(dirsCol.deleteMany).toHaveBeenCalledWith({
      rollup_at: { $ne: expect.any(Date) },
      $or: [{ path: { $regex: '^/mnt/media(?:[\\/]|$)' } }]
    });
  });

  test('Scanner.run stamps directory count after indexing files', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-scan-'));
    const subDir = path.join(tmpRoot, 'sub');
    const mediaDir = path.join(tmpRoot, 'Videos', 'Holiday');
    await fs.mkdir(subDir);
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'alpha');
    await fs.writeFile(path.join(subDir, 'b.txt'), 'beta');
    const diskImage = path.join(mediaDir, 'family-archive.bin');
    await fs.writeFile(diskImage, '');
    await fs.truncate(diskImage, 100 * 1024 * 1024);

    const scanUpdates = [];
    const collections = {
      nas_files: {
        bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 }),
        aggregate: jest.fn(() => asyncCursor([
          { path: tmpRoot, file_count: 1, total_size: 5, largest_file: path.join(tmpRoot, 'a.txt'), largest_file_size: 5 },
          { path: subDir, file_count: 1, total_size: 4, largest_file: path.join(subDir, 'b.txt'), largest_file_size: 4 }
        ]))
      },
      nas_directories: {
        deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
        bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 2, modifiedCount: 0 })
      },
      nas_scans: {
        updateOne: jest.fn(async (_filter, update) => {
          scanUpdates.push(update.$set);
          return { matchedCount: 1 };
        })
      }
    };
    const db = { collection: jest.fn(name => collections[name]) };

    try {
      const scanner = new Scanner(db);
      await scanner.run({ roots: [tmpRoot], scanId: 'scan-test', batchSize: 1 });

      const finalUpdate = scanUpdates[scanUpdates.length - 1];
      expect(finalUpdate.status).toBe('complete');
      expect(finalUpdate.counts.files_seen).toBe(3);
      expect(finalUpdate.counts.directories).toBe(2);
      const indexed = collections.nas_files.bulkWrite.mock.calls
        .flatMap(call => call[0])
        .map(operation => operation.updateOne.update.$set);
      expect(indexed).toEqual(expect.arrayContaining([
        expect.objectContaining({
          filename: 'a.txt',
          category: 'document',
          category_source: 'extension',
          storage_role: 'document',
          extension_status: 'present',
          timestamp_quality: 'valid'
        }),
        expect.objectContaining({
          filename: 'family-archive.bin',
          size: 100 * 1024 * 1024,
          category: 'disk_image',
          category_source: 'path-role',
          storage_role: 'virtual_disk_image'
        })
      ]));
      expect(collections.nas_directories.deleteMany).toHaveBeenCalledWith({
        rollup_at: { $ne: expect.any(Date) },
        $or: [{ path: { $regex: expect.any(String) } }]
      });
      expect(collections.nas_directories.bulkWrite).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('Scanner.run prunes stale rows before candidate hashing', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-scan-order-'));
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'alpha');
    const operations = [];
    const collections = {
      nas_files: {
        bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 1, modifiedCount: 0 }),
        deleteMany: jest.fn(async () => {
          operations.push('prune');
          return { deletedCount: 1 };
        }),
        aggregate: jest.fn(() => asyncCursor([]))
      },
      nas_directories: {
        deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
        bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 })
      },
      nas_scans: {
        updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
      }
    };
    const db = { collection: jest.fn(name => collections[name]) };
    const hasher = jest.spyOn(candidateHasher, 'hashDuplicateCandidates').mockImplementation(async () => {
      operations.push('hash');
      return {
        hashed: 0,
        hash_bytes: 0,
        candidate_groups: 0,
        candidate_files: 0,
        candidate_bytes: 0,
        selected_groups: 0,
        deferred_groups: 0,
        errors: 0
      };
    });

    try {
      const scanner = new Scanner(db);
      await scanner.run({ roots: [tmpRoot], scanId: 'scan-order', hashMode: 'candidates' });

      expect(operations).toEqual(['prune', 'hash']);
    } finally {
      hasher.mockRestore();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
