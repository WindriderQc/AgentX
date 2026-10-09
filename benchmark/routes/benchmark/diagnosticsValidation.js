/**
 * Benchmark Routes - Diagnostics judge validation
 * Health, consistency, ground-truth evaluation, bias, calibration analysis
 * and failure-mode analysis.
 */

const logger = require('../../config/logger');
const judgeValidation = require('../../src/services/judgeValidation');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const { withManagedWorkloadRoute } = require('../../src/services/benchmark/workloadAdmissionLifecycle');
const { diagnosticWorkloadOptions } = require('./diagnosticsShared');

function registerJudgeValidationRoutes(router) {
    // ============ Judge Validation Endpoints ============

    /**
     * POST /api/benchmark/judge/health
     * Run comprehensive judge health check
     */
    router.post('/judge/health', withManagedWorkloadRoute('judge-health', diagnosticWorkloadOptions, async (req, res) => {
        try {
            const { days } = req.query;
            const options = {};
            if (days) options.days = parseInt(days, 10);
            const readiness = await resolveReadyJudgeTarget({
                host: req.query.judge_host,
                model: req.query.judge_model
            });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Live judge health check'));
            }
            options.judgeConfig = {
                host: readiness.target.host,
                model: readiness.target.model,
                cancelSignal: req.workloadAdmissionSignal
            };

            const health = await judgeValidation.runHealthCheck(options);

            res.json({
                status: 'success',
                data: health
            });
        } catch (err) {
            logger.error('Failed to run judge health check', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    }));

    /**
     * POST /api/benchmark/judge/validate/consistency
     * Run consistency test on judge
     */
    router.post('/judge/validate/consistency', withManagedWorkloadRoute('judge-consistency', diagnosticWorkloadOptions, async (req, res) => {
        try {
            const { sampleSize, repeats, category, judge_model, judge_host,
                batchId, scorerVersion, judgeModel, judgeHost } = req.body;
            const readiness = await resolveReadyJudgeTarget({ host: judge_host, model: judge_model });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge consistency test'));
            }

            const result = await judgeValidation.runConsistencyTest({
                batchId, scorerVersion, judgeModel, judgeHost,
                sampleSize: sampleSize || 10,
                repeats: repeats || 3,
                category: category || null,
                judgeConfig: {
                    host: readiness.target.host,
                    model: readiness.target.model,
                    cancelSignal: req.workloadAdmissionSignal
                }
            });

            res.json({
                status: 'success',
                data: result
            });
        } catch (err) {
            logger.error('Failed to run consistency test', { error: err.message });
            res.status(err.statusCode || 500).json({ status: 'error', error: err.message });
        }
    }));

    /**
     * POST /api/benchmark/judge/validate/ground-truth
     * Run ground truth evaluation
     */
    router.post('/judge/validate/ground-truth', withManagedWorkloadRoute('judge-ground-truth-validation', diagnosticWorkloadOptions, async (req, res) => {
        try {
            const { category, limit, judge_model, judge_host } = req.body;
            const readiness = await resolveReadyJudgeTarget({ host: judge_host, model: judge_model });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Ground-truth judge evaluation'));
            }

            const result = await judgeValidation.runGroundTruthEvaluation({
                category: category || null,
                limit: limit || 50,
                judgeConfig: {
                    host: readiness.target.host,
                    model: readiness.target.model,
                    cancelSignal: req.workloadAdmissionSignal
                }
            });

            res.json({
                status: 'success',
                data: result
            });
        } catch (err) {
            logger.error('Failed to run ground truth evaluation', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    }));

    /**
     * GET /api/benchmark/judge/validate/bias
     * Run bias detection analysis
     */
    router.get('/judge/validate/bias', async (req, res) => {
        try {
            const { sampleSize, judgeModel, judgeHost, scorerVersion, batchId } = req.query;

            const result = await judgeValidation.runBiasDetection({
                judgeModel, judgeHost, scorerVersion, batchId,
                sampleSize: sampleSize ? parseInt(sampleSize, 10) : 100
            });

            res.json({
                status: 'success',
                data: result
            });
        } catch (err) {
            logger.error('Failed to run bias detection', { error: err.message });
            res.status(err.statusCode || 500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * GET /api/benchmark/judge/validate/calibration
     * Run calibration analysis
     */
    router.get('/judge/validate/calibration', async (req, res) => {
        try {
            const { days, judgeModel, judgeHost, scorerVersion, batchId } = req.query;

            const result = await judgeValidation.runCalibrationAnalysis({
                judgeModel, judgeHost, scorerVersion, batchId,
                days: days ? parseInt(days, 10) : 30
            });

            res.json({
                status: 'success',
                data: result
            });
        } catch (err) {
            logger.error('Failed to run calibration analysis', { error: err.message });
            res.status(err.statusCode || 500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * GET /api/benchmark/judge/validate/failures
     * Run failure mode analysis
     */
    router.get('/judge/validate/failures', async (req, res) => {
        try {
            const { days } = req.query;

            const result = await judgeValidation.runFailureModeAnalysis({
                days: days ? parseInt(days, 10) : 30
            });

            res.json({
                status: 'success',
                data: result
            });
        } catch (err) {
            logger.error('Failed to run failure mode analysis', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });
}

module.exports = { registerJudgeValidationRoutes };
