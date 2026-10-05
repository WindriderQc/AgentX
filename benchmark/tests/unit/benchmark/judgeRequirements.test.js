'use strict';

const { BENCHMARK_CATEGORY_KEYS } = require('../../../../shared/benchmarkCategories');
const {
    CATEGORY_JUDGE_REQUIREMENTS, categoryPromptSizes, promptTokensOf,
} = require('../../../src/services/scoring/judgeRequirements');

describe('catalog judge requirements (#397)', () => {
    test('every category states what it requires of its judge', () => {
        expect(Object.keys(CATEGORY_JUDGE_REQUIREMENTS).sort()).toEqual([...BENCHMARK_CATEGORY_KEYS].sort());
        for (const requirement of Object.values(CATEGORY_JUDGE_REQUIREMENTS)) {
            expect(['recommended', 'not_needed']).toContain(requirement.reasoning);
            expect(requirement.validation).toBe('accuracy_calibration_cases');
            expect(Boolean(requirement.reasoningReason)).toBe(requirement.reasoning === 'recommended');
        }
        // Questions that verify derivations ask for a reasoning judge.
        expect(CATEGORY_JUDGE_REQUIREMENTS.math.reasoning).toBe('recommended');
        expect(CATEGORY_JUDGE_REQUIREMENTS.reasoning.reasoning).toBe('recommended');
        expect(CATEGORY_JUDGE_REQUIREMENTS.translation.reasoning).toBe('not_needed');
    });

    test('the judge-side prompt counts the task, the expected answer, the reference and the criteria', () => {
        expect(promptTokensOf({ prompt: 'a'.repeat(40), expected_answer: 'b'.repeat(8), reference_answer: 'c'.repeat(4),
            judge_criteria: ['d'.repeat(3), 'e'.repeat(4)] })).toBe(10 + 2 + 1 + 2);
        expect(promptTokensOf({ prompt: 'x', expected_answer: { value: 42 } })).toBe(1 + 3);
        expect(categoryPromptSizes([
            { category: 'math', prompt: 'a'.repeat(400) }, { category: 'math', prompt: 'a'.repeat(40) }, { prompt: 'no category' },
        ])).toEqual({ math: { prompts: 2, promptTokens: 100 } });
    });
});
