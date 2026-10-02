/**
 * Bare embedding-model names route to the configured embedding host, using the
 * shared embedding predicate (org-prefixed bge tags included).
 */

process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';
process.env.AGENTX_EMBEDDING_HOST = 'tertiary';
delete process.env.AGENTX_ROUTER_EMBEDDING_HOST;

jest.mock('../../src/helpers/schedulerClient', () => ({
    resolveAdvisoryHost: jest.fn(async ({ fallbackHostUrl }) => ({
        source: 'fallback',
        hostId: null,
        hostUrl: fallbackHostUrl,
        reason: 'test fallback'
    }))
}));

const { getTargetForModel } = require('../../src/services/modelRouter');

afterAll(() => {
    delete process.env.AGENTX_EMBEDDING_HOST;
});

describe('getTargetForModel embedding host selection', () => {
    it.each([
        'qllama/bge-m3:f16',
        'bge-m3:f16',
        'nomic-embed-text:v1.5',
        'qwen3-embedding:0.6b',
        'all-minilm:l6-v2'
    ])('routes %s to the embedding host', (model) => {
        expect(getTargetForModel(model)).toBe('http://tertiary:11434');
    });

    it.each([
        'qwen3.5:9b',
        'gemma4:12b',
        'unknown-model:70b'
    ])('keeps generative model %s on the interactive host', (model) => {
        expect(getTargetForModel(model)).toBe('http://secondary:11434');
    });
});
