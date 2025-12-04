// Mock dependencies
jest.mock('../../src/services/embeddings', () => ({
  getEmbeddingsService: jest.fn(() => ({
    generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5]),
    generateEmbeddings: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4, 0.5]]),
    getDimension: jest.fn().mockReturnValue(5)
  }))
}));

jest.mock('../../src/services/vectorStore/factory', () => ({
  createVectorStore: jest.fn(() => {
    const InMemoryVectorStore = require('../../src/services/vectorStore/InMemoryVectorStore');
    return new InMemoryVectorStore();
  })
}));

const { getRagStore } = require('../../src/services/ragStore');
const { getEmbeddingsService } = require('../../src/services/embeddings');

let ragStore;
let embeddingsService;

describe('RAG Store', () => {
  beforeAll(() => {
    embeddingsService = getEmbeddingsService();
    ragStore = getRagStore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('upsertDocumentWithChunks', () => {
    test('should chunk and upsert a document', async () => {
      const documentContent = 'This is a test document. '.repeat(50); // Long document
      const metadata = { source: 'test.txt', type: 'text' };

      const result = await ragStore.upsertDocumentWithChunks(documentContent, metadata);

      expect(result.success).toBe(true);
      expect(result.documentId).toBeDefined();
      expect(result.chunksCreated).toBeGreaterThan(0);
      expect(embeddingsService.generateEmbeddings).toHaveBeenCalled();
    });

    test('should handle small documents', async () => {
      const documentContent = 'Short document';
      const metadata = { source: 'short.txt' };

      const result = await ragStore.upsertDocumentWithChunks(documentContent, metadata);

      expect(result.success).toBe(true);
      expect(result.chunksCreated).toBe(1);
    });

    test('should deduplicate based on content hash', async () => {
      const documentContent = 'Duplicate content';
      const metadata = { source: 'dup1.txt' };

      const result1 = await ragStore.upsertDocumentWithChunks(documentContent, metadata);
      const result2 = await ragStore.upsertDocumentWithChunks(documentContent, { source: 'dup2.txt' });

      // Same documentId means deduplication worked
      expect(result1.documentId).toBe(result2.documentId);
    });
  });

  describe('searchSimilarChunks', () => {
    beforeEach(async () => {
      // Seed some test data
      await ragStore.upsertDocumentWithChunks(
        'Information about artificial intelligence and machine learning',
        { source: 'ai.txt', category: 'tech' }
      );

      await ragStore.upsertDocumentWithChunks(
        'Information about cooking recipes and food preparation',
        { source: 'cooking.txt', category: 'food' }
      );
    });

    test('should find relevant chunks', async () => {
      const results = await ragStore.searchSimilarChunks('machine learning', 3);

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    test('should filter by metadata', async () => {
      const results = await ragStore.searchSimilarChunks('information', 5, {
        category: 'tech'
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach(result => {
        expect(result.metadata.category).toBe('tech');
      });
    });
  });

  describe('getDocumentById', () => {
    test('should retrieve document chunks', async () => {
      const content = 'Test document content';
      const { documentId } = await ragStore.upsertDocumentWithChunks(content, { source: 'test.txt' });

      const chunks = await ragStore.getDocumentById(documentId);

      expect(chunks).toBeDefined();
      expect(Array.isArray(chunks)).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);
    });

    test('should return empty array for nonexistent document', async () => {
      const chunks = await ragStore.getDocumentById('nonexistent-id');

      expect(chunks).toEqual([]);
    });
  });

  describe('deleteDocument', () => {
    test('should delete all chunks of a document', async () => {
      const content = 'Document to delete';
      const { documentId } = await ragStore.upsertDocumentWithChunks(content, { source: 'delete.txt' });

      const result = await ragStore.deleteDocument(documentId);

      expect(result.success).toBe(true);
      expect(result.chunksDeleted).toBeGreaterThan(0);

      const chunks = await ragStore.getDocumentById(documentId);
      expect(chunks).toEqual([]);
    });
  });

  describe('listDocuments', () => {
    beforeEach(async () => {
      await ragStore.upsertDocumentWithChunks('Doc 1', { source: 'doc1.txt', category: 'A' });
      await ragStore.upsertDocumentWithChunks('Doc 2', { source: 'doc2.txt', category: 'B' });
    });

    test('should list all documents', async () => {
      const docs = await ragStore.listDocuments();

      expect(docs).toBeDefined();
      expect(Array.isArray(docs)).toBe(true);
      expect(docs.length).toBeGreaterThan(0);
    });

    test('should filter by metadata', async () => {
      const docs = await ragStore.listDocuments({ category: 'A' });

      expect(docs.length).toBeGreaterThan(0);
      docs.forEach(doc => {
        expect(doc.metadata.category).toBe('A');
      });
    });
  });
});
