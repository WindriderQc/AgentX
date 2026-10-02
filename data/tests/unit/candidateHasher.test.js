const candidateHasher = require('../../services/candidateHasher');

function dbWithGroups(groups) {
  const files = {
    aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(groups) })),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
  };
  return { db: { collection: jest.fn(() => files) }, files };
}

describe('candidateHasher', () => {
  test('uses a deterministic high-value candidate-group queue without calling it savings', async () => {
    const files = {
      aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) }))
    };

    await candidateHasher.findCandidateGroups(files, {
      roots: ['/mnt/media'],
      groupLimit: 7
    });

    const pipeline = files.aggregate.mock.calls[0][0];
    expect(candidateHasher.CANDIDATE_QUEUE_ORDER).toEqual([
      'potential_duplicate_bytes_desc',
      'file_size_desc'
    ]);
    expect(pipeline).toContainEqual({ $sort: { potential_waste: -1, _id: -1 } });
    expect(pipeline).toContainEqual({ $limit: 7 });
  });

  test('hashes whole same-size groups within budget and records fingerprints', async () => {
    const group = {
      _id: 100,
      count: 2,
      files: [
        { _id: 'a', path: '/mnt/datalake/a.bin', size: 100, mtime: 10 },
        { _id: 'b', path: '/mnt/datalake/b.bin', size: 100, mtime: 20 }
      ]
    };
    const { db, files } = dbWithGroups([group]);
    const computeHash = jest.fn(async filePath => `hash-${filePath.slice(-5)}`);

    const result = await candidateHasher.hashDuplicateCandidates(db, {
      roots: ['/mnt/datalake'],
      maxFiles: 10,
      maxBytes: 1000,
      computeHash
    });

    expect(result).toMatchObject({ selected_groups: 1, hashed: 2, hash_bytes: 200, errors: 0 });
    expect(files.updateOne).toHaveBeenCalledTimes(2);
    expect(files.updateOne.mock.calls[0][1].$set).toMatchObject({
      hash_fingerprint: '100:10',
      hash_strategy: 'duplicate-size-candidate'
    });
  });

  test('progresses a group across runs when the whole group exceeds the byte budget', async () => {
    const group = {
      _id: 1000,
      count: 2,
      files: [
        { _id: 'a', path: '/mnt/datalake/a.bin', size: 1000, mtime: 10 },
        { _id: 'b', path: '/mnt/datalake/b.bin', size: 1000, mtime: 20 }
      ]
    };
    const { db, files } = dbWithGroups([group]);

    const result = await candidateHasher.hashDuplicateCandidates(db, {
      roots: ['/mnt/datalake'],
      maxFiles: 10,
      maxBytes: 1500,
      computeHash: jest.fn().mockResolvedValue('hash-a')
    });

    expect(result).toMatchObject({
      selected_groups: 1,
      hashed: 1,
      hash_bytes: 1000,
      partial_groups: 1,
      deferred_groups: 1,
      deferred_files: 1,
      oversized_groups: 0
    });
    expect(files.updateOne).toHaveBeenCalledTimes(1);
  });

  test('reports individual files larger than the byte budget as oversized', async () => {
    const group = {
      _id: 2000,
      count: 2,
      current_hashed: 0,
      files: [
        { _id: 'a', path: '/mnt/datalake/a.bin', size: 2000, mtime: 10 },
        { _id: 'b', path: '/mnt/datalake/b.bin', size: 2000, mtime: 20 }
      ]
    };
    const { db, files } = dbWithGroups([group]);

    const result = await candidateHasher.hashDuplicateCandidates(db, {
      roots: ['/mnt/datalake'],
      maxFiles: 10,
      maxBytes: 1500,
      computeHash: jest.fn()
    });

    expect(result).toMatchObject({
      selected_groups: 0,
      hashed: 0,
      deferred_groups: 1,
      oversized_groups: 1,
      oversized_files: 2,
      oversized_bytes: 4000
    });
    expect(files.updateOne).not.toHaveBeenCalled();
  });

  test('reports an oversized group as partial when some members already have current hashes', async () => {
    const group = {
      _id: 2000,
      count: 2,
      current_hashed: 1,
      files: [
        {
          _id: 'a', path: '/mnt/datalake/a.bin', size: 2000, mtime: 10,
          sha256: 'existing', hash_fingerprint: '2000:10'
        },
        { _id: 'b', path: '/mnt/datalake/b.bin', size: 2000, mtime: 20 }
      ]
    };
    const { db } = dbWithGroups([group]);

    const result = await candidateHasher.hashDuplicateCandidates(db, {
      maxFiles: 10,
      maxBytes: 1500,
      computeHash: jest.fn()
    });

    expect(result).toMatchObject({
      partial_groups: 1,
      deferred_files: 1,
      oversized_groups: 1,
      oversized_files: 1
    });
  });

  test('reuses hashes only when size and mtime fingerprint still match', () => {
    expect(candidateHasher.hasCurrentHash({
      sha256: 'abc', size: 10, mtime: 20, hash_fingerprint: '10:20'
    })).toBe(true);
    expect(candidateHasher.hasCurrentHash({
      sha256: 'abc', size: 10, mtime: 21, hash_fingerprint: '10:20'
    })).toBe(false);
  });

  test('does not count a hash when the file changed before persistence', async () => {
    const group = {
      _id: 100,
      count: 2,
      files: [
        { _id: 'a', path: '/mnt/datalake/a.bin', size: 100, mtime: 10 },
        { _id: 'b', path: '/mnt/datalake/b.bin', size: 100, mtime: 20 }
      ]
    };
    const { db, files } = dbWithGroups([group]);
    files.updateOne.mockResolvedValue({ matchedCount: 0 });

    const result = await candidateHasher.hashDuplicateCandidates(db, {
      maxFiles: 10,
      maxBytes: 1000,
      computeHash: jest.fn().mockResolvedValue('hash')
    });

    expect(result).toMatchObject({ hashed: 0, hash_bytes: 0, errors: 2 });
  });
});
