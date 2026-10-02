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

describe('Qdrant payload indexes', () => {
  let store;
  const indexCalls = () => fetch.mock.calls.filter(([url]) => url.endsWith('/index'))
    .map(([, options]) => JSON.parse(options.body));
  beforeEach(() => {
    fetch.mockReset();
    store = new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'target' });
  });

  test('an existing collection gets only its missing indexes, and a failed one does not block it', async () => {
    const present = Object.keys(QdrantVectorStore.PAYLOAD_INDEXES).filter(field => !['documentId', 'text'].includes(field));
    fetch.mockImplementation(async (url, options = {}) => {
      if (!options.method) return mockOk({ result: { payload_schema: Object.fromEntries(present.map(f => [f, {}])) } });
      return JSON.parse(options.body).field_name === 'text' ? mockFail(500, 'boom') : mockOk({ result: {} });
    });
    await store._ensureCollection(768);
    expect(indexCalls()).toEqual([
      { field_name: 'documentId', field_schema: 'keyword' },
      { field_name: 'text', field_schema: { type: 'text', tokenizer: 'word', min_token_len: 2, lowercase: true } }
    ]);
    expect(store._collectionVerified).toBe(true);
    expect(store._textIndexReady).toBe(false);
  });

  test('a new collection is created with every payload index', async () => {
    fetch.mockImplementation(async (url, options = {}) => (
      options.method ? mockOk({ result: {} }) : mockFail(404, 'Not found: Collection `target` doesn\'t exist!')));
    await store._ensureCollection(768);
    expect(indexCalls().map(body => body.field_name)).toEqual(Object.keys(QdrantVectorStore.PAYLOAD_INDEXES));
    expect(store._textIndexReady).toBe(true);
  });
});
