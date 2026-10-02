jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());

const fetch = require('../../src/utils/fetchWithTimeout');
const QdrantVectorStore = require('../../src/services/vectorStore/QdrantVectorStore');

const mockOk = (jsonBody = {}) => ({ ok: true, json: async () => jsonBody, text: async () => '' });
const mockFail = (status, body) => ({ ok: false, status, text: async () => body });

describe('Qdrant collection metadata helpers', () => {
  let store;
  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'target' });
  });

  test('getCollectionInfo returns vector size and payload indexes, or null when missing', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: {
      points_count: 12,
      config: { params: { vectors: { size: 1024, distance: 'Cosine' } } },
      payload_schema: { documentId: { data_type: 'keyword', points: 12 } }
    } }));
    expect(await store.getCollectionInfo()).toEqual({
      vectorSize: 1024, pointsCount: 12, payloadSchema: { documentId: { data_type: 'keyword', points: 12 } }
    });
    fetch.mockResolvedValueOnce(mockFail(404, 'Not found: Collection `target` doesn\'t exist!'));
    expect(await store.getCollectionInfo()).toBeNull();
    fetch.mockResolvedValueOnce(mockFail(500, 'boom'));
    await expect(store.getCollectionInfo()).rejects.toThrow(/500/);
  });

  test('createPayloadIndex sends the field schema to the collection index endpoint', async () => {
    fetch.mockResolvedValueOnce(mockOk({ result: { status: 'acknowledged' } }));
    await store.createPayloadIndex('documentId', 'keyword');
    const [url, options, , context] = fetch.mock.calls[0];
    expect(url).toBe('http://qdrant:6333/collections/target/index');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ field_name: 'documentId', field_schema: 'keyword' });
    expect(context.operationId).toBe('rag.qdrant.payload-index-create');
  });
});
