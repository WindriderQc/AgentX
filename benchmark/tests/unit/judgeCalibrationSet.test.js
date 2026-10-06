'use strict';

const { BENCHMARK_CATEGORY_KEYS } = require('../../../shared/benchmarkCategories');
const {
    calibrationPrompt,
    isIdentityCase,
    loadCalibrationSet,
    validateCalibrationSet
} = require('../../src/services/benchmark/judgeCalibration');
const calibration = require('../../data/judge-calibration-set.json');
const catalog = require('../../data/benchmark-prompts.json');

const TIERS = ['excellent', 'mediocre', 'clearly_wrong'];
const ofCategory = category => calibration.filter(item => item.category === category);

describe('judge calibration set', () => {
    test('covers every catalog category, so no category reads no_reference_cases', () => {
        const covered = new Set(calibration.map(item => item.category));
        expect(BENCHMARK_CATEGORY_KEYS.filter(category => !covered.has(category))).toEqual([]);
        expect(calibration.every(item => BENCHMARK_CATEGORY_KEYS.includes(item.category))).toBe(true);
    });

    test('every case is complete, with a unique id, a grade on the 0-10 scale and a known tier', () => {
        expect(new Set(calibration.map(item => item.id)).size).toBe(calibration.length);
        for (const item of calibration) {
            expect({ id: item.id, prompt: typeof item.prompt, response: typeof item.response, notes: typeof item.notes })
                .toEqual({ id: item.id, prompt: 'string', response: 'string', notes: 'string' });
            expect(item.gold_score).toBeGreaterThanOrEqual(0);
            expect(item.gold_score).toBeLessThanOrEqual(10);
            expect(TIERS).toContain(item.tier);
            if (item.judge_criteria !== undefined) {
                expect(item.judge_criteria.length).toBeGreaterThan(0);
                expect(item.judge_criteria.every(criterion => typeof criterion === 'string' && criterion.trim())).toBe(true);
            }
        }
        expect(() => validateCalibrationSet(loadCalibrationSet())).not.toThrow();
    });

    test.each(['translation', 'agent'])('%s has the three tiers and an identity case at full marks', (category) => {
        const cases = ofCategory(category);
        expect([...new Set(cases.map(item => item.tier))].sort()).toEqual([...TIERS].sort());
        const identity = cases.filter(isIdentityCase);
        expect(identity.length).toBeGreaterThan(0);
        expect(identity.every(item => item.gold_score === 10)).toBe(true);
    });

    test.each(['translation', 'agent'])('%s cases carry criteria, as every catalog prompt of the category does', (category) => {
        const prompts = catalog.filter(item => item.category === category);
        expect(prompts.every(item => Array.isArray(item.judge_criteria) && item.judge_criteria.length)).toBe(true);
        expect(ofCategory(category).filter(item => !item.judge_criteria).map(item => item.id)).toEqual([]);
    });

    test('translation is calibrated on both of its catalog paths: with and without a reference answer', () => {
        const prompts = catalog.filter(item => item.category === 'translation');
        expect(prompts.some(item => item.reference_answer) && prompts.some(item => !item.reference_answer)).toBe(true);
        const cases = ofCategory('translation');
        expect(cases.some(item => item.reference_answer)).toBe(true);
        expect(cases.some(item => !item.reference_answer)).toBe(true);
        // Agent prompts carry no reference answer; their cases are judged against criteria alone.
        expect(ofCategory('agent').some(item => item.reference_answer)).toBe(false);
        expect(ofCategory('translation').filter(item => item.reference_answer)
            .every(item => calibrationPrompt(item).reference_answer === item.reference_answer)).toBe(true);
    });
});
