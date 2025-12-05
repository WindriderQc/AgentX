const InMemoryVectorStore = require('../../src/services/vectorStore/InMemoryVectorStore');

describe('InMemoryVectorStore', () => {
  let vectorStore;

  beforeEach(() => {
    vectorStore = new InMemoryVectorStore();
  });

  describe('upsertDocument', () => {
    test('should add a new document', async () => {
      const chunks = [{
        chunkIndex: 0,
        text: 'Test document',
        embedding: [0.1, 0.2, 0.3]
      }];

      await vectorStore.upsertDocument('doc1', { source: 'test' }, chunks);
      
      const retrieved = await vectorStore.getDocument('doc1');
      expect(retrieved).toBeDefined();
      expect(retrieved.documentId).toBe('doc1');
    });

    test('should update existing document', async () => {
      const chunks1 = [{
        chunkIndex: 0,
        text: 'Original content',
        embedding: [0.1, 0.2, 0.3]
      }];

      const chunks2 = [{
        chunkIndex: 0,
        text: 'Updated content',
        embedding: [0.4, 0.5, 0.6]
      }];

      await vectorStore.upsertDocument('doc1', { source: 'test' }, chunks1);
      await vectorStore.upsertDocument('doc1', { source: 'test-updated' }, chunks2);
      
      const retrieved = await vectorStore.getDocument('doc1');
      expect(retrieved.source).toBe('test-updated');
    });
  });

  describe('searchSimilar', () => {
    beforeEach(async () => {
      // Add test documents
      await vectorStore.upsertDocument('doc1', { category: 'animals' }, [{
        chunkIndex: 0,
        text: 'Document about cats',
        embedding: [1, 0, 0]
      }]);

      await vectorStore.upsertDocument('doc2', { category: 'animals' }, [{
        chunkIndex: 0,
        text: 'Document about felines',
        embedding: [0.9, 0.1, 0]
      }]);

      await vectorStore.upsertDocument('doc3', { category: 'vehicles' }, [{
        chunkIndex: 0,
        text: 'Document about cars',
        embedding: [0, 1, 0]
      }]);
    });

    test('should return most similar documents', async () => {
      const queryVector = [0.95, 0.05, 0];
      const results = await vectorStore.searchSimilar(queryVector, { topK: 2 });

      expect(results).toHaveLength(2);
      expect(results[0].metadata.documentId).toBe('doc1'); // Most similar
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    test('should filter by metadata', async () => {
      const queryVector = [0.95, 0.05, 0];
      const results = await vectorStore.searchSimilar(queryVector, {
        topK: 5,
        filters: { category: 'vehicles' }
      });

      expect(results).toHaveLength(1);
      expect(results[0].metadata.documentId).toBe('doc3');
    });

    test('should return empty array when no documents match', async () => {
      const queryVector = [0, 0, 1];
      const results = await vectorStore.searchSimilar(queryVector, {
        topK: 5,
        filters: { category: 'nonexistent' }
      });

      expect(results).toHaveLength(0);
    });
  });

  describe('deleteDocument', () => {
    test('should delete a document', async () => {
      const chunks = [{
        chunkIndex: 0,
        text: 'Test document',
        embedding: [0.1, 0.2, 0.3]
      }];

      await vectorStore.upsertDocument('doc1', { source: 'test' }, chunks);
      await vectorStore.deleteDocument('doc1');
      
      const retrieved = await vectorStore.getDocument('doc1');
      expect(retrieved).toBeNull();
    });

    test('should return false when deleting nonexistent document', async () => {
      const result = await vectorStore.deleteDocument('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('listDocuments', () => {
    beforeEach(async () => {
      await vectorStore.upsertDocument('doc1', { category: 'A' }, [{
        chunkIndex: 0,
        text: 'Document 1',
        embedding: [1, 0, 0]
      }]);

      await vectorStore.upsertDocument('doc2', { category: 'B' }, [{
        chunkIndex: 0,
        text: 'Document 2',
        embedding: [0, 1, 0]
      }]);
    });

    test('should list all documents', async () => {
      const docs = await vectorStore.listDocuments();
      expect(docs).toHaveLength(2);
    });

    test('should filter documents by metadata', async () => {
      const docs = await vectorStore.listDocuments({ category: 'A' });
      expect(docs).toHaveLength(1);
      expect(docs[0].documentId).toBe('doc1');
    });

    test('should paginate results', async () => {
      const docs = await vectorStore.listDocuments({}, 1, 0);
      expect(docs).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    test('should return correct stats', async () => {
      await vectorStore.upsertDocument('doc1', {}, [{
        chunkIndex: 0,
        text: 'Document 1',
        embedding: [1, 0, 0]
      }]);

      await vectorStore.upsertDocument('doc2', {}, [{
        chunkIndex: 0,
        text: 'Document 2',
        embedding: [0, 1, 0]
      }]);

      const stats = await vectorStore.getStats();
      expect(stats.documentCount).toBe(2);
      expect(stats.vectorDimension).toBe(3);
    });
  });

  describe('healthCheck', () => {
    test('should return healthy status', async () => {
      const health = await vectorStore.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.type).toBe('memory');
    });
  });
});
