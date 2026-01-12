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
const { getFetchOptions } = require('../helpers/httpAgent');
const { waitForModelLoadWithFallback } = require('../helpers/modelLoadWaiter');

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
            // Use HTTP agent for connection pooling and proper timeout handling
            const url = `${host}/api/generate`;
            const fetchOptions = getFetchOptions(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt, stream: false }),
                timeout: 120000  // 120 seconds for model loading on first request
            });
            const response = await fetch(url, fetchOptions);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            const latency = Date.now() - start;
            const tokens = Math.ceil((data.response || '').length / 4);

            // Look up prompt metadata to store level/category
            let promptMeta = {};
            try {
                const promptDef = await BenchmarkPrompt.findOne({ prompt });
                if (promptDef) {
                    promptMeta = {
                        prompt_level: promptDef.level,
                        prompt_category: promptDef.category,
                        prompt_name: promptDef.name
                    };
                }
            } catch (err) {
                // Ignore lookup errors
            }

            const result = new BenchmarkResult({
                model,
                host,
                prompt,
                ...promptMeta,
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
            BenchmarkResult.find({ 
                success: true,
                model: { $not: /diagnostic/i } // Exclude diagnostic models
            }),
            BenchmarkResult.countDocuments({ 
                success: false,
                model: { $not: /diagnostic/i } // Exclude diagnostic models
            })
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
    async getDashboard({ sortBy = 'latency', modelCategory, promptCategory, tag } = {}) {
        // Build match query for filtering
        const matchQuery = { 
            success: true
        };

        // Filter by prompt category
        if (promptCategory) {
            matchQuery.prompt_category = promptCategory;
        }

        // Filter by tag (batch-level)
        if (tag) {
            const BenchmarkBatch = require('../../models/BenchmarkBatch');
            const batches = await BenchmarkBatch.find({ tags: tag }).distinct('_id');
            if (batches.length > 0) {
                matchQuery.batch_id = { $in: batches.map(b => b.toString()) };
            } else {
                // No batches with this tag - return empty results
                matchQuery.batch_id = { $in: [] };
            }
        }

        // Filter by model category (requires ModelRegistry lookup)
        let modelNames = null;
        if (modelCategory) {
            const ModelRegistry = require('../../models/ModelRegistry');
            const models = await ModelRegistry.findByCategory(modelCategory);
            modelNames = models.map(m => m.modelName);

            if (modelNames.length > 0) {
                matchQuery.model = { $in: modelNames };
            } else {
                // No models in this category - return empty results
                matchQuery.model = { $in: [] };
            }
        }

        const [totalTests, successCount, recentTests, modelStats, failureStats, judgeStats] = await Promise.all([
            BenchmarkResult.countDocuments({}),
            BenchmarkResult.countDocuments(matchQuery),
            BenchmarkResult.find(matchQuery).sort({ timestamp: -1 }).limit(10),
            BenchmarkResult.aggregate([
                { $match: matchQuery },
                {
                    $group: {
                        _id: { model: '$model', host: '$host' },
                        avg_latency: { $avg: '$latency' },
                        avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                        
                        // Level breakdown
                        tests_level_1: { $sum: { $cond: [{ $eq: ['$prompt_level', 1] }, 1, 0] } },
                        tests_level_2: { $sum: { $cond: [{ $eq: ['$prompt_level', 2] }, 1, 0] } },
                        tests_level_3: { $sum: { $cond: [{ $eq: ['$prompt_level', 3] }, 1, 0] } },
                        tests_level_4: { $sum: { $cond: [{ $eq: ['$prompt_level', 4] }, 1, 0] } },
                        tests_level_5: { $sum: { $cond: [{ $eq: ['$prompt_level', 5] }, 1, 0] } },
                        
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
            ]),
            BenchmarkResult.aggregate([
                { $match: {
                    success: false,
                    // Apply same model filter for failure stats to maintain category consistency
                    // When modelNames is set (even empty), enforce the filter to exclude unrelated models
                    ...(modelNames !== null ? { model: { $in: modelNames } } : {})
                } },
                {
                    $group: {
                        _id: { model: '$model', host: '$host' },
                        failed: { $sum: 1 }
                    }
                }
            ]),
            BenchmarkResult.aggregate([
                { $match: { scoring_time_ms: { $ne: null } } },
                {
                    $group: {
                        _id: { model: '$judge_model', host: '$judge_host' },
                        avg_latency: { $avg: '$scoring_time_ms' },
                        count: { $sum: 1 }
                    }
                }
            ])
        ]);

        const failureByKey = new Map(
            (failureStats || []).map(s => [`${s._id.model}@@${s._id.host}`, s.failed || 0])
        );

        // Format and sort model stats
        const successByKey = new Map();
        let sortedStats = modelStats.map(m => {
            const hasQuality = m.avg_quality != null && !isNaN(m.avg_quality);
            
            // Normalize quality to 0-10 for calculation (handle mixed 0-10 and 0-100 data)
            let rawQuality = m.avg_quality || 0;
            if (rawQuality > 10) rawQuality = rawQuality / 10;

            const avgLatency = Number(m.avg_latency) || 0;
            const avgTokens = parseFloat(m.avg_tokens_per_sec) || 0;

            // Calculate profiles dynamically
            const interactive = calculateCompositeScore({
                latency: avgLatency,
                tokens_per_sec: avgTokens,
                quality_score: rawQuality
            }, 'interactive');

            const reasoning = calculateCompositeScore({
                latency: avgLatency,
                tokens_per_sec: avgTokens,
                quality_score: rawQuality
            }, 'reasoning');

            const coding = calculateCompositeScore({
                latency: avgLatency,
                tokens_per_sec: avgTokens,
                quality_score: rawQuality
            }, 'coding');

            const key = `${m._id.model}@@${m._id.host}`;
            const failedTests = failureByKey.get(key) || 0;
            const successTests = m.count || 0;

            successByKey.set(key, true);

            // Helper to format score 0-10
            const fmtScore = (s) => (s !== null && s !== undefined && !isNaN(s)) ? (s / 10).toFixed(1) : null;

            return {
                model: m._id.model,
                host: m._id.host,
                avg_latency: Math.round(avgLatency),
                avg_tokens_per_sec: avgTokens.toFixed(2),
                avg_quality: hasQuality ? rawQuality.toFixed(1) : null, // Display as 0-10
                
                // Dynamic scores (converted to 0-10 scale)
                interactive_score: fmtScore(interactive.composite_score),
                reasoning_score: fmtScore(reasoning.composite_score),
                coding_score: fmtScore(coding.composite_score),
                
                // Legacy field for compat
                avg_composite: fmtScore(interactive.composite_score), 

                quality_tests: m.quality_tests || 0,
                level_stats: {
                    1: m.tests_level_1 || 0,
                    2: m.tests_level_2 || 0,
                    3: m.tests_level_3 || 0,
                    4: m.tests_level_4 || 0,
                    5: m.tests_level_5 || 0
                },
                tests: successTests,
                failed_tests: failedTests,
                total_tests: successTests + failedTests,
                failure_only: false
            };
        });

        // Add failure-only model/host combos so issues are visible in the leaderboard.
        for (const [key, failedTests] of failureByKey.entries()) {
            if (successByKey.has(key)) continue;
            const [model, host] = key.split('@@');
            sortedStats.push({
                model,
                host,
                avg_latency: 0,
                avg_tokens_per_sec: '0',
                avg_quality: null,
                avg_composite: null,
                interactive_score: 0,
                reasoning_score: 0,
                coding_score: 0,
                quality_tests: 0,
                tests: 0,
                failed_tests: failedTests,
                total_tests: failedTests,
                failure_only: true
            });
        }

        // Enrich with ModelRegistry data (recommended category, manual categories)
        const ModelRegistry = require('../../models/ModelRegistry');
        const uniqueModelNames = [...new Set(sortedStats.map(s => s.model))];
        const registryModels = await ModelRegistry.find({
            modelName: { $in: uniqueModelNames }
        }).lean();

        const registryByName = new Map();
        registryModels.forEach(rm => {
            registryByName.set(rm.modelName, rm);
        });

        sortedStats = sortedStats.map(stat => {
            const registryData = registryByName.get(stat.model);
            return {
                ...stat,
                recommended_category: registryData?.benchmarkStats?.bestCategory || null,
                manual_categories: registryData?.categories || []
            };
        });

        // Apply sorting
        switch (sortBy) {
            case 'reliability':
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    const aTotal = Number(a.total_tests) || 0;
                    const bTotal = Number(b.total_tests) || 0;
                    const aFailed = Number(a.failed_tests) || 0;
                    const bFailed = Number(b.failed_tests) || 0;
                    const aRate = aTotal > 0 ? (aFailed / aTotal) : 0;
                    const bRate = bTotal > 0 ? (bFailed / bTotal) : 0;
                    if (aRate !== bRate) return aRate - bRate;
                    // Tie-breakers: more samples first, then latency
                    if (aTotal !== bTotal) return bTotal - aTotal;
                    return a.avg_latency - b.avg_latency;
                });
                break;
            case 'quality':
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    return (Number(b.avg_quality) || 0) - (Number(a.avg_quality) || 0);
                });
                break;
            case 'composite':
            case 'interactive':
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    const diff = (b.interactive_score || 0) - (a.interactive_score || 0);
                    return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
                });
                break;
            case 'reasoning':
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    const diff = (b.reasoning_score || 0) - (a.reasoning_score || 0);
                    return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
                });
                break;
            case 'coding':
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    const diff = (b.coding_score || 0) - (a.coding_score || 0);
                    return diff !== 0 ? diff : a.model.localeCompare(b.model); // Stable tie-breaker
                });
                break;
            case 'speed':
                sortedStats.sort((a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    return parseFloat(b.avg_tokens_per_sec) - parseFloat(a.avg_tokens_per_sec);
                });
                break;
            case 'latency':
            default:
                sortedStats.sort((s => (a, b) => {
                    if (a.failure_only !== b.failure_only) return a.failure_only ? 1 : -1;
                    return a.avg_latency - b.avg_latency;
                })());
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
            judge_stats: judgeStats,
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
    async getQualityBreakdown(model = null, host = null) {
        const { byCategory, byLevel, byModel } = await BenchmarkResult.getQualityBreakdown(model, host);

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
     * Clear failed results only (for cleanup)
     */
    async clearFailedResults() {
        const count = await BenchmarkResult.countDocuments({ success: false });
        await BenchmarkResult.deleteMany({ success: false });

        logger.info('Benchmark failed results cleared', { count });
        return count;
    }

    /**
     * Start a batch benchmark test
     */
    async startBatch({ host, models, levels, run_name, quality_scoring = true, judge_config = {}, tags = [], description = '', execution_mode = 'latency' }) {
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
            started_at: new Date(),
            tags: Array.isArray(tags) ? tags : [],
            description: typeof description === 'string' ? description : '',
            execution_mode: execution_mode || 'latency'
        });

        // Capture system snapshot for reproducibility
        batch.captureSystemSnapshot();

        await batch.save();
        const batchId = batch._id.toString();

        // Start batch execution in background.
        // Skip in tests to keep Jest deterministic and avoid runaway async work.
        if (process.env.NODE_ENV !== 'test') {
            this.executeBatch(batchId, host, models, selectedPrompts, { quality_scoring, judge_config, execution_mode }).catch(err => {
                logger.error('Batch execution failed', { batchId, error: err.message });
            });
        }

        return {
            batch_id: batchId,
            total_tests: batch.total_tests,
            quality_scoring,
            plan
        };
    }

    /**
     * Execute batch tests with parallel or serial host execution
     */
    async executeBatch(batchId, defaultHost, models, prompts, options = {}) {
        const enableQualityScoring = options.quality_scoring !== false;
        const judgeConfig = options.judge_config || {};
        const judgeSameHost = judgeConfig.judge_same_host !== undefined ? !!judgeConfig.judge_same_host : false;
        const executionMode = options.execution_mode || 'latency';

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

        // Helper for model warmup
        // Uses intelligent VRAM monitoring to detect when model is loaded
        // Falls back to timeout if VRAM monitoring unavailable (e.g., Windows hosts)
        const warmupModel = async (hostUrl, model) => {
            try {
                logger.info('Starting model warmup', { host: hostUrl, model });
                
                // Trigger model load with a minimal request
                const url = `${hostUrl}/api/generate`;
                const fetchOptions = getFetchOptions(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        model, 
                        prompt: 'warmup', 
                        stream: false, 
                        options: { num_predict: 1 } 
                    }),
                    timeout: 10000  // Just trigger the load, don't wait for completion
                });
                
                // Start the request but don't wait for it (model will start loading)
                fetch(url, fetchOptions).catch(() => {}); // Ignore errors, we'll check VRAM
                
                // Wait for model to finish loading by monitoring VRAM
                const loadResult = await waitForModelLoadWithFallback(hostUrl, model, {
                    maxWaitMs: 120000,      // Max 120s to wait
                    pollIntervalMs: 2000,   // Check every 2s
                    stabilityChecks: 2,     // Need 2 stable readings
                    fallbackTimeoutMs: 30000 // If VRAM monitoring unavailable, wait 30s
                });
                
                if (loadResult.loaded) {
                    logger.info('Model warmed up successfully (VRAM-verified)', { 
                        host: hostUrl, 
                        model,
                        durationMs: loadResult.durationMs,
                        vramUsedMiB: loadResult.vramUsedMiB
                    });
                } else if (loadResult.loaded === null) {
                    logger.info('Model warmup completed (VRAM monitoring unavailable)', {
                        host: hostUrl,
                        model,
                        reason: loadResult.error
                    });
                } else {
                    logger.warn('Model warmup may not be complete', {
                        host: hostUrl,
                        model,
                        reason: loadResult.error
                    });
                }
            } catch (err) {
                // Non-fatal, just log
                logger.debug('Warmup encountered error', { host: hostUrl, model, error: err.message });
            }
        };

        // Per-batch judge queue - set concurrency based on execution mode
        const judgeConcurrency = executionMode === 'latency' ? 1 : (judgeConfig.concurrency || 2);
        const judgeQueue = new ConcurrencyQueue(judgeConcurrency);

        // Set up periodic heartbeat to update last_activity_at (every 10 seconds)
        const heartbeatInterval = setInterval(async () => {
            try {
                const currentBatch = await BenchmarkBatch.findById(batchId);
                if (currentBatch && ['running', 'judging'].includes(currentBatch.status)) {
                    await currentBatch.heartbeat();
                } else {
                    clearInterval(heartbeatInterval);
                }
            } catch (err) {
                logger.warn('Heartbeat failed', { batchId, error: err.message });
            }
        }, 10000);

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

            // Warmup judge if separate host (async background, don't block)
            if (enableQualityScoring && !judgeSameHost) {
                const jModel = judgeConfig.model || JUDGE_CONFIG.model;
                warmupModel(judgeHostUrl, jModel).catch(() => {});
            }

            for (const model of hostModels) {
                // Warmup tested model (await ensures accurate latency for first prompt)
                await warmupModel(hostUrl, model);

                for (const prompt of prompts) {
                    // Check if batch was stopped
                    const currentBatch = await BenchmarkBatch.findById(batchId);
                    if (currentBatch && currentBatch.status === 'stopped') {
                        logger.info('Batch execution stopped by user', { batchId });
                        return;
                    }

                    // Update current test indicator with detailed info
                    const testNumber = (currentBatch.completed || 0) + 1;
                    const start = Date.now();

                    try {
                        await currentBatch.updateCurrentTest(
                            model,
                            prompt._id ? prompt._id.toString() : null,
                            prompt.name,
                            'executing',
                            {
                                testNumber,
                                promptLevel: prompt.level
                            }
                        );
                        // After warmup, model should be loaded, so use standard timeout
                        // If model wasn't warmed up properly, this may still timeout
                        const url = `${hostUrl}/api/generate`;
                        const fetchOptions = getFetchOptions(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ model, prompt: prompt.prompt, stream: false }),
                            timeout: 90000  // 90s for actual inference (model should be loaded)
                        });
                        const response = await fetch(url, fetchOptions);

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

                        // Record test completion with timeline tracking
                        await currentBatch.recordTestComplete(
                            model,
                            prompt._id ? prompt._id.toString() : null,
                            latency,
                            true,
                            null
                        );

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
                                    // Update current test to judging stage
                                    const batchForJudge = await BenchmarkBatch.findById(batchId);
                                    if (batchForJudge) {
                                        await batchForJudge.updateCurrentTest(
                                            model,
                                            prompt._id ? prompt._id.toString() : null,
                                            prompt.name,
                                            'judging',
                                            {
                                                testNumber,
                                                promptLevel: prompt.level
                                            }
                                        );
                                    }

                                    const judgeStart = Date.now();
                                    const scores = await scoreResponse({
                                        response: data.response || '',
                                        prompt: prompt,
                                        judgeConfig: {
                                            ...judgeConfig,
                                            host: judgeHostUrl
                                        }
                                    });
                                    const judgeDuration = Date.now() - judgeStart;

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

                                    // Record judge completion with timeline tracking
                                    if (batchForJudge) {
                                        await batchForJudge.recordJudgeComplete(
                                            model,
                                            prompt._id ? prompt._id.toString() : null,
                                            judgeDuration,
                                            true
                                        );
                                    }

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
                        const errorDuration = Date.now() - start;

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

                        // Record test failure with timeline tracking
                        await currentBatch.recordTestComplete(
                            model,
                            prompt._id ? prompt._id.toString() : null,
                            errorDuration,
                            false,
                            err
                        );

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

        // Execute serially (latency mode) or in parallel (throughput mode)
        if (executionMode === 'latency') {
            // Serial execution: run one host at a time for clean latency measurements
            for (const hostPromise of hostPromises) {
                await hostPromise;
            }
        } else {
            // Parallel execution: maximize throughput
            await Promise.all(hostPromises);
        }

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

        // Clear heartbeat interval
        clearInterval(heartbeatInterval);

        // Mark batch as completed and calculate metrics
        const finalBatch = await BenchmarkBatch.findById(batchId);
        if (finalBatch) {
            await finalBatch.clearCurrentTest();
            await finalBatch.markAsCompleted();
            await finalBatch.calculateMetrics();
            logger.info('Batch completed with metrics', {
                batchId,
                total_duration: finalBatch.execution_metrics?.total_duration_ms,
                tests_per_minute: finalBatch.execution_metrics?.tests_per_minute
            });
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

    /**
     * Get time-series analytics for model performance trends
     */
    async getModelTrends({ model, days = 7, groupBy = 'day' } = {}) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);

        const matchStage = {
            timestamp: { $gte: cutoff },
            success: true
        };

        if (model) {
            matchStage.model = model;
        }

        // Determine grouping based on parameter
        let dateGroup;
        switch (groupBy) {
            case 'hour':
                dateGroup = {
                    year: { $year: '$timestamp' },
                    month: { $month: '$timestamp' },
                    day: { $dayOfMonth: '$timestamp' },
                    hour: { $hour: '$timestamp' }
                };
                break;
            case 'day':
            default:
                dateGroup = {
                    year: { $year: '$timestamp' },
                    month: { $month: '$timestamp' },
                    day: { $dayOfMonth: '$timestamp' }
                };
        }

        const trends = await BenchmarkResult.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: {
                        ...dateGroup,
                        ...(model ? {} : { model: '$model' })
                    },
                    avg_latency: { $avg: '$latency' },
                    avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                    avg_quality: { $avg: '$quality_score' },
                    avg_composite: { $avg: '$composite_score' },
                    tests_count: { $sum: 1 },
                    total_tokens: { $sum: '$tokens' }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
        ]);

        return {
            trends,
            period: { days, groupBy },
            model: model || 'all'
        };
    }

    /**
     * Get comparative batch analysis
     */
    async compareBatches(batchIds) {
        if (!Array.isArray(batchIds) || batchIds.length === 0) {
            throw new Error('batchIds array is required');
        }

        const batches = await Promise.all(
            batchIds.map(id => BenchmarkBatch.findById(id))
        );

        const validBatches = batches.filter(b => b !== null);

        if (validBatches.length === 0) {
            throw new Error('No valid batches found');
        }

        const comparison = await Promise.all(validBatches.map(async batch => {
            // Calculate aggregated scores for this batch
            let avg_quality = null;
            let avg_composite = null;

            if (batch.quality_scoring) {
                const scores = await BenchmarkResult.aggregate([
                    { $match: { batch_id: batch._id.toString() } },
                    {
                        $group: {
                            _id: null,
                            avg_quality: { $avg: '$quality_score' },
                            avg_composite: { $avg: '$composite_score' }
                        }
                    }
                ]);
                if (scores.length > 0) {
                    avg_quality = scores[0].avg_quality !== null ? parseFloat(scores[0].avg_quality.toFixed(1)) : null;
                    avg_composite = scores[0].avg_composite !== null ? parseFloat(scores[0].avg_composite.toFixed(1)) : null;
                }
            }

            return {
                batch_id: batch._id.toString(),
                run_name: batch.run_name,
                models: batch.models,
                status: batch.status,
                total_tests: batch.total_tests,
                completed: batch.completed,
                success_rate: batch.success_rate,
                execution_metrics: batch.execution_metrics,
                config_snapshot: batch.config_snapshot,
                created_at: batch.created_at,
                completed_at: batch.completed_at,
                quality_scoring: batch.quality_scoring,
                avg_quality,
                avg_composite
            };
        }));

        // Calculate comparative statistics
        const stats = {
            avg_duration_ms: null,
            avg_tests_per_minute: null,
            avg_tokens_generated: null,
            fastest_batch: null,
            slowest_batch: null
        };

        const durations = validBatches
            .filter(b => b.execution_metrics?.total_duration_ms)
            .map(b => ({
                id: b._id.toString(),
                name: b.run_name,
                duration: b.execution_metrics.total_duration_ms
            }));

        if (durations.length > 0) {
            stats.avg_duration_ms = Math.round(
                durations.reduce((a, b) => a + b.duration, 0) / durations.length
            );
            stats.fastest_batch = durations.reduce((a, b) => (a.duration < b.duration ? a : b));
            stats.slowest_batch = durations.reduce((a, b) => (a.duration > b.duration ? a : b));
        }

        const throughputs = validBatches
            .filter(b => b.execution_metrics?.tests_per_minute)
            .map(b => b.execution_metrics.tests_per_minute);

        if (throughputs.length > 0) {
            stats.avg_tests_per_minute = Math.round(
                throughputs.reduce((a, b) => a + b, 0) / throughputs.length
            );
        }

        const tokens = validBatches
            .filter(b => b.execution_metrics?.total_tokens_generated)
            .map(b => b.execution_metrics.total_tokens_generated);

        if (tokens.length > 0) {
            stats.avg_tokens_generated = Math.round(
                tokens.reduce((a, b) => a + b, 0) / tokens.length
            );
        }

        return { comparison, stats };
    }

    /**
     * Get Judge Leaderboard
     * Aggregates performance stats for judge models
     */
    async getJudgeLeaderboard() {
        const leaderboard = await BenchmarkResult.aggregate([
            { 
                $match: { 
                    judge_model: { $ne: null },
                    scoring_method: { $ne: 'skipped' }
                } 
            },
            {
                $group: {
                    _id: {
                        judge_model: '$judge_model',
                        judge_host: '$judge_host'
                    },
                    count: { $sum: 1 },
                    avg_latency: { $avg: '$scoring_time_ms' },
                    success_count: {
                        $sum: {
                            $cond: [{ $ne: ['$scoring_method', 'llm_failed'] }, 1, 0]
                        }
                    },
                    avg_score_given: { $avg: '$quality_score' },
                    avg_explanation_len: {
                        $avg: {
                            $cond: [
                                { $ifNull: ['$quality_explanation', false] },
                                { $strLenCP: '$quality_explanation' },
                                0
                            ]
                        }
                    },
                    // Collect score distribution for histogram
                    scores: { $push: '$quality_score' }
                }
            },
            {
                $project: {
                    _id: 0,
                    judge_model: '$_id.judge_model',
                    judge_host: '$_id.judge_host',
                    count: 1,
                    avg_latency: { $round: ['$avg_latency', 0] },
                    success_rate: {
                        $multiply: [
                            { $divide: ['$success_count', '$count'] },
                            100
                        ]
                    },
                    avg_score_given: { $round: ['$avg_score_given', 1] },
                    avg_explanation_len: { $round: ['$avg_explanation_len', 0] },
                    // Calculate score distribution buckets (0-2, 2-4, 4-6, 6-8, 8-10)
                    score_distribution: {
                        $reduce: {
                            input: '$scores',
                            initialValue: { '0-2': 0, '2-4': 0, '4-6': 0, '6-8': 0, '8-10': 0 },
                            in: {
                                $let: {
                                    vars: { score: '$$this' },
                                    in: {
                                        $cond: [
                                            { $eq: ['$$score', null] },
                                            '$$value',
                                            {
                                                $cond: [
                                                    { $lte: ['$$score', 2] },
                                                    { $mergeObjects: ['$$value', { '0-2': { $add: ['$$value.0-2', 1] } }] },
                                                    {
                                                        $cond: [
                                                            { $lte: ['$$score', 4] },
                                                            { $mergeObjects: ['$$value', { '2-4': { $add: ['$$value.2-4', 1] } }] },
                                                            {
                                                                $cond: [
                                                                    { $lte: ['$$score', 6] },
                                                                    { $mergeObjects: ['$$value', { '4-6': { $add: ['$$value.4-6', 1] } }] },
                                                                    {
                                                                        $cond: [
                                                                            { $lte: ['$$score', 8] },
                                                                            { $mergeObjects: ['$$value', { '6-8': { $add: ['$$value.6-8', 1] } }] },
                                                                            { $mergeObjects: ['$$value', { '8-10': { $add: ['$$value.8-10', 1] } }] }
                                                                        ]
                                                                    }
                                                                ]
                                                            }
                                                        ]
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            },
            { $sort: { count: -1 } }
        ]);

        return leaderboard;
    }

    /**
     * Get Judge Breakdown
     * Break down judge performance by prompt level or model-under-test.
     *
     * @param {Object} opts
     * @param {string} opts.judge_model - Judge model name (required)
     * @param {string|null} [opts.judge_host] - Optional judge host filter
     * @param {'level'|'model'} [opts.groupBy='level'] - Breakdown dimension
     * @param {number} [opts.limit=25] - Max groups to return (applies to model grouping)
     */
    async getJudgeBreakdown({ judge_model, judge_host = null, groupBy = 'level', limit = 25 } = {}) {
        if (!judge_model || typeof judge_model !== 'string') {
            throw new Error('judge_model is required');
        }

        const normalizedGroupBy = groupBy === 'model' ? 'model' : 'level';
        const safeLimit = Math.max(1, Math.min(200, Number(limit) || 25));

        const match = {
            judge_model,
            scoring_method: { $ne: 'skipped' }
        };

        if (typeof judge_host === 'string' && judge_host.trim()) {
            match.judge_host = judge_host.trim();
        }

        if (normalizedGroupBy === 'level') {
            match.prompt_level = { $ne: null };
        } else {
            match.model = { $ne: null };
        }

        const groupKey = normalizedGroupBy === 'level' ? '$prompt_level' : '$model';

        const pipeline = [
            { $match: match },
            {
                $group: {
                    _id: groupKey,
                    count: { $sum: 1 },
                    avg_latency: { $avg: '$scoring_time_ms' },
                    success_count: {
                        $sum: {
                            $cond: [{ $ne: ['$scoring_method', 'llm_failed'] }, 1, 0]
                        }
                    },
                    avg_score_given: { $avg: '$quality_score' },
                    avg_test_tokens: { $avg: '$tokens' }
                }
            },
            {
                $project: {
                    _id: 0,
                    key: '$_id',
                    count: 1,
                    avg_latency: { $round: ['$avg_latency', 0] },
                    success_rate: {
                        $multiply: [
                            { $divide: ['$success_count', '$count'] },
                            100
                        ]
                    },
                    avg_score_given: { $round: ['$avg_score_given', 1] },
                    avg_test_tokens: { $round: ['$avg_test_tokens', 0] }
                }
            },
            { $sort: { count: -1 } }
        ];

        if (normalizedGroupBy === 'model') {
            pipeline.push({ $limit: safeLimit });
        }

        const groups = await BenchmarkResult.aggregate(pipeline);

        return {
            judge_model,
            judge_host: (typeof judge_host === 'string' && judge_host.trim()) ? judge_host.trim() : null,
            groupBy: normalizedGroupBy,
            limit: normalizedGroupBy === 'model' ? safeLimit : null,
            groups
        };
    }

    /**
     * Get recent judge activity
     */
    async getJudgeActivity(limit = 10) {
        return BenchmarkResult.find({ 
            judge_model: { $ne: null },
            scoring_method: { $ne: 'skipped' }
        })
        .sort({ timestamp: -1 })
        .limit(limit)
        .select('judge_model judge_host model quality_score scoring_time_ms timestamp prompt_category');
    }

    /**
     * Get batch statistics grouped by tag
     */
    async getBatchStatsByTag() {
        const batches = await BenchmarkBatch.find({ tags: { $exists: true, $ne: [] } });

        const statsByTag = {};

        batches.forEach(batch => {
            batch.tags.forEach(tag => {
                if (!statsByTag[tag]) {
                    statsByTag[tag] = {
                        tag,
                        count: 0,
                        completed: 0,
                        avg_duration_ms: 0,
                        avg_success_rate: 0,
                        durations: [],
                        success_rates: []
                    };
                }

                statsByTag[tag].count += 1;

                if (batch.status === 'completed') {
                    statsByTag[tag].completed += 1;

                    if (batch.execution_metrics?.total_duration_ms) {
                        statsByTag[tag].durations.push(batch.execution_metrics.total_duration_ms);
                    }

                    const successRate = parseFloat(batch.success_rate);
                    if (!isNaN(successRate)) {
                        statsByTag[tag].success_rates.push(successRate);
                    }
                }
            });
        });

        // Calculate averages
        Object.values(statsByTag).forEach(stat => {
            if (stat.durations.length > 0) {
                stat.avg_duration_ms = Math.round(
                    stat.durations.reduce((a, b) => a + b, 0) / stat.durations.length
                );
            }

            if (stat.success_rates.length > 0) {
                stat.avg_success_rate =
                    (stat.success_rates.reduce((a, b) => a + b, 0) / stat.success_rates.length).toFixed(1) + '%';
            }

            // Clean up temporary arrays
            delete stat.durations;
            delete stat.success_rates;
        });

        return {
            tags: Object.values(statsByTag),
            total_tags: Object.keys(statsByTag).length
        };
    }

    /**
     * Get real-time statistics for active batches
     */
    async getActiveStats() {
        const activeBatches = await BenchmarkBatch.find({
            status: { $in: ['running', 'judging'] }
        });

        const stats = {
            active_batches: activeBatches.length,
            total_tests_running: 0,
            total_completed: 0,
            total_pending: 0,
            estimated_completion_time: null,
            batches: []
        };

        activeBatches.forEach(batch => {
            stats.total_tests_running += batch.total_tests;
            stats.total_completed += batch.completed || 0;
            stats.total_pending += batch.total_tests - (batch.completed || 0);

            const elapsed = batch.started_at ? Date.now() - batch.started_at : 0;
            const progress = batch.completed / batch.total_tests;
            const eta = progress > 0 ? (elapsed / progress) - elapsed : null;

            stats.batches.push({
                batch_id: batch._id.toString(),
                run_name: batch.run_name,
                progress: batch.progress,
                status: batch.status,
                completed: batch.completed,
                total: batch.total_tests,
                elapsed_ms: elapsed,
                eta_ms: eta,
                judge_progress: batch.judge_progress
            });
        });

        // Calculate overall ETA (weighted average)
        if (stats.batches.length > 0) {
            const etas = stats.batches.filter(b => b.eta_ms).map(b => b.eta_ms);
            if (etas.length > 0) {
                stats.estimated_completion_time = Math.max(...etas);
            }
        }

        return stats;
    }

    /**
     * Get configuration presets for common test scenarios
     */
    getConfigPresets() {
        return {
            presets: [
                {
                    id: 'quick-test',
                    name: 'Quick Test',
                    description: 'Fast validation test with simple prompts',
                    config: {
                        levels: [1, 2],
                        quality_scoring: false,
                        judge_config: null
                    },
                    recommended_for: 'Initial model validation, quick checks',
                    estimated_duration: '2-5 minutes'
                },
                {
                    id: 'standard-benchmark',
                    name: 'Standard Benchmark',
                    description: 'Balanced test across all levels with quality scoring',
                    config: {
                        levels: [1, 2, 3, 4, 5],
                        quality_scoring: true,
                        judge_config: {
                            concurrency: 2,
                            judge_same_host: false
                        }
                    },
                    recommended_for: 'Regular model evaluation',
                    estimated_duration: '15-30 minutes'
                },
                {
                    id: 'deep-quality',
                    name: 'Deep Quality Analysis',
                    description: 'Comprehensive quality scoring on complex prompts',
                    config: {
                        levels: [3, 4, 5],
                        quality_scoring: true,
                        judge_config: {
                            concurrency: 1,
                            judge_same_host: false,
                            timeout: 60000
                        }
                    },
                    recommended_for: 'In-depth model analysis, publication-ready benchmarks',
                    estimated_duration: '30-60 minutes'
                },
                {
                    id: 'speed-test',
                    name: 'Speed Test',
                    description: 'Focus on latency and throughput measurement',
                    config: {
                        levels: [1, 2],
                        quality_scoring: false,
                        judge_config: null
                    },
                    recommended_for: 'Performance optimization, latency testing',
                    estimated_duration: '5-10 minutes'
                },
                {
                    id: 'reasoning-test',
                    name: 'Reasoning & Logic',
                    description: 'Test logical reasoning and problem-solving',
                    config: {
                        levels: [3, 4],
                        quality_scoring: true,
                        judge_config: {
                            concurrency: 2,
                            judge_same_host: false
                        }
                    },
                    recommended_for: 'Evaluating reasoning capabilities',
                    estimated_duration: '20-40 minutes'
                }
            ]
        };
    }
}

// Export singleton instance
module.exports = new BenchmarkService();
