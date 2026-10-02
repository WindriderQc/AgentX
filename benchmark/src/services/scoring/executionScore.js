'use strict';

/**
 * Turn what the sandbox reported into the coding `correctness` score.
 *
 * The rule, from #18: every reference case passes, or the answer is wrong.
 *   correctness = all passed ? 10 : passed weight / total weight
 * Partial credit exists only to order wrong answers among themselves. It stays
 * below 1, so with the primary-dimension cap (overall <= correctness + 1) a
 * wrong program lands in the rubric's wrong tier (0-2) whatever the judge says
 * about style, and fixture cases that a do-nothing program happens to pass
 * (an empty string, a palindrome) cannot lift it out of that tier.
 *
 * No code, a program that fails to load, a crash, a timeout and a runaway
 * output all score 0 and say why. A runner that could not run the job is not
 * a property of the candidate: it is not scored at all, and the row asks for
 * review instead of carrying a penalty.
 *
 * Pure: reads the run as data. Nothing in stdout is ever executed or treated
 * as an instruction; only `RESULT` and `LOAD_ERROR` lines that parse as JSON
 * are read, and everything else is ignored.
 */

const { normalizeReferenceTests } = require('./referenceTests');
const { PROTOCOL } = require('./executionHarness');

const EXECUTABLE_PARTIAL_CAP = 1;
const EXECUTION_STATUSES = Object.freeze([
    'passed', 'failed', 'no_code', 'compile_error', 'runtime_error',
    'timeout', 'output_limit', 'runner_unavailable'
]);
const MAX_PROTOCOL_LINES = 2000;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function round1(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Read the protocol lines out of the run's stdout. Everything else is noise.
 */
function parseProtocol(stdout, protocol = PROTOCOL) {
    const results = new Map();
    let loadError = null;
    if (typeof stdout !== 'string' || stdout === '') return { results, loadError };

    const lines = stdout.split(/\r?\n/).slice(0, MAX_PROTOCOL_LINES);
    const resultPrefix = protocol.result_tag + ' ';
    const loadPrefix = protocol.load_error_tag + ' ';

    for (const rawLine of lines) {
        const line = rawLine.trim();
        let tag = null;
        if (line.startsWith(resultPrefix)) tag = 'result';
        else if (line.startsWith(loadPrefix)) tag = 'load_error';
        if (!tag) continue;

        let payload;
        try {
            payload = JSON.parse(line.slice(tag === 'result' ? resultPrefix.length : loadPrefix.length));
        } catch (error) {
            continue;
        }
        if (!isPlainObject(payload)) continue;

        if (tag === 'load_error') {
            if (!loadError) loadError = { error: String(payload.error || 'load error').slice(0, 2000) };
            continue;
        }
        if (typeof payload.id !== 'string' || results.has(payload.id)) continue;
        results.set(payload.id, {
            id: payload.id,
            passed: payload.passed === true,
            error: payload.error != null ? String(payload.error).slice(0, 500) : null,
            actual: payload.actual != null ? String(payload.actual).slice(0, 500) : null
        });
    }
    return { results, loadError };
}

function excerpt(text, length = 500) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    return text.trim().slice(-length);
}

function baseResult(fixture, status, extra = {}) {
    const declared = fixture.cases.map((c) => ({ id: c.id, weight: c.weight }));
    return {
        scored: true,
        status,
        correctness: 0,
        passed: 0,
        failed: declared.length,
        total: declared.length,
        passed_weight: 0,
        total_weight: declared.reduce((sum, c) => sum + c.weight, 0),
        cases: declared.map((c) => ({ id: c.id, passed: false, error: null })),
        exit_code: null,
        duration_ms: null,
        stderr_excerpt: null,
        detail: null,
        ...extra
    };
}

function scoreCases(fixture, reported, run) {
    // Declared cases are the yardstick; a case the driver never reported is a
    // failure, not a gap. A test_file fixture may declare none and let its own
    // driver name them, in which case the reported ids are the yardstick.
    const declared = fixture.cases.length > 0
        ? fixture.cases.map((c) => ({ id: c.id, weight: c.weight }))
        : Array.from(reported.keys(), (id) => ({ id, weight: 1 }));

    const cases = declared.map((c) => {
        const outcome = reported.get(c.id);
        if (!outcome) return { id: c.id, passed: false, error: 'not reported by the driver' };
        return { id: c.id, passed: outcome.passed, error: outcome.passed ? null : (outcome.error || null), actual: outcome.actual };
    });

    const totalWeight = declared.reduce((sum, c) => sum + c.weight, 0);
    const passedWeight = declared.reduce((sum, c, i) => sum + (cases[i].passed ? c.weight : 0), 0);
    const passedCount = cases.filter((c) => c.passed).length;
    const allPassed = cases.length > 0 && passedCount === cases.length;
    const correctness = allPassed
        ? 10
        : (totalWeight > 0 ? round1((EXECUTABLE_PARTIAL_CAP * passedWeight) / totalWeight) : 0);

    return {
        scored: true,
        status: allPassed ? 'passed' : 'failed',
        correctness,
        passed: passedCount,
        failed: cases.length - passedCount,
        total: cases.length,
        passed_weight: passedWeight,
        total_weight: totalWeight,
        cases,
        exit_code: Number.isInteger(run.exit_code) ? run.exit_code : null,
        duration_ms: Number.isFinite(run.duration_ms) ? run.duration_ms : null,
        stderr_excerpt: allPassed ? null : excerpt(run.stderr),
        detail: null
    };
}

