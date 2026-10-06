'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({
    getWorkloadAdmissionIdentity: jest.fn(id => (id ? { workloadAdmissionId: `adm-${id}`, workloadGeneration: 'gen' } : null)),
    coreRequest: jest.fn(async () => ({ data: { yield: false } }))
}));

const { judgeDrainBudgetMs, prepareStandaloneJudge, PER_RESULT_BUDGET_MS, MIN_DRAIN_BUDGET_MS } = require('../../../src/services/benchmark/standaloneJudgePreparation');
const ConcurrencyQueue = require('../../../src/services/benchmark/ConcurrencyQueue');

const freeze = async config => ({ ...config, num_ctx: config.num_ctx || 65536, execution_contract: { schema: 'frozen-test-contract' } });

const JUDGE = { host: 'http://judge:11434', model: 'qwen3.8:27b-mtp-q8_0' };

describe('standalone judge drain budget', () => {
    test('keeps the 30-minute floor for small runs and grows with the work', () => {
        expect(judgeDrainBudgetMs(10, 2)).toBe(MIN_DRAIN_BUDGET_MS);
        expect(judgeDrainBudgetMs(21, 2)).toBe(11 * PER_RESULT_BUDGET_MS);
        // The 147-result re-judge that overran 30 minutes now has 74 slots of work.
        expect(judgeDrainBudgetMs(147, 2)).toBe(74 * PER_RESULT_BUDGET_MS);
        expect(judgeDrainBudgetMs(147, 2)).toBeGreaterThan(31 * 60 * 1000);
        // A configured budget is honoured when it is the larger one.
        expect(judgeDrainBudgetMs(10, 2, 5 * 60 * 60 * 1000)).toBe(5 * 60 * 60 * 1000);
    });
});

describe('standalone judge preparation', () => {
    test('resolves the contract context when none is set and warms the judge with it', async () => {
        const warmup = jest.fn(async () => ({ success: true }));
        const resolve = jest.fn(freeze);

        const config = await prepareStandaloneJudge(JUDGE, { workloadId: 'judge-batch:1', _freezeConfig: resolve, _warmup: warmup });

        expect(resolve).toHaveBeenCalledWith(JUDGE, { signal: null });
        expect(config.execution_contract).toEqual({ schema: 'frozen-test-contract' });
        expect(config.num_ctx).toBe(65536);
        expect(warmup).toHaveBeenCalledWith(JUDGE.host, JUDGE.model, expect.objectContaining({
            strict: true, num_ctx: 65536, preUnloadOthers: false, warmupTimeoutCold: 5 * 60 * 1000,
            claimIdentity: { workloadAdmissionId: 'adm-judge-batch:1', workloadGeneration: 'gen' }
        }));
    });

    test('keeps an explicit context', async () => {
        const resolve = jest.fn(freeze);
        const config = await prepareStandaloneJudge({ ...JUDGE, num_ctx: 32768 }, { _freezeConfig: resolve, _warmup: jest.fn() });
        expect(resolve).toHaveBeenCalled();
        expect(config.num_ctx).toBe(32768);
    });

    test('an unresolvable contract stops before warmup or inference', async () => {
        const warmup = jest.fn();
        await expect(prepareStandaloneJudge(JUDGE, { _freezeConfig: async () => { throw new Error('no contract'); }, _warmup: warmup }))
            .rejects.toThrow('no contract');
        expect(warmup).not.toHaveBeenCalled();
    });

    test('a failed warmup stops the run before its first call', async () => {
        await expect(prepareStandaloneJudge(JUDGE, {
            _freezeConfig: freeze,
            _warmup: async () => { throw new Error('Warmup failed: cold load timed out'); }
        })).rejects.toThrow('cold load timed out');
    });

    test('harness judges are not warmed here', async () => {
        const warmup = jest.fn();
        const harness = { ...JUDGE, target: { executionKind: 'harness' } };
        await expect(prepareStandaloneJudge(harness, { _warmup: warmup })).resolves.toBe(harness);
        expect(warmup).not.toHaveBeenCalled();
    });
});

describe('queue stop', () => {
    test('cancelAndSettle rejects queued tasks and returns only once running ones finished', async () => {
        const queue = new ConcurrencyQueue(1);
        const events = [];
        let finish;
        queue.add(() => new Promise(resolve => { finish = () => { events.push('running task done'); resolve(); }; }));
        const queued = queue.add(async () => events.push('queued task ran')).catch(error => events.push(`queued rejected ${error.code}`));

        const stopping = queue.cancelAndSettle(Object.assign(new Error('over budget'), { code: 'JUDGE_BUDGET_EXCEEDED' }));
        await queued;
        setTimeout(() => finish(), 20);
        await stopping;
        events.push('settled');

        expect(events).toEqual(['queued rejected JUDGE_BUDGET_EXCEEDED', 'running task done', 'settled']);
    });
});
