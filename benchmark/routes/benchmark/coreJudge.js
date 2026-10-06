/**
 * Benchmark Routes - Core judge checks
 * Judge validation and quick/accuracy calibration.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const { validateJudgeModel, probeJudgeCapability } = require('../../src/services/benchmark/judgeModelValidator');
const { callJudge } = require('../../src/services/scoring/judgeCall');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const { withManagedWorkloadRoute } = require('../../src/services/benchmark/workloadAdmissionLifecycle');
const {
    getQuickJudgeCalibrationCases,
    getQuickJudgeCalibrationProtocol,
    evaluateQuickJudgeCalibrationCase
} = require('../../src/services/benchmark/quickJudgeCalibration');
const { evaluateCalibrationCase, summarizeAccuracyCalibration } = require('../../src/services/benchmark/judgeCalibration');
const { buildAccuracyCalibrationReport, recordAccuracyCalibration } = require('../../src/services/benchmark/judgeQualification');
const { freezeJudgeConfig } = require('../../src/services/benchmark/judgeExecutionContract');
const { diagnosticInput, reportedJudgeConfig } = require('../../src/services/benchmark/judgeCalibrationDiagnostic');
const { rethrowIfJudgeCancelled } = require('../../src/services/scoring/judgeCall');
const {
    judgeWorkloadOptions,
    judgeValidationAdmissionFailure
} = require('./coreShared');

/**
 * POST /api/benchmark/validate-judge
 * Pre-flight check: validate judge model availability and output capability
 */
