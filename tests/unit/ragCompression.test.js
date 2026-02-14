const { getCompressionService } = require('../../src/services/ragCompression');
const logger = require('../../config/logger');
const fetch = require('node-fetch');

jest.mock('../../config/logger');
jest.mock('node-fetch');

describe('RAGCompressionService', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = getCompressionService();
        service.clearCache();
    });

    test('should compress chunks successfully', async () => {
        const mockResponse = {
            response: "This is a relevant sentence."
        };
        fetch.mockResolvedValue({
            ok: true,
            json: async () => mockResponse
        });

        const chunks = [{ _id: '1', text: 'This is a relevant sentence. This is noise.' }];
        const result = await service.compressChunks('test query', chunks);

        expect(result).toHaveLength(1);
        expect(result[0].compressedText).toBe("This is a relevant sentence.");
        expect(result[0].wasCompressed).toBe(true);
        // Expect string containing /api/generate
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/generate'), expect.any(Object));
        
        // Verify payload format
        const callArgs = fetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body).toHaveProperty('model');
        expect(body).toHaveProperty('prompt');
        expect(body).toHaveProperty('system');
    });

    test('should handle no relevant content', async () => {
        const mockResponse = {
            response: "NO_RELEVANT_CONTENT" 
        };
        fetch.mockResolvedValue({
            ok: true,
            json: async () => mockResponse
        });

        const chunks = [{ _id: '1', text: 'Just noise.' }];
        const result = await service.compressChunks('test query', chunks);

        // Should return empty array as filtered
        expect(result).toHaveLength(0);
    });

    test('should use cache for repeated queries', async () => {
        const mockResponse = {
            response: "Compressed."
        };
        fetch.mockResolvedValue({
            ok: true,
            json: async () => mockResponse
        });

        const chunks = [{ _id: '1', text: 'Original text.' }];
        
        // First call
        await service.compressChunks('query', chunks);
        expect(fetch).toHaveBeenCalledTimes(1);

        // Second call
        await service.compressChunks('query', chunks);
        expect(fetch).toHaveBeenCalledTimes(1); // Should not call fetch again
    });

    test('should not collide cache entries for different chunks without _id/id', async () => {
        fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ response: 'Compressed output' })
        });

        const chunks = [
            { text: 'Chunk A text', metadata: { documentId: 'doc-1', chunkIndex: 0 } },
            { text: 'Chunk B text', metadata: { documentId: 'doc-1', chunkIndex: 1 } }
        ];

        await service.compressChunks('same-query', chunks);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('should handle API errors gracefully (fallback)', async () => {
        fetch.mockResolvedValue({
            ok: false,
            statusText: 'Internal Server Error'
        });

        const chunks = [{ _id: '1', text: 'Original text.' }];
        const result = await service.compressChunks('query', chunks);

        expect(result).toHaveLength(1);
        expect(result[0].compressedText).toBe('Original text.');
        expect(result[0].wasCompressed).toBe(false);
    });
});
