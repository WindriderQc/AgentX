const { warmupModel } = require('../../../src/services/benchmark/modelWarmup');

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function okJson(data) {
    return {
        ok: true,
        status: 200,
        json: async () => data
    };
}

describe('modelWarmup', () => {
    it('maps AbortError to timeout message instead of user-aborted wording', async () => {
        const abortErr = new Error('The user aborted a request.');
        abortErr.name = 'AbortError';

        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'qwen2.5:14b-instruct-q5_K_M' }] }))
            .mockRejectedValueOnce(abortErr);

        const result = await warmupModel('http://localhost:11434', 'qwen2.5:14b-instruct-q5_K_M', { _fetch });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Warmup timed out after 30s');
        expect(result.error).not.toContain('user aborted');
    });

    it('throws normalized timeout message in strict mode', async () => {
        const abortErr = new Error('The user aborted a request.');
        abortErr.name = 'AbortError';

        const _fetch = jest.fn()
            .mockResolvedValueOnce(okJson({ models: [{ name: 'qwen2.5:14b-instruct-q5_K_M' }] }))
            .mockRejectedValueOnce(abortErr);

        await expect(
            warmupModel('http://localhost:11434', 'qwen2.5:14b-instruct-q5_K_M', { _fetch, strict: true })
        ).rejects.toThrow('Warmup timed out after 30s');
    });
});