router.post('/validate-judge', withManagedWorkloadRoute('judge-validation', judgeWorkloadOptions, async (req, res) => {
    const { host, model } = req.body || {};

    try {
        const admission = await resolveReadyJudgeTarget({ host, model });
        if (!admission.ready) {
            const failure = judgeValidationAdmissionFailure(admission);
            return res.status(failure.statusCode).json(failure.payload);
        }

        // Only the canonical target returned by the configured-judge
        // admission authority may reach the outbound validation sinks.
        const judgeHost = admission.target.host;
        const judgeModel = admission.target.model;
        const validation = await validateJudgeModel(judgeHost, judgeModel, { signal: req.workloadAdmissionSignal });
        if (validation.valid) {
            const probe = await probeJudgeCapability(judgeHost, judgeModel, { signal: req.workloadAdmissionSignal });
            res.json({
                status: 'success',
                data: {
                    valid: true,
                    host: judgeHost,
                    model: judgeModel,
                    context_length: probe.context_length || null,
                    parameter_size: probe.parameter_size || null,
                    warning: validation.warning || null,
                    latency_ms: validation.latency_ms
                }
            });
        } else {
            const statusCode = validation.code === 'JUDGE_MODEL_UNAVAILABLE' ? 409 : 503;
            res.status(statusCode).json({
                status: 'error',
                code: validation.code || 'JUDGE_VALIDATION_UNAVAILABLE',
                error: validation.error,
                available_models: validation.available_models || [],
                latency_ms: validation.latency_ms
            });
        }
    } catch (err) {
        logger.error('Judge validation failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
}));

/**
 * GET /api/benchmark/judge/calibration-protocol
 * Shared metadata for the quick live judge calibration flow.
 */
router.get('/judge/calibration-protocol', (req, res) => {
    return res.json({
        status: 'success',
        data: {
            protocol: getQuickJudgeCalibrationProtocol()
        }
    });
});

/**
 * POST /api/benchmark/judge/calibrate
 * Quick calibration of judge model JSON reliability, consistency, and latency.
 */
router.post('/judge/calibrate', withManagedWorkloadRoute('judge-calibration', judgeWorkloadOptions, async (req, res) => {
    const { host, model, num_ctx } = req.body || {};
    if (num_ctx !== undefined && (!Number.isInteger(num_ctx) || num_ctx < 512)) {
        return res.status(400).json({ status: 'error', error: 'num_ctx must be an integer of at least 512' });
    }
    const readiness = await resolveReadyJudgeTarget({ host, model });
    if (!readiness.ready) {
        return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge calibration'));
    }
    const judgeHost = readiness.target.host;
    const judgeModel = readiness.target.model;

    const calibrationCases = getQuickJudgeCalibrationCases();

    try {
        const details = [];

        for (const testCase of calibrationCases) {
            const startedAt = Date.now();
            const judgeRes = await callJudge(testCase.prompt, {
                host: judgeHost,
                model: judgeModel,
                // The first probe may cold-load a multi-GB local judge. Keep
                // the subsequent protocol checks short once it is resident.
                timeout: details.length === 0 ? 120000 : 20000,
                max_retries: 1,
                temperature: 0.1,
                num_predict: 120,
                ...(num_ctx !== undefined && { num_ctx }),
                cancelSignal: req.workloadAdmissionSignal
            });
            const latencyMs = Date.now() - startedAt;

            const passed = !!(judgeRes.success && !judgeRes.judge_truncated && evaluateQuickJudgeCalibrationCase(testCase, judgeRes.scores));
            details.push({
                id: testCase.id,
                title: testCase.title,
                purpose: testCase.purpose,
                pass_criteria: testCase.passCriteria,
                passed,
                latency_ms: latencyMs,
                overall: typeof judgeRes?.scores?.overall === 'number' ? judgeRes.scores.overall : null,
                judge_truncated: judgeRes.judge_truncated === true,
                error: judgeRes.judge_truncated ? 'Judge output truncated' : judgeRes.success ? null : judgeRes.error
            });
        }

        const consistencyA = details.find((d) => d.id === 'consistency_a');
        const consistencyB = details.find((d) => d.id === 'consistency_b');
        if (consistencyA && consistencyB && consistencyA.overall !== null && consistencyB.overall !== null) {
            const drift = Math.abs(consistencyA.overall - consistencyB.overall);
            if (drift > 2.0) {
                consistencyA.passed = false;
                consistencyA.error = `consistency drift=${drift.toFixed(2)}`;
            }
        }

        const testsTotal = details.length;
        const testsPassed = details.filter((d) => d.passed).length;
        const reliability = testsTotal > 0 ? testsPassed / testsTotal : 0;
        const avgLatencyMs = Math.round(details.reduce((sum, d) => sum + d.latency_ms, 0) / Math.max(1, details.length));

        return res.json({
            status: 'success',
            data: {
                protocol: getQuickJudgeCalibrationProtocol(),
                host: judgeHost,
                model: judgeModel,
                passed: reliability >= 0.70,
                requested_num_ctx: num_ctx ?? null,
                reliability,
                avg_latency_ms: avgLatencyMs,
                tests_total: testsTotal,
                tests_passed: testsPassed,
                details
            }
        });
    } catch (err) {
        logger.error('Judge calibration failed', { error: err.message, host: judgeHost, model: judgeModel });
        return res.status(500).json({ status: 'error', error: err.message });
    }
}));

/**
 * POST /api/benchmark/judge/calibrate-accuracy
 * Test judge accuracy against gold-standard scored responses.
 * Returns Pearson correlation, MAE, per-tier breakdown, the identity check
 * (reference answers must earn full marks) and the keying-bias diagnostic.
 */
router.post('/judge/calibrate-accuracy', withManagedWorkloadRoute('judge-accuracy-calibration', judgeWorkloadOptions, async (req, res) => {
    const { host, model, num_ctx } = req.body || {};
    const calibrationSet = require('../../data/judge-calibration-set.json');
    let input;
    try {
        input = diagnosticInput(req.body || {}, calibrationSet);
    } catch (err) {
        return res.status(err.statusCode || 400).json({ status: 'error', error: err.message });
    }
    const readiness = await resolveReadyJudgeTarget({ host, model });
    if (!readiness.ready) {
        return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge accuracy calibration'));
    }
    const judgeHost = readiness.target.host;
    const judgeModel = readiness.target.model;

    try {
        const { scoreResponse } = require('../../src/services/qualityScorer');
        const results = [];
        const judgeConfig = await freezeJudgeConfig({ host: judgeHost, model: judgeModel, ...input.options },
            { signal: req.workloadAdmissionSignal });
        judgeConfig.cancelSignal = req.workloadAdmissionSignal;

        for (const item of input.cases) {
            const start = Date.now();
            try {
                const scores = await scoreResponse({
                    response: item.response,
                    prompt: {
                        prompt: item.prompt,
                        category: item.category,
                        expected_answer: item.expected_answer,
                        reference_tests: item.reference_tests
                    },
                    judgeConfig
                });

                const grade = evaluateCalibrationCase({ ...item, expert_scores: { overall: item.gold_score } }, scores);
                results.push({
                    id: item.id,
                    category: item.category,
                    tier: item.tier,
                    gold_score: item.gold_score,
                    judge_score: grade.judge_score,
                    diff: grade.absolute_error === null ? null : Math.round((grade.judge_score - item.gold_score) * 10) / 10,
                    abs_diff: grade.absolute_error === null ? null : Math.round(grade.absolute_error * 10) / 10,
                    latency_ms: Date.now() - start,
                    success: grade.judge_score !== null,
                    scoring_method: scores.scoring_method || null,
                    explanation: scores.explanation || null,
                    breakdown: scores.breakdown || null,
                    judge_prompt: scores.judge_prompt || null,
                    judge_raw_response: scores.judge_raw_response || null,
                    needs_review: scores.needs_review === true,
                    identity_case: grade.identity_case,
                    attention_check: scores.attention_check || null,
                    primary_cap: scores.primary_cap || null,
                    identity_full_marks: grade.identity_full_marks,
                    keying: grade.keying,
                    error: grade.judge_score === null ? (scores.error || 'Scoring returned no valid grade') : null
                });
            } catch (err) {
                rethrowIfJudgeCancelled(err, judgeConfig);
                results.push({
                    id: item.id,
                    category: item.category,
                    tier: item.tier,
                    gold_score: item.gold_score,
                    judge_score: null,
                    diff: null,
                    abs_diff: null,
                    latency_ms: Date.now() - start,
                    success: false,
                    error: err.message
                });
            }
        }

        const summary = summarizeAccuracyCalibration(results, input.cases.length);
        const report = buildAccuracyCalibrationReport({ host: judgeHost, model: judgeModel, numCtx: num_ctx, summary, results, calibrationSet });
        report.judge_config = reportedJudgeConfig(judgeConfig);
        report.reference_total = calibrationSet.length;
        report.selected_case_ids = input.cases.map(item => item.id);
        report.diagnostic = input.diagnostic;
        report.warnings = input.warnings;
        if (input.diagnostic) {
            report.valid = false;
            report.qualification.failed.push('diagnostic_run');
            return res.json({ status: 'success', data: { ...report,
                qualification_record: { skipped: true, reason: 'diagnostic_run' } } });
        }
        // The record is what qualifies judged rankings; a failed write is reported, never hidden.
        const digest = judgeConfig.execution_contract.artifact.digest;
        const record = await recordAccuracyCalibration(report, { digest }).catch((error) => ({ error: error.message }));
        return res.json({ status: 'success', data: { ...report, qualification_record: record } });
    } catch (err) {
        logger.error('Judge accuracy calibration failed', { error: err.message, host: judgeHost, model: judgeModel });
        return res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
}));

module.exports = router;
