'use strict';

const { checkJudgeLimits } = require('../../../src/services/benchmark/judgeLaunchLimits');

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

    it.each([
        [{ num_predict: 50 }, /num_predict must be a number between 100 and 32768/],
        [{ num_predict: 40000 }, /num_predict must be a number between 100 and 32768/],
        [{ num_predict: '800' }, /num_predict/],
        [{ timeout: 1000 }, /timeout must be a number between 5000 and 1800000/],
        [{ timeout: 3600000 }, /timeout must be a number between 5000 and 1800000/]
    ])('still refuses nonsense (%j)', (judgeConfig, message) => {
        expect(checkJudgeLimits(judgeConfig).error).toMatch(message);
    });
});
