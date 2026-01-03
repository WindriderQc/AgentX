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
const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG, SCORING_CONFIGS } = require('../src/services/qualityScorer');
const { HOSTS, MODEL_ROUTING } = require('../src/services/modelRouter');

// Simple Concurrency Queue for managing parallel tasks (like judging)
class ConcurrencyQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
        this.activePromises = [];
    }

    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const { task, resolve, reject } = this.queue.shift();

        const promise = (async () => {
            try {
                const result = await task();
                resolve(result);
            } catch (err) {
                reject(err);
            } finally {
                this.running--;
                // Remove from active promises
                const idx = this.activePromises.indexOf(promise);
                if (idx > -1) this.activePromises.splice(idx, 1);
                this.process();
            }
        })();

        this.activePromises.push(promise);
    }

    // Wait for all tasks to complete
    async drain() {
        while (this.queue.length > 0 || this.running > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

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
 * GET /api/benchmark/config
 * Get benchmark configuration including judge settings
 */
router.get('/config', (req, res) => {
    res.json({
        status: 'success',
        data: {
            judge_config: JUDGE_CONFIG,
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
 * Body: { host, models: ['model1', 'model2'], levels: [1, 2, 3], quality_scoring: true, judge_config: {...} }
 */
router.post('/batch', async (req, res) => {
    const { host, models, levels, run_name, quality_scoring = true, judge_config } = req.body;

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
        // Compute a simple plan for UI display (exec host(s), judge host(s), counts)
        const modelsByHost = {};
        for (const model of models) {
            let targetHost = host;
            if (MODEL_ROUTING[model]) {
                targetHost = HOSTS[MODEL_ROUTING[model]];
            }
            if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
            modelsByHost[targetHost].push(model);
        }

        const execHosts = Object.entries(modelsByHost).map(([exec_host, hostModels]) => {
            let judge_host = HOSTS.primary;
            if (exec_host === HOSTS.primary) judge_host = HOSTS.secondary;
            else if (exec_host === HOSTS.secondary) judge_host = HOSTS.primary;

            return {
                exec_host,
                judge_host: quality_scoring ? judge_host : null,
                models: hostModels,
                tests: hostModels.length * selectedPrompts.length
            };
        });

        const categoryCounts = {};
        for (const p of selectedPrompts) {
            const cat = p.category || 'uncategorized';
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
        }

        const categories = Object.entries(categoryCounts)
            .map(([category, prompt_count]) => ({
                category,
                prompt_count,
                tests: prompt_count * models.length
            }))
            .sort((a, b) => b.tests - a.tests);

        const plan = {
            exec_hosts: execHosts,
            judge_model: (judge_config && judge_config.model) ? judge_config.model : null,
            total_models: models.length,
            total_prompts: selectedPrompts.length,
            categories
        };

        const batch = {
            host,
            models,
            levels,
            quality_scoring,
            judge_config,
            run_name: run_name || `Batch ${new Date().toLocaleString()}`,
            total_tests: models.length * selectedPrompts.length,
            plan,
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
        executeBatch(batchId, host, models, selectedPrompts, { quality_scoring, judge_config }).catch(err => {
            logger.error('Batch execution failed', { batchId, error: err.message });
        });

        res.json({
            status: 'success',
            data: {
                batch_id: batchId,
                total_tests: batch.total_tests,
                quality_scoring,
                plan,
                message: `Batch test started${quality_scoring ? ' with quality scoring' : ''}`
            }
        });
    } catch (err) {
        logger.error('Failed to start batch test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * Execute batch tests with parallel host execution
 */
async function executeBatch(batchId, defaultHost, models, prompts, options = {}) {
    const batchCollection = getBatchCollection();
    const resultsCollection = getCollection();
    const enableQualityScoring = options.quality_scoring !== false;
    const judgeConfig = options.judge_config || {};

    // Group models by host
    const modelsByHost = {};
    
    for (const model of models) {
        // Determine host for this model
        let targetHost = defaultHost;
        
        // Check if model has a specific host assignment
        if (MODEL_ROUTING[model]) {
            targetHost = HOSTS[MODEL_ROUTING[model]];
        }
        
        if (!modelsByHost[targetHost]) {
            modelsByHost[targetHost] = [];
        }
        modelsByHost[targetHost].push(model);
    }

    // Create execution promises for each host
    const hostPromises = Object.entries(modelsByHost).map(async ([hostUrl, hostModels]) => {
        // Determine judge host (opposite of execution host) to optimize performance
        let judgeHostUrl = HOSTS.primary; 
        if (hostUrl === HOSTS.primary) {
            judgeHostUrl = HOSTS.secondary;
        } else if (hostUrl === HOSTS.secondary) {
            judgeHostUrl = HOSTS.primary;
        }

        for (const model of hostModels) {
            for (const prompt of prompts) {
                // Check if batch was stopped
                const currentBatch = await batchCollection.findOne({ _id: new ObjectId(batchId) });
                if (currentBatch && currentBatch.status === 'stopped') {
                    logger.info('Batch execution stopped by user', { batchId });
                    return; // Stop processing this host
                }

                try {
                    const start = Date.now();
                    const response = await fetch(`${hostUrl}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, prompt: prompt.prompt, stream: false }),
                        timeout: 60000 // 60s timeout for complex prompts
                    });

                    const data = await response.json();
                    const latency = Date.now() - start;
                    const tokens = Math.ceil((data.response || '').length / 4);
                    const tokens_per_sec = tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0;

                    // Initial result without quality score
                    const result = {
                        model,
                        host: hostUrl,
                        judge_host: enableQualityScoring ? judgeHostUrl : null,
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
                        quality_score: null, // Will be updated if scoring is enabled
                        scoring_method: enableQualityScoring ? 'pending' : 'disabled'
                    };

                    const insertResult = await resultsCollection.insertOne(result);
                    const resultId = insertResult.insertedId;

                    // Update batch progress
                    await batchCollection.updateOne(
                        { _id: new ObjectId(batchId) },
                        {
                            $inc: { completed: 1 },
                            $push: { 
                                results: { 
                                    model, 
                                    host: hostUrl,
                                    judge_host: enableQualityScoring ? judgeHostUrl : null,
                                    prompt_name: prompt.name, 
                                    success: true, 
                                    latency,
                                    response_preview: (data.response || '').substring(0, 100) + '...'
                                } 
                            }
                        }
                    );

                    // Queue quality scoring if enabled (judge even if model == judge model)
                    if (enableQualityScoring) {
                        judgeQueue.enqueue(async () => {
                            try {
                                const scores = await scoreResponse({
                                    response: data.response || '',
                                    prompt: prompt,
                                    judgeConfig: {
                                        ...judgeConfig,
                                        host: judgeHostUrl
                                    }
                                });
                                
                                const composite = calculateCompositeScore({
                                    latency,
                                    tokens_per_sec,
                                    quality_score: scores.quality_score
                                });
                                
                                // Update the specific result with scores
                                await resultsCollection.updateOne(
                                    { _id: resultId },
                                    { 
                                        $set: {
                                            quality_score: scores.quality_score,
                                            quality_breakdown: scores.breakdown,
                                            quality_explanation: scores.explanation,
                                            judge_prompt: scores.judge_prompt,
                                            judge_model: scores.judge_model,
                                            scoring_method: scores.scoring_method,
                                            scoring_type: prompt.scoring_type,
                                            quick_pattern: scores.quick_pattern,
                                            composite_score: composite.composite_score,
                                            normalized_scores: composite.normalized
                                        }
                                    }
                                );
                            } catch (scoreErr) {
                                logger.warn('Quality scoring failed', { model, prompt: prompt.name, error: scoreErr.message });
                                await resultsCollection.updateOne(
                                    { _id: resultId },
                                    { $set: { scoring_method: 'llm_failed', quality_explanation: scoreErr.message, judge_model: judgeConfig.model || JUDGE_CONFIG.model } }
                                );
                            }
                        });
                    }

                    logger.info('Batch test completed', { batchId, model, prompt: prompt.name, latency });

                } catch (err) {
                    const result = {
                        model,
                        host: hostUrl,
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
                            $inc: { completed: 1 },
                            $push: { 
                                results: { 
                                    model, 
                                    prompt_name: prompt.name, 
                                    success: false, 
                                    error: err.message 
                                } 
                            }
                        }
                    );
                    logger.error('Batch test failed', { batchId, model, prompt: prompt.name, error: err.message });
                }
            }
        }
    });

    // Wait for all host executions to complete
    await Promise.all(hostPromises);

    // Wait for any remaining judge tasks
    // Note: We don't strictly need to wait for judging to finish to mark batch as "completed" in terms of generation,
    // but it's nice to know when everything is done. 
    // However, for UI responsiveness, we might want to mark as completed_at now.
    
    await batchCollection.updateOne(
        { _id: new ObjectId(batchId) },
        { 
            $set: { 
                completed_at: new Date(),
                status: 'completed'
            } 
        }
    );
}



/**
 * GET /api/benchmark/batch/:id
 * Get batch progress and results
 */
router.get('/batch/:id', async (req, res) => {
    try {
        const batchCollection = getBatchCollection();
        const resultsCollection = getCollection();

        const batch = await batchCollection.findOne({ _id: new ObjectId(req.params.id) });

        if (!batch) {
            return res.status(404).json({
                status: 'error',
                error: 'Batch not found'
            });
        }

        const progress = batch.total_tests > 0
            ? Math.min(Math.round((batch.completed / batch.total_tests) * 100), 100)
            : 0;

        // Hydrate results from benchmark_results to include latest judge data
        const results = await resultsCollection
            .find({ batch_id: req.params.id })
            .sort({ timestamp: -1 })
            .toArray();

        const formattedResults = results.map((r) => ({
            id: r._id ? r._id.toString() : null,
            model: r.model,
            host: r.host,
            judge_host: r.judge_host || null,
            prompt_name: r.prompt_name,
            prompt_level: r.prompt_level,
            prompt_category: r.prompt_category,
            expected_answer: r.expected_answer,
            latency: r.latency,
            tokens_per_sec: r.tokens_per_sec,
            quality_score: r.quality_score,
            quality_explanation: r.quality_explanation,
            judge_prompt: r.judge_prompt,
            judge_model: r.judge_model,
            scoring_method: r.scoring_method,
            quick_pattern: r.quick_pattern,
            composite_score: r.composite_score,
            success: r.success,
            error: r.error,
            response_preview: r.response
                ? `${r.response.substring(0, 100)}...`
                : (r.response_preview || ''),
            timestamp: r.timestamp
        }));

        res.json({
            status: 'success',
            data: {
                ...batch,
                results: formattedResults,
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
