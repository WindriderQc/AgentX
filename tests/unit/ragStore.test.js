// ragStore.test.js

const source = require('../../src/services/ragStore');
const RagStore = source.RagStore || source;

const { getEmbeddingsService } = require('../../src/services/embeddings');
const { createVectorStore } = require('../../src/services/vectorStore/factory');
const logger = require('../../config/logger');

// Mock dependencies
jest.mock('../../src/services/embeddings', () => ({
    getEmbeddingsService: jest.fn()
}));
jest.mock('../../src/services/vectorStore/factory');
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

describe('RagStore', () => {
    let mockEmbeddingsService;
    let mockVectorStore;
    let ragStore;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup EmbeddingsService mock
        mockEmbeddingsService = {
            embedTextBatch: jest.fn().mockResolvedValue([])
        };
        getEmbeddingsService.mockReturnValue(mockEmbeddingsService);

        // Setup VectorStore mock
        mockVectorStore = {
            getDocument: jest.fn().mockResolvedValue(null),
            upsertDocument: jest.fn().mockResolvedValue({ chunkCount: 1, status: 'created' }),
            searchSimilar: jest.fn().mockResolvedValue([]),
            listDocuments: jest.fn().mockResolvedValue([]),
            deleteDocument: jest.fn().mockResolvedValue(true),
            healthCheck: jest.fn().mockResolvedValue(true),
            getStats: jest.fn().mockResolvedValue({ documentCount: 5, chunkCount: 50 })
        };
        createVectorStore.mockReturnValue(mockVectorStore);

        ragStore = new RagStore({
            vectorStoreType: 'memory'
        });
    });

    describe('Factory & Initialization', () => {
        it('should initialize with correct configuration', () => {
            expect(createVectorStore).toHaveBeenCalledWith('memory', expect.anything());
            expect(ragStore.chunkSize).toBe(800);
        });

        it('should use default chunk size if not provided', () => {
             const customStore = new RagStore({});
             expect(customStore.chunkSize).toBe(800);
        });
    });

    describe('upsertDocumentWithChunks', () => {
        const metadata = {
            source: 'test-source',
            path: 'test/doc.txt',
            title: 'Test Document'
        };
        const text = 'This is a test document text that is long enough to be chunked.';

        it('should chunk text and upsert to vector store', async () => {
            mockEmbeddingsService.embedTextBatch.mockResolvedValue([
                [0.1, 0.2, 0.3] // Embedding for one chunk
            ]);

            const result = await ragStore.upsertDocumentWithChunks(metadata, text);

            expect(result).toEqual(expect.objectContaining({
                documentId: expect.any(String),
                status: expect.stringMatching(/upserted|created/)
            }));

            // Verify interactions
            expect(mockEmbeddingsService.embedTextBatch).toHaveBeenCalledTimes(1);
            expect(mockVectorStore.upsertDocument).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ title: 'Test Document' }),
                expect.arrayContaining([
                    expect.objectContaining({
                        text: expect.any(String),
                        embedding: expect.any(Array)
                    })
                ])
            );
        });

        it('should skip upsert if document is unchanged (hash match)', async () => {
             const crypto = require('crypto');
             // Implementation uses MD5 for hashing
             const hash = crypto.createHash('md5').update(text).digest('hex');

             mockVectorStore.getDocument.mockResolvedValue({
                 documentId: 'some-id',
                 hash: hash,
                 chunkCount: 1
             });
             
             const result = await ragStore.upsertDocumentWithChunks(metadata, text);
             expect(result.status).toBe('unchanged');
             expect(mockVectorStore.upsertDocument).not.toHaveBeenCalled();
        });

        it('should handle argument swapping (text, metadata)', async () => {
             mockEmbeddingsService.embedTextBatch.mockResolvedValue([[0.1]]);
             
             // Call with swapped args
             const result = await ragStore.upsertDocumentWithChunks(text, metadata);
             
             expect(result.status).not.toBe('error');
             expect(mockVectorStore.upsertDocument).toHaveBeenCalled();
        });
    });

    describe('searchSimilarChunks', () => {
        it('should search using embeddings', async () => {
            const query = "find me something";
            mockEmbeddingsService.embedTextBatch.mockResolvedValue([[0.1, 0.2]]);
            mockVectorStore.searchSimilar.mockResolvedValue([
                { text: 'result', score: 0.9 }
            ]);

            const results = await ragStore.searchSimilarChunks(query);
            
            expect(mockEmbeddingsService.embedTextBatch).toHaveBeenCalledWith([query], null);
            expect(mockVectorStore.searchSimilar).toHaveBeenCalledWith(
                [0.1, 0.2], 
                expect.objectContaining({ topK: 5 })
            );
            expect(results).toHaveLength(1);
        });

        it('should validate query input', async () => {
            await expect(ragStore.searchSimilarChunks('')).rejects.toThrow();
            await expect(ragStore.searchSimilarChunks(null)).rejects.toThrow();
        });
    });

    describe('Document Management', () => {
        it('should list documents', async () => {
            const docs = [{ id: '1', title: 'Doc 1' }];
            mockVectorStore.listDocuments.mockResolvedValue(docs);
            
            const result = await ragStore.listDocuments();
            expect(result).toBe(docs);
            expect(mockVectorStore.listDocuments).toHaveBeenCalled();
        });

        it('should delete a document', async () => {
            await ragStore.deleteDocument('doc-1');
            expect(mockVectorStore.deleteDocument).toHaveBeenCalledWith('doc-1');
        });

        it('should return stats', async () => {
            const stats = await ragStore.getStats();
            expect(stats.chunkCount).toBe(50);
            expect(stats.avgChunksPerDoc).toBe("10.00"); // 50 / 5
        });
        
        it('should check health', async () => {
            const healthy = await ragStore.healthCheck();
            expect(healthy).toBe(true);
            expect(mockVectorStore.healthCheck).toHaveBeenCalled();
        });
    });

    describe('_generateDocumentId', () => {
        it('should generate consistent IDs', async () => {
            const meta = { source: 's1', path: 'p1', title: 't1' };
            await ragStore.upsertDocumentWithChunks(meta, 'text');
            const id1 = mockVectorStore.upsertDocument.mock.calls[0][0];

            await ragStore.upsertDocumentWithChunks(meta, 'text');
            const id2 = mockVectorStore.upsertDocument.mock.calls[1][0];
            
            expect(id1).toBe(id2);
        });
    });
});
