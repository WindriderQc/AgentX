'use strict';

const { checkJudgeLimits, normalizeJudgeThink } = require('../../../src/services/benchmark/judgeLaunchLimits');

describe('judge limits at launch', () => {
    it('accepts a larger judge budget and timeout, with a warning for each', () => {
        const result = checkJudgeLimits({ num_predict: 8192, timeout: 300000 });
        expect(result.error).toBeNull();
        expect(result.warnings).toEqual([
            expect.stringMatching(/num_predict 8192 is above 4096.*Kept as chosen/),
            expect.stringMatching(/timeout 300000 ms is above 120000 ms.*Kept as chosen/)
        ]);
    });

    it('says nothing about usual values', () => {
        expect(checkJudgeLimits({ num_predict: 800, timeout: 60000 })).toEqual({ error: null, warnings: [] });
        expect(checkJudgeLimits({})).toEqual({ error: null, warnings: [] });
    });

    it('keeps operator budgets beyond the former token and duration ceilings', () => {
        const result = checkJudgeLimits({ num_predict: 65536, timeout: 7200000 });
        expect(result.error).toBeNull();
        expect(result.warnings).toEqual([
            expect.stringMatching(/num_predict 65536.*Kept as chosen/),
            expect.stringMatching(/timeout 7200000 ms.*Kept as chosen/)
        ]);
    });

    it('accepts judge reasoning chosen by the operator, with its cost and cohort stated', () => {
        const result = checkJudgeLimits({ think: true, num_predict: 16384 });
        expect(result.error).toBeNull();
        expect(result.warnings).toEqual([
            expect.stringMatching(/num_predict 16384 is above 4096/),
            expect.stringMatching(/think true: the judge reasons before each verdict.*own scoring cohort.*Kept as chosen/)
        ]);
    });

    it('warns that reasoning shares a usual judge budget with the verdict', () => {
        const result = checkJudgeLimits({ think: true });
        expect(result.error).toBeNull();
        expect(result.warnings).toEqual([
            expect.stringMatching(/think true/),
            expect.stringMatching(/shares judge_config.num_predict \(default\).*cannot be scored/)
        ]);
        expect(checkJudgeLimits({ think: false })).toEqual({ error: null, warnings: [] });
    });

    it('accepts only a boolean judge reasoning setting', () => {
        expect([undefined, null, false].map(normalizeJudgeThink)).toEqual([false, false, false]);
        expect(normalizeJudgeThink(true)).toBe(true);
        // Core's thinking policy does not carry effort levels.
        expect(normalizeJudgeThink('high')).toBeUndefined();
        expect(normalizeJudgeThink('true')).toBeUndefined();
    });

    it.each([
        [{ think: 'high' }, /judge_config.think must be a boolean/],
        [{ num_predict: 50 }, /num_predict must be a safe integer/],
        [{ num_predict: 100.5 }, /num_predict must be a safe integer/],
        [{ num_predict: NaN }, /num_predict must be a safe integer/],
        [{ num_predict: Infinity }, /num_predict must be a safe integer/],
        [{ num_predict: Number.MAX_SAFE_INTEGER + 1 }, /num_predict must be a safe integer/],
        [{ num_predict: '800' }, /num_predict/],
        [{ timeout: 1000 }, /timeout must be an integer/],
        [{ timeout: 5000.5 }, /timeout must be an integer/],
        [{ timeout: NaN }, /timeout must be an integer/],
        [{ timeout: Infinity }, /timeout must be an integer/],
        [{ timeout: 2147483648 }, /Node timer limit/]
    ])('still refuses nonsense (%j)', (judgeConfig, message) => {
        expect(checkJudgeLimits(judgeConfig).error).toMatch(message);
    });
});
