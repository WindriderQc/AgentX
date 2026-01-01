/**
 * Benchmark Routes
 * LLM performance testing and metrics with quality scoring
 */

const express = require('express');
const router = express.Router();
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const mongoose = require('mongoose');
const logger = require('../config/logger');
const fs = require('fs').promises;
const path = require('path');
const { ObjectId } = mongoose.Types;
const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG } = require('../src/services/qualityScorer');

// Get MongoDB collections using Mongoose connection
function getCollection() {
    return mongoose.connection.db.collection('benchmark_results');
}

function getPromptsCollection() {
    return mongoose.connection.db.collection('benchmark_prompts');
}

function getBatchCollection() {
    return mongoose.connection.db.collection('benchmark_batches');
}

// Seed prompts from JSON file if collection is empty
async function seedPrompts() {
    const promptsCollection = getPromptsCollection();
    const count = await promptsCollection.countDocuments();

    if (count === 0) {
        const promptsPath = path.join(__dirname, '..', 'data', 'benchmark-prompts.json');
        const promptsData = await fs.readFile(promptsPath, 'utf-8');
        const prompts = JSON.parse(promptsData);

        await promptsCollection.insertMany(prompts.map(p => ({
            ...p,
            custom: false,
            created_at: new Date()
        })));

        logger.info('Seeded benchmark prompts', { count: prompts.length });
    }
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
 * Get dashboard data with charts and stats including quality metrics
 */
router.get('/dashboard', async (req, res) => {
    try {
        const resultsCollection = getCollection();
        const sortBy = req.query.sort || 'latency'; // latency, quality, composite, speed

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
                        avg_quality: { 
                            $avg: { 
                                $cond: [
                                    { $and: [
                                        { $ne: ['$quality_score', null] },
                                        { $ne: [{ $type: '$quality_score' }, 'missing'] }
                                    ]},
                                    '$quality_score',
                                    null
                                ]
                            }
                        },
                        avg_composite: { 
                            $avg: { 
                                $cond: [
                                    { $and: [
                                        { $ne: ['$composite_score', null] },
                                        { $ne: [{ $type: '$composite_score' }, 'missing'] }
                                    ]},
                                    '$composite_score',
                                    null
                                ]
                            }
                        },
                        quality_tests: { 
                            $sum: { 
                                $cond: [
                                    { $and: [
                                        { $ne: ['$quality_score', null] },
                                        { $ne: [{ $type: '$quality_score' }, 'missing'] }
                                    ]},
                                    1,
                                    0
                                ]
                            }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { avg_latency: 1 } }
            ]).toArray()
        ]);

        // Sort model stats based on query param
        let sortedStats = modelStats.map(m => {
            // Handle null/undefined quality scores
            const hasQuality = m.avg_quality != null && !isNaN(m.avg_quality);
            const hasComposite = m.avg_composite != null && !isNaN(m.avg_composite);
            
            return {
                model: m._id,
                avg_latency: Math.round(m.avg_latency || 0),
                avg_tokens_per_sec: m.avg_tokens_per_sec ? m.avg_tokens_per_sec.toFixed(2) : '0',
                avg_quality: hasQuality ? m.avg_quality.toFixed(1) : null,
                avg_composite: hasComposite ? m.avg_composite.toFixed(1) : null,
                quality_tests: m.quality_tests || 0,
                tests: m.count
            };
        });

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

/**
 * GET /api/benchmark/prompts
 * Get all prompts grouped by level
 */