/**
 * Score one candidate from its extraction and its sandbox run.
 *
 * @param {object} input
 * @param {object} input.fixture the prompt's `reference_tests`
 * @param {{ status: 'ok'|'no_code' }} input.extraction from `codeExtractor`
 * @param {object|null} input.run what the runner returned:
 *   `{ exit_code, timed_out, stdout, stderr, duration_ms, stdout_truncated }`,
 *   or `{ status: 'runner_unavailable', error }`, or null when no run happened
 */
function scoreExecution({ fixture: rawFixture, extraction, run }) {
    const fixture = normalizeReferenceTests(rawFixture);

    if (!extraction || extraction.status !== 'ok') {
        return baseResult(fixture, 'no_code', { detail: 'No program found in the response' });
    }

    if (!run || run.status === 'runner_unavailable') {
        return {
            ...baseResult(fixture, 'runner_unavailable'),
            scored: false,
            correctness: null,
            detail: (run && run.error) ? String(run.error).slice(0, 500) : 'Code runner unavailable'
        };
    }

    const runMeta = {
        exit_code: Number.isInteger(run.exit_code) ? run.exit_code : null,
        duration_ms: Number.isFinite(run.duration_ms) ? run.duration_ms : null,
        stderr_excerpt: excerpt(run.stderr)
    };

    if (run.timed_out === true) {
        return baseResult(fixture, 'timeout', { ...runMeta, detail: `Job exceeded ${fixture.timeout_ms} ms` });
    }
    if (run.stdout_truncated === true) {
        return baseResult(fixture, 'output_limit', { ...runMeta, detail: 'Output exceeded the runner cap' });
    }

    const { results, loadError } = parseProtocol(run.stdout, PROTOCOL);
    if (loadError) {
        return baseResult(fixture, 'compile_error', { ...runMeta, detail: loadError.error });
    }

    if (results.size === 0) {
        if (fixture.harness === 'test_file') {
            // The fixture's own driver reports nothing per case: its exit code
            // is the verdict.
            const passed = runMeta.exit_code === 0;
            const declared = fixture.cases.map((c) => ({ id: c.id, weight: c.weight }));
            return {
                ...baseResult(fixture, passed ? 'passed' : 'failed', runMeta),
                correctness: passed ? 10 : 0,
                passed: passed ? declared.length : 0,
                failed: passed ? 0 : declared.length,
                passed_weight: passed ? declared.reduce((s, c) => s + c.weight, 0) : 0,
                cases: declared.map((c) => ({ id: c.id, passed, error: passed ? null : 'test file exited non-zero' })),
                stderr_excerpt: passed ? null : runMeta.stderr_excerpt,
                detail: passed ? null : `Test file exited with ${runMeta.exit_code}`
            };
        }
        return baseResult(fixture, 'runtime_error', {
            ...runMeta,
            detail: `Driver reported no case (exit ${runMeta.exit_code === null ? 'unknown' : runMeta.exit_code})`
        });
    }

    return scoreCases(fixture, results, run);
}

function summarizeFailures(execution) {
    const failed = execution.cases.filter((c) => !c.passed).map((c) => c.id);
    if (failed.length === 0) return '';
    const shown = failed.slice(0, 5).join(', ');
    return failed.length > 5 ? `${shown} and ${failed.length - 5} more` : shown;
}

/**
 * One sentence a reviewer can read on the result row.
 */
function explainExecution(execution) {
    switch (execution.status) {
        case 'passed':
            return execution.total > 0
                ? `Executed ${execution.total} reference test${execution.total === 1 ? '' : 's'}: all passed`
                : 'Test file passed';
        case 'failed':
            return `Executed ${execution.total} reference test${execution.total === 1 ? '' : 's'}: `
                + `${execution.passed} passed, ${execution.failed} failed (${summarizeFailures(execution)}). `
                + `Partial credit is capped at ${EXECUTABLE_PARTIAL_CAP}`;
        case 'no_code':
            return 'No program found in the response';
        case 'compile_error':
            return `The program failed to load: ${(execution.detail || '').split('\n').filter(Boolean).pop() || 'unknown error'}`;
        case 'runtime_error':
            return `The program did not run to completion: ${execution.detail || 'unknown error'}`;
        case 'timeout':
            return execution.detail || 'The program timed out';
        case 'output_limit':
            return 'The program produced more output than the runner allows';
        case 'runner_unavailable':
            return `Not scored: ${execution.detail || 'code runner unavailable'}`;
        default:
            return `Execution status ${execution.status}`;
    }
}

/**
 * The scorer-shaped result for a row whose quality rests on execution alone
 * (judge skipped or failed). Same shape as a deterministic result, plus the
 * execution evidence, so downstream aggregation needs no special case.
 */
function executionQualityResult(execution, { category = 'coding' } = {}) {
    const scored = execution.scored === true && Number.isFinite(execution.correctness);
    return {
        quality_score: scored ? execution.correctness : null,
        scoring_method: 'executable',
        scoring_type: category,
        correctness_source: 'executable',
        execution_result: execution,
        explanation: explainExecution(execution),
        breakdown: scored ? { overall: execution.correctness, correctness: execution.correctness } : {},
        judge_confidence: scored ? 1.0 : null,
        needs_review: !scored,
        review_reason: scored ? null : explainExecution(execution)
    };
}

module.exports = {
    EXECUTABLE_PARTIAL_CAP,
    EXECUTION_STATUSES,
    parseProtocol,
    scoreExecution,
    explainExecution,
    executionQualityResult
};
