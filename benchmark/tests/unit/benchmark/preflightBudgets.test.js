'use strict';

const { checkResponseBudgets, JUDGE_PROMPT_ALLOWANCE_TOKENS } = require('../../../src/services/benchmark/preflightBudgets');

// Two candidates whose frozen budgets come from Core's contracts (#397).
const contracts = {
    'big-model': { num_ctx: 65536, num_ctx_source: 'inference_contract:pin', num_predict: 32000, num_predict_source: 'documented_default_half_window_v1' },
    'small-model': { num_ctx: 8192, num_ctx_source: 'inference_contract:pin', num_predict: 2048, num_predict_source: 'core_default_reserve' },
};
const resolveCandidate = jest.fn(async (model) => {
    if (!contracts[model]) throw new Error(`Context 131072 is not verified for ${model}`);
    return { execution: contracts[model] };
});
const targets = [
    { host: 'http://gpu-a:11434', model: 'big-model' },
    { host: 'http://gpu-a:11434', model: 'small-model' },
];

describe('preflight response budgets', () => {
    test('lists each candidate budget with its source and the room left for the prompt', async () => {
        const result = await checkResponseBudgets(targets, {}, { host: 'http://judge:11434', model: 'judge', num_ctx: 131072 },
            { resolveCandidate });
        expect(result.candidates).toEqual([
            expect.objectContaining({ model: 'big-model', num_ctx: 65536, num_predict: 32000,
                num_predict_source: 'documented_default_half_window_v1', input_tokens: 33536, error: null }),
            expect.objectContaining({ model: 'small-model', num_predict: 2048, num_predict_source: 'core_default_reserve', input_tokens: 6144 }),
        ]);
        // The launch's normalized config is what the contract is resolved with.
        expect(resolveCandidate.mock.calls[0][2]).toMatchObject({ response_max_tokens: 32000, response_budget_rule: expect.any(String) });
        expect(result.judge).toMatchObject({ num_ctx: 131072, num_ctx_source: 'explicit', fits: true,
            needed_tokens: 32000 + JUDGE_PROMPT_ALLOWANCE_TOKENS + 800 });
        expect(result.warnings).toEqual([]);
    });

    test('a judge window too small for the longest answer is a warning with its numbers', async () => {
        const resolveJudgeNumCtx = jest.fn(async () => ({ num_ctx: 16384, num_ctx_source: 'inference_contract:pin' }));
        const result = await checkResponseBudgets(targets, {}, { host: 'http://judge:11434', model: 'judge', num_predict: 1500 },
            { resolveCandidate, resolveJudgeNumCtx });
        expect(resolveJudgeNumCtx).toHaveBeenCalledWith('judge', 'http://judge:11434');
        expect(result.judge).toMatchObject({ num_ctx: 16384, num_predict: 1500, fits: false });
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/16384-token window.*32000 tokens.*1500-token verdict/);
    });

    test('an unresolved candidate or judge window is reported, not thrown', async () => {
        const result = await checkResponseBudgets([...targets, { host: 'http://gpu-b:11434', model: 'huge-model' }], {},
            { host: 'http://judge:11434', model: 'judge' },
            { resolveCandidate, resolveJudgeNumCtx: async () => { throw new Error('Core unreachable'); } });
        expect(result.candidates[2]).toMatchObject({ model: 'huge-model', num_predict: null, error: expect.stringMatching(/not verified/) });
        expect(result.judge).toMatchObject({ num_ctx: null, fits: null });
        expect(result.warnings).toEqual([
            expect.stringMatching(/Response budget of huge-model on http:\/\/gpu-b:11434 is unresolved/),
            expect.stringMatching(/Judge window of judge on http:\/\/judge:11434 is unresolved: Core unreachable/),
        ]);
    });

    test('a harness judge has no Ollama window to check', async () => {
        const result = await checkResponseBudgets(targets, {}, { target: { executionKind: 'harness' } }, { resolveCandidate });
        expect(result.judge).toBeNull();
    });
});
