'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('node-fetch', () => jest.fn());

const nodeFetch = require('node-fetch');
const { applySecondaryBounds } = require('../../../src/services/scoring/decomposedHelpers');
const { ENHANCED_SCORING_CONFIGS, PRIMARY_DIMENSION_CAP_MARGIN, QUALITY_BOUND_MARGIN } = require('../../../src/services/scoring/scoringConfigs');
const { DECOMPOSED_QUESTIONS } = require('../../../src/services/decomposedJudgeQuestions');
const decomposedJudge = require('../../../src/services/decomposedJudge');

const judgeConfig = { host: 'http://judge:11434', model: 'judge' };

// A judge that answers every question of `dimension` NO (or "3 or more") and every other one YES (or "0").
function judgeFailing(category, dimension) {
    const failing = (DECOMPOSED_QUESTIONS[category][dimension] || []).map(item => item.q);
    nodeFetch.mockImplementation((url, opts) => {
        const prompt = JSON.parse(opts.body).prompt;
        const question = prompt.slice(prompt.lastIndexOf('RESPONSE_END'));
        const fails = failing.some(text => question.includes(text));
        const counted = question.includes('Answer ONLY one of');
        const answer = question.includes('completely empty') ? 'NO'
            : counted ? (fails ? '3 or more' : '0') : (fails ? 'NO' : 'YES');
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ response: answer, done: true }) });
    });
}

beforeEach(() => nodeFetch.mockReset());

describe('secondary bounds (#446)', () => {
    test('each bound is a dimension score plus its margin; an unscored dimension sets none', () => {
        const bounds = [{ dimension: 'efficiency', margin: 4 }, { dimension: 'clarity', margin: 4 }];
        expect(applySecondaryBounds(8.4, { efficiency: 2, clarity: 9 }, bounds)).toEqual({
            score: 6,
            bounds: [{ dimension: 'efficiency', score: 2, margin: 4, applied: true }, { dimension: 'clarity', score: 9, margin: 4, applied: false }]
        });
        expect(applySecondaryBounds(8.4, { efficiency: null }, bounds).score).toBe(8.4);
        expect(applySecondaryBounds(8.4, {}, undefined)).toEqual({ score: 8.4, bounds: [] });
    });

    test('coding efficiency, instruction completeness and creative originality and engagement are bounded', () => {
        const declared = Object.fromEntries(Object.entries(ENHANCED_SCORING_CONFIGS)
            .filter(([, config]) => config.secondary_bounds).map(([category, config]) => [category, config.secondary_bounds]));
        expect(declared).toEqual({
            coding: [{ dimension: 'efficiency', margin: QUALITY_BOUND_MARGIN }],
            instruction: [{ dimension: 'completeness', margin: PRIMARY_DIMENSION_CAP_MARGIN }],
            creative: [{ dimension: 'originality', margin: QUALITY_BOUND_MARGIN }, { dimension: 'engagement', margin: QUALITY_BOUND_MARGIN }]
        });
    });

    test.each([
        ['coding', 'efficiency', QUALITY_BOUND_MARGIN],
        ['instruction', 'completeness', PRIMARY_DIMENSION_CAP_MARGIN],
        ['creative', 'originality', QUALITY_BOUND_MARGIN],
        ['creative', 'engagement', QUALITY_BOUND_MARGIN]
    ])('a %s answer with nothing in %s is held to that dimension plus %s', async (category, dimension, margin) => {
        judgeFailing(category, dimension);
        const result = await decomposedJudge.score('An answer.', { prompt: 'A task.', category }, judgeConfig);
        expect(result.breakdown[dimension]).toBe(0);
        expect(result.primary_cap.uncapped_score).toBeGreaterThan(margin);
        expect(result.quality_score).toBe(margin);
        expect(result.secondary_bounds).toEqual(expect.arrayContaining([{ dimension, score: 0, margin, applied: true }]));
        expect(result.explanation).toContain(`Bounded at ${dimension} + ${margin}.`);
    });

    test('a full answer is not bounded, and categories without bounds report none', async () => {
        judgeFailing('coding', 'none');
        const coding = await decomposedJudge.score('An answer.', { prompt: 'A task.', category: 'coding' }, judgeConfig);
        expect(coding.quality_score).toBe(10);
        expect(coding.secondary_bounds).toEqual([{ dimension: 'efficiency', score: 10, margin: QUALITY_BOUND_MARGIN, applied: false }]);
        const knowledge = await decomposedJudge.score('An answer.', { prompt: 'A task.', category: 'knowledge' }, judgeConfig);
        expect(knowledge.secondary_bounds).toBeUndefined();
    });
});
