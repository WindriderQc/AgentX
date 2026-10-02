'use strict';

/**
 * Qualification card of one benchmark result.
 *
 * A score mixes five questions that fail independently. The card answers each
 * one separately, so a reader can tell a model that answered badly from a
 * grader that cannot be trusted, a broken environment or missing proof:
 *
 * - product_behavior: did the run produce an answer at all;
 * - model_quality: the raw score, always shown, never invented;
 * - grader: whether the grader of record is qualified for this exact judge
 *   and scorer version, and whether it held up on this answer;
 * - environment: whether infrastructure failed, in which case the model was
 *   not measured (no quality verdict, not a zero);
 * - evidence: which proof the result lacks.
 *
 * `authoritative` is true only when every section allows it. The card is a
 * read projection: it grants no retry, rejudge or ranking by itself.
 */

const { describeFailure } = require('../../../../shared/failureDiagnostics');

const CARD_SCHEMA = 'agentx.benchmark-qualification-card/v1';

const DETERMINISTIC_METHODS = new Set([
    'deterministic', 'deterministic_fallback', 'quick', 'pattern', 'empty_response',
    'response_contract_failed', 'executable', 'exec_failed'
]);
const GRADER_FAILURE_METHODS = new Set(['llm_failed', 'authority_invalidated']);
const ENVIRONMENT_CLASSIFICATIONS = new Map([
    ['infra', 'infrastructure_error'],
    ['infrastructure_error', 'infrastructure_error'],
    ['provider_error', 'provider_error'],
    ['timeout', 'timeout'],
    ['cancelled', 'cancelled'],
    ['harness_error', 'harness_error'],
    ['adapter_error', 'adapter_error']
]);

function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Aggregation counters for leaderboard rows: rows an LLM judge may have
 * graded (fail closed: any method outside the deterministic set, a missing
 * method included) and, among them, rows that do not record which judge.
 */
function judgeIdentityCounters() {
    const judged = {
        $or: [
            { $ne: [{ $ifNull: ['$subjective_score', null] }, null] },
            { $not: [{ $in: [{ $toLower: { $ifNull: ['$scoring_method', ''] } }, [...DETERMINISTIC_METHODS]] }] }
        ]
    };
    const blank = field => ({ $in: [{ $ifNull: [field, ''] }, ['']] });
    return {
        judgedRows: { $sum: { $cond: [judged, 1, 0] } },
        judgeIdentityMissingRows: {
            $sum: { $cond: [{ $and: [judged, { $or: [blank('$judge_model'), blank('$judge_host')] }] }, 1, 0] }
        }
    };
}

/** Whether an LLM judge contributed to the stored grade. */
function judgeUsed(result = {}) {
    const method = String(result.scoring_method || '').toLowerCase();
    if (finiteOrNull(result.subjective_score) !== null) return true;
    if (GRADER_FAILURE_METHODS.has(method)) return true;
    if (DETERMINISTIC_METHODS.has(method)) return false;
    return Boolean(method) && method !== 'pending' && method !== 'skipped';
}

function environmentSection(result) {
    if (result.success === true && result.infra_error !== true) {
        return { status: 'ok', diagnostic: null };
    }
    const classification = String(result.failure_classification || result.error_type || '').toLowerCase();
    const environmentClass = ENVIRONMENT_CLASSIFICATIONS.get(classification);
    if (result.infra_error === true || environmentClass) {
        return {
            status: 'failed',
            diagnostic: describeFailure(null, { classification: environmentClass || 'infrastructure_error' })
        };
    }
    if (result.success === false && (!classification || classification === 'unknown')) {
        return { status: 'unknown', diagnostic: describeFailure(null, { classification: 'unknown' }) };
    }
    return { status: 'ok', diagnostic: null };
}

function productSection(result, environment) {
    if (environment.status === 'failed') {
        return { status: 'not_measured', detail: 'environment_failure' };
    }
    if (result.success === true) {
        const empty = !String(result.response || '').trim();
        return empty
            ? { status: 'failed', detail: 'empty_response' }
            : { status: 'completed', detail: null };
    }
    if (environment.status === 'unknown') return { status: 'unknown', detail: 'failure_cause_unknown' };
    return { status: 'failed', detail: result.failure_classification || result.error_type || 'model_error' };
}

