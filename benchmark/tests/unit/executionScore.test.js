'use strict';

const {
    EXECUTABLE_PARTIAL_CAP,
    parseProtocol,
    scoreExecution,
    explainExecution,
    executionQualityResult
} = require('../../src/services/scoring/executionScore');

const fixture = () => ({
    language: 'python',
    harness: 'function_calls',
    entry: 'is_prime',
    cases: [
        { id: 'n=0', args: [0], expected: false, weight: 0.5 },
        { id: 'n=1', args: [1], expected: false, weight: 0.5 },
        { id: 'n=2', args: [2], expected: true },
        { id: 'n=9', args: [9], expected: false },
        { id: 'n=97', args: [97], expected: true },
        { id: 'n=7919', args: [7919], expected: true }
    ]
});

const ok = { status: 'ok', code: 'def is_prime(n): ...', source: 'raw', blocks: 0 };
const line = (tag, payload) => `${tag} ${JSON.stringify(payload)}`;
const run = (lines, extra = {}) => ({
    exit_code: 0, timed_out: false, stdout: lines.join('\n') + '\n', stderr: '', duration_ms: 42, ...extra
});
const allPassed = () => run(fixture().cases.map((c) => line('RESULT', { id: c.id, passed: true })));

describe('reading the driver protocol', () => {
    test('keeps only RESULT and LOAD_ERROR lines that parse, first occurrence wins', () => {
        const stdout = [
            'hello from the candidate',
            line('RESULT', { id: 'a', passed: true }),
            'RESULT not json',
            line('RESULT', { id: 'a', passed: false }),
            line('RESULT', { id: 'b', passed: false, error: 'AssertionError: x', actual: '3' }),
            'RESULT {"passed": true}',
            '   ' + line('RESULT', { id: 'c', passed: 'yes' }),
            'RESULT [1,2]'
        ].join('\n');
        const { results, loadError } = parseProtocol(stdout);
        expect(loadError).toBeNull();
        expect([...results.keys()]).toEqual(['a', 'b', 'c']);
        expect(results.get('a').passed).toBe(true);
        expect(results.get('b')).toEqual({ id: 'b', passed: false, error: 'AssertionError: x', actual: '3' });
        // Only a literal true is a pass.
        expect(results.get('c').passed).toBe(false);
    });

    test('reports a load error and tolerates empty or missing output', () => {
        expect(parseProtocol(line('LOAD_ERROR', { error: 'SyntaxError' })).loadError).toEqual({ error: 'SyntaxError' });
        expect(parseProtocol('').results.size).toBe(0);
        expect(parseProtocol(null).results.size).toBe(0);
        expect(parseProtocol(undefined).loadError).toBeNull();
    });
});

