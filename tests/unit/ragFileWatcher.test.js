const { getRagStore } = require('../../src/services/ragStore');

jest.mock('chokidar', () => ({
  watch: jest.fn()
}));

jest.mock('../../src/services/ragStore', () => ({
  getRagStore: jest.fn()
}));

jest.mock('../../src/app', () => ({
  systemEvents: new (require('events').EventEmitter)()
}));

const RagFileWatcher = require('../../src/services/ragFileWatcher');

describe('RagFileWatcher safety', () => {
  let mockRagStore;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRagStore = {
      getDocument: jest.fn(),
      deleteDocument: jest.fn(),
      listDocuments: jest.fn()
    };
    getRagStore.mockReturnValue(mockRagStore);
  });

  test('removeDocument should skip when auto-delete is disabled', async () => {
    const watcher = new RagFileWatcher({
      ragDir: '/rag',
      source: 'rag-folder',
      autoDeleteOnUnlink: false
    });

    const result = await watcher.removeDocument('/rag/docs/a.md');
    expect(result).toEqual(expect.objectContaining({ deletedCount: 0, skipped: true }));
    expect(mockRagStore.getDocument).not.toHaveBeenCalled();
    expect(mockRagStore.deleteDocument).not.toHaveBeenCalled();
  });

  test('removeDocument should refuse delete on source/path mismatch', async () => {
    const watcher = new RagFileWatcher({
      ragDir: '/rag',
      source: 'rag-folder',
      autoDeleteOnUnlink: true
    });
    mockRagStore.getDocument.mockResolvedValue({
      source: 'other-source',
      path: 'docs/a.md'
    });

    const result = await watcher.removeDocument('/rag/docs/a.md');
    expect(result.deletedCount).toBe(0);
    expect(mockRagStore.deleteDocument).not.toHaveBeenCalled();
  });

  test('removeDocument should delete exact source+path match only', async () => {
    const watcher = new RagFileWatcher({
      ragDir: '/rag',
      source: 'rag-folder',
      autoDeleteOnUnlink: true
    });
    const documentId = watcher.buildDocumentId('rag-folder', 'docs/a.md');
    mockRagStore.getDocument.mockResolvedValue({
      source: 'rag-folder',
      path: 'docs/a.md'
    });
    mockRagStore.deleteDocument.mockResolvedValue(true);

    const result = await watcher.removeDocument('/rag/docs/a.md');
    expect(result.deletedCount).toBe(1);
    expect(mockRagStore.deleteDocument).toHaveBeenCalledWith(documentId);
  });

  test('cleanupObsoleteDocuments should return cleaned count', async () => {
    const watcher = new RagFileWatcher({
      ragDir: '/rag',
      source: 'rag-folder',
      autoDeleteOnUnlink: true
    });

    mockRagStore.listDocuments.mockResolvedValue([
      { documentId: 'doc1', path: 'docs/existing.md' },
      { documentId: 'doc2', path: 'docs/missing.md' },
      { documentId: 'doc3', path: '' }
    ]);
    mockRagStore.deleteDocument.mockResolvedValue(true);
    watcher.scanDirectory = jest.fn().mockResolvedValue(['/rag/docs/existing.md']);

    const cleanedCount = await watcher.cleanupObsoleteDocuments();
    expect(cleanedCount).toBe(1);
    expect(mockRagStore.deleteDocument).toHaveBeenCalledWith('doc2');
  });
});
