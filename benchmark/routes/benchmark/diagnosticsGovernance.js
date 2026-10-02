/**
 * Benchmark Routes - Diagnostics feedback loop and governance
 * Ground-truth coverage, judge feedback stats, auto-promotion and the
 * judge governance loop.
 */

const logger = require('../../config/logger');
const { getCoverageStats } = require('../../src/services/benchmark/retroCalibration');
const { getJudgeFeedbackStats, autoPromoteGroundTruth } = require('../../src/services/judgeFeedbackLoop');
const {
    runJudgeGovernanceLoop,
    getLatestGovernanceRun
} = require('../../src/services/judgeGovernance');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const { withManagedWorkloadRoute } = require('../../src/services/benchmark/workloadAdmissionLifecycle');
const { diagnosticWorkloadOptions } = require('./diagnosticsShared');

function registerGovernanceRoutes(router) {
    /**
     * GET /api/benchmark/judge/ground-truth/coverage
     * Returns coverage matrix showing ground truth counts per category x difficulty cell.
     */
    router.get('/judge/ground-truth/coverage', async (req, res) => {
        try {
            const coverage = await getCoverageStats();
            res.json({ status: 'success', data: coverage });
        } catch (err) {
            logger.error('Coverage stats failed', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * GET /api/benchmark/judge/feedback-stats
     * Per-category accuracy stats: human review vs judge score divergence
     */
    router.get('/judge/feedback-stats', async (req, res) => {
        try {
            const stats = await getJudgeFeedbackStats();
            res.json({ status: 'success', data: stats });
        } catch (err) {
            logger.error('Judge feedback stats failed', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * POST /api/benchmark/judge/auto-promote
     * Auto-promote high-divergence human-reviewed results to ground truth
     */
    router.post('/judge/auto-promote', withManagedWorkloadRoute('judge-auto-promote', diagnosticWorkloadOptions, async (req, res) => {
        try {
            const result = await autoPromoteGroundTruth({
                cancelSignal: req.workloadAdmissionSignal,
                assertAuthorityActive: req.assertWorkloadAdmissionActive
            });
            res.json({ status: 'success', data: result });
        } catch (err) {
            if (err.retainAdmission === true) req.workloadAdmissionReconciliationError = err;
            logger.error('Auto-promote failed', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    }));

    // ============ Governance Loop Endpoints ============

    /**
     * POST /api/benchmark/judge/governance-run
     *
     * Trigger one full governance loop and return the saved summary.
     * Body: {
     *   batch_id?, judge_model?, judge_host?, reference_model?, reference_host?,
     *   pass_threshold?, run_retro_calibration?, retro_per_cell?, retro_dry_run?,
     *   triggered_by?
     * }
     *
     * All fields are optional. Sub-steps that are missing prerequisite inputs
     * are marked `skipped` in the summary instead of failing the whole run.
     */
    router.post('/judge/governance-run', withManagedWorkloadRoute('judge-governance', diagnosticWorkloadOptions, async (req, res) => {
        try {
            const {
                batch_id, judge_model, judge_host, reference_model, reference_host,
                pass_threshold, run_retro_calibration, retro_per_cell, retro_dry_run,
                triggered_by
            } = req.body || {};

            if (batch_id) {
                const batch = await BenchmarkBatch.exists({ _id: batch_id });
                if (!batch) {
                    return res.status(404).json({ status: 'error', error: 'Batch not found' });
                }
            }

            if (judge_model || judge_host) {
                const readiness = await resolveReadyJudgeTarget({ host: judge_host, model: judge_model });
                if (!readiness.ready) {
                    return res.status(503).json(judgeUnavailablePayload(readiness, 'Judge governance'));
                }
            }
            if (run_retro_calibration || reference_model || reference_host) {
                const readiness = await resolveReadyJudgeTarget({ host: reference_host, model: reference_model });
                if (!readiness.ready) {
                    return res.status(503).json(judgeUnavailablePayload(readiness, 'Reference governance'));
                }
            }

            const summary = await runJudgeGovernanceLoop({
                batchId: batch_id || null,
                judgeModel: judge_model || null,
                judgeHost: judge_host || null,
                referenceModel: reference_model || null,
                referenceHost: reference_host || null,
                passThreshold: pass_threshold !== undefined ? pass_threshold : 1.5,
                runRetroCalibration: !!run_retro_calibration,
                retroPerCell: retro_per_cell || 3,
                retroDryRun: !!retro_dry_run,
                triggeredBy: triggered_by || 'api',
                workloadId: req.workloadAdmissionId,
                cancelSignal: req.workloadAdmissionSignal,
                assertAuthorityActive: req.assertWorkloadAdmissionActive
            });

            res.json({ status: 'success', data: summary });
        } catch (err) {
            if (err.retainAdmission === true) req.workloadAdmissionReconciliationError = err;
            logger.error('Governance loop failed', { error: err.message });
            res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
        }
    }));

    /**
     * GET /api/benchmark/judge/governance-run/latest
     * Returns the most recent persisted governance summary.
     * Query: judge_model (optional)
     */
    router.get('/judge/governance-run/latest', async (req, res) => {
        try {
            const { judge_model } = req.query;
            const summary = await getLatestGovernanceRun(judge_model || null);
            if (!summary) {
                return res.json({ status: 'success', data: null });
            }
            res.json({ status: 'success', data: summary });
        } catch (err) {
            logger.error('Fetch latest governance run failed', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });
}

module.exports = { registerGovernanceRoutes };
