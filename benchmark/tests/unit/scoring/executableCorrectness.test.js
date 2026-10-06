'use strict';

/**
 * The scoring pipeline end to end for a coding prompt with reference tests:
 * the runner supplies correctness, the judge keeps the secondary dimensions,
 * and a runner that cannot answer leaves the row unscored.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('node-fetch', () => jest.fn());

const mockFetch = require('node-fetch');
const { scoreResponse } = require('../../../src/services/qualityScorer');
const { setCodeRunner, createCodeRunner } = require('../../../src/services/scoring/codeRunnerClient');
const { SCORER_VERSION } = require('../../../src/services/scoring/scorerVersion');

const judgeConfig = { host: 'http://judge:11434', model: 'judge:27b' };

function mockBinary(answer) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ response: answer }) });
}

// Counted questions (rubric 2.16) take a count, not YES/NO: an all-YES judge
// finds nothing missing, an all-NO judge finds everything missing.
function judgeAnswer(opts, answer) {
    const prompt = JSON.parse(opts?.body || '{}').prompt || '';
    // The known-answer probe that expects NO is answered correctly: this mock
    // is a judge that reads, not one that answers by disposition.
    if (prompt.includes('completely empty, with no characters at all')) return 'NO';
    if (!prompt.includes('Answer ONLY one of')) return answer;
    return answer === 'NO' ? '3 or more' : '0';
}

function askedPrompts() {
    return mockFetch.mock.calls.map(([, opts]) => JSON.parse(opts?.body || '{}').prompt || '');
}

const fixture = () => ({
    language: 'python',
    harness: 'function_calls',
    entry: 'is_prime',
    cases: [{ id: 'n=2', args: [2], expected: true }, { id: 'n=9', args: [9], expected: false }]
});

const prompt = (extra = {}) => ({
    name: 'prime',
    prompt: 'Write a Python function is_prime(n) that returns whether n is prime.',
    category: 'coding',
    expected_answer: 'def is_prime(n):\n    return n > 1 and all(n % i for i in range(2, n))',
    reference_answer: 'A trial-division primality test.',
    reference_tests: fixture(),
    ...extra
});

const response = 'def is_prime(n):\n    if n < 2:\n        return False\n    return all(n % i for i in range(2, n))';

function fakeRunner({ failIds = [], unavailable = false } = {}) {
    const calls = [];
    return {
        calls,
        mode: 'fake',
        isAvailable: () => !unavailable,
        describe: () => ({ mode: 'fake', available: !unavailable }),
        async runJob(job) {
            calls.push(job);
            if (unavailable) return { status: 'runner_unavailable', error: 'sidecar down' };
            const driver = job.files['driver.py'];
            const match = /b64decode\("([^"]+)"\)/.exec(driver);
            const cases = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
            const lines = cases.map((c) => `RESULT ${JSON.stringify({ id: c.id, passed: !failIds.includes(c.id) })}`);
            return {
                exit_code: failIds.length === 0 ? 0 : 1, timed_out: false, stdout: lines.join('\n') + '\n',
                stderr: '', duration_ms: 5, stdout_truncated: false, stderr_truncated: false
            };
        }
    };
}

beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation((url, opts) => mockBinary(judgeAnswer(opts, 'YES')));
});
afterEach(() => setCodeRunner(null));

describe('a coding prompt with reference tests', () => {
    test('is scored by the runner for correctness and by the judge for the rest', async () => {
        const runner = fakeRunner();
        setCodeRunner(runner);
        const result = await scoreResponse({ response, prompt: prompt(), judgeConfig });

        expect(runner.calls).toHaveLength(1);
        expect(result).toMatchObject({
            scoring_method: 'decomposed',
            quality_score: 10,
            correctness_source: 'executable',
            supplied_dimensions: ['correctness'],
            composite_formula: 'executable_primary_judge_secondary',
            deterministic_score: 10,
            deterministic_pass: true,
            subjective_score: 10,
            needs_review: false
        });
        expect(result.execution_result).toMatchObject({ status: 'passed', correctness: 10, passed: 2, total: 2 });
        expect(result.code_extraction).toEqual({ status: 'ok', source: 'raw', blocks: 0 });
        expect(result.breakdown.correctness).toBe(10);
        expect(result.decomposed_breakdown.correctness).toEqual([expect.objectContaining({ supplied: 'executable' })]);
        expect(result.explanation).toContain('Correctness: 10 (reference tests executed)');

        // The judge was never asked whether the code works.
        const asked = askedPrompts();
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.some((text) => text.includes('Would the code produce correct output'))).toBe(false);
        expect(asked.some((text) => text.includes('Does the response do what the task asks for'))).toBe(false);
        expect(asked.some((text) => text.includes('readable enough for a reviewer'))).toBe(true);
    });

    test('a wrong program cannot be rescued by clarity: the cap holds it at correctness plus one', async () => {
        setCodeRunner(fakeRunner({ failIds: ['n=9'] }));
        const result = await scoreResponse({ response, prompt: prompt(), judgeConfig });

        // 1 of 2 cases: 0.5; secondary dimensions all 10 from an all-YES judge;
        // the overall is capped at 0.5 + 1, inside the wrong tier.
        expect(result.execution_result).toMatchObject({ status: 'failed', correctness: 0.5, passed: 1, failed: 1 });
        expect(result.breakdown.correctness).toBe(0.5);
        expect(result.quality_score).toBe(1.5);
        expect(result.primary_cap).toMatchObject({ dimension: 'correctness', score: 0.5, applied: true });
        expect(result.deterministic_pass).toBe(false);
    });

    test('a response without a program scores zero through the judge path, and the judge is still asked the rest', async () => {
        const runner = fakeRunner();
        setCodeRunner(runner);
        const result = await scoreResponse({ response: 'Prime numbers are those with two divisors.', prompt: prompt(), judgeConfig });
        expect(runner.calls).toHaveLength(0);
        expect(result.execution_result.status).toBe('no_code');
        expect(result.breakdown.correctness).toBe(0);
        expect(result.quality_score).toBeLessThanOrEqual(1);
    });

    test('with the judge skipped, execution alone decides', async () => {
        setCodeRunner(fakeRunner());
        const result = await scoreResponse({ response, prompt: prompt(), judgeConfig, skipLLM: true });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            scoring_method: 'executable',
            quality_score: 10,
            correctness_source: 'executable',
            composite_formula: 'executable_only',
            deterministic_score: 10,
            deterministic_pass: true,
            subjective_score: null,
            needs_review: false
        });
    });

    test('a failed judge costs the secondary dimensions, not the score', async () => {
        setCodeRunner(fakeRunner());
        mockFetch.mockImplementation(() => mockBinary('undecidable'));
        const result = await scoreResponse({ response, prompt: prompt(), judgeConfig });
        expect(result).toMatchObject({
            scoring_method: 'executable',
            quality_score: 10,
            correctness_source: 'executable',
            composite_formula: 'executable_only',
            needs_review: true
        });
        expect(result.review_reason).toContain('judge unavailable for the secondary dimensions');
    });

    test('without a runner the row is not scored and asks for review; the judge is not asked to guess', async () => {
        setCodeRunner(createCodeRunner({ mode: 'off' }));
        const result = await scoreResponse({ response, prompt: prompt(), judgeConfig });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            quality_score: null,
            scoring_method: 'executable',
            correctness_source: 'executable',
            needs_review: true,
            composite_formula: 'executable_unavailable',
            deterministic_score: null,
            format_score: null
        });
        expect(result.review_reason).toContain('Not scored');
        expect(result.execution_result.status).toBe('runner_unavailable');
    });

    test('a prompt outside the coding category is untouched, even with a fixture', async () => {
        const runner = fakeRunner();
        setCodeRunner(runner);
        const result = await scoreResponse({
            response: 'Paris.',
            prompt: { name: 'capital', prompt: 'Capital of France?', category: 'knowledge', expected_answer: 'Paris', reference_tests: fixture() },
            judgeConfig
        });
        expect(runner.calls).toHaveLength(0);
        expect(result.correctness_source).toBeUndefined();
        expect(result.scoring_method).toBe('decomposed');
    });

    test('the scorer version says these rows are a new family', () => {
        expect(SCORER_VERSION).toBe('2.20.0');
    });
});
