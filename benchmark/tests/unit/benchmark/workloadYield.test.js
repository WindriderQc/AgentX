'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({
    coreRequest: jest.fn(),
    getWorkloadAdmissionIdentity: jest.fn()
}));

const coreApiClient = require('../../../src/clients/coreApiClient');
const { enterInference, withInference, runPromptAfterYield, yieldWaitMs, forgetWorkload } = require('../../../src/services/benchmark/workloadYield');

const PROOF = { workloadAdmissionId: 'admission-1', workloadGeneration: 'generation-1' };
const answer = (data) => ({ status: 'success', data });
const sentBodies = () => coreApiClient.coreRequest.mock.calls.map(call => JSON.parse(call[1].body));

beforeEach(() => {
    jest.clearAllMocks();
    forgetWorkload('batch-1');
    coreApiClient.getWorkloadAdmissionIdentity.mockImplementation(id => (id === 'batch-1' ? PROOF : null));
});

describe('workload yield point', () => {
    test('a request without a workload admission goes straight on', async () => {
        const inference = await enterInference('interactive-test');
        expect(inference.yielded).toBe(false);
        expect(coreApiClient.coreRequest).not.toHaveBeenCalled();
    });

    test('waits while Core asks to yield, then goes on and reports the yield', async () => {
        coreApiClient.coreRequest
            .mockResolvedValueOnce(answer({ yield: true, yielded: true, retryAfterMs: 1 }))
            .mockResolvedValueOnce(answer({ yield: true, yielded: true, retryAfterMs: 1 }))
            .mockResolvedValueOnce(answer({ yield: false, yielded: false }));

        const inference = await enterInference('batch-1');

        expect(inference.yielded).toBe(true);
        expect(coreApiClient.coreRequest).toHaveBeenCalledTimes(3);
        expect(coreApiClient.coreRequest.mock.calls[0][0]).toBe('/api/nerve-center/workload-admissions/admission-1/yield-point');
        expect(sentBodies()[0]).toEqual({ generation: 'generation-1', inFlight: 0 });
        expect(yieldWaitMs('batch-1')).toBeGreaterThanOrEqual(1);
        inference.release();
    });

    test('reports the requests still in flight, one pass at a time', async () => {
        coreApiClient.coreRequest.mockResolvedValue(answer({ yield: false }));

        const first = await enterInference('batch-1');
        const [second, third] = await Promise.all([enterInference('batch-1'), enterInference('batch-1')]);
        expect(sentBodies().map(body => body.inFlight)).toEqual([0, 1, 2]);

        first.release();
        first.release();
        second.release();
        await enterInference('batch-1');
        expect(sentBodies()[3].inFlight).toBe(1);
        third.release();
    });

    test('an unavailable yield point never blocks evaluation', async () => {
        coreApiClient.coreRequest.mockRejectedValueOnce(Object.assign(new Error('Core API 404'), { status: 404 }));
        await expect(withInference('batch-1', async () => 'answered')).resolves.toBe('answered');
        // The failed request was released: the next pass sees nothing in flight.
        coreApiClient.coreRequest.mockResolvedValueOnce(answer({ yield: false }));
        (await enterInference('batch-1')).release();
        expect(sentBodies()[1].inFlight).toBe(0);
    });

    test('a prompt after a yield rewarms its model first; otherwise it runs directly', async () => {
        const order = [];
        const rewarm = async () => { order.push('rewarm'); };
        coreApiClient.coreRequest
            .mockResolvedValueOnce(answer({ yield: true, yielded: true, retryAfterMs: 1 }))
            .mockResolvedValueOnce(answer({ yield: false }));
        await expect(runPromptAfterYield('batch-1', { rewarm }, async () => { order.push('prompt'); return { ok: true }; }))
            .resolves.toEqual({ ok: true });
        expect(order).toEqual(['rewarm', 'prompt']);

        coreApiClient.coreRequest.mockResolvedValueOnce(answer({ yield: false }));
        await runPromptAfterYield('batch-1', { rewarm }, async () => order.push('prompt'));
        expect(order).toEqual(['rewarm', 'prompt', 'prompt']);
    });

    test('a stop while waiting reads as a stopped prompt', async () => {
        coreApiClient.coreRequest.mockResolvedValue(answer({ yield: true, yielded: true, retryAfterMs: 60_000 }));
        const controller = new AbortController();
        const prompt = jest.fn();
        const waiting = runPromptAfterYield('batch-1', { rewarm: jest.fn(), signal: controller.signal }, prompt);
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
        await expect(waiting).resolves.toEqual({ infraError: false, stopped: true, cancelled: true });
        expect(prompt).not.toHaveBeenCalled();
    });

    test('a cancelled workload stops waiting', async () => {
        coreApiClient.coreRequest.mockResolvedValue(answer({ yield: true, yielded: true, retryAfterMs: 60_000 }));
        const controller = new AbortController();
        const waiting = enterInference('batch-1', { signal: controller.signal });
        await new Promise(resolve => setImmediate(resolve));
        controller.abort(new Error('batch stopped'));
        await expect(waiting).rejects.toThrow('batch stopped');
    });
});
