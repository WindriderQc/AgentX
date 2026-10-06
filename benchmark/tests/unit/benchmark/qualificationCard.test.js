'use strict';

const { buildResultQualificationCard, judgeUsed } = require('../../../src/services/benchmark/qualificationCard');
const { combineJudges, assessJudge } = require('../../../src/services/benchmark/judgeQualification');

const JUDGE = { model: 'qwen3.8:27b-mtp-q8_0', host: 'http://judge-a:11434' };
const { buildJudgeQualificationContract } = require('../../../src/services/benchmark/judgeQualificationContract');
JUDGE.qualification_contract = buildJudgeQualificationContract({ ...JUDGE, seed: 7, num_ctx: 65536, num_predict: 800,
    temperature: 0.1, max_retries: 2, timeout: 60000, execution_contract: {
        schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 65536,
        artifact: { ...JUDGE, digest: 'digest-a', runtimeFingerprint: 'runtime-a' } } });
const REF = 'a'.repeat(64);

function record(overrides = {}) {
    return {
        _id: '507f1f77bcf86cd799439011',
        qualification_contract: JUDGE.qualification_contract,
        judge_model: JUDGE.model,
        judge_host: JUDGE.host,
        scorer_version: '2.17.0',
        reference_fingerprint: REF,
        qualified: true,
        failed: [],
        metrics: { mae: 0.79, ordering_ties_half: 89.4 },
        recorded_at: new Date('2026-09-23T05:15:00Z'),
        ...overrides
    };
}

function grader(records) {
    return combineJudges([assessJudge({ ...JUDGE, scorerVersion: '2.17.0', records, referenceFingerprint: REF })], { scorerVersion: '2.17.0' });
}

function result(overrides = {}) {
    return {
        success: true,
        response: 'def is_prime(n): ...',
        quality_score: 9.4,
        composite_score: 9.1,
        subjective_score: 9,
        scoring_method: 'decomposed',
        correctness_source: 'executable',
        execution_result: { passed: 5, total: 5 },
        judge_model: JUDGE.model,
        judge_host: JUDGE.host,
        scorer_version: '2.17.0',
        attention_check: { passed: true },
        needs_review: false,
        ...overrides
    };
}

describe('result qualification card', () => {
    test('known correct case with a qualified grader is authoritative', () => {
        const card = buildResultQualificationCard(result(), grader([record()]));
        expect(card).toMatchObject({
            authoritative: true,
            reasons: [],
            product_behavior: { status: 'completed' },
            model_quality: { status: 'scored', quality_score: 9.4, correctness_source: 'executable' },
            grader: { status: 'qualified' },
            environment: { status: 'ok' },
            evidence: { status: 'complete', missing: [] }
        });
    });

    test('a wrong but well presented answer keeps its low score apart from completion', () => {
        // Executed tests fail; the judge still liked the style. The product
        // behaved (an answer exists), the quality is low, and it is authoritative.
        const wrong = result({ quality_score: 1.2, composite_score: 1.1, subjective_score: 8.8,
            execution_result: { passed: 0, total: 5 } });
        const card = buildResultQualificationCard(wrong, grader([record()]));
        expect(card.authoritative).toBe(true);
        expect(card.product_behavior.status).toBe('completed');
        expect(card.model_quality).toMatchObject({ status: 'scored', quality_score: 1.2, subjective_score: 8.8 });

        // The same answer graded by a judge that failed calibration is not
        // authoritative, but its raw score and the causes stay readable.
        const failedGrader = grader([record({ qualified: false, failed: ['ordering', 'mae'] })]);
        const provisional = buildResultQualificationCard(wrong, failedGrader);
        expect(provisional.authoritative).toBe(false);
        expect(provisional.reasons).toContain('grader_unqualified');
        expect(provisional.model_quality.quality_score).toBe(1.2);
        expect(provisional.grader.causes).toEqual(['calibration_failed_ordering', 'calibration_failed_mae']);
    });

    test('an attention failure on this answer makes a qualified grader unreliable here', () => {
        const card = buildResultQualificationCard(
            result({ attention_check: { passed: false }, needs_review: true }),
            grader([record()])
        );
        expect(card.authoritative).toBe(false);
        expect(card.grader.status).toBe('unreliable_on_result');
        expect(card.grader.causes).toEqual(expect.arrayContaining(['attention_check_failed', 'needs_review']));
        expect(card.reasons).toContain('grader_unreliable_on_result');
        expect(card.model_quality.quality_score).toBe(9.4);
    });

    test('missing proof is named and blocks authority', () => {
        const card = buildResultQualificationCard(
            result({ judge_model: null, judge_host: null, scorer_version: null, execution_result: null }),
            combineJudges([assessJudge({ host: null, model: null, scorerVersion: null, records: [] })])
        );
        expect(card.authoritative).toBe(false);
        expect(card.evidence).toEqual({ status: 'missing', missing: ['scorer_version', 'judge_identity', 'execution_result'] });
        expect(card.grader.status).toBe('unqualified');
        expect(card.grader.causes).toContain('judge_identity_missing');
        expect(card.reasons).toEqual(expect.arrayContaining(['grader_unqualified', 'evidence_missing']));
    });

    test('an environment failure is not a model verdict', () => {
        const card = buildResultQualificationCard({
            success: false,
            response: '',
            quality_score: null,
            scoring_method: 'exec_failed',
            infra_error: true,
            failure_classification: 'infra',
            error_type: 'infra',
            judge_model: JUDGE.model,
            judge_host: JUDGE.host,
            scorer_version: null
        }, null);
        expect(card.authoritative).toBe(false);
        expect(card.environment.status).toBe('failed');
        expect(card.environment.diagnostic).toMatchObject({ classification: 'infrastructure_error',
            recovery: { authorization: 'not_granted' } });
        expect(card.product_behavior).toEqual({ status: 'not_measured', detail: 'environment_failure' });
        expect(card.model_quality.status).toBe('not_measured');
        expect(card.model_quality.quality_score).toBeNull();
        expect(card.evidence).toEqual({ status: 'not_evaluated', missing: [] });
        // No LLM judge ran, so the grader is not blamed.
        expect(card.grader.status).toBe('not_applicable');
        expect(card.reasons).toEqual(['environment_failed']);
    });

    test('a model failure stays a model failure', () => {
        const card = buildResultQualificationCard({
            success: false, response: '', quality_score: null, scoring_method: 'exec_failed',
            infra_error: false, failure_classification: 'model', error_type: 'model',
            judge_model: JUDGE.model, judge_host: JUDGE.host, scorer_version: '2.17.0'
        }, null);
        expect(card.environment.status).toBe('ok');
        expect(card.product_behavior).toEqual({ status: 'failed', detail: 'model' });
        expect(card.model_quality.status).toBe('not_scored');
        expect(card.authoritative).toBe(true);
    });

    test('deterministic grades need no judge qualification', () => {
        expect(judgeUsed({ scoring_method: 'deterministic' })).toBe(false);
        expect(judgeUsed({ scoring_method: 'decomposed' })).toBe(true);
        expect(judgeUsed({ scoring_method: 'executable', subjective_score: 7 })).toBe(true);
        expect(judgeUsed({ scoring_method: 'llm_failed' })).toBe(true);
    });
});
