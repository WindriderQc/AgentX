/**
 * Benchmark Service
 * Business logic for LLM performance testing and quality scoring
 * Implements Service-Oriented Architecture pattern
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const fs = require('fs').promises;
const path = require('path');
const { ObjectId } = require('mongoose').Types;

// Models
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');

// Services
const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG } = require('./qualityScorer');
const { HOSTS, MODEL_ROUTING } = require('./modelRouter');

// Simple Concurrency Queue for managing parallel judge tasks
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
                const idx = this.activePromises.indexOf(promise);
                if (idx > -1) this.activePromises.splice(idx, 1);
                this.process();
            }
        })();

        this.activePromises.push(promise);
    }

    async drain() {
        while (this.queue.length > 0 || this.running > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

class BenchmarkService {
    /**
     * Seed prompts from JSON file if database is empty
     */
    async seedPrompts() {
        const count = await BenchmarkPrompt.countDocuments();

        if (count === 0) {
            const promptsPath = path.join(__dirname, '..', '..', 'data', 'benchmark-prompts.json');
            const promptsData = await fs.readFile(promptsPath, 'utf-8');
            const prompts = JSON.parse(promptsData);

            const seededCount = await BenchmarkPrompt.seedFromArray(prompts);
            logger.info('Seeded benchmark prompts', { count: seededCount });

            return seededCount;
        }

        return 0;
    }

    /**
     * Cleanup stale batches on startup
     */
    async cleanupStaleBatches() {
        try {
            const count = await BenchmarkBatch.cleanupStale();
            if (count > 0) {
                logger.info('Cleaned up stale batches', { count });
            }
            return count;
        } catch (err) {
            logger.error('Failed to cleanup stale batches', { error: err.message });
            throw err;
        }
    }

    /**
     * Get all prompts grouped by level
     */
    async getPrompts() {
        await this.seedPrompts();
        const { prompts, byLevel } = await BenchmarkPrompt.getAllGroupedByLevel();

        return {
            prompts,
            by_level: byLevel,
            total: prompts.length
        };
    }

    /**
     * Run a single benchmark test
     */
    async runTest({ model, host, prompt }) {
        if (!model || !host || !prompt) {
            throw new Error('model, host, and prompt are required');
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
                success: true,
                timestamp: new Date()
            });

            await result.save();

            logger.info('Benchmark test completed', {
                model, host, latency, tokens_per_sec: result.tokens_per_sec
            });

            return result;

        } catch (err) {
            const result = new BenchmarkResult({
                model,
                host,
                prompt,
                error: err.message,
                success: false,
                timestamp: new Date()
            });

            await result.save();
            logger.error('Benchmark test failed', { model, host, error: err.message });

            throw err;
        }
    }

    /**
     * Get paginated test results
     */
    async getResults({ limit = 20 } = {}) {
        const results = await BenchmarkResult.find()
            .sort({ timestamp: -1 })
            .limit(limit);

        const total = await BenchmarkResult.countDocuments();

        return { results, total };
    }

    /**
     * Generate summary statistics and leaderboard
     */
    async getSummary() {
        const [successful, failed] = await Promise.all([
            BenchmarkResult.find({ success: true }),
            BenchmarkResult.countDocuments({ success: false })
        ]);

        if (successful.length === 0) {
            return {
                total_tests: 0,
                successful: 0,
                failed: 0,
                avg_latency: 0,
                leaderboard: []
            };
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

        return {
            total_tests: successful.length + failed,
            successful: successful.length,
            failed,
            avg_latency: Math.round(avgLatency),
            leaderboard
        };
    }

    /**
     * Get dashboard data with model statistics
     */
    async getDashboard({ sortBy = 'latency' } = {}) {
        const [totalTests, successCount, recentTests, modelStats] = await Promise.all([
            BenchmarkResult.countDocuments(),
            BenchmarkResult.countDocuments({ success: true }),
            BenchmarkResult.find().sort({ timestamp: -1 }).limit(10),
            BenchmarkResult.aggregate([
                { $match: { success: true } },
                {
                    $group: {
                        _id: { model: '$model', host: '$host' },
                        avg_latency: { $avg: '$latency' },
                        avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                        avg_quality: {
                            $avg: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$quality_score', null] },
                                            { $ne: [{ $type: '$quality_score' }, 'missing'] }
                                        ]
                                    },
                                    '$quality_score',
                                    null
                                ]
                            }
                        },
                        avg_composite: {
                            $avg: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$composite_score', null] },
                                            { $ne: [{ $type: '$composite_score' }, 'missing'] }
                                        ]
                                    },
                                    '$composite_score',
                                    null
                                ]
                            }
                        },
                        quality_tests: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$quality_score', null] },
                                            { $ne: [{ $type: '$quality_score' }, 'missing'] }
                                        ]
                                    },
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

        // Format and sort model stats
        let sortedStats = modelStats.map(m => {
            const hasQuality = m.avg_quality != null && !isNaN(m.avg_quality);
            const hasComposite = m.avg_composite != null && !isNaN(m.avg_composite);

            return {
                model: m._id.model,
                host: m._id.host,
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

        return {
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
        };
    }

    /**
     * Compare multiple models
     */
    async compareModels(models) {
        if (!models || !Array.isArray(models)) {
            throw new Error('models array is required');
        }

        const comparison = await Promise.all(
            models.map(model => BenchmarkResult.getModelStats(model))
        );

        return { comparison };
    }

    /**
     * Get quality score breakdown by category and level
     */
    async getQualityBreakdown(model = null) {
        const { byCategory, byLevel, byModel } = await BenchmarkResult.getQualityBreakdown(model);

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

        return {
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
        };
    }

    /**
     * Clear all results (for testing)
     */
    async clearResults() {
        const count = await BenchmarkResult.countDocuments();
        await BenchmarkResult.deleteMany({});

        logger.info('Benchmark results cleared', { count });
        return count;
    }

    /**
     * Start a batch benchmark test
     */
    async startBatch({ host, models, levels, run_name, quality_scoring = true, judge_config = {} }) {
        if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
            throw new Error('host, models (array), and levels (array) are required');
        }

        await this.seedPrompts();

        // Get prompts for selected levels
        const selectedPrompts = await BenchmarkPrompt.getByLevels(levels);

        if (selectedPrompts.length === 0) {
            throw new Error('No prompts found for selected levels');
        }

        // Build execution plan
        const modelsByHost = {};
        for (const model of models) {
            let targetHost = host;
            // Model routing disabled for benchmark tool - respect user selection
            if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
            modelsByHost[targetHost].push(model);
        }

        const judgeSameHost = (judge_config && judge_config.judge_same_host !== undefined)
            ? !!judge_config.judge_same_host
            : false;

        const execHosts = Object.entries(modelsByHost).map(([exec_host, hostModels]) => {
            let judge_host = exec_host;
            if (!judgeSameHost) {
                judge_host = HOSTS.primary;
                if (exec_host === HOSTS.primary) judge_host = HOSTS.secondary;
                else if (exec_host === HOSTS.secondary) judge_host = HOSTS.primary;
            }

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
            judge_model: (judge_config && judge_config.model) ? judge_config.model : JUDGE_CONFIG.model,
            judge_same_host: judgeSameHost,
            total_models: models.length,
            total_prompts: selectedPrompts.length,
            categories
        };

        const batch = new BenchmarkBatch({
            host,
            models,
            levels,
            quality_scoring,
            judge_config,
            run_name: run_name || `Batch ${new Date().toLocaleString()}`,
            total_tests: models.length * selectedPrompts.length,
            plan,
            judge_same_host: judgeSameHost,
            judge_total: quality_scoring ? (models.length * selectedPrompts.length) : 0,
            status: 'running',
            started_at: new Date()
        });

        await batch.save();
        const batchId = batch._id.toString();

        // Start batch execution in background
        this.executeBatch(batchId, host, models, selectedPrompts, { quality_scoring, judge_config }).catch(err => {
            logger.error('Batch execution failed', { batchId, error: err.message });
        });

        return {
            batch_id: batchId,
            total_tests: batch.total_tests,
            quality_scoring,
            plan
        };
    }

    /**
     * Execute batch tests with parallel host execution
     */
    async executeBatch(batchId, defaultHost, models, prompts, options = {}) {
        const enableQualityScoring = options.quality_scoring !== false;
        const judgeConfig = options.judge_config || {};
        const judgeSameHost = judgeConfig.judge_same_host !== undefined ? !!judgeConfig.judge_same_host : false;

        // Prevent duplicate execution
        const batch = await BenchmarkBatch.findById(batchId);
        if (!batch) {
            logger.error('Batch not found', { batchId });
            return;
        }

        if (batch.execution_started_at) {
            logger.warn('Skipping duplicate batch execution', { batchId, pid: process.pid });
            return;
        }

        await batch.lockForExecution(process.pid);

        // Per-batch judge queue
        const judgeConcurrency = judgeConfig.concurrency || 2;
        const judgeQueue = new ConcurrencyQueue(judgeConcurrency);

        // Sync total_tests to actual plan
        const plannedTotalTests = models.length * prompts.length;
        if (plannedTotalTests > 0) {
            batch.total_tests = plannedTotalTests;
            await batch.save();
        }

        // Group models by host
        const modelsByHost = {};
        for (const model of models) {
            let targetHost = defaultHost;
            // Model routing disabled for benchmark tool
            if (!modelsByHost[targetHost]) {
                modelsByHost[targetHost] = [];
            }
            modelsByHost[targetHost].push(model);
        }

        // Create execution promises for each host
        const hostPromises = Object.entries(modelsByHost).map(async ([hostUrl, hostModels]) => {
            // Determine judge host
            let judgeHostUrl = hostUrl;
            if (!judgeSameHost) {
                judgeHostUrl = HOSTS.primary;
                if (hostUrl === HOSTS.primary) {
                    judgeHostUrl = HOSTS.secondary;
                } else if (hostUrl === HOSTS.secondary) {
                    judgeHostUrl = HOSTS.primary;
                }
            }

            for (const model of hostModels) {
                for (const prompt of prompts) {
                    // Check if batch was stopped
                    const currentBatch = await BenchmarkBatch.findById(batchId);
                    if (currentBatch && currentBatch.status === 'stopped') {
                        logger.info('Batch execution stopped by user', { batchId });
                        return;
                    }

                    try {
                        const start = Date.now();
                        const response = await fetch(`${hostUrl}/api/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model, prompt: prompt.prompt, stream: false }),
                            timeout: 60000
                        });

                        const data = await response.json();
                        const latency = Date.now() - start;
                        const tokens = Math.ceil((data.response || '').length / 4);
                        const tokens_per_sec = tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0;

                        // Create result
                        const result = new BenchmarkResult({
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
                            quality_score: null,
                            scoring_method: enableQualityScoring ? 'pending' : 'disabled',
                            judge_model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null
                        });

                        await result.save();
                        const resultId = result._id;

                        // Update batch progress
                        await BenchmarkBatch.updateOne(
                            { _id: batchId },
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

                        // Queue quality scoring if enabled
                        if (enableQualityScoring) {
                            judgeQueue.add(async () => {
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

                                    await BenchmarkResult.updateOne(
                                        { _id: resultId },
                                        {
                                            $set: {
                                                quality_score: scores.quality_score,
                                                quality_breakdown: scores.breakdown,
                                                quality_explanation: scores.explanation,
                                                judge_prompt: scores.judge_prompt,
                                                judge_model: scores.judge_model,
                                                scoring_method: scores.scoring_method,
                                                scoring_type: scores.scoring_type || prompt.scoring_type || 'reasoning',
                                                scoring_time_ms: scores.scoring_time_ms,
                                                quick_pattern: scores.quick_pattern,
                                                composite_score: composite.composite_score,
                                                normalized_scores: composite.normalized
                                            }
                                        }
                                    );

                                    await BenchmarkBatch.updateOne(
                                        { _id: batchId },
                                        { $inc: { judge_completed: 1 } }
                                    );
                                } catch (scoreErr) {
                                    logger.warn('Quality scoring failed', {
                                        model,
                                        prompt: prompt.name,
                                        error: scoreErr.message
                                    });

                                    await BenchmarkResult.updateOne(
                                        { _id: resultId },
                                        {
                                            $set: {
                                                scoring_method: 'llm_failed',
                                                quality_explanation: scoreErr.message,
                                                judge_model: judgeConfig.model || JUDGE_CONFIG.model
                                            }
                                        }
                                    );

                                    await BenchmarkBatch.updateOne(
                                        { _id: batchId },
                                        { $inc: { judge_completed: 1, judge_failed: 1 } }
                                    );
                                }
                            }).catch((enqueueErr) => {
                                logger.error('Failed to enqueue judge task', {
                                    batchId,
                                    model,
                                    prompt: prompt.name,
                                    error: enqueueErr.message
                                });
                            });
                        }

                        logger.info('Batch test completed', { batchId, model, prompt: prompt.name, latency });

                    } catch (err) {
                        const result = new BenchmarkResult({
                            model,
                            host: hostUrl,
                            prompt: prompt.prompt,
                            prompt_level: prompt.level,
                            prompt_category: prompt.category,
                            prompt_name: prompt.name,
                            error: err.message,
                            success: false,
                            batch_id: batchId,
                            timestamp: new Date(),
                            quality_score: null,
                            scoring_method: enableQualityScoring ? 'exec_failed' : 'disabled',
                            judge_model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null,
                            judge_host: enableQualityScoring ? judgeHostUrl : null
                        });

                        await result.save();

                        await BenchmarkBatch.updateOne(
                            { _id: batchId },
                            {
                                $inc: {
                                    completed: 1,
                                    failed: 1,
                                    ...(enableQualityScoring
                                        ? { judge_completed: 1, judge_failed: 1 }
                                        : {})
                                },
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

                        logger.error('Batch test failed', {
                            batchId,
                            model,
                            prompt: prompt.name,
                            error: err.message
                        });
                    }
                }
            }
        });

        // Wait for all host executions to complete
        await Promise.all(hostPromises);

        if (enableQualityScoring) {
            const postExecBatch = await BenchmarkBatch.findById(batchId);
            const wasStopped = postExecBatch && postExecBatch.status === 'stopped';
            const executedCount = postExecBatch && typeof postExecBatch.completed === 'number'
                ? postExecBatch.completed
                : plannedTotalTests;

            if (!wasStopped) {
                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    {
                        $set: {
                            status: 'judging',
                            generated_at: new Date(),
                            judge_total: executedCount
                        }
                    }
                );
            } else {
                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    { $set: { judge_total: executedCount, generated_at: new Date() } }
                );
                return;
            }

            // Wait for all judge tasks to complete
            await judgeQueue.drain();

            // Check if stopped during judging
            const postJudgeBatch = await BenchmarkBatch.findById(batchId);
            if (postJudgeBatch && postJudgeBatch.status === 'stopped') {
                return;
            }
        }

        // Mark batch as completed
        const finalBatch = await BenchmarkBatch.findById(batchId);
        if (finalBatch) {
            await finalBatch.markAsCompleted();
        }
    }

    /**
     * Stop a running batch
     */
    async stopBatch(batchId) {
        const batch = await BenchmarkBatch.findOne({
            _id: batchId,
            status: { $in: ['running', 'judging'] }
        });

        if (!batch) {
            throw new Error('Batch not found or not running');
        }

        await batch.markAsStopped();
        logger.info('Batch stopped by user', { batchId });

        return batch;
    }

    /**
     * Get batch progress and results
     */
    async getBatch(batchId) {
        const batch = await BenchmarkBatch.findById(batchId);

        if (!batch) {
            throw new Error('Batch not found');
        }

        const results = await BenchmarkResult.getByBatch(batchId);

        const defaultJudgeModel = (batch && batch.judge_config && batch.judge_config.model)
            ? batch.judge_config.model
            : JUDGE_CONFIG.model;

        const judgeSameHost = !!(
            (batch && batch.judge_same_host) ||
            (batch && batch.judge_config && batch.judge_config.judge_same_host) ||
            (batch && batch.plan && batch.plan.judge_same_host)
        );

        // Calculate judge stats
        const judgedResults = results.filter(r => r.quality_score !== null && r.scoring_time_ms);
        const avgJudgeTime = judgedResults.length > 0
            ? judgedResults.reduce((acc, r) => acc + (r.scoring_time_ms || 0), 0) / judgedResults.length
            : 0;

        const rawJudgeTotal = Number(batch.judge_total) || 0;
        const effectiveJudgeTotal = rawJudgeTotal > 0
            ? Math.min(rawJudgeTotal, Number(batch.completed) || rawJudgeTotal)
            : 0;

        const judgeCompletedCount = Number(batch.judge_completed) || 0;
        const judgeFailedCount = Number(batch.judge_failed) || 0;
        const execFailedCount = Number(batch.failed) || 0;
        const judgeLag = Math.max(0, (Number(batch.completed) || 0) - judgeCompletedCount);

        const inferredConcurrency = (batch && batch.judge_config && batch.judge_config.concurrency)
            ? Math.max(1, Number(batch.judge_config.concurrency) || 2)
            : 2;
        const inferredTimeoutMs = (batch && batch.judge_config && batch.judge_config.timeout)
            ? Math.max(1000, Number(batch.judge_config.timeout) || JUDGE_CONFIG.timeout)
            : JUDGE_CONFIG.timeout;

        const pending = effectiveJudgeTotal > 0
            ? Math.max(0, effectiveJudgeTotal - judgeCompletedCount)
            : 0;

        const etaAvgMs = (pending > 0 && avgJudgeTime > 0)
            ? Math.ceil((pending / inferredConcurrency) * avgJudgeTime)
            : null;
        const etaWorstMs = pending > 0
            ? Math.ceil((pending / inferredConcurrency) * inferredTimeoutMs)
            : null;

        const judgeStats = {
            avg_time_ms: Math.round(avgJudgeTime),
            lag: judgeLag,
            completed: judgeCompletedCount,
            total: effectiveJudgeTotal,
            pending,
            failed: judgeFailedCount,
            exec_failed: execFailedCount,
            timeout_ms: inferredTimeoutMs,
            eta_avg_ms: etaAvgMs,
            eta_worst_ms: etaWorstMs,
            concurrency: inferredConcurrency
        };

        const inferJudgeHost = (execHost) => {
            if (!execHost) return null;
            if (judgeSameHost) return execHost;
            if (execHost === HOSTS.primary) return HOSTS.secondary;
            if (execHost === HOSTS.secondary) return HOSTS.primary;
            return HOSTS.primary;
        };

        const formattedResults = results.map((r) => {
            const inferredJudgeHost = batch.quality_scoring !== false
                ? (r.judge_host || inferJudgeHost(r.host))
                : null;

            const inferredJudgeModel = batch.quality_scoring !== false
                ? (r.judge_model || defaultJudgeModel)
                : null;

            const inferredScoringMethod = r.scoring_method
                ? r.scoring_method
                : (batch.quality_scoring !== false ? (r.success ? 'pending' : 'disabled') : 'disabled');

            return {
                id: r._id ? r._id.toString() : null,
                model: r.model,
                host: r.host,
                judge_host: inferredJudgeHost,
                prompt_name: r.prompt_name,
                prompt_level: r.prompt_level,
                prompt_category: r.prompt_category,
                expected_answer: r.expected_answer,
                latency: r.latency,
                tokens_per_sec: r.tokens_per_sec,
                quality_score: r.quality_score,
                quality_explanation: r.quality_explanation,
                judge_prompt: r.judge_prompt,
                judge_model: inferredJudgeModel,
                scoring_method: inferredScoringMethod,
                scoring_type: r.scoring_type,
                scoring_time_ms: r.scoring_time_ms,
                quick_pattern: r.quick_pattern,
                composite_score: r.composite_score,
                normalized_scores: r.normalized_scores,
                success: r.success,
                error: r.error,
                response_preview: r.response
                    ? `${r.response.substring(0, 100)}...`
                    : '',
                timestamp: r.timestamp
            };
        });

        const judge_progress = rawJudgeTotal > 0
            ? Math.min(Math.round(((batch.judge_completed || 0) / rawJudgeTotal) * 100), 100)
            : 0;

        const judge_progress_effective = effectiveJudgeTotal > 0
            ? Math.min(Math.round(((batch.judge_completed || 0) / effectiveJudgeTotal) * 100), 100)
            : 0;

        return {
            ...batch.toObject(),
            judge_total: rawJudgeTotal,
            judge_total_effective: effectiveJudgeTotal,
            results: formattedResults,
            progress: batch.progress,
            judge_progress,
            judge_progress_effective,
            judge_stats: judgeStats,
            success_rate: batch.success_rate
        };
    }

    /**
     * Get all batch runs
     */
    async getBatches({ limit = 20 } = {}) {
        const batches = await BenchmarkBatch.getRecent(limit);
        return { batches, total: batches.length };
    }
}

// Export singleton instance
module.exports = new BenchmarkService();
