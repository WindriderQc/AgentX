/**
 * Tests for Model Sync Orchestrator
 */

// Mock logger
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock ModelRegistry
const mockModelRegistry = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn()
};
jest.mock('../../models/ModelRegistry', () => mockModelRegistry);

// Mock ollamaVramService
jest.mock('../../src/services/ollamaVramService', () => ({
    getHostVram: jest.fn().mockResolvedValue({ ok: true, memoryTotalMiBTotal: 24576 })
}));

// Mock httpAgent
jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: jest.fn(() => ({}))
}));

// We'll test syncModel and detection logic, but not fetchHostModels (requires network)
const { syncModel } = require('../../src/services/modelSync/syncOrchestrator');
const { getHostUrls } = require('../../src/helpers/ollamaHostConfig');

describe('syncModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    const sampleOllamaModel = {
        name: 'qwen2.5:7b-instruct-q4_K_M',
        size: 4_700_000_000,
        digest: 'abc123',
        details: {
            parameter_size: '7B',
            quantization_level: 'Q4_K_M',
            family: 'qwen2'
        }
    };

    it('should create a new registry entry for unknown model', async () => {
        mockModelRegistry.findOne.mockResolvedValue(null);
        mockModelRegistry.create.mockResolvedValue({});

        const result = await syncModel(sampleOllamaModel, 'http://192.168.2.99:11434', 24576);

        expect(result).toBe('created');
        expect(mockModelRegistry.create).toHaveBeenCalledTimes(1);

        const createArg = mockModelRegistry.create.mock.calls[0][0];
        expect(createArg.modelName).toBe('qwen2.5:7b-instruct-q4_K_M');
        expect(createArg.sourceType).toBe('ollama');
        expect(createArg.sourceHost).toBe('http://192.168.2.99:11434');
        expect(createArg.vendor).toBe('alibaba');
        expect(createArg.executionDefaults.num_ctx).toBeGreaterThan(0);
        expect(createArg.executionDefaults._source).toBe('auto');
    });

    it('should update existing model metadata', async () => {
        mockModelRegistry.findOne.mockResolvedValue({
            modelName: 'qwen2.5:7b-instruct-q4_K_M',
            sourceType: 'ollama',
            sourceHost: 'http://192.168.2.99:11434',
            ollamaDigest: 'old_digest',
            modelSizeBytes: 4_700_000_000,
            parameterSize: '7B',
            quantization: 'Q4_K_M',
            family: 'qwen2',
            status: 'active',
            executionDefaults: { num_ctx: 16384, _source: 'auto' },
            executionOverrides: {}
        });
        mockModelRegistry.updateOne.mockResolvedValue({});

        const result = await syncModel(sampleOllamaModel, 'http://192.168.2.99:11434', 24576);

        expect(result).toBe('updated');
        expect(mockModelRegistry.updateOne).toHaveBeenCalled();
        const updateSet = mockModelRegistry.updateOne.mock.calls[0][1].$set;
        expect(updateSet.ollamaDigest).toBe('abc123');
    });

    it('should not overwrite user execution overrides', async () => {
        mockModelRegistry.findOne.mockResolvedValue({
            modelName: 'qwen2.5:7b-instruct-q4_K_M',
            sourceType: 'ollama',
            sourceHost: 'http://192.168.2.99:11434',
            ollamaDigest: 'abc123',
            modelSizeBytes: 4_700_000_000,
            parameterSize: '7B',
            quantization: 'Q4_K_M',
            family: 'qwen2',
            status: 'active',
            executionDefaults: { num_ctx: 16384, _source: 'auto' },
            executionOverrides: { num_ctx: 4096 }
        });
        mockModelRegistry.updateOne.mockResolvedValue({});

        await syncModel(sampleOllamaModel, 'http://192.168.2.99:11434', 24576);

        // Should still update, but should NOT touch executionDefaults since user has override
        const calls = mockModelRegistry.updateOne.mock.calls;
        if (calls.length > 0) {
            const updateSet = calls[0][1].$set;
            expect(updateSet['executionDefaults.num_ctx']).toBeUndefined();
        }
    });

    it('should re-activate retired models when rediscovered', async () => {
        mockModelRegistry.findOne.mockResolvedValue({
            modelName: 'qwen2.5:7b-instruct-q4_K_M',
            sourceType: 'ollama',
            sourceHost: 'http://192.168.2.99:11434',
            ollamaDigest: 'abc123',
            modelSizeBytes: 4_700_000_000,
            parameterSize: '7B',
            quantization: 'Q4_K_M',
            family: 'qwen2',
            status: 'retired',
            executionDefaults: { num_ctx: 16384, _source: 'auto' },
            executionOverrides: {}
        });
        mockModelRegistry.updateOne.mockResolvedValue({});

        const result = await syncModel(sampleOllamaModel, 'http://192.168.2.99:11434', 24576);

        expect(result).toBe('updated');
        const updateSet = mockModelRegistry.updateOne.mock.calls[0][1].$set;
        expect(updateSet.status).toBe('active');
        expect(updateSet.isActive).toBe(true);
    });
});

describe('getHostUrls (via ollamaHostConfig)', () => {
    const origEnv = process.env;

    beforeEach(() => {
        process.env = { ...origEnv };
    });

    afterAll(() => {
        process.env = origEnv;
    });

    it('should return all configured hosts', () => {
        process.env.OLLAMA_HOST = 'http://host1:11434';
        process.env.OLLAMA_HOST_2 = 'http://host2:11434';
        process.env.OLLAMA_HOST_3 = 'http://host3:11434';

        const hosts = getHostUrls();
        expect(hosts).toHaveLength(3);
    });

    it('should filter out undefined hosts', () => {
        process.env.OLLAMA_HOST = 'http://host1:11434';
        delete process.env.OLLAMA_HOST_2;
        delete process.env.OLLAMA_HOST_SECONDARY;
        delete process.env.OLLAMA_HOST_3;
        delete process.env.OLLAMA_HOST_TERTIARY;

        const hosts = getHostUrls();
        expect(hosts).toHaveLength(1);
    });

    it('should prefer a concrete host alias over a wildcard bind address', () => {
        process.env.OLLAMA_HOST = '0.0.0.0:11434';
        process.env.OLLAMA_HOST_PRIMARY = 'http://192.168.2.99:11434';
        delete process.env.OLLAMA_HOST_2;
        delete process.env.OLLAMA_HOST_SECONDARY;
        delete process.env.OLLAMA_HOST_3;
        delete process.env.OLLAMA_HOST_TERTIARY;

        const hosts = getHostUrls();
        expect(hosts).toEqual(['http://192.168.2.99:11434']);
    });
});
