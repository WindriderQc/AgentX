'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const catalog = require('../../data/benchmark-prompts.json');
const hard = require('../../data/benchmark-prompts-hard.json');
const deterministicScorer = require('../../src/services/deterministicScorer');
const { BENCHMARK_CATEGORY_KEYS } = require('../../config/categories');

const identity = prompt => `${prompt.category}::${prompt.name.toLowerCase()}::${prompt.level}`;

describe('hard prompt library', () => {
    it('adds level 5 prompts in known categories without colliding with the catalog', () => {
        expect(hard.length).toBe(30);
        const keys = [...catalog, ...hard].map(identity);
        expect(new Set(keys).size).toBe(keys.length);
        for (const prompt of hard) {
            expect([prompt.name, prompt.level]).toEqual([prompt.name, 5]);
            expect(BENCHMARK_CATEGORY_KEYS).toContain(prompt.category);
            expect(prompt.judge_criteria.length).toBeGreaterThanOrEqual(3);
        }
    });

    it('scores every prompt by its computed answer, never by a judge', () => {
        for (const prompt of hard) {
            expect(['exact', 'numeric']).toContain(prompt.deterministic_scoring.type);
            expect(prompt.output_contract.type).toBe('regex');
            expect([prompt.name, new RegExp(prompt.output_contract.pattern).test(prompt.expected_answer)]).toEqual([prompt.name, true]);

            const right = deterministicScorer.score(prompt.expected_answer, prompt);
            expect([prompt.name, right.score, right.matched]).toEqual([prompt.name, 10, true]);

            const wrong = deterministicScorer.score('no answer', prompt);
            expect([prompt.name, wrong.matched]).toEqual([prompt.name, false]);
        }
    });

    it('does not credit an answer that differs by one element', () => {
        const seating = hard.find(prompt => prompt.name === 'Eight Seats In A Row One');
        const names = seating.expected_answer.split(',');
        [names[0], names[1]] = [names[1], names[0]];
        expect(deterministicScorer.score(names.join(','), seating).matched).toBe(false);

        const count = hard.find(prompt => prompt.name === 'Bounded Integer Solutions');
        expect(deterministicScorer.score(String(Number(count.expected_answer) + 1), count).matched).toBe(false);
    });
});
