'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { getDimensions, getQuestions, parseGradedAnswer } = require('../../src/services/scoring/decomposedHelpers');
const { DEFAULT_SCORING_CATEGORY } = require('../../src/services/scoring/scoringConfigs');
const { BENCHMARK_CATEGORY_KEYS } = require('../../../shared/benchmarkCategories');
const GroundTruth = require('../../models/JudgeGroundTruth');
const options = [{ answer: '0', credit: 1 }, { answer: '1', credit: 0.66 },
    { answer: '2', credit: 0.33 }, { answer: '3 or more', credit: 0 }];

test.each([undefined, '', 'unknown_category'])('unknown category %s uses the canonical fallback', category => {
    expect(getDimensions(category)).toEqual(getDimensions(DEFAULT_SCORING_CATEGORY));
    expect(getQuestions(category)).toEqual(getQuestions(DEFAULT_SCORING_CATEGORY));
    expect(getQuestions(category, 'not-a-dimension')).toEqual([]);
});

test.each(['0.5', '1e2', '-1', '+1', '2 requirements are met; 1 is missing',
    '1. The answer discusses the first issue.', '1e100', '9007199254740993', '0+'])(
    'does not turn malformed or ambiguous count %s into credit', answer => {
        expect(parseGradedAnswer(answer, options)).toBeNull();
    });

test('a final count overrides a numbered opening', () => {
    expect(parseGradedAnswer('1. The answer discusses the first issue.\nFinal count: 0', options).answer).toBe('0');
    expect(parseGradedAnswer('2 missing\nFinal answer: 1', options).answer).toBe('1');
});

test.each(BENCHMARK_CATEGORY_KEYS)('human reference evidence supports catalog category %s', category => {
    const record = new GroundTruth({ name: 'catalog-coverage', category, prompt: 'Task',
        response: 'Answer', expert_scores: { overall: 7 }, expert_rationale: 'Independent assessment',
        provenance_class: 'independent_human_score', review_protocol: 'blind_independent' });
    expect(record.validateSync()).toBeUndefined();
});

test('old parsed and consensus scores need fresh judging, never automatic carry-over', () => {
    const { carryGrade } = require('../../src/services/scoring/gradeCarryOver');
    const { SCORER_VERSION, versionsComparable } = require('../../src/services/scoring/scorerVersion');
    expect(SCORER_VERSION).toBe('2.22.0');
    expect(versionsComparable('2.21.0', SCORER_VERSION)).toBe(false);
    expect(carryGrade({ scorer_version: '2.21.0', quality_score: 8,
        scoring_method: 'decomposed', prompt_category: 'agent' })).toMatchObject({ carried: false });
});