describe('scoring an execution', () => {
    test('all cases passed is 10', () => {
        const execution = scoreExecution({ fixture: fixture(), extraction: ok, run: allPassed() });
        expect(execution).toMatchObject({
            scored: true, status: 'passed', correctness: 10, passed: 6, failed: 0, total: 6,
            passed_weight: 5, total_weight: 5, exit_code: 0, duration_ms: 42, stderr_excerpt: null
        });
        expect(execution.cases.every((c) => c.passed)).toBe(true);
    });

    test('one failing case is wrong, and partial credit stays below the cap', () => {
        const lines = fixture().cases.map((c) => line('RESULT', { id: c.id, passed: c.id !== 'n=9' }));
        const execution = scoreExecution({
            fixture: fixture(), extraction: ok, run: run(lines, { exit_code: 1, stderr: 'trace' })
        });
        expect(execution.status).toBe('failed');
        expect(execution.passed).toBe(5);
        // 4/5 of the weight passed: 0.8, inside the wrong tier, never near a right answer.
        expect(execution.correctness).toBe(0.8);
        expect(execution.correctness).toBeLessThan(EXECUTABLE_PARTIAL_CAP);
        expect(execution.stderr_excerpt).toBe('trace');
        expect(execution.cases.find((c) => c.id === 'n=9').passed).toBe(false);
    });

    test('partial credit below the cap orders wrong answers by weight', () => {
        // Only the two half-weight edge cases pass: 1/5 = 0.2.
        const lines = fixture().cases.map((c) => line('RESULT', { id: c.id, passed: c.weight === 0.5 }));
        const execution = scoreExecution({ fixture: fixture(), extraction: ok, run: run(lines, { exit_code: 1 }) });
        expect(execution.correctness).toBe(0.2);
        expect(execution.passed_weight).toBe(1);
    });

    test('a case the driver never reported counts as failed', () => {
        const lines = fixture().cases.slice(0, 3).map((c) => line('RESULT', { id: c.id, passed: true }));
        const execution = scoreExecution({ fixture: fixture(), extraction: ok, run: run(lines) });
        expect(execution.status).toBe('failed');
        expect(execution.passed).toBe(3);
        expect(execution.cases.find((c) => c.id === 'n=7919')).toEqual({
            id: 'n=7919', passed: false, error: 'not reported by the driver'
        });
    });

    test('ignores reported ids the fixture does not declare', () => {
        const lines = [...allPassed().stdout.split('\n'), line('RESULT', { id: 'forged', passed: true })];
        const execution = scoreExecution({ fixture: fixture(), extraction: ok, run: run(lines) });
        expect(execution.total).toBe(6);
        expect(execution.status).toBe('passed');
    });

    test('no code, load errors, crashes, timeouts and runaway output score 0 and say why', () => {
        const base = { fixture: fixture(), extraction: ok };
        const noCode = scoreExecution({ ...base, extraction: { status: 'no_code', code: '' }, run: allPassed() });
        expect(noCode).toMatchObject({ scored: true, status: 'no_code', correctness: 0, total: 6, failed: 6 });

        const load = scoreExecution({ ...base, run: run([line('LOAD_ERROR', { error: 'SyntaxError: bad' })], { exit_code: 3 }) });
        expect(load).toMatchObject({ status: 'compile_error', correctness: 0, detail: 'SyntaxError: bad', exit_code: 3 });

        const crash = scoreExecution({ ...base, run: run(['Traceback'], { exit_code: 1, stderr: 'MemoryError' }) });
        expect(crash).toMatchObject({ status: 'runtime_error', correctness: 0, stderr_excerpt: 'MemoryError' });

        const timeout = scoreExecution({ ...base, run: run([], { timed_out: true, exit_code: null }) });
        expect(timeout).toMatchObject({ status: 'timeout', correctness: 0, detail: 'Job exceeded 5000 ms' });

        const flood = scoreExecution({ ...base, run: run([], { stdout_truncated: true }) });
        expect(flood).toMatchObject({ status: 'output_limit', correctness: 0 });
    });

    test('a runner that could not run is not a score', () => {
        for (const run of [null, undefined, { status: 'runner_unavailable', error: 'sidecar down' }]) {
            const execution = scoreExecution({ fixture: fixture(), extraction: ok, run });
            expect(execution.scored).toBe(false);
            expect(execution.status).toBe('runner_unavailable');
            expect(execution.correctness).toBeNull();
        }
        expect(scoreExecution({ fixture: fixture(), extraction: ok, run: { status: 'runner_unavailable', error: 'sidecar down' } }).detail)
            .toBe('sidecar down');
    });

    test('a test_file fixture without declared cases is judged by its exit code, or by what it reports', () => {
        const testFile = { language: 'python', harness: 'test_file', files: { 'test_main.py': 'x' } };
        expect(scoreExecution({ fixture: testFile, extraction: ok, run: run([]) }))
            .toMatchObject({ status: 'passed', correctness: 10, total: 0 });
        expect(scoreExecution({ fixture: testFile, extraction: ok, run: run([], { exit_code: 1 }) }))
            .toMatchObject({ status: 'failed', correctness: 0, detail: 'Test file exited with 1' });

        const reported = run([line('RESULT', { id: 'alpha', passed: true }), line('RESULT', { id: 'beta', passed: false })], { exit_code: 1 });
        const execution = scoreExecution({ fixture: testFile, extraction: ok, run: reported });
        expect(execution).toMatchObject({ status: 'failed', total: 2, passed: 1, correctness: 0.5 });
    });

    test('a test_file fixture with declared cases uses their weights and its exit code as fallback', () => {
        const testFile = {
            language: 'python',
            harness: 'test_file',
            files: { 'test_main.py': 'x' },
            cases: [{ id: 'alpha' }, { id: 'beta', weight: 3 }]
        };
        const silentPass = scoreExecution({ fixture: testFile, extraction: ok, run: run([]) });
        expect(silentPass).toMatchObject({ status: 'passed', correctness: 10, total: 2, passed: 2, passed_weight: 4 });

        const partial = run([line('RESULT', { id: 'beta', passed: true })], { exit_code: 1 });
        const execution = scoreExecution({ fixture: testFile, extraction: ok, run: partial });
        expect(execution).toMatchObject({ status: 'failed', passed_weight: 3, total_weight: 4, correctness: 0.8 });
    });
});

describe('explaining and shaping the result', () => {
    test('writes one sentence per outcome', () => {
        const passed = scoreExecution({ fixture: fixture(), extraction: ok, run: allPassed() });
        expect(explainExecution(passed)).toBe('Executed 6 reference tests: all passed');

        const lines = fixture().cases.map((c) => line('RESULT', { id: c.id, passed: c.id === 'n=0' }));
        const failed = scoreExecution({ fixture: fixture(), extraction: ok, run: run(lines, { exit_code: 1 }) });
        expect(explainExecution(failed))
            .toBe('Executed 6 reference tests: 1 passed, 5 failed (n=1, n=2, n=9, n=97, n=7919). Partial credit is capped at 1');

        const load = scoreExecution({
            fixture: fixture(), extraction: ok,
            run: run([line('LOAD_ERROR', { error: 'Traceback\n  File x\nSyntaxError: invalid syntax' })], { exit_code: 3 })
        });
        expect(explainExecution(load)).toBe('The program failed to load: SyntaxError: invalid syntax');
    });

    test('shapes a scored execution like a deterministic result, and an unscored one as a review', () => {
        const passed = executionQualityResult(scoreExecution({ fixture: fixture(), extraction: ok, run: allPassed() }));
        expect(passed).toMatchObject({
            quality_score: 10,
            scoring_method: 'executable',
            scoring_type: 'coding',
            correctness_source: 'executable',
            breakdown: { overall: 10, correctness: 10 },
            judge_confidence: 1,
            needs_review: false,
            review_reason: null
        });
        expect(passed.execution_result.status).toBe('passed');

        const unscored = executionQualityResult(scoreExecution({ fixture: fixture(), extraction: ok, run: null }));
        expect(unscored).toMatchObject({
            quality_score: null, needs_review: true, judge_confidence: null, breakdown: {}
        });
        expect(unscored.review_reason).toBe('Not scored: Code runner unavailable');
    });
});
