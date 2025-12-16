// Mock dependencies
jest.mock('../../src/services/embeddings', () => ({
  getEmbeddingsService: jest.fn(() => ({
    generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5]),
    generateEmbeddings: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4, 0.5]]),
    embedTextBatch: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4, 0.5]]),
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
    // Ensure we're asserting against the exact embeddings service instance
    // used by the RagStore singleton.
    ragStore = getRagStore();
    embeddingsService = ragStore.embeddings;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('upsertDocumentWithChunks', () => {
    test('should chunk and upsert a document', async () => {
      const documentContent = 'This is a test document. '.repeat(50); // Long document
      const metadata = { source: 'test.txt', type: 'text', path: 'test.txt', title: 'Test Document' };

      const result = await ragStore.upsertDocumentWithChunks(metadata, documentContent);

      expect(result.documentId).toBeDefined();
      expect(result.chunkCount).toBeGreaterThan(0);
      expect(embeddingsService.embedTextBatch).toHaveBeenCalled();
    });

    test('should handle small documents', async () => {
      const documentContent = 'Short document';
      const metadata = { source: 'short.txt', path: 'short.txt', title: 'Short Document' };

      const result = await ragStore.upsertDocumentWithChunks(metadata, documentContent);

      expect(result.chunkCount).toBe(1);
    });

    test('should deduplicate based on content hash', async () => {
      const documentContent = 'Duplicate content';
      const metadata = { source: 'dup1.txt', path: 'dup1.txt', title: 'Dup 1' };

      const result1 = await ragStore.upsertDocumentWithChunks(metadata, documentContent);
      const result2 = await ragStore.upsertDocumentWithChunks({ source: 'dup2.txt', path: 'dup2.txt', title: 'Dup 2' }, documentContent);

      // Different source/path means different documentId
      expect(result1.documentId).not.toBe(result2.documentId);

      // Test actual deduplication: same source/path, same content should be unchanged
      const result3 = await ragStore.upsertDocumentWithChunks(metadata, documentContent);
      expect(result3.status).toBe('unchanged');
    });
  });

  describe('searchSimilarChunks', () => {
    beforeEach(async () => {
      // Seed some test data
      await ragStore.upsertDocumentWithChunks(
        { source: 'ai.txt', category: 'tech', path: 'ai.txt', title: 'AI' },
        'Information about artificial intelligence and machine learning'
      );

      await ragStore.upsertDocumentWithChunks(
        { source: 'cooking.txt', category: 'food', path: 'cooking.txt', title: 'Cooking' },
        'Information about cooking recipes and food preparation'
      );
    });

    test('should find relevant chunks', async () => {
      const results = await ragStore.searchSimilarChunks('machine learning', { topK: 3 });

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    test('should filter by metadata', async () => {
      const results = await ragStore.searchSimilarChunks('information', {
        topK: 5,
        filters: { category: 'tech' }
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach(result => {
        expect(result.metadata.category).toBe('tech');
      });
    });
  });

  describe('getDocument', () => {
    test('should retrieve document', async () => {
      const content = 'Test document content';
      const { documentId } = await ragStore.upsertDocumentWithChunks({ source: 'test.txt', path: 'test.txt', title: 'Test' }, content);

      const doc = await ragStore.getDocument(documentId);

      expect(doc).toBeDefined();
      expect(doc.documentId).toBe(documentId);
    });

    test('should return null for nonexistent document', async () => {
      const doc = await ragStore.getDocument('nonexistent-id');

      expect(doc).toBeNull();
    });
  });

  describe('deleteDocument', () => {
    test('should delete all chunks of a document', async () => {
      const content = 'Document to delete';
      const { documentId } = await ragStore.upsertDocumentWithChunks({ source: 'delete.txt', path: 'delete.txt', title: 'Delete' }, content);

      const result = await ragStore.deleteDocument(documentId);

      // deleteDocument returns boolean
      expect(result).toBe(true);

      const doc = await ragStore.getDocument(documentId);
      expect(doc).toBeNull();
    });
  });

  describe('listDocuments', () => {
    beforeEach(async () => {
      await ragStore.upsertDocumentWithChunks({ source: 'doc1.txt', category: 'A', path: 'doc1.txt', title: 'Doc 1' }, 'Doc 1');
      await ragStore.upsertDocumentWithChunks({ source: 'doc2.txt', category: 'B', path: 'doc2.txt', title: 'Doc 2' }, 'Doc 2');
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
        // InMemoryVectorStore returns flat objects
        expect(doc.category).toBe('A');
      });
    });
  });
});
