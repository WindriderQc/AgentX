/**
 * Integration test — ingest, search, delete cycle using InMemoryVectorStore
 * with mocked embedding provider. No external services required.
 */

// Must mock before any require that touches these modules
jest.mock('mongoose', () => {
  function FakeSchema() {
    // Schema instances need index() for compound index declarations
    this.index = jest.fn().mockReturnThis();
  }
  return {
    connection: { readyState: 0 },
    connect: jest.fn(),
    Schema: FakeSchema,
    model: jest.fn(() => ({ create: jest.fn().mockResolvedValue({}) })),
  };
});

const supertest = require('supertest');
const { resetRagStore, RagStore } = require('../../src/services/ragStore');
const { resetEmbeddingsService } = require('../../src/services/embeddings');

// A fixed embedding vector to return for all texts
const DIMENSION = 8;
const FIXED_EMBEDDING = Array.from({ length: DIMENSION }, (_, i) => (i + 1) / DIMENSION);

let app;
let ragStoreInstance;

beforeAll(() => {
  // Reset singletons before setting up
  resetRagStore();
  resetEmbeddingsService();

  // Set env so factory picks in-memory store
  process.env.VECTOR_STORE_TYPE = 'memory';

  // Create a RagStore with in-memory vector store
  ragStoreInstance = new RagStore({ type: 'memory' });

  // Replace the embeddings service with a mock that returns fixed vectors
  ragStoreInstance.embeddingsService = {
    model: 'mock-embed',
    embedBatch: jest.fn(async (texts) => texts.map(() => [...FIXED_EMBEDDING])),
    getDimension: () => DIMENSION,
  };

  // Monkey-patch getRagStore so routes use our prepared instance
  const ragStoreModule = require('../../src/services/ragStore');
  ragStoreModule.getRagStore = () => ragStoreInstance;

  // Now require app (after mocks are in place)
  app = require('../../app');
});

afterAll(() => {
  resetRagStore();
  resetEmbeddingsService();
});

describe('Input refusal preserves the indexed corpus', () => {
  let originalEmbed;
  beforeEach(() => {
    originalEmbed = ragStoreInstance.embeddingsService.embedBatch.getMockImplementation();
    const provider = new (require('../../src/services/embeddings/coreProxyProvider'))();
    ragStoreInstance.embeddingsService.embedBatch.mockImplementation(async texts => {
      provider.validateTexts(texts);
      return texts.map(() => [...FIXED_EMBEDDING]);
    });
  });
  afterEach(() => ragStoreInstance.embeddingsService.embedBatch.mockImplementation(originalEmbed));

  it('reports the provider limit and preserves an existing document after a refused update', async () => {
    const documentId = 'input-limit-regression';
    await supertest(app).post('/api/rag/ingest').send({ documentId, source: 'limit-test', text: 'Original complete source' }).expect(200);
    const refused = await supertest(app).post('/api/rag/ingest').send({ documentId, source: 'limit-test', text: 'x'.repeat(9001), chunkSize: 10000 }).expect(413);
    expect(refused.body).toMatchObject({ ok: false, error: 'EMBEDDING_INPUT_TOO_LARGE', meta: { limit: 8000, inputLength: 9001, unit: 'characters', overflow: 'reject' } });
    const chunks = await ragStoreInstance.getDocumentChunks(documentId);
    expect(chunks.map(chunk => chunk.text).join('')).toBe('Original complete source');
    const search = await supertest(app).post('/api/rag/search').send({ query: 'x'.repeat(8001) }).expect(413);
    expect(search.body.error).toBe('EMBEDDING_INPUT_TOO_LARGE');
    await ragStoreInstance.deleteDocument(documentId);
  });

  it('reports a refused first batch document and still accounts for the next one', async () => {
    const result = await supertest(app).post('/api/rag/ingest/batch').send({ documents: [
      { documentId: 'batch-limit-refused', text: 'x'.repeat(9001), chunkSize: 10000 },
      { documentId: 'batch-limit-accepted', text: 'Complete small source' }
    ] }).expect(200);
    expect(result.body.data).toMatchObject({ total: 2, succeeded: 1, failed: 1, results: [
      { index: 0, status: 'error', code: 'EMBEDDING_INPUT_TOO_LARGE', statusCode: 413 },
      { index: 1, status: 'ok' }
    ] });
    expect(await ragStoreInstance.vectorStore.getDocument('batch-limit-refused')).toBeNull();
    await ragStoreInstance.deleteDocument('batch-limit-accepted');
  });

  it('never indexes an apparently complete document after the chunk safety limit', async () => {
    const response = await supertest(app).post('/api/rag/ingest').send({ documentId: 'chunk-limit-refused', text: 'x'.repeat(1_000_100), chunkSize: 100, chunkOverlap: 0 }).expect(413);
    expect(response.body.error).toBe('RAG_CHUNK_LIMIT_EXCEEDED');
    expect(await ragStoreInstance.vectorStore.getDocument('chunk-limit-refused')).toBeNull();
  });
});

