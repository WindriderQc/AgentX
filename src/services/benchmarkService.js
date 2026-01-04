/**
 * Benchmark Service
 * Handles batch execution, queue management, and scoring coordination.
 */
const mongoose = require('mongoose');
const logger = require('../../config/logger');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG } = require('./qualityScorer');
const { HOSTS } = require('./modelRouter');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

// Simple Concurrency Queue for managing parallel tasks (judging)
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
     * Seed default prompts if none exist
     */
    async seedPrompts() {
        const count = await BenchmarkPrompt.countDocuments();
        if (count === 0) {
            const fs = require('fs').promises;
            const path = require('path');
            // Assuming this service is in src/services/
            const promptsPath = path.join(__dirname, '..', '..', 'data', 'benchmark-prompts.json');
            try {
                const promptsData = await fs.readFile(promptsPath, 'utf-8');
                const prompts = JSON.parse(promptsData);
                await BenchmarkPrompt.insertMany(prompts.map(p => ({
                    ...p,
                    custom: false,
                    created_at: new Date()
                })));
                logger.info('Seeded benchmark prompts', { count: prompts.length });
            } catch (err) {
                logger.error('Failed to seed prompts', { error: err.message });
            }
        }
    }

    /**
     * Start a batch execution
     */
    async startBatch(batchData) {
        const { host, models, levels, run_name, quality_scoring = true, judge_config } = batchData;

        // Validation
        if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
            throw new Error('host, models (array), and levels (array) are required');
        }

        await this.seedPrompts();

        // Get prompts
        const selectedPrompts = await BenchmarkPrompt.find({ level: { $in: levels } }).lean();
        if (selectedPrompts.length === 0) {
            throw new Error('No prompts found for selected levels');
        }

        // Calculate Plan
        const modelsByHost = {};
        for (const model of models) {
            let targetHost = host;
            if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
            modelsByHost[targetHost].push(model);
        }

        const judgeSameHost = (judge_config && judge_config.judge_same_host !== undefined) ? !!judge_config.judge_same_host : false;

        const execHosts = Object.entries(modelsByHost).map(([exec_host, hostModels]) => {
            let judge_host = exec_host;
            if (!judgeSameHost) {
                // Default logic: swap host
                judge_host = (exec_host === HOSTS.primary) ? HOSTS.secondary : HOSTS.primary;
                // Fallback if secondary undefined
                if (!HOSTS.secondary) judge_host = HOSTS.primary;
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

        const totalTests = models.length * selectedPrompts.length;

        const batch = new BenchmarkBatch({
            host,
            models,
            levels,
            quality_scoring,
            judge_config,
            run_name: run_name || `Batch ${new Date().toLocaleString()}`,
            total_tests: totalTests,
            plan,
            judge_same_host: judgeSameHost,
            // Initialize judge_total. If quality_scoring is off, it remains 0.
            // If on, it matches totalTests.
            judge_total: quality_scoring ? totalTests : 0,
            judge_completed: 0,
            judge_failed: 0,
            completed: 0,
            failed: 0,
            status: 'running',
            results: []
        });

        await batch.save();

        // Fire and forget execution
        this.executeBatch(batch._id, host, models, selectedPrompts, { quality_scoring, judge_config }).catch(err => {
            logger.error('Batch execution failed', { batchId: batch._id, error: err.message });
        });

        return batch;
    }

    /**
     * Execute the batch logic
     */
    async executeBatch(batchId, defaultHost, models, prompts, options = {}) {
        const enableQualityScoring = options.quality_scoring !== false;
        const judgeConfig = options.judge_config || {};
        const judgeSameHost = judgeConfig.judge_same_host !== undefined ? !!judgeConfig.judge_same_host : false;

        // Prevent duplicate execution
        const lock = await BenchmarkBatch.updateOne(
            { _id: batchId, execution_started_at: { $exists: false } },
            { $set: { execution_started_at: new Date(), execution_pid: process.pid } }
        );

        if (!lock || lock.modifiedCount === 0) {
            logger.warn('Skipping duplicate batch execution', { batchId });
            return;
        }

        // Judge Queue
        const judgeConcurrency = judgeConfig.concurrency || 2;
        const judgeQueue = new ConcurrencyQueue(judgeConcurrency);

        // Group models
        const modelsByHost = {};
        for (const model of models) {
            let targetHost = defaultHost;
            if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
            modelsByHost[targetHost].push(model);
        }

        // Execution Promises
        const hostPromises = Object.entries(modelsByHost).map(async ([hostUrl, hostModels]) => {
            let judgeHostUrl = hostUrl;
            if (!judgeSameHost) {
                judgeHostUrl = (hostUrl === HOSTS.primary) ? HOSTS.secondary : HOSTS.primary;
                if (!HOSTS.secondary) judgeHostUrl = HOSTS.primary;
            }

            for (const model of hostModels) {
                for (const prompt of prompts) {
                    // Check stopped status
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

                        const result = new BenchmarkResult({
                            batch_id: batchId,
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
                            quality_score: null,
                            scoring_method: enableQualityScoring ? 'pending' : 'disabled',
                            judge_model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null
                        });

                        await result.save();

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

                        // Queue for Judging
                        if (enableQualityScoring) {
                            judgeQueue.add(async () => {
                                try {
                                    const scores = await scoreResponse({
                                        response: data.response || '',
                                        prompt: prompt,
                                        judgeConfig: { ...judgeConfig, host: judgeHostUrl }
                                    });

                                    const composite = calculateCompositeScore({
                                        latency,
                                        tokens_per_sec,
                                        quality_score: scores.quality_score
                                    });

                                    await BenchmarkResult.updateOne(
                                        { _id: result._id },
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
                                    logger.warn('Quality scoring failed', { model, prompt: prompt.name, error: scoreErr.message });
                                    await BenchmarkResult.updateOne(
                                        { _id: result._id },
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
                            }).catch(err => {
                                logger.error('Failed to enqueue judge task', { batchId, error: err.message });
                            });
                        }

                    } catch (err) {
                        // Handle Execution Failure
                        const result = new BenchmarkResult({
                            batch_id: batchId,
                            model,
                            host: hostUrl,
                            prompt: prompt.prompt,
                            prompt_level: prompt.level,
                            prompt_category: prompt.category,
                            prompt_name: prompt.name,
                            error: err.message,
                            success: false,
                            scoring_method: enableQualityScoring ? 'exec_failed' : 'disabled' // Mark as failed for judging too
                        });

                        await result.save();

                        // Increment completed AND judge_completed if needed
                        const update = {
                            $inc: { completed: 1, failed: 1 },
                            $push: {
                                results: {
                                    model,
                                    prompt_name: prompt.name,
                                    success: false,
                                    error: err.message
                                }
                            }
                        };

                        // FIX: Ensure judge stats are updated so UI doesn't stall
                        if (enableQualityScoring) {
                            update.$inc.judge_completed = 1;
                            // Optionally track judge_failed too or just count it as completed (but failed execution)
                        }

                        await BenchmarkBatch.updateOne({ _id: batchId }, update);
                        logger.error('Batch test failed', { batchId, model, prompt: prompt.name, error: err.message });
                    }
                }
            }
        });

        await Promise.all(hostPromises);

        if (enableQualityScoring) {
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $set: { status: 'judging', generated_at: new Date() } }
            );
            await judgeQueue.drain();
        }

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            { $set: { status: 'completed', completed_at: new Date() } }
        );
    }
}

module.exports = new BenchmarkService();
