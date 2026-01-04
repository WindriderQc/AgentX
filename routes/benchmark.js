/**
 * Benchmark Routes
 * LLM performance testing and metrics with quality scoring
 */

const express = require('express');
const router = express.Router();
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const mongoose = require('mongoose');
const logger = require('../config/logger');
const { ObjectId } = mongoose.Types;
const { JUDGE_CONFIG, SCORING_CONFIGS } = require('../src/services/qualityScorer');
const benchmarkService = require('../src/services/benchmarkService');
const BenchmarkResult = require('../models/BenchmarkResult');
const BenchmarkBatch = require('../models/BenchmarkBatch');
const BenchmarkPrompt = require('../models/BenchmarkPrompt');

// Cleanup stale batches on startup
async function cleanupStaleBatches() {
    try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (mongoose.connection.readyState !== 1) return;

        const result = await BenchmarkBatch.updateMany(
            { status: { $in: ['running', 'judging'] } },
            { $set: { status: 'interrupted', completed_at: new Date() } }
        );

        if (result.modifiedCount > 0) {
            logger.info('Cleaned up stale batches', { count: result.modifiedCount });
        }
    } catch (err) {
        logger.error('Failed to cleanup stale batches', { error: err.message });
    }
}
cleanupStaleBatches();

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
                judge_same_host: true
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

    if (!model || !host || !prompt) {
        return res.status(400).json({
            status: 'error',
            error: 'model, host, and prompt are required'
        });
    }

    const start = Date.now();

    try {
        const response = await fetch(`${host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt, stream: false }),
            timeout: 30000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const latency = Date.now() - start;
        const tokens = Math.ceil((data.response || '').length / 4);

        const result = new BenchmarkResult({
            model,
            host,
            prompt,
            latency,
            tokens,
            tokens_per_sec: tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0,
            response: data.response || '',
            success: true
        });

        await result.save();
        logger.info('Benchmark test completed', {
            model, host, latency, tokens_per_sec: result.tokens_per_sec
        });

        res.json({
            status: 'success',
            data: result
        });

    } catch (err) {
        const result = new BenchmarkResult({
            model,
            host,
            prompt,
            error: err.message,
            success: false
        });

        await result.save();
        logger.error('Benchmark test failed', { model, host, error: err.message });

        res.status(500).json({
            status: 'error',
            error: err.message,
            data: result
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

        const results = await BenchmarkResult.find()
            .sort({ timestamp: -1 })
            .limit(limit);

        const total = await BenchmarkResult.countDocuments();

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
        const successful = await BenchmarkResult.find({ success: true }).lean();
        const failedCount = await BenchmarkResult.countDocuments({ success: false });

        if (successful.length === 0) {
            return res.json({
                status: 'success',
                message: 'No successful tests yet',
                data: {
                    total_tests: 0,
                    successful: 0,
                    failed: 0,
                    avg_latency: 0,
                    leaderboard: []
                }
            });
        }

        const latencies = successful.map(r => r.latency);
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

        const byModel = {};
        successful.forEach(r => {
            if (!byModel[r.model]) {
                byModel[r.model] = { latencies: [], tokens_per_sec: [] };
            }
            byModel[r.model].latencies.push(r.latency);
            if (r.tokens_per_sec) {
                byModel[r.model].tokens_per_sec.push(parseFloat(r.tokens_per_sec));
            }
        });

        const leaderboard = Object.entries(byModel).map(([model, data]) => ({
            model,
            avg_latency: Math.round(data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length),
            avg_tokens_per_sec: data.tokens_per_sec.length > 0
                ? (data.tokens_per_sec.reduce((a, b) => a + b, 0) / data.tokens_per_sec.length).toFixed(2)
                : 0,
            tests: data.latencies.length
        })).sort((a, b) => a.avg_latency - b.avg_latency);

        res.json({
            status: 'success',
            data: {
                total_tests: successful.length + failedCount,
                successful: successful.length,
                failed: failedCount,
                avg_latency: Math.round(avgLatency),
                leaderboard
            }
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
        const sortBy = req.query.sort || 'latency'; // latency, quality, composite, speed

        const [totalTests, successCount, recentTests, modelStats] = await Promise.all([
            BenchmarkResult.countDocuments(),
            BenchmarkResult.countDocuments({ success: true }),
            BenchmarkResult.find().sort({ timestamp: -1 }).limit(10).lean(),
            BenchmarkResult.aggregate([
                { $match: { success: true } },
                {
                    $group: {
                        _id: { model: '$model', host: '$host' },
                        avg_latency: { $avg: '$latency' },
                        avg_tokens_per_sec: { $avg: '$tokens_per_sec' }, // Mongoose stores as number now
                        avg_quality: {
                            $avg: {
                                $cond: [
                                    { $ne: ['$quality_score', null] },
                                    '$quality_score',
                                    null
                                ]
                            }
                        },
                        avg_composite: {
                            $avg: {
                                $cond: [
                                    { $ne: ['$composite_score', null] },
                                    '$composite_score',
                                    null
                                ]
                            }
                        },
                        quality_tests: {
                            $sum: {
                                $cond: [
                                    { $ne: ['$quality_score', null] },
                                    1,
                                    0
                                ]
                            }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { avg_latency: 1 } }
            ])
        ]);

        let sortedStats = modelStats.map(m => ({
            model: m._id.model,
            host: m._id.host,
            avg_latency: Math.round(m.avg_latency || 0),
            avg_tokens_per_sec: m.avg_tokens_per_sec ? m.avg_tokens_per_sec.toFixed(2) : '0',
            avg_quality: m.avg_quality != null ? m.avg_quality.toFixed(1) : null,
            avg_composite: m.avg_composite != null ? m.avg_composite.toFixed(1) : null,
            quality_tests: m.quality_tests || 0,
            tests: m.count
        }));

        // Apply sorting
        switch (sortBy) {
            case 'quality':
                sortedStats.sort((a, b) => (b.avg_quality || 0) - (a.avg_quality || 0));
                break;
            case 'composite':
                sortedStats.sort((a, b) => (b.avg_composite || 0) - (a.avg_composite || 0));
                break;
            case 'speed':
                sortedStats.sort((a, b) => parseFloat(b.avg_tokens_per_sec) - parseFloat(a.avg_tokens_per_sec));
                break;
            case 'latency':
            default:
                sortedStats.sort((a, b) => a.avg_latency - b.avg_latency);
        }

        res.json({
            status: 'success',
            data: {
                overview: {
                    total_tests: totalTests,
                    successful: successCount,
                    failed: totalTests - successCount,
                    success_rate: totalTests > 0
                        ? ((successCount / totalTests) * 100).toFixed(1) + '%'
                        : '0%'
                },
                recent_tests: recentTests,
                model_stats: sortedStats,
                sorted_by: sortBy
            }
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
        const comparison = await Promise.all(
            modelList.map(async (model) => {
                const tests = await BenchmarkResult.find({ model, success: true }).lean();

                if (tests.length === 0) {
                    return { model, error: 'No successful tests found' };
                }

                const latencies = tests.map(t => t.latency);
                const tokensPerSec = tests.map(t => parseFloat(t.tokens_per_sec)).filter(t => t > 0);

                return {
                    model,
                    tests: tests.length,
                    avg_latency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
                    min_latency: Math.min(...latencies),
                    max_latency: Math.max(...latencies),
                    avg_tokens_per_sec: tokensPerSec.length > 0
                        ? (tokensPerSec.reduce((a, b) => a + b, 0) / tokensPerSec.length).toFixed(2)
                        : '0'
                };
            })
        );

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
        const result = await BenchmarkResult.deleteMany({});
        logger.info('Benchmark results cleared', { count: result.deletedCount });
        res.json({
            status: 'success',
            message: `Cleared ${result.deletedCount} results`
        });
    } catch (err) {
        logger.error('Failed to clear results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/prompts
 * Get all prompts grouped by level
 */
router.get('/prompts', async (req, res) => {
    try {
        await benchmarkService.seedPrompts();
        const prompts = await BenchmarkPrompt.find()
            .sort({ level: 1, category: 1 })
            .lean();

        const byLevel = {};
        prompts.forEach(p => {
            if (!byLevel[p.level]) byLevel[p.level] = [];
            byLevel[p.level].push(p);
        });

        res.json({
            status: 'success',
            data: {
                prompts,
                by_level: byLevel,
                total: prompts.length
            }
        });
    } catch (err) {
        logger.error('Failed to fetch prompts', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch
 * Start a batch benchmark
 */
router.post('/batch', async (req, res) => {
    try {
        const batch = await benchmarkService.startBatch(req.body);
        res.json({
            status: 'success',
            data: {
                batch_id: batch._id,
                total_tests: batch.total_tests,
                quality_scoring: batch.quality_scoring,
                plan: batch.plan,
                message: `Batch test started${batch.quality_scoring ? ' with quality scoring' : ''}`
            }
        });
    } catch (err) {
        if (err.message.includes('required')) {
            return res.status(400).json({ status: 'error', error: err.message });
        }
        logger.error('Failed to start batch test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/stop
 */
router.post('/batch/:id/stop', async (req, res) => {
    try {
        const result = await BenchmarkBatch.updateOne(
            { _id: req.params.id, status: { $in: ['running', 'judging'] } },
            { $set: { status: 'stopped', completed_at: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                status: 'error',
                error: 'Batch not found or not running'
            });
        }

        logger.info('Batch stopped by user', { batchId: req.params.id });
        res.json({ status: 'success', message: 'Batch stopped' });
    } catch (err) {
        logger.error('Failed to stop batch', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id
 */
router.get('/batch/:id', async (req, res) => {
    try {
        const batch = await BenchmarkBatch.findById(req.params.id).lean();

        if (!batch) {
            return res.status(404).json({
                status: 'error',
                error: 'Batch not found'
            });
        }

        const progress = batch.total_tests > 0
            ? Math.min(Math.round((batch.completed / batch.total_tests) * 100), 100)
            : 0;

        const judge_progress = batch.judge_total > 0
            ? Math.min(Math.round(((batch.judge_completed || 0) / batch.judge_total) * 100), 100)
            : 0;

        const results = await BenchmarkResult.find({ batch_id: req.params.id })
            .sort({ timestamp: -1 })
            .lean();

        // Calculate judge stats (re-implementation of logic from old controller)
        const judgedResults = results.filter(r => r.quality_score !== null && r.scoring_time_ms);
        const avgJudgeTime = judgedResults.length > 0
            ? judgedResults.reduce((acc, r) => acc + (r.scoring_time_ms || 0), 0) / judgedResults.length
            : 0;
        
        const judgeStats = {
            avg_time_ms: Math.round(avgJudgeTime),
            lag: Math.max(0, batch.completed - (batch.judge_completed || 0)),
            completed: batch.judge_completed || 0,
            total: batch.judge_total || 0,
            concurrency: (batch.judge_config && batch.judge_config.concurrency) || 2
        };

        const formattedResults = results.map(r => ({
            id: r._id.toString(),
            ...r
        }));

        res.json({
            status: 'success',
            data: {
                ...batch,
                results: formattedResults,
                progress,
                judge_progress,
                judge_stats: judgeStats,
                success_rate: batch.completed > 0
                    ? (((batch.completed - batch.failed) / batch.completed) * 100).toFixed(1) + '%'
                    : '0%'
            }
        });
    } catch (err) {
        logger.error('Failed to fetch batch', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches
 */
router.get('/batches', async (req, res) => {
    try {
        const batches = await BenchmarkBatch.find()
            .sort({ created_at: -1 })
            .limit(20)
            .lean();

        res.json({
            status: 'success',
            data: { batches, total: batches.length }
        });
    } catch (err) {
        logger.error('Failed to fetch batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/quality-breakdown
 */
router.get('/quality-breakdown', async (req, res) => {
    try {
        const { model } = req.query;

        const matchStage = {
            success: true,
            quality_score: { $ne: null }
        };
        if (model) matchStage.model = model;

        const [byCategory, byLevel, byModel] = await Promise.all([
            BenchmarkResult.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: { model: '$model', category: '$prompt_category' },
                        avg_quality: { $avg: '$quality_score' },
                        avg_latency: { $avg: '$latency' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { '_id.model': 1, avg_quality: -1 } }
            ]),

            BenchmarkResult.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: { model: '$model', level: '$prompt_level' },
                        avg_quality: { $avg: '$quality_score' },
                        avg_latency: { $avg: '$latency' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { '_id.model': 1, '_id.level': 1 } }
            ]),

            BenchmarkResult.aggregate([
                { $match: matchStage },
                {
                    $group: {
                        _id: '$model',
                        avg_quality: { $avg: '$quality_score' },
                        avg_composite: { $avg: '$composite_score' },
                        avg_latency: { $avg: '$latency' },
                        best_category: { $max: '$quality_score' },
                        worst_category: { $min: '$quality_score' },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { avg_composite: -1 } }
            ])
        ]);

        const categoryByModel = {};
        byCategory.forEach(item => {
            const modelName = item._id.model;
            if (!categoryByModel[modelName]) categoryByModel[modelName] = {};
            categoryByModel[modelName][item._id.category] = {
                avg_quality: item.avg_quality.toFixed(1),
                avg_latency: Math.round(item.avg_latency),
                tests: item.count
            };
        });

        const levelByModel = {};
        byLevel.forEach(item => {
            const modelName = item._id.model;
            if (!levelByModel[modelName]) levelByModel[modelName] = {};
            levelByModel[modelName][`level_${item._id.level}`] = {
                avg_quality: item.avg_quality.toFixed(1),
                avg_latency: Math.round(item.avg_latency),
                tests: item.count
            };
        });

        res.json({
            status: 'success',
            data: {
                overall: byModel.map(m => ({
                    model: m._id,
                    avg_quality: m.avg_quality.toFixed(1),
                    avg_composite: m.avg_composite ? m.avg_composite.toFixed(1) : null,
                    avg_latency: Math.round(m.avg_latency),
                    quality_range: {
                        best: m.best_category.toFixed(1),
                        worst: m.worst_category.toFixed(1)
                    },
                    tests: m.count
                })),
                by_category: categoryByModel,
                by_level: levelByModel,
                categories: ['coding', 'reasoning', 'factual', 'math', 'creative'],
                levels: [1, 2, 3, 4, 5]
            }
        });
    } catch (err) {
        logger.error('Failed to fetch quality breakdown', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
