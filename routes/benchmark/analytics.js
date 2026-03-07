/**
 * Benchmark Routes - Analytics
 * Summary, dashboard, compare, trends, leaderboard, presets
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { JUDGE_CONFIG, ENHANCED_SCORING_CONFIGS } = require('../../src/services/qualityScorer');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { getCategoryHeatmap, getDimensionBreakdown, calculateEliteScores, detectCeilingModels, CEILING_THRESHOLD } = require('../../src/services/benchmark/ceilingDetection');
const { calculateAllGeneralistScores, getActiveCategoryWeights } = require('../../src/services/benchmark/generalistScore');
const { compareBatchRegression, detectLatestRegression, generateChangelog } = require('../../src/services/benchmark/regressionDetector');
const { archiveOldResults, pruneExcessBatches, purgeDeadModels, getRetentionStats } = require('../../src/services/benchmark/dataRetention');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');

/**
 * GET /api/benchmark/summary
 * Get summary statistics and leaderboard
 */
router.get('/summary', async (req, res) => {
    try {
        const summary = await benchmarkService.getSummary();

        res.json({
            status: 'success',
            message: summary.total_tests === 0 ? 'No successful tests yet' : undefined,
            data: summary
        });
    } catch (err) {
        logger.error('Failed to generate summary', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/dashboard
 * Get dashboard data with charts and stats including quality metrics
 */
router.get('/dashboard', async (req, res) => {
    try {
        const { sort, modelCategory, promptCategory, tag } = req.query;
        const sortBy = sort || 'latency';

        const dashboard = await benchmarkService.getDashboard({
            sortBy,
            modelCategory,
            promptCategory,
            tag
        });

        res.json({
            status: 'success',
            data: dashboard
        });
    } catch (err) {
        logger.error('Failed to load dashboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/compare
 * Compare multiple models
 */
router.get('/compare', async (req, res) => {
    const { models } = req.query;

    if (!models) {
        return res.status(400).json({
            status: 'error',
            error: 'models query parameter required (comma-separated)'
        });
    }

    const modelList = models.split(',').map(m => m.trim());

    try {
        const { comparison } = await benchmarkService.compareModels(modelList);

        res.json({
            status: 'success',
            data: { comparison }
        });
    } catch (err) {
        logger.error('Failed to compare models', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/quality-breakdown
 * Get quality scores broken down by category and level
 */
router.get('/quality-breakdown', async (req, res) => {
    try {
        const { model, host } = req.query;

        const data = await benchmarkService.getQualityBreakdown(model, host);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch quality breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/trends
 * Get time-series performance trends
 */
router.get('/trends', async (req, res) => {
    try {
        const { model, days, groupBy } = req.query;

        const data = await benchmarkService.getModelTrends({
            model,
            days: parseInt(days, 10) || 7,
            groupBy: groupBy || 'day'
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch trends', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge-leaderboard
 * Get judge performance statistics
 */
router.get('/judge-leaderboard', async (req, res) => {
    try {
        const leaderboard = await benchmarkService.getJudgeLeaderboard();
        const activity = await benchmarkService.getJudgeActivity(5);

        res.json({
            status: 'success',
            data: {
                leaderboard,
                activity
            }
        });
    } catch (err) {
        logger.error('Failed to fetch judge leaderboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/generalist-leaderboard
 * Get generalist quality scores for all models
 */
router.get('/generalist-leaderboard', async (req, res) => {
    try {
        const data = await benchmarkService.getGeneralistLeaderboard();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch generalist leaderboard', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/host-names
 * Returns URL-to-friendly-name mapping for Ollama hosts
 */
router.get('/host-names', (req, res) => {
    const hosts = getConfiguredHosts();
    const hostMap = {};
    for (const h of hosts) {
        hostMap[h.url] = h.name;
    }
    res.json({ status: 'success', data: hostMap });
});

/**
 * GET /api/benchmark/judge-breakdown
 * Break down judge performance by prompt level or model-under-test
 */
router.get('/judge-breakdown', async (req, res) => {
    try {
        const { judge_model, judge_host, groupBy, limit } = req.query;

        if (!judge_model) {
            return res.status(400).json({
                status: 'error',
                error: 'judge_model query parameter is required'
            });
        }

        const data = await benchmarkService.getJudgeBreakdown({
            judge_model: String(judge_model),
            judge_host: (judge_host !== undefined ? String(judge_host) : null),
            groupBy: groupBy ? String(groupBy) : 'level',
            limit: limit !== undefined ? Number(limit) : undefined
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch judge breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/truncation-stats
 * Get truncation statistics for diagnostics
 */
router.get('/truncation-stats', async (req, res) => {
    try {
        const { batch_id, limit } = req.query;

        const data = await benchmarkService.getTruncationStats({
            batch_id: batch_id || null,
            limit: limit ? parseInt(limit, 10) : 1000
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch truncation stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/compare-batches
 * Compare multiple batches side-by-side
 */
router.post('/compare-batches', async (req, res) => {
    try {
        const { batch_ids } = req.body;

        if (!batch_ids || !Array.isArray(batch_ids)) {
            return res.status(400).json({
                status: 'error',
                error: 'batch_ids array is required'
            });
        }

        const data = await benchmarkService.compareBatches(batch_ids);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to compare batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/stats-by-tag
 * Get statistics grouped by tags
 */
router.get('/stats-by-tag', async (req, res) => {
    try {
        const data = await benchmarkService.getBatchStatsByTag();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch stats by tag', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/active-stats
 * Get real-time statistics for active batches
 */
router.get('/active-stats', async (req, res) => {
    try {
        const data = await benchmarkService.getActiveStats();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch active stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/presets
 * Get configuration presets for common test scenarios
 */
router.get('/presets', (req, res) => {
    try {
        const data = benchmarkService.getConfigPresets();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch presets', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge-calibration
 * Judge accuracy vs human reviewers — per judge model:
 * - agreement rate (within ±1 point)
 * - mean absolute error
 * - systematic bias (positive = judge scores higher than human)
 * - per-category breakdown
 */
router.get('/judge-calibration', async (req, res) => {
    try {
        const BenchmarkResult = require('../../models/BenchmarkResult');

        // Find all results that have both judge and human scores
        const reviewed = await BenchmarkResult.find({
            human_score: { $ne: null },
            quality_score: { $ne: null },
            judge_model: { $ne: null }
        }).select({
            judge_model: 1, quality_score: 1, human_score: 1,
            prompt_category: 1, human_notes: 1
        }).lean();

        if (reviewed.length === 0) {
            return res.json({
                status: 'success',
                data: { judges: [], totalReviews: 0, message: 'No human reviews yet' }
            });
        }

        // Group by judge model
        const byJudge = {};
        for (const r of reviewed) {
            const jm = r.judge_model;
            if (!byJudge[jm]) byJudge[jm] = [];
            byJudge[jm].push(r);
        }

        const judges = [];
        for (const [judgeModel, results] of Object.entries(byJudge)) {
            let totalError = 0;
            let totalBias = 0;
            let agreements = 0;
            const byCategory = {};

            for (const r of results) {
                const diff = r.quality_score - r.human_score;
                const absDiff = Math.abs(diff);
                totalError += absDiff;
                totalBias += diff;
                if (absDiff <= 1) agreements++;

                // Per-category stats
                const cat = r.prompt_category || 'unknown';
                if (!byCategory[cat]) byCategory[cat] = { count: 0, totalError: 0, totalBias: 0, agreements: 0 };
                byCategory[cat].count++;
                byCategory[cat].totalError += absDiff;
                byCategory[cat].totalBias += diff;
                if (absDiff <= 1) byCategory[cat].agreements++;
            }

            const n = results.length;
            const categoryBreakdown = {};
            for (const [cat, stats] of Object.entries(byCategory)) {
                categoryBreakdown[cat] = {
                    reviews: stats.count,
                    meanAbsoluteError: Math.round((stats.totalError / stats.count) * 100) / 100,
                    bias: Math.round((stats.totalBias / stats.count) * 100) / 100,
                    agreementRate: Math.round((stats.agreements / stats.count) * 100)
                };
            }

            judges.push({
                judgeModel,
                reviews: n,
                meanAbsoluteError: Math.round((totalError / n) * 100) / 100,
                bias: Math.round((totalBias / n) * 100) / 100,
                agreementRate: Math.round((agreements / n) * 100),
                categoryBreakdown
            });
        }

        judges.sort((a, b) => a.meanAbsoluteError - b.meanAbsoluteError);

        res.json({
            status: 'success',
            data: { judges, totalReviews: reviewed.length }
        });
    } catch (err) {
        logger.error('Failed to fetch judge calibration', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/ceiling-analysis
 * Detect ceiling models and suggest differentiation strategies
 */
router.get('/ceiling-analysis', async (req, res) => {
    try {
        const threshold = parseFloat(req.query.threshold) || CEILING_THRESHOLD;
        const categoryWeights = await getActiveCategoryWeights();
        const generalistScores = await calculateAllGeneralistScores({ success: true }, { categoryWeights });
        const ceilingModels = detectCeilingModels(generalistScores, threshold);
        const eliteScores = await calculateEliteScores({ success: true });

        // Match elite scores to ceiling models
        const enriched = ceilingModels.map(cm => {
            const elite = eliteScores.find(e => e.model === cm.model && e.host === cm.host);
            return {
                ...cm,
                eliteScore: elite?.eliteScore || null,
                eliteCoverage: elite?.eliteCoverage || 0,
                eliteCategoryScores: elite?.categoryScores || {}
            };
        });

        res.json({
            status: 'success',
            data: {
                threshold,
                ceilingCount: enriched.length,
                totalModels: [...generalistScores.values()].filter(d => !d.filtered).length,
                ceilingModels: enriched
            }
        });
    } catch (err) {
        logger.error('Failed to fetch ceiling analysis', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/category-heatmap
 * Model x category score matrix for heatmap visualization
 */
router.get('/category-heatmap', async (req, res) => {
    try {
        const data = await getCategoryHeatmap({ success: true });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch category heatmap', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/dimension-breakdown
 * Per-model scoring dimension averages from quality_breakdown
 */
router.get('/dimension-breakdown', async (req, res) => {
    try {
        const data = await getDimensionBreakdown({ success: true });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch dimension breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/elite-scores
 * Elite scores based on hard-mode categories (L4+ prompts only)
 */
router.get('/elite-scores', async (req, res) => {
    try {
        const data = await calculateEliteScores({ success: true });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to fetch elite scores', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/regression
 * Auto-detect regressions between the two most recent completed batches
 */
router.get('/regression', async (req, res) => {
    try {
        const report = await detectLatestRegression();
        if (!report) {
            return res.json({
                status: 'success',
                data: null,
                message: 'Need at least 2 completed batches to detect regressions'
            });
        }

        res.json({
            status: 'success',
            data: {
                ...report,
                changelog: generateChangelog(report)
            }
        });
    } catch (err) {
        logger.error('Failed to detect regressions', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/regression/compare
 * Compare two specific batches for regressions
 * Body: { current_batch_id, previous_batch_id }
 */
router.post('/regression/compare', async (req, res) => {
    try {
        const { current_batch_id, previous_batch_id } = req.body || {};
        if (!current_batch_id || !previous_batch_id) {
            return res.status(400).json({
                status: 'error',
                error: 'current_batch_id and previous_batch_id are required'
            });
        }
        if (!validateObjectId(current_batch_id, res, 'current_batch_id')) return;
        if (!validateObjectId(previous_batch_id, res, 'previous_batch_id')) return;

        const report = await compareBatchRegression(current_batch_id, previous_batch_id);

        res.json({
            status: 'success',
            data: {
                ...report,
                changelog: generateChangelog(report)
            }
        });
    } catch (err) {
        logger.error('Failed to compare batches for regression', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/retention/stats
 * Get data retention statistics (how much can be cleaned up)
 */
router.get('/retention/stats', async (req, res) => {
    try {
        const stats = await getRetentionStats();
        res.json({ status: 'success', data: stats });
    } catch (err) {
        logger.error('Failed to get retention stats', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/retention/archive
 * Archive old batch results beyond retention period
 * Body: { retention_days, dry_run }
 */
router.post('/retention/archive', async (req, res) => {
    try {
        const { retention_days, dry_run } = req.body || {};
        const days = parseInt(retention_days, 10) || 90;
        const dryRun = dry_run !== false && dry_run !== 0;

        const result = await archiveOldResults(days, dryRun);
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Failed to archive old results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/retention/prune
 * Prune excess batches per model (keep only latest N)
 * Body: { keep_batches, dry_run }
 */
router.post('/retention/prune', async (req, res) => {
    try {
        const { keep_batches, dry_run } = req.body || {};
        const keep = parseInt(keep_batches, 10) || 3;
        const dryRun = dry_run !== false && dry_run !== 0;

        const result = await pruneExcessBatches(keep, dryRun);
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Failed to prune excess batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/retention/purge-dead
 * Purge results from dead models (95%+ empty responses)
 * Body: { dry_run }
 */
router.post('/retention/purge-dead', async (req, res) => {
    try {
        const { dry_run } = req.body || {};
        const dryRun = dry_run !== false && dry_run !== 0;

        const result = await purgeDeadModels(dryRun);
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Failed to purge dead models', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
