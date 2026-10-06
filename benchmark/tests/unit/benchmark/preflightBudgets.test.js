'use strict';

const { checkResponseBudgets } = require('../../../src/services/benchmark/preflightBudgets');
const { JUDGE_QUESTION_OVERHEAD_TOKENS } = require('../../../src/services/scoring/judgeRequirements');

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
// Selected prompts: a 4,000-character math task and a short translation one.
const prompts = [
    { category: 'math', prompt: 'x'.repeat(4000), expected_answer: '42', judge_criteria: ['Answer is 42'] },
    { category: 'math', prompt: 'short' },
    { category: 'translation', prompt: 'Translate this.' },
];
const loadPrompts = jest.fn(async () => prompts);
const validated = { status: 'validated', cases: 3, mae: 0.6, causes: [] };
const assessJudgeCategories = jest.fn(async (_judge, categories) => Object.fromEntries(categories.map(category => [category,
    category === 'translation' ? { status: 'no_reference_cases', cases: 0, mae: null, causes: [] } : validated])));
const seams = { resolveCandidate, loadPrompts, assessJudgeCategories };

describe('preflight response budgets', () => {
    test('lists each candidate budget with its source and the room left for the prompt', async () => {
        const result = await checkResponseBudgets(targets, {}, { host: 'http://judge:11434', model: 'judge', num_ctx: 131072, think: true },
            { ...seams, levels: [3] });
        expect(result.candidates).toEqual([
            expect.objectContaining({ model: 'big-model', num_ctx: 65536, num_predict: 32000,
                num_predict_source: 'documented_default_half_window_v1', input_tokens: 33536, error: null }),
            expect.objectContaining({ model: 'small-model', num_predict: 2048, num_predict_source: 'core_default_reserve', input_tokens: 6144 }),
        ]);
        // The launch's normalized config is what the contract is resolved with.
        expect(resolveCandidate.mock.calls[0][2]).toMatchObject({ response_max_tokens: 32000, response_budget_rule: expect.any(String) });
        expect(loadPrompts).toHaveBeenLastCalledWith({ levels: [3], promptIds: undefined });
        expect(assessJudgeCategories).toHaveBeenLastCalledWith({ host: 'http://judge:11434', model: 'judge', num_ctx: 131072, think: true }, ['math', 'translation']);
        expect(result.judge).toMatchObject({ num_ctx: 131072, num_ctx_source: 'explicit', think: true, fits: true });
        expect(result.judge.categories.math).toMatchObject({
            prompts: 2, prompt_tokens: 1000 + 1 + 3, reasoning: 'recommended', judge_reasons: true, fits: true,
            window_needed: 1004 + JUDGE_QUESTION_OVERHEAD_TOKENS + 32000 + 800, validation: validated,
        });
        // Only the uncovered category is flagged; the judge reasons, so math raises nothing.
        expect(result.warnings).toEqual([expect.stringMatching(/not validated for: translation \(no calibration case\)/)]);
    });

    test('a judge window too small, an unvalidated category and a non-reasoning judge are each one warning', async () => {
        const resolveJudgeNumCtx = jest.fn(async () => ({ num_ctx: 16384, num_ctx_source: 'inference_contract:pin' }));
        const result = await checkResponseBudgets(targets, {}, { host: 'http://judge:11434', model: 'judge', num_predict: 1500 },
            { ...seams, resolveJudgeNumCtx });
        expect(resolveJudgeNumCtx).toHaveBeenCalledWith('judge', 'http://judge:11434');
        expect(result.judge).toMatchObject({ num_ctx: 16384, num_predict: 1500, fits: false });
        expect(result.warnings).toHaveLength(3);
        expect(result.warnings[0]).toMatch(/16384-token window.*math \(35016\), translation \(\d+\).*32000-token answer.*1500-token verdict/);
        expect(result.warnings[1]).toMatch(/not validated for: translation/);
        expect(result.warnings[2]).toMatch(/^math recommend a reasoning judge .*judges without reasoning/);
    });

    test('a judge whose profile is not current is reported with the window it judges at', async () => {
        const stale = await checkResponseBudgets(targets, {}, { host: 'http://judge:11434', model: 'judge', think: true },
            { ...seams, resolveJudgeNumCtx: async () => ({ num_ctx: 131072, source: 'inference_contract:pin', profile_qualified: false }) });
        expect(stale.judge).toMatchObject({ num_ctx: 131072, profile_qualified: false });
        expect(stale.warnings).toContainEqual(
            expect.stringMatching(/profile of judge judge on http:\/\/judge:11434 is not current.*131072 tokens.*Profile it again/));

        const current = await checkResponseBudgets(targets, {}, { host: 'http://judge:11434', model: 'judge', think: true },
            { ...seams, resolveJudgeNumCtx: async () => ({ num_ctx: 131072, source: 'inference_contract:pin', profile_qualified: true }) });
        expect(current.judge.profile_qualified).toBe(true);
        expect(current.warnings.join(' ')).not.toMatch(/is not current/);
    });

    test('an unresolved candidate or judge window is reported, not thrown', async () => {
        const result = await checkResponseBudgets([...targets, { host: 'http://gpu-b:11434', model: 'huge-model' }], {},
            { host: 'http://judge:11434', model: 'judge', think: true },
            { ...seams, resolveJudgeNumCtx: async () => { throw new Error('Core unreachable'); },
                assessJudgeCategories: async () => { throw new Error('database unavailable'); } });
        expect(result.candidates[2]).toMatchObject({ model: 'huge-model', num_predict: null, error: expect.stringMatching(/not verified/) });
        expect(result.judge).toMatchObject({ num_ctx: null, fits: null });
        expect(result.judge.categories.math.validation).toMatchObject({ status: 'unvalidated', causes: ['qualification_unreadable: database unavailable'] });
        expect(result.warnings).toEqual([
            expect.stringMatching(/Response budget of huge-model on http:\/\/gpu-b:11434 is unresolved/),
            expect.stringMatching(/Judge window of judge on http:\/\/judge:11434 is unresolved: Core unreachable/),
            expect.stringMatching(/not validated for: math \(qualification_unreadable: database unavailable\), translation/),
        ]);
    });

    test('a harness judge has no Ollama window to check', async () => {
        const result = await checkResponseBudgets(targets, {}, { target: { executionKind: 'harness' } }, seams);
        expect(result.judge).toBeNull();
    });
});
