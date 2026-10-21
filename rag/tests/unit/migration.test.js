jest.mock('mongoose', () => ({
  connection: { readyState: 1 }
}));

jest.mock('../../src/services/ragStore', () => {
  const mockRagStore = {
    listDocuments: jest.fn(),
    getStats: jest.fn(),
    upsertDocumentWithChunks: jest.fn(),
    vectorStore: {
      getDocumentOriginalText: jest.fn(),
      getDocument: jest.fn(),
    },
  };
  return {
    getRagStore: jest.fn(() => mockRagStore),
    _mockRagStore: mockRagStore,
  };
});

jest.mock('../../src/services/embeddings', () => {
  const mockEmbeddingsService = {
    model: 'nomic-embed-text:v1.5',
    getDimension: jest.fn(() => 768),
  };
  return {
    getEmbeddingsService: jest.fn(() => mockEmbeddingsService),
    _mockEmbeddingsService: mockEmbeddingsService,
  };
});

const express = require('express');
const request = require('supertest');
const { getRagStore, _mockRagStore } = require('../../src/services/ragStore');
const { getEmbeddingsService, _mockEmbeddingsService } = require('../../src/services/embeddings');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', require('../../routes/migration.routes'));
  return app;
}

describe('GET /api/rag/embedding-migration/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _mockEmbeddingsService.model = 'nomic-embed-text:v1.5';
    _mockEmbeddingsService.getDimension.mockReturnValue(768);
  });

  it('returns status with matching dimensions', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 768,
      documentCount: 42,
      chunkCount: 310,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({
      currentModel: 'nomic-embed-text:v1.5',
      currentDimension: 768,
      storedDimension: 768,
      dimensionMatch: true,
      documentCount: 42,
      chunkCount: 310,
      migrationNeeded: false,
    });
  });

  it('detects dimension mismatch and reports migrationNeeded', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 384,
      documentCount: 10,
      chunkCount: 80,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.status).toBe(200);
    expect(res.body.data.dimensionMatch).toBe(false);
    expect(res.body.data.migrationNeeded).toBe(true);
    expect(res.body.data.note).toContain('collection recreation');
  });

  it('reports no migration needed for empty collection', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 0,
      documentCount: 0,
      chunkCount: 0,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.body.data.dimensionMatch).toBe(true);
    expect(res.body.data.migrationNeeded).toBe(false);
  });

  it('reports no migration needed when dimensions differ but no documents exist', async () => {
    _mockRagStore.getStats.mockResolvedValue({
      vectorDimension: 384,
      documentCount: 0,
      chunkCount: 0,
    });

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.body.data.dimensionMatch).toBe(false);
    expect(res.body.data.migrationNeeded).toBe(false);
  });

  it('returns 500 on internal error', async () => {
    _mockRagStore.getStats.mockRejectedValue(new Error('Qdrant down'));

    const app = buildApp();
    const res = await request(app).get('/api/rag/embedding-migration/status');

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /api/rag/embedding-migration/reindex', () => {
  it('is retired: it neither reads nor re-embeds the serving collection', async () => {
    jest.clearAllMocks();
    const res = await request(buildApp())
      .post('/api/rag/embedding-migration/reindex')
      .send({ confirmation: 'REINDEX ALL DOCUMENTS', force: true });

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ ok: false, error: 'IN_PLACE_REINDEX_RETIRED' });
    expect(_mockRagStore.listDocuments).not.toHaveBeenCalled();
    expect(_mockRagStore.upsertDocumentWithChunks).not.toHaveBeenCalled();
  });
});
