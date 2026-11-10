'use strict';

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: jest.fn((url, options) => options)
}));

jest.mock('../../src/services/benchmark/http', () => ({
    benchmarkFetch: jest.fn()
}));

jest.mock('../../src/clients/coreApiClient', () => ({
    getBenchmarkClaimIdentity: jest.fn(() => null),
    getWorkloadAdmissionIdentity: jest.fn(() => null)
}));

const { getWorkloadAdmissionIdentity } = require('../../src/clients/coreApiClient');

const { benchmarkFetch } = require('../../src/services/benchmark/http');
const {
    BENCHMARK_BATCH_STOPPED_CODE,
    callJudge
} = require('../../src/services/scoring/judgeCall');

function abortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function rejectWhenAborted(signal) {
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}

const CONFIG = {
    host: 'http://judge.example:11434',
    model: 'judge:test',
    timeout: 30_000,
    max_retries: 2
};

beforeEach(() => {
    jest.clearAllMocks();
});
describe('judge caller cancellation', () => {
    it('carries the standalone calibration admission through to Core inference', async () => {
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'workloadId', { value: 'judge-calibration:owned' });
        const proof = { workloadAdmissionId: 'admission-owned', workloadGeneration: 'generation-owned' };
        // Read by the yield point and by the request itself.
        getWorkloadAdmissionIdentity.mockImplementation(id => (id === 'judge-calibration:owned' ? proof : null));
        benchmarkFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ response: '{"overall":8}', done_reason: 'stop' })
        });
        await expect(callJudge('evaluate this', { ...CONFIG, cancelSignal: controller.signal }))
            .resolves.toMatchObject({ success: true });
        expect(getWorkloadAdmissionIdentity).toHaveBeenCalledWith('judge-calibration:owned');
        const request = JSON.parse(benchmarkFetch.mock.calls[0][1].body);
        expect(request).toMatchObject({ ...proof, host: CONFIG.host, callerDetail: 'benchmark-judge',
            workItemId: 'benchmark-workload/judge-calibration:owned' });
        expect(request.claimGeneration).toBeUndefined();
    });

    it('refuses a verdict without its frozen runtime identity and does not retry', async () => {
        benchmarkFetch.mockResolvedValue({ ok: true, json: async () => ({ response: '{"overall":8}' }) });
        await expect(callJudge('evaluate this', { ...CONFIG,
            execution_contract: { schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 65536,
                artifact: { model: CONFIG.model, digest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64) } }
        })).rejects.toMatchObject({ code: 'JUDGE_EXECUTION_CONTRACT_MISMATCH' });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(benchmarkFetch.mock.calls[0][1].body).includeArtifactIdentity).toBe(true);
    });

    it.each([800, 16384])('does not change a frozen budget of %i after incomplete output', async numPredict => {
        const artifact = { model: CONFIG.model, host: CONFIG.host, hostId: 'judge',
            digest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64) };
        benchmarkFetch.mockResolvedValue({ ok: true, json: async () => ({
            response: '{"overall":8}', done_reason: 'length',
            agentx_contract: { artifact: { ...artifact, identityQualified: true, registryQualified: true },
                contextBudget: { windowTokens: 65536 } }
        }) });
        await expect(callJudge('evaluate this', { ...CONFIG, num_predict: numPredict, num_ctx: 65536,
            execution_contract: { schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 65536, artifact }
        })).resolves.toMatchObject({ success: false, scores: null, error: expect.stringMatching(/incomplete/) });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(benchmarkFetch.mock.calls[0][1].body).options.num_predict).toBe(numPredict);
    });

    it('aborts an active fetch with a stable code and does not retry', async () => {
        const fetchStarted = deferred();
        benchmarkFetch.mockImplementation((url, options) => {
            fetchStarted.resolve();
            return rejectWhenAborted(options.signal);
        });

        const controller = new AbortController();
        const pending = callJudge('evaluate this', {
            ...CONFIG,
            cancelSignal: controller.signal
        });

        await fetchStarted.promise;
        controller.abort(new Error('private operator reason'));

        await expect(pending).rejects.toMatchObject({
            name: 'BenchmarkBatchStoppedError',
            code: BENCHMARK_BATCH_STOPPED_CODE,
            message: 'Benchmark batch judging cancelled'
        });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps cancellation live through response-body consumption and does not retry', async () => {
        const bodyStarted = deferred();
        benchmarkFetch.mockImplementation(async (url, options) => ({
            ok: true,
            json: () => {
                bodyStarted.resolve();
                return rejectWhenAborted(options.signal);
            }
        }));

        const controller = new AbortController();
        const pending = callJudge('evaluate this', {
            ...CONFIG,
            signal: controller.signal
        });

        await bodyStarted.promise;
        controller.abort(new Error('must never escape'));

        await expect(pending).rejects.toMatchObject({
            code: BENCHMARK_BATCH_STOPPED_CODE,
            message: 'Benchmark batch judging cancelled'
        });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });
});

describe('terminal Core admission errors', () => {
    it('propagates a native quarantine instead of retrying or returning an ungraded result', async () => {
        benchmarkFetch.mockResolvedValue({ ok: false, status: 503,
            text: async () => JSON.stringify({ code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' }) });
        await expect(callJudge('evaluate this', CONFIG))
            .rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });

    it('does not wait out a quarantined reference judge host', async () => {
        const { fetchWhenJudgeHostFree } = require('../../src/services/scoring/judgeCall');
        const response = { status: 503, clone: () => ({
            status: 503, text: async () => JSON.stringify({ code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' })
        }) };
        const send = jest.fn().mockResolvedValue(response);
        await expect(fetchWhenJudgeHostFree(send, CONFIG))
            .rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' });
        expect(send).toHaveBeenCalledTimes(1);
    });
});

describe('managed judge failure without a completion receipt', () => {
    function managedConfig() {
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'workloadId', { value: 'judge-accuracy-calibration:body' });
        return { ...CONFIG, cancelSignal: controller.signal };
    }
    it.each([503, 502, 504])('stops on aborted HTTP %i body consumption', async status => {
        const config = managedConfig();
        benchmarkFetch.mockResolvedValue({ ok: false, status, text: async () => { throw abortError(); } });
        await expect(callJudge('evaluate', config))
            .rejects.toMatchObject({ code: 'JUDGE_INFERENCE_TERMINALITY_UNKNOWN' });
        expect(config.cancelSignal.aborted).toBe(false);
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });
    it.each([502, 504])('does not replay an unclassified gateway %i response', async status => {
        benchmarkFetch.mockResolvedValue({ ok: false, status, text: async () => 'gateway failed' });
        await expect(callJudge('evaluate', managedConfig()))
            .rejects.toMatchObject({ code: 'JUDGE_INFERENCE_TERMINALITY_UNKNOWN' });
        expect(benchmarkFetch).toHaveBeenCalledTimes(1);
    });
    it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'])(
        'does not replay after transport %s', async code => {
            benchmarkFetch.mockRejectedValue(Object.assign(new Error('connection interrupted'), { code }));
            await expect(callJudge('evaluate', managedConfig()))
                .rejects.toMatchObject({ code: 'JUDGE_INFERENCE_TERMINALITY_UNKNOWN' });
            expect(benchmarkFetch).toHaveBeenCalledTimes(1);
        });
});
