/**
 * Benchmark Routes
 * Thin HTTP layer - validates requests and delegates to benchmarkService
 * Follows Service-Oriented Architecture pattern
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { attachWorkspace } = require('../src/middleware/workspace');
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
 * Run a single benchmark test - workspace-aware
 */
router.post('/test', attachWorkspace, async (req, res) => {
    const { model, host, prompt } = req.body;

    // Validation
    if (!model || !host || !prompt) {
        return res.status(400).json({
            status: 'error',
            error: 'model, host, and prompt are required'
        });
    }

    try {
        // Week 4: Pass workspace context to service
        const result = await benchmarkService.runTest({
            model,
            host,
            prompt,
            workspaceId: req.workspace ? req.workspace._id : null
        });

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
 * Start a batch benchmark test with optional quality scoring - workspace-aware
 */
router.post('/batch', attachWorkspace, async (req, res) => {
    const { host, models, levels, run_name, quality_scoring, judge_config } = req.body;

    // Validation
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        return res.status(400).json({
            status: 'error',
            error: 'host, models (array), and levels (array) are required'
        });
    }

    try {
        // ENFORCE SINGLE BATCH: Check for existing active batches
        const BenchmarkBatch = require('../models/BenchmarkBatch');
        const activeBatches = await BenchmarkBatch.getActive();

        if (activeBatches.length > 0) {
            const active = activeBatches[0];
            const inactiveSeconds = active.last_activity_at
                ? Math.floor((Date.now() - new Date(active.last_activity_at).getTime()) / 1000)
                : 0;

            return res.status(409).json({
                status: 'error',
                error: 'Another batch is already running',
                active_batch: {
                    id: active._id,
                    run_name: active.run_name,
                    status: active.status,
                    progress: active.progress,
                    inactive_seconds: inactiveSeconds,
                    is_stuck: inactiveSeconds > 300,
                    started_at: active.started_at
                },
                message: inactiveSeconds > 300
                    ? 'The active batch appears stuck. Use the "Recover" button to stop it before starting a new batch.'
                    : `Batch "${active.run_name}" is currently running (${active.progress}% complete). Please wait for it to finish or stop it first.`
            });
        }

        // Week 4: Pass workspace context to service
        const data = await benchmarkService.startBatch({
            host,
            models,
            levels,
            run_name,
            quality_scoring,
            judge_config,
            workspaceId: req.workspace ? req.workspace._id : null
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
 * GET /api/benchmark/batches/active
 * Get all currently running batches across all clients
 */
router.get('/batches/active', async (req, res) => {
    try {
        const BenchmarkBatch = require('../models/BenchmarkBatch');
        const batches = await BenchmarkBatch.getActive();

        // Add activity status and stuck detection
        const now = Date.now();
        const enriched = batches.map(batch => {
            const lastActivity = batch.last_activity_at ? new Date(batch.last_activity_at).getTime() : batch.started_at ? new Date(batch.started_at).getTime() : now;
            const inactiveSeconds = Math.floor((now - lastActivity) / 1000);
            const isStuck = inactiveSeconds > 300; // 5 minutes

            return {
                ...batch.toJSON(),
                inactive_seconds: inactiveSeconds,
                is_stuck: isStuck,
                activity_status: isStuck ? 'stuck' : (inactiveSeconds > 60 ? 'slow' : 'active')
            };
        });

        res.json({
            status: 'success',
            data: enriched
        });
    } catch (err) {
        logger.error('Failed to fetch active batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches/stuck
 * Get stuck batches (no activity for >5 minutes)
 */
router.get('/batches/stuck', async (req, res) => {
    try {
        const BenchmarkBatch = require('../models/BenchmarkBatch');
        const thresholdSeconds = parseInt(req.query.threshold) || 300;
        const stuck = await BenchmarkBatch.findStuck(thresholdSeconds);

        res.json({
            status: 'success',
            data: stuck,
            threshold_seconds: thresholdSeconds
        });
    } catch (err) {
        logger.error('Failed to fetch stuck batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id/timeline
 * Get detailed execution timeline for a batch
 */
router.get('/batch/:id/timeline', async (req, res) => {
    try {
        const BenchmarkBatch = require('../models/BenchmarkBatch');
        const batch = await BenchmarkBatch.findById(req.params.id);

        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        // Get timeline events with calculated metrics
        const timeline = batch.timeline || [];
        const enriched = timeline.map((event, index) => {
            const timeSinceStart = batch.started_at
                ? event.timestamp - batch.started_at
                : 0;

            return {
                ...event.toObject(),
                time_since_start_ms: timeSinceStart,
                index
            };
        });

        // Calculate summary statistics
        const testEvents = timeline.filter(e => e.event === 'test_complete');
        const judgeEvents = timeline.filter(e => e.event === 'judge_complete');
        const errorEvents = timeline.filter(e => e.event === 'error');

        const avgTestDuration = testEvents.length > 0
            ? testEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / testEvents.length
            : null;

        const avgJudgeDuration = judgeEvents.length > 0
            ? judgeEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / judgeEvents.length
            : null;

        res.json({
            status: 'success',
            data: {
                batch_id: batch._id,
                timeline: enriched,
                summary: {
                    total_events: timeline.length,
                    tests_completed: testEvents.length,
                    tests_failed: errorEvents.length,
                    judges_completed: judgeEvents.length,
                    avg_test_duration_ms: avgTestDuration ? Math.round(avgTestDuration) : null,
                    avg_judge_duration_ms: avgJudgeDuration ? Math.round(avgJudgeDuration) : null,
                    started_at: batch.started_at,
                    last_event_at: timeline.length > 0 ? timeline[timeline.length - 1].timestamp : null
                }
            }
        });
    } catch (err) {
        logger.error('Failed to fetch batch timeline', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/recover
 * Recover a stuck batch by marking it as interrupted
 */
router.post('/batch/:id/recover', async (req, res) => {
    try {
        const BenchmarkBatch = require('../models/BenchmarkBatch');
        const batch = await BenchmarkBatch.findById(req.params.id);

        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        if (!['running', 'judging'].includes(batch.status)) {
            return res.status(400).json({
                status: 'error',
                error: `Batch is ${batch.status}, cannot recover`
            });
        }

        await batch.markAsStopped();

        res.json({
            status: 'success',
            message: 'Batch marked as stopped',
            data: batch
        });
    } catch (err) {
        logger.error('Failed to recover batch', { error: err.message, batchId: req.params.id });
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
 * GET /api/benchmark/judge-breakdown
 * Break down judge performance by prompt level or model-under-test.
 *
 * Query params:
 *  - judge_model: required
 *  - judge_host: optional
 *  - groupBy: 'level' | 'model' (default: level)
 *  - limit: max groups (only applies to groupBy=model)
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