function qualitySection(result, product) {
    const raw = {
        quality_score: finiteOrNull(result.quality_score),
        composite_score: finiteOrNull(result.composite_score),
        deterministic_score: finiteOrNull(result.deterministic_score),
        subjective_score: finiteOrNull(result.subjective_score),
        judge_quality_score: finiteOrNull(result.judge_quality_score),
        human_score: finiteOrNull(result.human_score)
    };
    const base = {
        ...raw,
        scoring_method: result.scoring_method || null,
        correctness_source: result.correctness_source || null
    };
    if (product.status === 'not_measured' || product.status === 'unknown') {
        return { status: 'not_measured', ...base };
    }
    if (raw.quality_score === null) {
        return { status: result.success === true ? 'pending' : 'not_scored', ...base };
    }
    return { status: 'scored', ...base };
}

function graderSection(result, graderQualification, used) {
    if (!used) {
        return { status: 'not_applicable', qualification: graderQualification || null, causes: [], result_checks: [] };
    }
    const qualification = graderQualification || { status: 'unknown', causes: ['judge_identity_missing'], judges: [] };
    const resultChecks = [];
    const method = String(result.scoring_method || '').toLowerCase();
    if (GRADER_FAILURE_METHODS.has(method)) resultChecks.push(`grader_${method}`);
    if (result.attention_check?.passed === false) resultChecks.push('attention_check_failed');
    if (result.needs_review === true && !result.human_review_status) resultChecks.push('needs_review');
    const causes = [...new Set([...(qualification.causes || []), ...resultChecks])];
    let status = qualification.status || 'unknown';
    if (status === 'qualified' && resultChecks.length) status = 'unreliable_on_result';
    return {
        status,
        judge: { model: result.judge_model || null, host: result.judge_host || null },
        scorer_version: result.scorer_version || null,
        attention_check: result.attention_check || null,
        needs_review: result.needs_review === true,
        review_reason: result.review_reason || null,
        causes,
        result_checks: resultChecks,
        qualification
    };
}

function evidenceSection(result, used, environment) {
    // A run the environment broke has no answer to prove; it is not "complete".
    if (environment.status === 'failed') return { status: 'not_evaluated', missing: [] };
    const missing = [];
    if (result.success === true && !String(result.response || '').trim()) missing.push('response');
    if (!result.scorer_version) missing.push('scorer_version');
    if (used && (!result.judge_model || !result.judge_host)) missing.push('judge_identity');
    if (result.correctness_source === 'executable' && !result.execution_result) missing.push('execution_result');
    if (result.execution_target?.executionKind === 'harness'
        && result.execution_receipt?.finalState !== 'succeeded') {
        missing.push('execution_receipt');
    }
    return { status: missing.length ? 'missing' : 'complete', missing };
}

/**
 * @param {object} result - a lean BenchmarkResult
 * @param {object|null} graderQualification - from judgeQualification.assessResult
 */
function buildResultQualificationCard(result = {}, graderQualification = null) {
    const used = judgeUsed(result);
    const environment = environmentSection(result);
    const product = productSection(result, environment);
    const quality = qualitySection(result, product);
    const grader = graderSection(result, graderQualification, used);
    const evidence = evidenceSection(result, used, environment);

    const reasons = [];
    if (environment.status === 'failed') reasons.push('environment_failed');
    if (environment.status === 'unknown') reasons.push('environment_unknown');
    if (product.status === 'unknown') reasons.push('product_behavior_unknown');
    if (quality.status === 'pending') reasons.push('grade_missing');
    if (!['qualified', 'not_applicable'].includes(grader.status)) {
        reasons.push(`grader_${grader.status}`);
    }
    if (evidence.status === 'missing') reasons.push('evidence_missing');
    if (result.excluded_from_leaderboard === true) reasons.push('excluded_from_leaderboard');

    return {
        schema: CARD_SCHEMA,
        authoritative: reasons.length === 0,
        reasons: [...new Set(reasons)],
        product_behavior: product,
        model_quality: quality,
        grader,
        environment,
        evidence
    };
}

module.exports = {
    CARD_SCHEMA,
    buildResultQualificationCard,
    judgeIdentityCounters,
    judgeUsed
};
