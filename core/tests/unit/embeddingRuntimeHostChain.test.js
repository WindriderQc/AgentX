'use strict';

jest.mock('../../src/services/embeddingHostChain', () => ({
    embeddingHostCandidates: jest.fn(() => ['http://primary:11434', 'http://backup:11434', 'http://cpu:11435']),
    isEmbedHostLive: jest.fn(async () => true),
    isModelMissingResponse: result => result.status === 404
}));

const { wrap } = require('../../src/services/embeddingRuntimeHostChain');
const { embeddingHostCandidates, isEmbedHostLive } = require('../../src/services/embeddingHostChain');
const request = { mode: 'embed', model: 'embedding-model', input: ['alpha', 'beta'], truncate: false };
const deps = { getTargetForModel: jest.fn(() => 'http://excluded:11434'), resolveHostKey: url => url };
const ok = { ok: true, status: 200, body: { embeddings: [[1], [2]] } };
const refusal = () => Object.assign(new Error('Host busy'), { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' });
let original;

beforeEach(() => {
    original = process.env.AGENTX_EMBEDDING_HOST_CHAIN;
    process.env.AGENTX_EMBEDDING_HOST_CHAIN = '["primary","backup","cpu"]';
    jest.clearAllMocks();
    embeddingHostCandidates.mockImplementation(() => ['http://primary:11434', 'http://backup:11434', 'http://cpu:11435']);
    isEmbedHostLive.mockImplementation(async () => true);
});
afterEach(() => {
    if (original === undefined) delete process.env.AGENTX_EMBEDDING_HOST_CHAIN;
    else process.env.AGENTX_EMBEDDING_HOST_CHAIN = original;
});

test('native batches retain input and options on the configured first host', async () => {
    const execute = jest.fn(async () => ok);
    const options = { consumerContract: 'native-client' };
    expect(await wrap(execute, deps)(request, options)).toBe(ok);
    expect(execute).toHaveBeenCalledWith(request, { ...options, hostUrl: 'http://primary:11434' });
    expect(execute).toHaveBeenCalledTimes(1);
});

test('attested admission refusals reach backup and CPU in order', async () => {
    const execute = jest.fn().mockRejectedValueOnce(refusal()).mockRejectedValueOnce(refusal()).mockResolvedValue(ok);
    expect(await wrap(execute, deps)(request)).toBe(ok);
    expect(execute.mock.calls.map(([, options]) => options.hostUrl))
        .toEqual(['http://primary:11434', 'http://backup:11434', 'http://cpu:11435']);
    expect(execute.mock.calls[2][1].degraded).toEqual({
        degraded: true, fallbackFrom: { model: request.model, host: 'http://primary:11434' },
        fallbackTo: { model: request.model, host: 'http://cpu:11435' }, reason: 'RUNTIME_INFERENCE_ADMISSION_DENIED'
    });
});

test('a terminal model-missing reply continues with the same batch', async () => {
    const execute = jest.fn().mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValue(ok);
    expect(await wrap(execute, deps)(request)).toBe(ok);
    expect(execute.mock.calls[1][0]).toBe(request);
    expect(execute.mock.calls[1][1].degraded.reason).toBe('embedding_model_missing');
});

test('unreachable hosts are skipped before any execution', async () => {
    isEmbedHostLive.mockResolvedValueOnce(false);
    const execute = jest.fn(async () => ok);
    expect(await wrap(execute, deps)(request)).toBe(ok);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1].hostUrl).toBe('http://backup:11434');
});

test.each(['INFERENCE_TIMEOUT', 'RUNTIME_INFERENCE_COMPLETION_FAILED', 'INFERENCE_UPSTREAM_UNAVAILABLE', 'INFERENCE_CONTEXT_POLICY_UNAVAILABLE'])(
    '%s never launches a replacement', async code => {
        const error = Object.assign(new Error('Uncertain or invalid execution'), { code });
        const execute = jest.fn().mockRejectedValue(error);
        await expect(wrap(execute, deps)(request)).rejects.toBe(error);
        expect(execute).toHaveBeenCalledTimes(1);
    }
);

test('an exhausted chain retains its final native refusal', async () => {
    const error = refusal();
    const execute = jest.fn().mockRejectedValue(error);
    await expect(wrap(execute, deps)(request)).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(3);
});

test('an entirely unreachable chain refuses without launching a model', async () => {
    isEmbedHostLive.mockResolvedValue(false);
    const execute = jest.fn();
    await expect(wrap(execute, deps)(request)).rejects.toMatchObject({ code: 'EMBEDDING_HOST_CHAIN_EXHAUSTED', statusCode: 503 });
    expect(execute).not.toHaveBeenCalled();
});

test('an exclusive embedding request retains its native owner', async () => {
    const execute = jest.fn(async () => ok);
    const exclusive = { ...request, exclusiveHost: true };
    expect(await wrap(execute, deps)(exclusive)).toBe(ok);
    expect(execute).toHaveBeenCalledWith(exclusive, {});
    expect(embeddingHostCandidates).not.toHaveBeenCalled();
});

test('invalid configured placement fails before probing or executing', async () => {
    embeddingHostCandidates.mockImplementation(() => { throw Error('Invalid chain'); });
    const execute = jest.fn();
    await expect(wrap(execute, deps)(request)).rejects.toThrow('Invalid chain');
    expect(isEmbedHostLive).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
});

test.each([{ hostUrl: 'http://explicit:11434' }, { benchmarkClaims: [] }, { codingCapacity: {} }])(
    'explicit native ownership is preserved: %j', async options => {
        const execute = jest.fn(async () => ok);
        expect(await wrap(execute, deps)(request, options)).toBe(ok);
        expect(execute).toHaveBeenCalledWith(request, options);
        expect(embeddingHostCandidates).not.toHaveBeenCalled();
    }
);

test.each([undefined, '', '  '])('unset/blank placement retains the original native path', async setting => {
    if (setting === undefined) delete process.env.AGENTX_EMBEDDING_HOST_CHAIN;
    else process.env.AGENTX_EMBEDDING_HOST_CHAIN = setting;
    const execute = jest.fn(async () => ok);
    expect(await wrap(execute, deps)(request)).toBe(ok);
    expect(execute).toHaveBeenCalledWith(request, {});
    expect(embeddingHostCandidates).not.toHaveBeenCalled();
});

test('conversation calls are unaffected', async () => {
    const execute = jest.fn(async () => ok);
    const chat = { mode: 'chat', model: 'conversation-model' };
    expect(await wrap(execute, deps)(chat)).toBe(ok);
    expect(execute).toHaveBeenCalledWith(chat, {});
    expect(embeddingHostCandidates).not.toHaveBeenCalled();
});

test('caller cancellation prevents subsequent execution', async () => {
    const controller = new AbortController();
    const execute = jest.fn(async () => { controller.abort(); throw refusal(); });
    await expect(wrap(execute, deps)(request, { signal: controller.signal })).rejects.toThrow('Host busy');
    expect(execute).toHaveBeenCalledTimes(1);
});
