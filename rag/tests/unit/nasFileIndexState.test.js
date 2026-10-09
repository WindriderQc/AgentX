'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  resetIndexedFiles, excludeIndexedFiles, restoreExcludedFile, listExcludedFiles
} = require('../../src/services/nasFileIndexState');

function fakeDb(modifiedCount = 2) {
  const collection = { updateMany: jest.fn().mockResolvedValue({ modifiedCount }) };
  return { collection: jest.fn(() => collection), files: collection };
}

describe('resetIndexedFiles', () => {
  it('clears index state of the files behind deleted documents, keeping policy and operator exclusions', async () => {
    const db = fakeDb(2);
    await expect(resetIndexedFiles(['/notes/a.md', '/notes/a.md', '/docs/b.pdf'], { db })).resolves.toBe(2);
    expect(db.collection).toHaveBeenCalledWith('nas_files');
    expect(db.files.updateMany).toHaveBeenCalledWith(
      { indexed_document_id: { $in: ['/notes/a.md', '/docs/b.pdf'] }, indexed_status: { $nin: ['skipped-note', 'excluded'] } },
      { $unset: { indexed_at: '', indexed_status: '', indexed_document_id: '' } }
    );
  });

  it('does nothing for an empty list', async () => {
    const db = fakeDb();
    await expect(resetIndexedFiles([], { db })).resolves.toBe(0);
    expect(db.files.updateMany).not.toHaveBeenCalled();
  });

  it('reports null instead of failing when MongoDB is unavailable or the update fails', async () => {
    await expect(resetIndexedFiles(['a'])).resolves.toBeNull();
    const db = fakeDb();
    db.files.updateMany.mockRejectedValue(new Error('mongo down'));
    await expect(resetIndexedFiles(['a'], { db })).resolves.toBeNull();
  });
});

describe('excludeIndexedFiles', () => {
  it('marks the files behind deleted documents excluded instead of resetting them', async () => {
    const db = fakeDb(1);
    await expect(excludeIndexedFiles(['/notes/a.md'], { db })).resolves.toBe(1);
    const [filter, update] = db.files.updateMany.mock.calls[0];
    expect(filter).toEqual({ indexed_document_id: { $in: ['/notes/a.md'] } });
    expect(update.$set.indexed_status).toBe('excluded');
    expect(update.$set.excluded_at).toBeInstanceOf(Date);
  });

  it('reports 0 when no scanned file produced the document, null without MongoDB', async () => {
    await expect(excludeIndexedFiles(['api-doc'], { db: fakeDb(0) })).resolves.toBe(0);
    await expect(excludeIndexedFiles(['api-doc'])).resolves.toBeNull();
  });
});

describe('restoreExcludedFile', () => {
  it('clears the exclusion and index state so the next scan ingests the file', async () => {
    const db = fakeDb(1);
    await expect(restoreExcludedFile('/notes/a.md', { db })).resolves.toBe(1);
    expect(db.files.updateMany).toHaveBeenCalledWith(
      { path: '/notes/a.md', indexed_status: 'excluded' },
      { $unset: { indexed_at: '', indexed_status: '', indexed_document_id: '', excluded_at: '' } }
    );
  });

  it('ignores an empty path', async () => {
    const db = fakeDb();
    await expect(restoreExcludedFile('', { db })).resolves.toBe(0);
    expect(db.files.updateMany).not.toHaveBeenCalled();
  });
});

describe('listExcludedFiles', () => {
  it('lists excluded files newest first', async () => {
    const excludedAt = new Date('2026-10-01T00:00:00Z');
    const cursor = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([{ _id: 'x', path: '/notes/a.md', excluded_at: excludedAt }])
    };
    const collection = { find: jest.fn(() => cursor) };
    const db = { collection: jest.fn(() => collection) };
    await expect(listExcludedFiles({ db })).resolves.toEqual([{ path: '/notes/a.md', excludedAt }]);
    expect(collection.find.mock.calls[0][0]).toEqual({ indexed_status: 'excluded' });
    expect(cursor.sort).toHaveBeenCalledWith({ excluded_at: -1 });
  });

  it('returns null without MongoDB', async () => {
    await expect(listExcludedFiles()).resolves.toBeNull();
  });
});
