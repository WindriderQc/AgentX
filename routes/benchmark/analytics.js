/**
 * Benchmark Routes - Analytics
 * Summary, dashboard, compare, trends, leaderboard, presets
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');

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

module.exports = router;
