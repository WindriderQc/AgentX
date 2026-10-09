/**
 * Benchmark Routes - Diagnostics calibration
 * Matrix calibration, calibration status, drift detection and retro-calibration.
 */

const mongoose = require('mongoose');
const logger = require('../../config/logger');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { runCalibrationBatch, buildAccuracyMatrix } = require('../../src/services/benchmark/calibrationRunner');
const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');
const { detectDrift } = require('../../src/services/benchmark/driftDetector');
const { runRetroCalibration } = require('../../src/services/benchmark/retroCalibration');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const { withManagedWorkloadRoute } = require('../../src/services/benchmark/workloadAdmissionLifecycle');
const {
    diagnosticWorkloadOptions,
    calibrationTargetKey,
    persistCalibrationUnderAdmission
} = require('./diagnosticsShared');

function registerCalibrationRoutes(router) {
    // ============ Calibration Endpoints ============

    /**
     * POST /api/benchmark/judge/matrix-calibrate
     * Run a judge-agreement check: score curated corpus entries with a distinct
     * reference + candidate judge, build an agreement matrix, and save it.
     */
    router.post('/judge/matrix-calibrate', withManagedWorkloadRoute('judge-matrix-calibration', diagnosticWorkloadOptions, async (req, res) => {
        try {
            const { judge_model, judge_host, reference_model, reference_host, pass_threshold } = req.body;

            if (!judge_model || !reference_model || !judge_host || !reference_host) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing required fields: judge_model, judge_host, reference_model, reference_host'
                });
            }

            const entries = await JudgeGroundTruth.getForValidation();
            if (!entries || entries.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'No ground truth entries found. Add ground truth entries before calibrating.'
                });
            }

            const [judgeReadiness, referenceReadiness] = await Promise.all([
                resolveReadyJudgeTarget({ host: judge_host, model: judge_model }),
                resolveReadyJudgeTarget({ host: reference_host, model: reference_model })
            ]);
            if (!judgeReadiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(judgeReadiness, 'Judge calibration'));
            }
            if (!referenceReadiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(referenceReadiness, 'Reference judging'));
            }
            if (calibrationTargetKey(judgeReadiness.target) === calibrationTargetKey(referenceReadiness.target)) {
                return res.status(400).json({
                    status: 'error',
                    code: 'CALIBRATION_TARGETS_IDENTICAL',
                    error: 'Judge and reference judge must be different host/model targets.'
                });
            }

            const threshold = pass_threshold !== undefined ? pass_threshold : 1.5;

            const referenceScores = await runCalibrationBatch(entries, {
                model: referenceReadiness.target.model,
                host: referenceReadiness.target.host,
                cancelSignal: req.workloadAdmissionSignal
            });

            const challengerScores = await runCalibrationBatch(entries, {
                model: judgeReadiness.target.model,
                host: judgeReadiness.target.host,
                cancelSignal: req.workloadAdmissionSignal
            });

            const matrix = buildAccuracyMatrix(referenceScores, challengerScores, threshold);

            const saved = await persistCalibrationUnderAdmission({
                judge_model: judgeReadiness.target.model,
                judge_host: String(judgeReadiness.target.host || judge_host).trim().replace(/\/+$/, ''),
                reference_model: referenceReadiness.target.model,
                reference_host: String(referenceReadiness.target.host || reference_host).trim().replace(/\/+$/, ''),
                pass_threshold: threshold,
                ground_truth_count: entries.length,
                cells: matrix.cells,
                overall_avg_deviation: matrix.overall_avg_deviation,
                pass_rate: matrix.pass_rate,
                cell_pass_rate: matrix.cell_pass_rate,
                scored_entry_count: matrix.scored_entry_count,
                comparison_kind: 'reference_judge_agreement'
            }, req);

            logger.info('Calibration complete', {
                judge_model,
                reference_model,
                ground_truth_count: entries.length,
                overall_avg_deviation: matrix.overall_avg_deviation,
                pass_rate: matrix.pass_rate
            });

            res.json({
                status: 'success',
                data: saved
            });
        } catch (err) {
            logger.error('Failed to run calibration', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    }));

    /**
     * GET /api/benchmark/judge/calibration-status
     * Returns latest calibration matrices for all judges, or a specific judge.
     * Query params: judge_model (optional)
     */
    router.get('/judge/calibration-status', async (req, res) => {
        try {
            const { judge_model, judge_host } = req.query;

            let matrices;
            if (judge_model) {
                if (!judge_host) {
                    return res.status(400).json({
                        status: 'error',
                        code: 'JUDGE_HOST_REQUIRED',
                        error: 'judge_host is required when requesting one judge calibration target.'
                    });
                }
                const latest = await JudgeAccuracyMatrix.getLatest(judge_model, judge_host);
                matrices = latest ? [latest] : [];
            } else {
                // Aggregate to get the latest matrix per judge_model
                matrices = await JudgeAccuracyMatrix.aggregate([
                    { $sort: { calibrated_at: -1 } },
                    {
                        $group: {
                            _id: {
                                judge_model: '$judge_model',
                                judge_host: '$judge_host'
                            },
                            doc: { $first: '$$ROOT' }
                        }
                    },
                    { $replaceRoot: { newRoot: '$doc' } },
                    { $sort: { calibrated_at: -1 } }
                ]);
            }

            res.json({
                status: 'success',
                data: {
                    matrices: matrices.map((matrix) => {
                        const value = typeof matrix?.toObject === 'function' ? matrix.toObject() : matrix;
                        return {
                            ...value,
                            comparison_kind: value?.comparison_kind || 'reference_judge_agreement'
                        };
                    })
                }
            });
        } catch (err) {
            logger.error('Failed to fetch calibration status', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    // ============ Drift Detection Endpoints ============

    /**
     * GET /api/benchmark/judge/drift
     * Check score distribution drift on the most recent (or specified) batch vs historical.
     * Query params: judge_model (optional), batch_id (optional)
     */
    router.get('/judge/drift', async (req, res) => {
        try {
            const { judge_model, batch_id } = req.query;

            const match = { quality_score: { $ne: null } };
            if (judge_model) match.judge_model = judge_model;

            const latestBatch = batch_id
                ? null
                : await BenchmarkBatch
                    .findOne({ judge_status: 'completed' })
                    .sort({ updatedAt: -1 })
                    .lean();

            const effectiveBatchId = batch_id || latestBatch?._id?.toString();
            if (!effectiveBatchId) {
                return res.json({ status: 'success', data: { drifted: null, insufficient_data: true } });
            }
            const normalizedBatchId = String(effectiveBatchId);
            if (!/^[0-9a-f]{24}$/i.test(normalizedBatchId)) {
                return res.status(400).json({
                    status: 'error',
                    code: 'BENCHMARK_DRIFT_BATCH_ID_INVALID',
                    error: 'batch_id must be a canonical Mongo ObjectId'
                });
            }
            // Aggregation pipelines do not apply Mongoose query casting. Use the
            // stored ObjectId type for both sides so the current batch is selected
            // and excluded from the historical cohort exactly.
            const batchObjectId = new mongoose.Types.ObjectId(normalizedBatchId);

            const [currentStats, historicalStats] = await Promise.all([
                BenchmarkResult.aggregate([
                    { $match: { ...match, batch_id: batchObjectId } },
                    { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
                ]),
                BenchmarkResult.aggregate([
                    { $match: { ...match, batch_id: { $ne: batchObjectId } } },
                    { $sort: { timestamp: -1 } },
                    { $limit: 500 },
                    { $group: { _id: null, mean: { $avg: '$quality_score' }, stddev: { $stdDevPop: '$quality_score' }, count: { $sum: 1 } } }
                ])
            ]);

            if (!currentStats.length || !historicalStats.length) {
                return res.json({ status: 'success', data: { drifted: null, insufficient_data: true } });
            }

            const current = { mean: currentStats[0].mean, variance: (currentStats[0].stddev || 0) ** 2, count: currentStats[0].count };
            const historical = { mean: historicalStats[0].mean, variance: (historicalStats[0].stddev || 0) ** 2, count: historicalStats[0].count };

            const drift = detectDrift(current, historical);
            res.json({ status: 'success', data: { ...drift, batch_id: normalizedBatchId } });
        } catch (err) {
            logger.error('Drift check failed', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    // ============ Retro-Calibration Endpoints ============

    /**
     * POST /api/benchmark/judge/retro-calibrate
     * Expand ground truth by sampling a batch, re-scoring with a reference judge,
     * and creating JudgeGroundTruth entries with stratified coverage.
     */
    router.post('/judge/retro-calibrate', withManagedWorkloadRoute('judge-retro-calibration', diagnosticWorkloadOptions, async (req, res) => {
        try {
            const { batch_id, reference_model, reference_host, per_cell, dry_run } = req.body;

            if (!batch_id || !reference_model || !reference_host) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing required fields: batch_id, reference_model, reference_host'
                });
            }

            const batch = await BenchmarkBatch.exists({ _id: batch_id });
            if (!batch) {
                return res.status(404).json({ status: 'error', error: 'Batch not found' });
            }

            const readiness = await resolveReadyJudgeTarget({
                host: reference_host,
                model: reference_model
            });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Retro-calibration'));
            }

            const result = await runRetroCalibration(batch_id, {
                model: readiness.target.model,
                host: readiness.target.host
            }, {
                perCell: per_cell || 3,
                dryRun: dry_run || false,
                workloadId: req.workloadAdmissionId,
                cancelSignal: req.workloadAdmissionSignal,
                assertAuthorityActive: req.assertWorkloadAdmissionActive
            });

            res.json({ status: 'success', data: result });
        } catch (err) {
            if (err.retainAdmission === true) req.workloadAdmissionReconciliationError = err;
            logger.error('Retro-calibration failed', { error: err.message });
            res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
        }
    }));
}

module.exports = { registerCalibrationRoutes };
