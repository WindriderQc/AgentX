'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { resetIndexedFiles } = require('../../src/services/nasFileIndexState');

function fakeDb(modifiedCount = 2) {
  const collection = { updateMany: jest.fn().mockResolvedValue({ modifiedCount }) };
  return { collection: jest.fn(() => collection), files: collection };
}

describe('resetIndexedFiles', () => {
  it('clears index state of the files behind deleted documents, keeping policy exclusions', async () => {
    const db = fakeDb(2);
    await expect(resetIndexedFiles(['/notes/a.md', '/notes/a.md', '/docs/b.pdf'], { db })).resolves.toBe(2);
    expect(db.collection).toHaveBeenCalledWith('nas_files');
    expect(db.files.updateMany).toHaveBeenCalledWith(
      { indexed_document_id: { $in: ['/notes/a.md', '/docs/b.pdf'] }, indexed_status: { $ne: 'skipped-note' } },
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