router.get('/prompts', async (req, res) => {
    try {
        await seedPrompts(); // Ensure prompts are seeded
        const promptsCollection = getPromptsCollection();

        const prompts = await promptsCollection
            .find()
            .sort({ level: 1, category: 1 })
            .toArray();

        // Group by level
        const byLevel = {};
        prompts.forEach(p => {
            if (!byLevel[p.level]) {
                byLevel[p.level] = [];
            }
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
 * Start a batch benchmark test with optional quality scoring
 * Body: { host, models: ['model1', 'model2'], levels: [1, 2, 3], quality_scoring: true }
 */
router.post('/batch', async (req, res) => {
    const { host, models, levels, run_name, quality_scoring = true } = req.body;

    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        return res.status(400).json({
            status: 'error',
            error: 'host, models (array), and levels (array) are required'
        });
    }

    try {
        await seedPrompts(); // Ensure prompts are seeded
        const promptsCollection = getPromptsCollection();
        const batchCollection = getBatchCollection();

        // Get prompts for selected levels
        const selectedPrompts = await promptsCollection
            .find({ level: { $in: levels } })
            .toArray();

        if (selectedPrompts.length === 0) {
            return res.status(400).json({
                status: 'error',
                error: 'No prompts found for selected levels'
            });
        }

        // Create batch record
        const batch = {
            host,
            models,
            levels,
            quality_scoring,
            run_name: run_name || `Batch ${new Date().toLocaleString()}`,
            total_tests: models.length * selectedPrompts.length,
            completed: 0,
            failed: 0,
            status: 'running',
            results: [],
            created_at: new Date(),
            started_at: new Date(),
            completed_at: null
        };

        const insertResult = await batchCollection.insertOne(batch);
        const batchId = insertResult.insertedId.toString();

        // Start batch execution in background with quality scoring option
        executeBatch(batchId, host, models, selectedPrompts, { quality_scoring }).catch(err => {
            logger.error('Batch execution failed', { batchId, error: err.message });
        });

        res.json({
            status: 'success',
            data: {
                batch_id: batchId,
                total_tests: batch.total_tests,
                quality_scoring,
                message: `Batch test started${quality_scoring ? ' with quality scoring' : ''}`
            }
        });
    } catch (err) {
        logger.error('Failed to start batch test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * Execute batch tests sequentially
 */
async function executeBatch(batchId, host, models, prompts, options = {}) {
    const batchCollection = getBatchCollection();
    const resultsCollection = getCollection();
    const enableQualityScoring = options.quality_scoring !== false; // Default enabled

    for (const model of models) {
        for (const prompt of prompts) {
            try {
                const start = Date.now();
                const response = await fetch(`${host}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, prompt: prompt.prompt, stream: false }),
                    timeout: 60000 // 60s timeout for complex prompts
                });

                const data = await response.json();
                const latency = Date.now() - start;
                const tokens = Math.ceil((data.response || '').length / 4);
                const tokens_per_sec = tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0;

                // Quality scoring (if enabled and not the judge model itself)
                let qualityData = {};
                if (enableQualityScoring && model !== JUDGE_CONFIG.model) {
                    try {
                        const scores = await scoreResponse({
                            response: data.response || '',
                            prompt: prompt
                        });
                        
                        const composite = calculateCompositeScore({
                            latency,
                            tokens_per_sec,
                            quality_score: scores.quality_score
                        });
                        
                        qualityData = {
                            quality_score: scores.quality_score,
                            quality_breakdown: scores.breakdown,
                            quality_explanation: scores.explanation,
                            scoring_method: scores.scoring_method,
                            scoring_type: prompt.scoring_type,
                            composite_score: composite.composite_score,
                            normalized_scores: composite.normalized
                        };
                    } catch (scoreErr) {
                        logger.warn('Quality scoring failed', { model, prompt: prompt.name, error: scoreErr.message });
                        qualityData = { quality_score: null, scoring_error: scoreErr.message };
                    }
                }

                const result = {
                    model,
                    host,
                    prompt: prompt.prompt,
                    prompt_level: prompt.level,
                    prompt_category: prompt.category,
                    prompt_name: prompt.name,
                    expected_answer: prompt.expected_answer,
                    latency,
                    tokens,
                    tokens_per_sec,
                    response: data.response || '',
                    success: true,
                    batch_id: batchId,
                    timestamp: new Date(),
                    ...qualityData
                };

                await resultsCollection.insertOne(result);
                await batchCollection.updateOne(
                    { _id: new ObjectId(batchId) },
                    {
                        $inc: { completed: 1 },
                        $push: { 
                            results: { 
                                model, 
                                prompt_name: prompt.name, 
                                success: true, 
                                latency,
                                quality_score: qualityData.quality_score,
                                composite_score: qualityData.composite_score
                            } 
                        }
                    }
                );

                logger.info('Batch test completed', { batchId, model, prompt: prompt.name, latency });

            } catch (err) {
                const result = {
                    model,
                    host,
                    prompt: prompt.prompt,
                    prompt_level: prompt.level,
                    prompt_category: prompt.category,
                    prompt_name: prompt.name,
                    error: err.message,
                    success: false,
                    batch_id: batchId,
                    timestamp: new Date()
                };

                await resultsCollection.insertOne(result);
                await batchCollection.updateOne(
                    { _id: new ObjectId(batchId) },
                    {
                        $inc: { completed: 1, failed: 1 },
                        $push: { results: { model, prompt_name: prompt.name, success: false, error: err.message } }
                    }
                );

                logger.error('Batch test failed', { batchId, model, prompt: prompt.name, error: err.message });
            }
        }
    }

    // Mark batch as complete
    await batchCollection.updateOne(
        { _id: new ObjectId(batchId) },
        {
            $set: {
                status: 'completed',
                completed_at: new Date()
            }
        }
    );

    logger.info('Batch execution completed', { batchId });
}

/**
 * GET /api/benchmark/batch/:id
 * Get batch progress and results
 */
router.get('/batch/:id', async (req, res) => {
    try {
        const batchCollection = getBatchCollection();

        const batch = await batchCollection.findOne({ _id: new ObjectId(req.params.id) });

        if (!batch) {
            return res.status(404).json({
                status: 'error',
                error: 'Batch not found'
            });
        }

        const progress = batch.total_tests > 0
            ? Math.round((batch.completed / batch.total_tests) * 100)
            : 0;

        res.json({
            status: 'success',
            data: {
                ...batch,
                progress,
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
 * Get all batch runs
 */
router.get('/batches', async (req, res) => {
    try {
        const batchCollection = getBatchCollection();
        const batches = await batchCollection
            .find()
            .sort({ created_at: -1 })
            .limit(20)
            .toArray();

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
 * Get quality scores broken down by category and level
 */
router.get('/quality-breakdown', async (req, res) => {
    try {
        const resultsCollection = getCollection();
        const { model } = req.query;
        
        const matchStage = { 
            success: true, 
            quality_score: { $ne: null } 
        };
        if (model) matchStage.model = model;

        const [byCategory, byLevel, byModel] = await Promise.all([
            // Breakdown by category (coding, reasoning, factual, etc.)
            resultsCollection.aggregate([
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
            ]).toArray(),
            
            // Breakdown by level (1-5)
            resultsCollection.aggregate([
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
            ]).toArray(),
            
            // Overall by model
            resultsCollection.aggregate([
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
            ]).toArray()
        ]);

        // Restructure category data by model
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

        // Restructure level data by model
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
