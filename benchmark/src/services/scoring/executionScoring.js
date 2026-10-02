'use strict';

/**
 * Executable correctness inside the scoring pipeline.
 *
 * A coding prompt that carries `reference_tests` is scored by running the
 * candidate's program: extraction, one sandbox job, then the correctness
 * rule from `executionScore`. The judge keeps clarity, efficiency and
 * robustness; it is never asked whether the code works, because the tests
 * just answered that.
 *
 * Three outcomes reach `scoreResponse`:
 *   - scored: the correctness dimension is supplied to the decomposed judge
 *     (`_suppliedDimensions`), and the primary-dimension cap bounds the
 *     overall by executed correctness;
 *   - scored, but the judge was skipped or failed: execution alone decides,
 *     `scoring_method: 'executable'`;
 *   - not scored (runner unavailable): quality is null and the row asks for
 *     review. Infrastructure is never a candidate penalty, and the judge is
 *     not asked to guess instead.
 */

const logger = require('../../../config/logger');
const { hasReferenceTests, normalizeReferenceTests } = require('./referenceTests');
const { extractCode } = require('./codeExtractor');
const { buildExecutionJob } = require('./executionHarness');
const { scoreExecution, executionQualityResult, explainExecution } = require('./executionScore');
const { getCodeRunner } = require('./codeRunnerClient');
const { DEFAULT_SCORING_CATEGORY, normalizeScoringCategory } = require('./scoringConfigs');

const EXECUTION_CATEGORY = 'coding';

/**
 * Whether execution scoring applies to a prompt: the coding category and a
 * usable fixture. A malformed fixture reads as absent.
 */
function executionApplies(prompt) {
    if (!prompt || !hasReferenceTests(prompt)) return false;
    const category = normalizeScoringCategory(prompt.scoring_type || prompt.category, DEFAULT_SCORING_CATEGORY);
    return category === EXECUTION_CATEGORY;
}

/**
 * Run the candidate against the prompt's reference tests.
 *
 * @returns {Promise<null|{ execution: object, extraction: object, runner: object|null }>}
 *   null when execution scoring does not apply to this prompt.
 */
async function scoreByExecution(response, prompt, { runner } = {}) {
    if (!executionApplies(prompt)) return null;

    const fixture = normalizeReferenceTests(prompt.reference_tests);
    const extraction = extractCode(response, { language: fixture.language, entry: fixture.entry || null });
    const codeExtraction = { status: extraction.status, source: extraction.source, blocks: extraction.blocks };
    const activeRunner = runner || getCodeRunner();

    let run = null;
    if (extraction.status === 'ok') {
        const job = buildExecutionJob({ fixture, code: extraction.code });
        run = await activeRunner.runJob(job);
    }

    const execution = scoreExecution({ fixture, extraction, run });
    logger.info('Executable correctness', {
        prompt: prompt.name || prompt.prompt_name || 'unknown',
        status: execution.status,
        scored: execution.scored,
        correctness: execution.correctness,
        passed: execution.passed,
        total: execution.total,
        extraction: codeExtraction.source
    });

    return {
        execution,
        extraction: codeExtraction,
        runner: typeof activeRunner.describe === 'function' ? activeRunner.describe() : null
    };
}

/**
 * The fields every execution-scored row carries, whether or not a judge ran.
 */
function executionFields(executed) {
    return {
        execution_result: executed.execution,
        code_extraction: executed.extraction,
        correctness_source: 'executable'
    };
}

/**
 * A result whose quality rests on execution alone: the judge was skipped, or
 * it failed and its failure is recorded for review rather than guessed at.
 */
function executableOnlyResult(executed, { scoringTimeMs = null, judgeFailure = null } = {}) {
    const base = executionQualityResult(executed.execution, { category: EXECUTION_CATEGORY });
    const failureNote = judgeFailure ? `judge unavailable for the secondary dimensions: ${judgeFailure}` : null;
    return {
        ...base,
        ...executionFields(executed),
        explanation: failureNote ? `${base.explanation}. ${failureNote}` : base.explanation,
        needs_review: base.needs_review || !!judgeFailure,
        review_reason: [base.review_reason, failureNote].filter(Boolean).join('; ') || null,
        judge_prompt: null,
        judge_model: null,
        scoring_time_ms: scoringTimeMs
    };
}

/**
 * The row for a candidate the runner could not run: no score, explicit nulls
 * on every axis, and a review reason that names the infrastructure.
 */
function unscoredExecutionResult(executed, { scoringTimeMs = null } = {}) {
    const explanation = explainExecution(executed.execution);
    return {
        quality_score: null,
        scoring_method: 'executable',
        scoring_type: EXECUTION_CATEGORY,
        ...executionFields(executed),
        explanation,
        breakdown: null,
        judge_prompt: null,
        judge_model: null,
        judge_confidence: null,
        needs_review: true,
        review_reason: explanation,
        scoring_time_ms: scoringTimeMs,
        format_score: null,
        format_compliant: null,
        semantic_score: null,
        deterministic_score: null,
        deterministic_pass: null,
        subjective_score: null,
        composite_formula: 'executable_unavailable'
    };
}

module.exports = {
    EXECUTION_CATEGORY,
    executionApplies,
    scoreByExecution,
    executionFields,
    executableOnlyResult,
    unscoredExecutionResult
};
