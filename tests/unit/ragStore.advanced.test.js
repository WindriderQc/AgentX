// ragStore.advanced.test.js

const source = require('../../src/services/ragStore');
const RagStore = source.RagStore || source;

const { getEmbeddingsService } = require('../../src/services/embeddings');
const { createVectorStore } = require('../../src/services/vectorStore/factory');
const logger = require('../../config/logger');
const fetch = require('node-fetch');

// Mock dependencies
jest.mock('../../src/services/embeddings', () => ({
    getEmbeddingsService: jest.fn()
}));
jest.mock('../../src/services/vectorStore/factory');
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('node-fetch');

describe('RagStore Advanced Features', () => {
    let mockEmbeddingsService;
    let mockVectorStore;
    let ragStore;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup EmbeddingsService mock
        mockEmbeddingsService = {
            embedTextBatch: jest.fn().mockResolvedValue([[0.1, 0.2]])
        };
        getEmbeddingsService.mockReturnValue(mockEmbeddingsService);

        // Setup VectorStore mock
        mockVectorStore = {
            searchSimilar: jest.fn().mockResolvedValue([]),
            listDocuments: jest.fn().mockResolvedValue([]),
            getDocumentChunks: jest.fn().mockResolvedValue([])
        };
        createVectorStore.mockReturnValue(mockVectorStore);

        // Default mock fetch response (ok: true)
        fetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ response: '' })
        });

        ragStore = new RagStore({
            vectorStoreType: 'memory'
        });
    });

    // 1. Query Expansion
    describe('expandQuery', () => {
        it('should generate related queries from LLM response', async () => {
             fetch.mockResolvedValue({
                 ok: true,
                 json: () => Promise.resolve({
                     response: 'python list comprehension\npython loops\n'
                 })
             });

             const queries = await ragStore.expandQuery('python iteration');
             expect(queries).toEqual(['python list comprehension', 'python loops']);
             expect(fetch).toHaveBeenCalledWith(
                 expect.stringContaining('/api/generate'),
                 expect.any(Object)
             );
        });

        it('should handle API failure gracefully', async () => {
            fetch.mockResolvedValue({ ok: false });
            const queries = await ragStore.expandQuery('fail');
            expect(queries).toEqual([]);
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('expansion failed'));
        });

        it('should fallback on fetch exception', async () => {
             fetch.mockRejectedValue(new Error('Net error'));
             const queries = await ragStore.expandQuery('error');
             expect(queries).toEqual([]);
        });
    });

    // 2. Result Re-Ranking
    describe('rerankResults', () => {
        const mockResults = [
            { text: 'irrelevant text here', score: 0.9 }, // High vector score, low relevance
            { text: 'highly relevant text', score: 0.5 }  // Low vector score, high relevance
        ];

        it('should reorder results based on LLM judge score', async () => {
            // Mock fetch to return scores based on prompt content
            fetch.mockImplementation(async (url, options) => {
                const body = JSON.parse(options.body);
                const prompt = body.prompt || '';
                if (prompt.includes('highly relevant')) {
                    return { ok: true, json: () => Promise.resolve({ response: '10' }) };
                }
                return { ok: true, json: () => Promise.resolve({ response: '0' }) };
            });

            const reranked = await ragStore.rerankResults('query', mockResults, null, 2);

            expect(reranked[0].text).toBe('highly relevant text');
            expect(reranked[0].llmScore).toBe(1.0); // 10/10
            
            expect(reranked[1].text).toBe('irrelevant text here');
            expect(reranked[1].llmScore).toBe(0.0);
        });

        it('should fallback to vector score on error', async () => {
            fetch.mockRejectedValue(new Error('Judge down'));
            const results = await ragStore.rerankResults('query', mockResults);
            
            expect(results).toHaveLength(2);
            expect(results[0].text).toBe('irrelevant text here');
        });
    });

    // 3. Keyword Search
    describe('keywordSearch', () => {
        it('should find documents containing query terms', async () => {
            mockVectorStore.listDocuments.mockResolvedValue([
                { id: 'doc1', title: 'Doc 1' },
                { id: 'doc2', title: 'Doc 2' }
            ]);

            mockVectorStore.getDocumentChunks.mockImplementation(async (id) => {
                if (id === 'doc1') return [{ text: 'apple banana', chunkIndex: 0 }];
                if (id === 'doc2') return [{ text: 'cherry date', chunkIndex: 0 }];
                return [];
            });

            const results = await ragStore.keywordSearch('banana');
            
            expect(results).toHaveLength(1);
            expect(results[0].text).toBe('apple banana');
            expect(results[0].score).toBeGreaterThan(0);
        });

        it('should calculate scores based on frequency and position', async () => {
             // Term at start > Term at end
             const docs = [
                 { id: 'start', title: 'Start' },
                 { id: 'end', title: 'End' }
             ];
             mockVectorStore.listDocuments.mockResolvedValue(docs);
             mockVectorStore.getDocumentChunks.mockImplementation(async (id) => {
                 if (id === 'start') return [{ text: 'banana at start', chunkIndex: 0 }];
                 if (id === 'end') return [{ text: 'at end banana', chunkIndex: 0 }];
                 return [];
             });

             const results = await ragStore.keywordSearch('banana');
             expect(results).toHaveLength(2);
             // First result should be 'start' because position bonus
             expect(results[0].metadata.documentId).toBe('start');
        });

        it('should handle empty store gracefully', async () => {
             mockVectorStore.listDocuments.mockResolvedValue([]);
             const results = await ragStore.keywordSearch('test');
             expect(results).toEqual([]);
        });
    });

    // 4. Reciprocal Rank Fusion
    describe('_reciprocalRankFusion', () => {
        it('should merge two lists and boost items appearing in both', () => {
            // Mock items with metadata
            const itemA = { metadata: { documentId: '1', chunkIndex: 0 }, text: 'A' };
            const itemB = { metadata: { documentId: '2', chunkIndex: 0 }, text: 'B' }; // Only in List 1
            const itemC = { metadata: { documentId: '3', chunkIndex: 0 }, text: 'C' }; // Only in List 2

            const list1 = [itemA, itemB];
            const list2 = [itemA, itemC]; 

            const fused = ragStore._reciprocalRankFusion(list1, list2);
            
            expect(fused[0].metadata.documentId).toBe('1');
            expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore);
            expect(fused).toHaveLength(3);
        });
    });

    // 5. Hybrid Search Integration
    describe('searchSimilarChunks (Hybrid)', () => {
        it('should execute both searches and fuse results', async () => {
            // Spy on the public keywordSearch method
            jest.spyOn(ragStore, 'keywordSearch').mockResolvedValue([
                { text: 'keyword match', score: 0.8, metadata: { documentId: 'k1', chunkIndex: 0 } }
            ]);
            
            mockVectorStore.searchSimilar.mockResolvedValue([
                { text: 'vector match', score: 0.8, metadata: { documentId: 'v1', chunkIndex: 0 } }
            ]);
            
            const fusionSpy = jest.spyOn(ragStore, '_reciprocalRankFusion');

            const results = await ragStore.searchSimilarChunks('test query', { 
                hybridSearch: true,
                topK: 5
            });

            expect(mockVectorStore.searchSimilar).toHaveBeenCalled();
            expect(ragStore.keywordSearch).toHaveBeenCalled();
            expect(fusionSpy).toHaveBeenCalled();
            expect(results).toHaveLength(2); 
        });

        it('should skip expansion/reranking when hybrid is used', async () => {
             // Mock hybrid returning results
             jest.spyOn(ragStore, 'keywordSearch').mockResolvedValue([{ text: 'A', metadata: {documentId:'1', chunkIndex:0} }]);
             mockVectorStore.searchSimilar.mockResolvedValue([]);
             
             const expandSpy = jest.spyOn(ragStore, 'expandQuery');
             const rerankSpy = jest.spyOn(ragStore, 'rerankResults');

             await ragStore.searchSimilarChunks('q', {
                 hybridSearch: true,
                 expandQuery: true, // Should be ignored
                 rerankResults: true // Should be ignored
             });

             expect(expandSpy).not.toHaveBeenCalled();
             expect(rerankSpy).not.toHaveBeenCalled();
        });
    });
});
