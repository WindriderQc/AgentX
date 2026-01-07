// embeddings.test.js

// Mock logger first
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
}));

// Mock node-fetch module BEFORE require
jest.mock('node-fetch', () => ({
    __esModule: true,
    default: jest.fn()
}));

// Mock embeddingCache helper
jest.mock('../../src/services/embeddingCache', () => ({
    getCache: jest.fn(() => ({
        getOrCompute: jest.fn((key, fn) => fn(key))
    }))
}));

const { EmbeddingsService, getEmbeddingsService } = require('../../src/services/embeddings');

describe('EmbeddingsService', () => {
    let service;
    const OLLAMA_HOST = 'http://localhost:11434';

    beforeEach(() => {
        process.env.OLLAMA_HOST = OLLAMA_HOST;
        service = new EmbeddingsService();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Instantiation', () => {
        it('should create instance with default config', () => {
            expect(service).toBeDefined();
            expect(service.ollamaHost).toBe(OLLAMA_HOST);
        });
    });

    describe('embedTextBatch', () => {
        it('should process batch calls', async () => {
            // Spy on the private method _embedSingle to avoid any fetch logic/mocking issues
            // This tests the batching logic and service structure
            const spy = jest.spyOn(service, '_embedSingle').mockResolvedValue([0.1, 0.2]);
            
            const texts = ['a', 'b'];
            const results = await service.embedTextBatch(texts);
            
            expect(results).toHaveLength(2);
            expect(spy).toHaveBeenCalledTimes(2);
        });
    });
});
