'use strict';

jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const {
    executionApplies,
    scoreByExecution,
    executionFields,
    executableOnlyResult,
    unscoredExecutionResult
} = require('../../../src/services/scoring/executionScoring');
const { setCodeRunner, createCodeRunner } = require('../../../src/services/scoring/codeRunnerClient');

const fixture = () => ({
    language: 'python',
    harness: 'function_calls',
    entry: 'is_prime',
    cases: [{ id: 'n=2', args: [2], expected: true }, { id: 'n=9', args: [9], expected: false }]
});

const prompt = (extra = {}) => ({
    name: 'prime', prompt: 'Write is_prime(n).', category: 'coding', reference_tests: fixture(), ...extra
});

/**
 * A runner that answers from the job it was handed: it decodes the cases the
 * driver carries and reports each one as passed unless told otherwise.
 */
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
            const driver = job.files['driver.py'] || job.files['driver.js'];
            const match = /b64decode\("([^"]+)"\)|from\("([^"]+)", "base64"\)/.exec(driver);
            const cases = JSON.parse(Buffer.from(match[1] || match[2], 'base64').toString('utf8'));
            const lines = cases.map((c) => `RESULT ${JSON.stringify({ id: c.id, passed: !failIds.includes(c.id) })}`);
            return {
                exit_code: failIds.length === 0 ? 0 : 1, timed_out: false, stdout: lines.join('\n') + '\n',
                stderr: '', duration_ms: 5, stdout_truncated: false, stderr_truncated: false
            };
        }
    };
}

afterEach(() => setCodeRunner(null));

describe('when execution scoring applies', () => {
    test('only to coding prompts with a usable fixture', () => {
        expect(executionApplies(prompt())).toBe(true);
        expect(executionApplies(prompt({ category: 'reasoning' }))).toBe(false);
        expect(executionApplies(prompt({ scoring_type: 'reasoning' }))).toBe(false);
        expect(executionApplies(prompt({ reference_tests: { harness: 'function_calls' } }))).toBe(false);
        expect(executionApplies({ category: 'coding' })).toBe(false);
        expect(executionApplies(null)).toBe(false);
    });

    test('returns null for prompts it does not apply to, without touching the runner', async () => {
        const runner = fakeRunner();
        expect(await scoreByExecution('def is_prime(n): pass', prompt({ category: 'knowledge' }), { runner })).toBeNull();
        expect(runner.calls).toHaveLength(0);
    });
});

describe('scoring by execution', () => {
    test('runs the extracted program and scores it', async () => {
        const runner = fakeRunner();
        const executed = await scoreByExecution('def is_prime(n):\n    return n > 1', prompt(), { runner });
        expect(runner.calls).toHaveLength(1);
        expect(runner.calls[0].files['solution.py']).toBe('def is_prime(n):\n    return n > 1\n');
        expect(executed.execution).toMatchObject({ scored: true, status: 'passed', correctness: 10, passed: 2 });
        expect(executed.extraction).toEqual({ status: 'ok', source: 'raw', blocks: 0 });
        expect(executed.runner).toEqual({ mode: 'fake', available: true });
    });

    test('scores a response without a program as no code, without a job', async () => {
        const runner = fakeRunner();
        const executed = await scoreByExecution('I would rather not.', prompt(), { runner });
        expect(runner.calls).toHaveLength(0);
        expect(executed.execution).toMatchObject({ scored: true, status: 'no_code', correctness: 0 });
        expect(executed.extraction.status).toBe('no_code');
    });

    test('leaves the candidate unscored when the runner cannot answer', async () => {
        const runner = fakeRunner({ unavailable: true });
        const executed = await scoreByExecution('def is_prime(n): return True', prompt(), { runner });
        expect(executed.execution).toMatchObject({ scored: false, status: 'runner_unavailable', correctness: null, detail: 'sidecar down' });
    });

    test('uses the instance runner when none is injected', async () => {
        setCodeRunner(createCodeRunner({ mode: 'off' }));
        const executed = await scoreByExecution('def is_prime(n): return True', prompt());
        expect(executed.execution.status).toBe('runner_unavailable');
        expect(executed.runner.mode).toBe('off');
    });
});

describe('shaping the results', () => {
    test('every execution-scored row carries the evidence and its source', async () => {
        const executed = await scoreByExecution('def is_prime(n):\n    return n > 1', prompt(), { runner: fakeRunner() });
        expect(executionFields(executed)).toEqual({
            execution_result: executed.execution,
            code_extraction: { status: 'ok', source: 'raw', blocks: 0 },
            correctness_source: 'executable'
        });
    });

    test('an executable-only result explains a judge failure without changing the score', async () => {
        const executed = await scoreByExecution('def is_prime(n):\n    return n > 1', prompt(), { runner: fakeRunner() });
        const plain = executableOnlyResult(executed, { scoringTimeMs: 7 });
        expect(plain).toMatchObject({
            quality_score: 10, scoring_method: 'executable', correctness_source: 'executable',
            needs_review: false, review_reason: null, scoring_time_ms: 7, judge_prompt: null
        });
        const failed = executableOnlyResult(executed, { judgeFailure: 'timeout' });
        expect(failed.quality_score).toBe(10);
        expect(failed.needs_review).toBe(true);
        expect(failed.review_reason).toBe('judge unavailable for the secondary dimensions: timeout');
        expect(failed.explanation).toContain('all passed. judge unavailable');
    });

    test('an unscored row has explicit nulls on every axis and names the infrastructure', async () => {
        const executed = await scoreByExecution('def is_prime(n): return True', prompt(), { runner: fakeRunner({ unavailable: true }) });
        expect(unscoredExecutionResult(executed, { scoringTimeMs: 3 })).toEqual({
            quality_score: null,
            scoring_method: 'executable',
            scoring_type: 'coding',
            execution_result: executed.execution,
            code_extraction: { status: 'ok', source: 'raw', blocks: 0 },
            correctness_source: 'executable',
            explanation: 'Not scored: sidecar down',
            breakdown: null,
            judge_prompt: null,
            judge_model: null,
            judge_confidence: null,
            needs_review: true,
            review_reason: 'Not scored: sidecar down',
            scoring_time_ms: 3,
            format_score: null,
            format_compliant: null,
            semantic_score: null,
            deterministic_score: null,
            deterministic_pass: null,
            subjective_score: null,
            composite_formula: 'executable_unavailable'
        });
    });
});
