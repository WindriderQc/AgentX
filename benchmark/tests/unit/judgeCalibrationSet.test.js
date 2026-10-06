'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/services/benchmark/http', () => ({ benchmarkFetch: jest.fn() }));

const nodeFetch = require('node-fetch');
const { benchmarkFetch } = require('../../src/services/benchmark/http');
const { BENCHMARK_CATEGORY_KEYS } = require('../../../shared/benchmarkCategories');
const { CATEGORY_STRATEGIES } = require('../../src/services/scoring/scoringConfigs');
const { scoreResponse } = require('../../src/services/qualityScorer');
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
// The reference scorer grades a prompt whose category falls back to it, when it has a
// reference answer and no reference tests (routeScoring.js).
const onReferencePath = item => CATEGORY_STRATEGIES[item.scoring_type || item.category]?.reference_fallback === true
    && Boolean(item.reference_answer) && !item.reference_tests;

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

    test.each(BENCHMARK_CATEGORY_KEYS)('%s has the three tiers', (category) => {
        expect([...new Set(ofCategory(category).map(item => item.tier))].sort()).toEqual([...TIERS].sort());
    });

    test.each(['translation', 'agent'])('%s has an identity case at full marks', (category) => {
        const identity = ofCategory(category).filter(isIdentityCase);
        expect(identity.length).toBeGreaterThan(0);
        expect(identity.every(item => item.gold_score === 10)).toBe(true);
    });

    test.each(BENCHMARK_CATEGORY_KEYS)('%s cases carry criteria wherever every catalog prompt of the category does', (category) => {
        const prompts = catalog.filter(item => item.category === category);
        if (!prompts.every(item => Array.isArray(item.judge_criteria) && item.judge_criteria.length)) return;
        expect(ofCategory(category).filter(item => !item.judge_criteria).map(item => item.id)).toEqual([]);
    });

    test.each(BENCHMARK_CATEGORY_KEYS)('%s is calibrated on the reference path when its catalog prompts use it', (category) => {
        const prompts = catalog.filter(item => item.category === category);
        expect(ofCategory(category).some(onReferencePath)).toBe(prompts.some(onReferencePath));
    });

    test('translation is calibrated on both of its catalog paths: with and without a reference answer', () => {
        const prompts = catalog.filter(item => item.category === 'translation');
        expect(prompts.some(item => item.reference_answer) && prompts.some(item => !item.reference_answer)).toBe(true);
        const cases = ofCategory('translation');
        expect(cases.some(item => item.reference_answer)).toBe(true);
        expect(cases.some(item => !item.reference_answer)).toBe(true);
        expect(cases.filter(item => item.reference_answer)
            .every(item => calibrationPrompt(item).reference_answer === item.reference_answer)).toBe(true);
    });

    test('every category keeps cases the judge grades; the ones settled without it are known', async () => {
        const reply = (url, opts) => {
            const prompt = JSON.parse(opts.body).prompt;
            const text = prompt.includes('Answer ONLY one of') ? '0'
                : prompt.includes('RATING:') ? 'x\nRATING: EXCELLENT'
                    : prompt.includes('CONTRADICT') ? 'x\nVERDICT: NO'
                        : prompt.includes('KEY POINT') ? 'x\nVERDICT: YES'
                            : prompt.includes('completely empty') ? 'NO' : 'YES';
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ response: text, done: true }) });
        };
        nodeFetch.mockImplementation(reply);
        benchmarkFetch.mockImplementation(reply);
        const judged = {};
        const settled = [];
        // Executed coding cases need the code runner; the judge grades their secondary dimensions.
        for (const item of calibration.filter(entry => !entry.reference_tests)) {
            const result = await scoreResponse({ response: item.response, prompt: calibrationPrompt(item),
                judgeConfig: { host: 'http://judge:11434', model: 'judge' } });
            if (['decomposed', 'reference'].includes(result.scoring_method)) judged[item.category] = (judged[item.category] || 0) + 1;
            else settled.push(`${item.id}:${result.scoring_method}`);
        }
        expect(settled.sort()).toEqual(['cal-exc-04:quick', 'cal-good-04:deterministic']);
        for (const category of BENCHMARK_CATEGORY_KEYS) expect({ category, enough: (judged[category] || 0) >= 2 }).toEqual({ category, enough: true });
    });
});
