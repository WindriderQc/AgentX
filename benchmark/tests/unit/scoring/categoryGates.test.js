'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('node-fetch', () => jest.fn());
jest.mock('../../../src/services/benchmark/http', () => ({ benchmarkFetch: jest.fn() }));

const nodeFetch = require('node-fetch');
const { benchmarkFetch } = require('../../../src/services/benchmark/http');
const { CATEGORY_GATES, GATE_BOUND, assessGates, boundByGates } = require('../../../src/services/scoring/categoryGates');
const { scoreResponse } = require('../../../src/services/qualityScorer');

const GATE = CATEGORY_GATES.translation[0].q;
const judgeConfig = { host: 'http://judge:11434', model: 'judge' };
const reply = text => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ response: text, done: true }) });

// A judge that finds the answer perfect, except for what `gate` says about the language.
function judge(gate) {
    const answer = (url, opts) => {
        const prompt = JSON.parse(opts.body).prompt;
        if (prompt.includes(GATE)) return reply(gate === null ? 'maybe' : `Evidence.\n${prompt.includes('KEY POINT') ? 'VERDICT: ' : ''}${gate ? 'YES' : 'NO'}`);
        if (prompt.includes('Answer ONLY one of')) return reply('0');
        if (prompt.includes('completely empty')) return reply('NO');
        if (prompt.includes('RATING:')) return reply('Nothing missing.\nRATING: EXCELLENT');
        if (prompt.includes('CONTRADICT')) return reply('None.\nVERDICT: NO');
        if (prompt.includes('KEY POINT')) return reply('Present.\nVERDICT: YES');
        return reply('YES');
    };
    nodeFetch.mockImplementation(answer);
    benchmarkFetch.mockImplementation(answer);
}

const asked = () => [...nodeFetch.mock.calls, ...benchmarkFetch.mock.calls].map(([, opts]) => JSON.parse(opts.body).prompt);
const decomposed = { prompt: "Translate to Spanish: 'The library opens at nine.'", category: 'translation',
    expected_answer: 'La biblioteca abre a las nueve.', judge_criteria: ['Opening time rendered as a las nueve'] };
const reference = { ...decomposed, reference_answer: 'La biblioteca abre a las nueve.' };

beforeEach(() => {
    nodeFetch.mockReset();
    benchmarkFetch.mockReset();
});

describe('category gates', () => {
    test('only translation is gated; a failed gate bounds a score, nothing else does', async () => {
        expect(Object.keys(CATEGORY_GATES)).toEqual(['translation']);
        const ask = jest.fn(async () => false);
        expect(await assessGates('knowledge', ask)).toEqual([]);
        expect(ask).not.toHaveBeenCalled();
        const gates = await assessGates('translation', ask);
        expect(gates).toEqual([{ key: 'target_language', question: GATE, answer: false }]);
        expect(boundByGates(8.5, gates)).toBe(GATE_BOUND);
        expect(boundByGates(0.4, gates)).toBe(0.4);
        expect(boundByGates(null, gates)).toBeNull();
        expect(boundByGates(8.5, [{ ...gates[0], answer: true }])).toBe(8.5);
    });

    test.each([['decomposed', decomposed], ['reference', reference]])(
        'on the %s path, a translation in the requested language keeps its grade', async (method, prompt) => {
            judge(true);
            const result = await scoreResponse({ response: 'La biblioteca abre a las nueve.', prompt, judgeConfig });
            expect(result).toMatchObject({ scoring_method: method, quality_score: 10, gates: [{ key: 'target_language', answer: true }] });
            expect(asked().filter(text => text.includes(GATE))).toHaveLength(1);
        });

    test.each([['decomposed', decomposed], ['reference', reference]])(
        'on the %s path, a faithful translation into another language is bounded at 1', async (method, prompt) => {
            judge(false);
            const result = await scoreResponse({ response: 'La biblioteca apre alle nove.', prompt, judgeConfig });
            expect(result).toMatchObject({ scoring_method: method, quality_score: GATE_BOUND, gates: [{ answer: false }] });
            expect(result.explanation).toMatch(/Bounded at 1: target_language not met/);
        });

    test.each([['decomposed', decomposed], ['reference', reference]])(
        'on the %s path, an unanswered gate leaves the grade unknown', async (method, prompt) => {
            judge(null);
            const result = await scoreResponse({ response: 'La biblioteca abre a las nueve.', prompt, judgeConfig });
            expect(result).toMatchObject({ scoring_method: 'llm_failed', attempted_scoring_method: method, quality_score: null });
        });

    test('other categories ask no gate', async () => {
        judge(false);
        const result = await scoreResponse({ response: 'Paris', judgeConfig,
            prompt: { prompt: 'What is the capital of France?', category: 'knowledge', expected_answer: 'Paris' } });
        expect(result.quality_score).toBe(10);
        expect(result.gates).toBeUndefined();
        expect(asked().some(text => text.includes(GATE))).toBe(false);
    });
});
