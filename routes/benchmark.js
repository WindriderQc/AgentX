/**
 * Benchmark Routes
 * Thin HTTP layer - validates requests and delegates to benchmarkService
 * Follows Service-Oriented Architecture pattern
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const benchmarkService = require('../src/services/benchmarkService');
const { JUDGE_CONFIG, SCORING_CONFIGS } = require('../src/services/qualityScorer');

// Cleanup stale batches on startup
// Skip in tests to avoid timers/open handles and cross-test DB interference.
if (process.env.NODE_ENV !== 'test') {
    (async () => {
        try {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for DB connection
            await benchmarkService.cleanupStaleBatches();
        } catch (err) {
            logger.error('Failed to cleanup stale batches', { error: err.message });
        }
    })();
}

/**
 * GET /api/benchmark/config
 * Get benchmark configuration including judge settings
 */
router.get('/config', (req, res) => {
    res.json({
        status: 'success',
        data: {
            judge_config: {
                ...JUDGE_CONFIG,
                concurrency: 2,
                judge_same_host: false
            },
            scoring_configs: SCORING_CONFIGS
        }
    });
});

/**
 * POST /api/benchmark/test
 * Run a single benchmark test
 */
router.post('/test', async (req, res) => {
    const { model, host, prompt } = req.body;

    // Validation
    if (!model || !host || !prompt) {
        return res.status(400).json({
            status: 'error',
            error: 'model, host, and prompt are required'
        });
    }

    try {
        const result = await benchmarkService.runTest({ model, host, prompt });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Benchmark test failed', { model, host, error: err.message });

        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /api/benchmark/results
 * Get all test results (paginated)
 */
router.get('/results', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;

        const { results, total } = await benchmarkService.getResults({ limit });

        res.json({
            status: 'success',
            data: { total, results }
        });
    } catch (err) {
        logger.error('Failed to fetch results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

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
 *
 * Query params:
 *   - sort: Sort criteria (latency, quality, composite, etc.)
 *   - modelCategory: Filter by model category (ops, coding, reasoning, etc.)
 *   - promptCategory: Filter by prompt category (coding, reasoning, factual, etc.)
 *   - tag: Filter by batch tag
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

    // Validation
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
 * DELETE /api/benchmark/results
 * Clear all results (for testing)
 */
router.delete('/results', async (req, res) => {
    try {
        const count = await benchmarkService.clearResults();

        res.json({
            status: 'success',
            message: `Cleared ${count} results`
        });
    } catch (err) {
        logger.error('Failed to clear results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * DELETE /api/benchmark/results/failed
 * Clear failed results only
 */
router.delete('/results/failed', async (req, res) => {
    try {
        const count = await benchmarkService.clearFailedResults();

        res.json({
            status: 'success',
            message: `Cleared ${count} failed results`
        });
    } catch (err) {
        logger.error('Failed to clear failed results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/prompts
 * Get all prompts grouped by level
 */
router.get('/prompts', async (req, res) => {
    try {
        const data = await benchmarkService.getPrompts();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch prompts', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch
 * Start a batch benchmark test with optional quality scoring
 */
router.post('/batch', async (req, res) => {
    const { host, models, levels, run_name, quality_scoring, judge_config } = req.body;

    // Validation
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        return res.status(400).json({
            status: 'error',
            error: 'host, models (array), and levels (array) are required'
        });
    }

    try {
        const data = await benchmarkService.startBatch({
            host,
            models,
            levels,
            run_name,
            quality_scoring,
            judge_config
        });

        res.json({
            status: 'success',
            data: {
                ...data,
                message: `Batch test started${data.quality_scoring ? ' with quality scoring' : ''}`
            }
        });
    } catch (err) {
        logger.error('Failed to start batch test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/stop
 * Stop a running batch
 */
router.post('/batch/:id/stop', async (req, res) => {
    try {
        await benchmarkService.stopBatch(req.params.id);

        res.json({ status: 'success', message: 'Batch stopped' });
    } catch (err) {
        logger.error('Failed to stop batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id
 * Get batch progress and results
 */
router.get('/batch/:id', async (req, res) => {
    try {
        const data = await benchmarkService.getBatch(req.params.id);

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches
 * Get all batch runs
 */
router.get('/batches', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;

        const data = await benchmarkService.getBatches({ limit });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/quality-breakdown
 * Get quality scores broken down by category and level
 */
router.get('/quality-breakdown', async (req, res) => {
    try {
        const { model } = req.query;

        const data = await benchmarkService.getQualityBreakdown(model);

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
            days: parseInt(days) || 7,
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