describe('Integration: ingest → search → delete cycle', () => {
  const testText = 'The quick brown fox jumps over the lazy dog. ' +
    'This is an important document about foxes and dogs. ' +
    'It contains several sentences for chunking.';
  let documentId;

  it('ingests a document via POST /api/rag/ingest', async () => {
    const res = await supertest(app)
      .post('/api/rag/ingest')
      .send({
        text: testText,
        source: 'integration-test',
        tags: ['fox', 'dog'],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documentId).toBeDefined();
    expect(res.body.data.chunkCount).toBeGreaterThanOrEqual(1);
    expect(res.body.data.status).toBe('created');

    documentId = res.body.data.documentId;
  });

  it('finds the document via POST /api/rag/search', async () => {
    const res = await supertest(app)
      .post('/api/rag/search')
      .send({ query: 'fox and dog', topK: 5 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.results.length).toBeGreaterThanOrEqual(1);

    // All chunks share the same fixed embedding, so cosine similarity should be 1.0
    const topResult = res.body.data.results[0];
    expect(topResult.score).toBeCloseTo(1.0);
    expect(topResult.text).toBeDefined();
    expect(topResult.metadata).toBeDefined();
    expect(topResult.metadata.source).toBe('integration-test');
  });

  it('lists the document via GET /api/rag/documents', async () => {
    const res = await supertest(app)
      .get('/api/rag/documents')
      .query({ source: 'integration-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.documents[0].documentId).toBe(documentId);
  });

  it('deletes the document via DELETE /api/rag/documents/:id', async () => {
    const res = await supertest(app)
      .delete(`/api/rag/documents/${documentId}`)
      .send({ confirmation: `DELETE ${documentId}` });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.documentId).toBe(documentId);
  });

  it('search returns no results after deletion', async () => {
    const res = await supertest(app)
      .post('/api/rag/search')
      .send({ query: 'fox and dog', topK: 5 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.results).toHaveLength(0);
  });
});

describe('Memory classification through ingestion and retrieval', () => {
  it.each([
    ['owner', 'private'],
    ['private_domain', 'highly_private'],
    ['household', 'normal'],
  ])('preserves %s / %s through the HTTP API', async (scope, sensitivity) => {
    const documentId = `classification-${scope}`;
    await supertest(app).post('/api/rag/documents').send({
      documentId, source: 'classification-test', text: `Synthetic note for ${scope}`, scope, sensitivity,
    }).expect(200);
    const response = await supertest(app).post('/api/rag/search').send({
      query: 'synthetic note', filters: { scope, sensitivity },
    }).expect(200);
    expect(response.body.data.results).toHaveLength(1);
    expect(response.body.data.results[0].metadata).toMatchObject({ documentId, scope, sensitivity });
    const detail = await supertest(app).get(`/api/rag/documents/${documentId}`).expect(200);
    expect(detail.body.data.metadata).toMatchObject({ scope, sensitivity });
    const chunks = await supertest(app).get(`/api/rag/documents/${documentId}/chunks`).expect(200);
    expect(chunks.body.data.chunks[0].metadata).toMatchObject({ scope, sensitivity });
  });

  it.each([
    { scope: 'owner' },
    { sensitivity: 'private' },
    { scope: 'owner', sensitivity: 'public' },
    { scope: 'arbitrary', sensitivity: 'normal' },
  ])('rejects incomplete or invented classification: %j', async (classification) => {
    await supertest(app).post('/api/rag/documents').send({
      text: 'Unclassified test content', ...classification,
    }).expect(400);
  });
});
