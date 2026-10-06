'use strict';

const { carryGrade, carryOverSteps, carriableVersions } = require('../../../src/services/scoring/gradeCarryOver');
const { SCORER_VERSION, SCORER_CARRY_OVER } = require('../../../src/services/scoring/scorerVersion');
const { ENHANCED_SCORING_CONFIGS } = require('../../../src/services/scoring/scoringConfigs');

const CHAIN = [
    { from: '1.0.0', to: '1.1.0', categories: { translation: 'judge' } },
    { from: '1.1.0', to: '1.2.0', categories: { coding: 'secondary_bounds' } }
];
const carry = result => carryGrade(result, { target: '1.2.0', chain: CHAIN });

// Coding weights 0.45/0.15/0.20/0.20, primary correctness, efficiency + 4 as a secondary bound.
const coding = (overrides = {}) => ({
    scorer_version: '1.0.0', prompt_category: 'coding', scoring_type: 'coding', scoring_method: 'decomposed',
    quality_score: 9.2, quality_breakdown: { correctness: 10, clarity: 10, efficiency: 6, robustness: 10 },
    judge_quality_score: null, judge_scores: [], ...overrides
});

describe('carry-over chain', () => {
    test('the declared chain leads every named version to the current one', () => {
        expect(carriableVersions()).toEqual(SCORER_CARRY_OVER.map(step => step.from));
        expect(SCORER_CARRY_OVER.at(-1).to).toBe(SCORER_VERSION);
        for (const step of SCORER_CARRY_OVER) {
            for (const category of Object.keys(step.categories)) expect(ENHANCED_SCORING_CONFIGS).toHaveProperty(category);
        }
    });

    test('a version no step leads from has no carry-over', () => {
        expect(carryOverSteps('0.9.0', '1.2.0', CHAIN)).toBeNull();
        expect(carryOverSteps('1.2.0', '1.2.0', CHAIN)).toEqual([]);
        expect(carry(coding({ scorer_version: '0.9.0' }))).toEqual({ carried: false, reason: expect.stringContaining('no declared carry-over') });
    });
});

describe('carrying one grade', () => {
    test('a category no step names keeps its grade', () => {
        expect(carry({ scorer_version: '1.0.0', prompt_category: 'math', scoring_method: 'deterministic', quality_score: 10 }))
            .toEqual({ carried: true, quality_score: 10, changed: false, rules: [] });
    });

    test('a step that asks the judge something new is not carried', () => {
        expect(carry({ scorer_version: '1.0.0', prompt_category: 'translation', scoring_method: 'decomposed', quality_score: 7 }))
            .toEqual({ carried: false, reason: expect.stringContaining('asks the judge something new') });
    });

    test('a grade the new bound does not reach is carried unchanged', () => {
        expect(carry(coding())).toMatchObject({ carried: true, quality_score: 9.2, changed: false, rules: ['1.2.0:secondary_bounds'] });
    });

    test('a grade the new bound holds is recomputed from its stored dimension scores', () => {
        const weak = coding({ quality_score: 8, quality_breakdown: { correctness: 10, clarity: 10, efficiency: 0, robustness: 10 } });
        expect(carry(weak)).toMatchObject({ carried: true, quality_score: 4, changed: true });
    });

    test('only the decomposed path is bound; other paths keep their grade', () => {
        expect(carry(coding({ scoring_method: 'reference', quality_score: 6, quality_breakdown: null })))
            .toMatchObject({ carried: true, quality_score: 6, changed: false, rules: [] });
    });

    test.each([
        ['a grade that does not follow from its dimension scores', { quality_score: 7.1 }, 'does not follow'],
        ['a grade several judges shaped', { judge_scores: [{}, {}] }, 'several judges'],
        ['a human override', { judge_quality_score: 6 }, 'human override'],
        ['a result without dimension scores', { quality_breakdown: null }, 'no stored dimension scores'],
        ['a result without a grade', { quality_score: null }, 'no grade']
    ])('%s is not carried', (_label, overrides, reason) => {
        expect(carry(coding(overrides))).toEqual({ carried: false, reason: expect.stringContaining(reason) });
    });

    test('the prompt\'s own criteria take their share of the weights when reproducing the grade', () => {
        // 0.75 x (4.5 + 1.5 + 1.2 + 2) + 0.25 x 0 = 6.9
        const withCriteria = coding({ quality_score: 6.9,
            quality_breakdown: { correctness: 10, clarity: 10, efficiency: 6, robustness: 10, specific_criteria: 0 } });
        expect(carry(withCriteria)).toMatchObject({ carried: true, quality_score: 6.9, changed: false });
    });
});
