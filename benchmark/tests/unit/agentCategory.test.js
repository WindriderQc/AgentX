'use strict';

const prompts = require('../../data/benchmark-prompts.json');
const { ENHANCED_SCORING_CONFIGS, CATEGORY_COMPOSITE_PROFILES, CATEGORY_STRATEGIES } = require('../../src/services/scoring/scoringConfigs');
const { DECOMPOSED_QUESTIONS } = require('../../src/services/decomposedJudgeQuestions');
const { BENCHMARK_CATEGORY_KEYS, GENERALIST_CATEGORY_WEIGHTS } = require('../../config/categories');

describe('agent category', () => {
    const agent = prompts.filter(prompt => prompt.category === 'agent');

    it('is a weighted benchmark category with a scoring rubric', () => {
        expect(BENCHMARK_CATEGORY_KEYS).toContain('agent');
        expect(GENERALIST_CATEGORY_WEIGHTS.agent).toBeGreaterThan(0);
        expect(ENHANCED_SCORING_CONFIGS.agent.primary_dimension).toBe('finding_accuracy');
        expect(CATEGORY_COMPOSITE_PROFILES.agent.weights.quality).toBeGreaterThan(0.8);
        expect(CATEGORY_STRATEGIES.agent.primary).toBe('decomposed');
        for (const [dimension, questions] of Object.entries(DECOMPOSED_QUESTIONS.agent)) {
            const total = questions.reduce((sum, question) => sum + question.weight, 0);
            expect([dimension, Math.round(total * 1000) / 1000]).toEqual([dimension, 1]);
        }
    });

    it('covers every level, including the hard levels full scope requires', () => {
        const levels = new Set(agent.map(prompt => prompt.level));
        expect([...levels].sort()).toEqual([1, 2, 3, 4, 5]);
        expect(agent.filter(prompt => prompt.level >= 4).length).toBeGreaterThanOrEqual(4);
    });

    it('judges every prompt against its planted findings', () => {
        for (const prompt of agent) {
            expect(prompt.expected_answer).toBeTruthy();
            expect(prompt.judge_criteria.length).toBeGreaterThanOrEqual(3);
        }
    });
});
