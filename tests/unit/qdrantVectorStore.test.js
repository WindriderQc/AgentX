const QdrantVectorStore = require('../../src/services/vectorStore/QdrantVectorStore');

jest.mock('node-fetch');
const fetch = require('node-fetch');

describe('QdrantVectorStore', () => {
  let store;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new QdrantVectorStore({
      host: 'http://localhost:6333',
      collection: 'test_embeddings'
    });
    store.initialized = true; // Skip collection bootstrap in unit tests
  });

  test('listDocuments should include source/path/tag filters and expose sha256 metadata', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          points: [
            {
              payload: {
                documentId: 'doc-1',
                source: 'rag-folder',
                path: 'docs/a.md',
                title: 'A',
                tags: ['alpha'],
                text: 'chunk text',
                hash: 'hash-md5',
                sha256: 'hash-sha256'
              }
            }
          ]
        }
      })
    });

    const docs = await store.listDocuments({
      source: 'rag-folder',
      path: 'docs/a.md',
      tags: ['alpha']
    });

    const request = JSON.parse(fetch.mock.calls[0][1].body);
    const must = request.filter.must;

    expect(must).toEqual(expect.arrayContaining([
      { key: 'source', match: { value: 'rag-folder' } },
      { key: 'path', match: { value: 'docs/a.md' } },
      { key: 'tags', match: { any: ['alpha'] } }
    ]));
    expect(docs[0].sha256).toBe('hash-sha256');
    expect(docs[0].hash).toBe('hash-md5');
  });

  test('searchSimilar should support path filter', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: []
      })
    });

    await store.searchSimilar([0.1, 0.2], {
      filters: {
        source: 'rag-folder',
        path: 'docs/a.md'
      }
    });

    const request = JSON.parse(fetch.mock.calls[0][1].body);
    expect(request.filter.must).toEqual(expect.arrayContaining([
      { key: 'source', match: { value: 'rag-folder' } },
      { key: 'path', match: { value: 'docs/a.md' } }
    ]));
  });

  test('getDocumentChunks should return chunks ordered by chunkIndex', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          points: [
            { payload: { text: 'second', chunkIndex: 1 } },
            { payload: { text: 'first', chunkIndex: 0 } }
          ]
        }
      })
    });

    const chunks = await store.getDocumentChunks('doc-1');
    expect(chunks).toEqual([
      { text: 'first', chunkIndex: 0 },
      { text: 'second', chunkIndex: 1 }
    ]);
  });
});
