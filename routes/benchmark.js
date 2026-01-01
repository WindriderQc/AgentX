/**
 * Benchmark Routes
 * LLM performance testing and metrics
 */

const express = require('express');
const router = express.Router();
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const mongoose = require('mongoose');
const logger = require('../config/logger');

// Get MongoDB collection using Mongoose connection
function getCollection() {
    return mongoose.connection.db.collection('benchmark_results');
}

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
    const resultsCollection = getCollection();

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

        const result = {
            model,
            host,
            prompt,
            latency,
            tokens,
            tokens_per_sec: tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0,
            response: data.response || '',
            success: true,
            timestamp: new Date()
        };

        await resultsCollection.insertOne(result);
        logger.info('Benchmark test completed', {
            model, host, latency, tokens_per_sec: result.tokens_per_sec
        });

        res.json({
            status: 'success',
            data: result
        });

    } catch (err) {
        const result = {
            model,
            host,
            prompt,
            error: err.message,
            success: false,
            timestamp: new Date()
        };

        await resultsCollection.insertOne(result);
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
        const resultsCollection = getCollection();

        const results = await resultsCollection
            .find()
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();

        const total = await resultsCollection.countDocuments();

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
        const resultsCollection = getCollection();

        const [successful, failed] = await Promise.all([
            resultsCollection.find({ success: true }).toArray(),
            resultsCollection.countDocuments({ success: false })
        ]);

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

        // Group by model
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
                total_tests: successful.length + failed,
                successful: successful.length,
                failed,
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
 * Get dashboard data with charts and stats
 */
router.get('/dashboard', async (req, res) => {
    try {
        const resultsCollection = getCollection();

        const [totalTests, successCount, recentTests, modelStats] = await Promise.all([
            resultsCollection.countDocuments(),
            resultsCollection.countDocuments({ success: true }),
            resultsCollection.find().sort({ timestamp: -1 }).limit(10).toArray(),
            resultsCollection.aggregate([
                { $match: { success: true } },
                {
                    $group: {
                        _id: '$model',
                        avg_latency: { $avg: '$latency' },
                        avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { avg_latency: 1 } }
            ]).toArray()
        ]);

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
                model_stats: modelStats.map(m => ({
                    model: m._id,
                    avg_latency: Math.round(m.avg_latency),
                    avg_tokens_per_sec: m.avg_tokens_per_sec
                        ? m.avg_tokens_per_sec.toFixed(2)
                        : '0',
                    tests: m.count
                }))
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
        const resultsCollection = getCollection();

        const comparison = await Promise.all(
            modelList.map(async (model) => {
                const tests = await resultsCollection
                    .find({ model, success: true })
                    .toArray();

                if (tests.length === 0) {
                    return { model, error: 'No successful tests found' };
                }

                const latencies = tests.map(t => t.latency);
                const tokensPerSec = tests.map(t => parseFloat(t.tokens_per_sec))
                    .filter(t => t > 0);

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
        const resultsCollection = getCollection();
        const count = await resultsCollection.countDocuments();
        await resultsCollection.deleteMany({});

        logger.info('Benchmark results cleared', { count });

        res.json({
            status: 'success',
            message: `Cleared ${count} results`
        });
    } catch (err) {
        logger.error('Failed to clear results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
