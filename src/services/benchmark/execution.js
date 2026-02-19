/**
 * Benchmark Execution Module
 * Core batch management, orchestration, and progress tracking
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { HOSTS } = require('../modelRouter');
const hardwareProfileService = require('../hardwareProfileService');
const ConcurrencyQueue = require('./ConcurrencyQueue');
const { normalizeExecutionConfig, applyLengthHint } = require('./config');
const { seedPrompts } = require('./init');
const { classifyBenchmarkError } = require('./errorClassifier');
const { extractThinkingBlocks } = require('../../helpers/ollamaResponseHandler');

// Extracted modules
const { samplePromptsByDepth } = require('./promptSampling');
const { runTest } = require('./testExecution');
const { warmupModel } = require('./modelWarmup');
const { buildExecutionPlan } = require('./batchPlanner');
const ModelRegistry = require('../../../models/ModelRegistry');

// Track active batch for graceful shutdown
let activeBatchId = null;
let activeHeartbeatInterval = null;

function getActiveBatchId() {
    return activeBatchId;
}

function getActiveHeartbeatInterval() {
    return activeHeartbeatInterval;
}

function clearActiveBatch() {
    if (activeHeartbeatInterval) {
        clearInterval(activeHeartbeatInterval);
        activeHeartbeatInterval = null;
    }
    activeBatchId = null;
}

/**
 * Get per-model execution config by merging batch config with registry defaults/overrides
 * @param {string} modelName
 * @param {object} batchConfig - Batch-level execution config
 * @returns {Promise<object>} Merged execution config
 */
async function getModelExecutionConfig(modelName, batchConfig) {
    try {
        const entry = await ModelRegistry.findOne({ modelName }).lean();
        if (!entry) return batchConfig;

        const overrides = entry.executionOverrides || {};
        const defaults = entry.executionDefaults || {};

        // Priority: user override > auto-detected default > batch config
        const numCtx = overrides.num_ctx ?? defaults.num_ctx ?? batchConfig.num_ctx;
        return { ...batchConfig, num_ctx: numCtx };
    } catch (err) {
        logger.debug('Failed to lookup model execution config, using batch config', { modelName, error: err.message });
        return batchConfig;
    }
}

/**
 * Start a batch benchmark test
 */
async function startBatch({ host, models, levels, run_name, quality_scoring = true, judge_config = {}, execution_config = {}, tags = [], description = '', execution_mode = 'latency', depth_config = null }) {
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        throw new Error('host, models (array), and levels (array) are required');
    }

    await seedPrompts();

    let selectedPrompts = await BenchmarkPrompt.getByLevels(levels);

    if (depth_config && typeof depth_config === 'object') {
        selectedPrompts = samplePromptsByDepth(selectedPrompts, depth_config);
    }

    selectedPrompts.sort((a, b) => (a.level || 0) - (b.level || 0));

    if (selectedPrompts.length === 0) {
        throw new Error('No prompts found for selected levels');
    }

    const { plan, normalizedExecutionConfig, judgeSameHost } = buildExecutionPlan(host, models, selectedPrompts, {
        quality_scoring, judge_config, execution_config
    });

    const batch = new BenchmarkBatch({
        host,
        models,
        levels,
        quality_scoring,
        judge_config,
        execution_config: normalizedExecutionConfig,
        depth_config: (depth_config && typeof depth_config === 'object') ? depth_config : null,
        run_name: run_name || `Batch ${new Date().toLocaleString()}`,
        active_slot: 'benchmark_singleton',
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

    batch.captureSystemSnapshot();
    await batch.save();
    const batchId = batch._id.toString();

    if (process.env.NODE_ENV !== 'test') {
        executeBatch(batchId, host, models, selectedPrompts, { quality_scoring, judge_config, execution_config: normalizedExecutionConfig, execution_mode }).catch(err => {
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
async function executeBatch(batchId, defaultHost, models, prompts, options = {}) {
    const enableQualityScoring = options.quality_scoring !== false;
    const judgeConfig = options.judge_config || {};
    const judgeSameHost = judgeConfig.judge_same_host !== undefined ? !!judgeConfig.judge_same_host : false;
    const executionMode = options.execution_mode || 'latency';

    // Prevent duplicate execution with atomic lock
    const batch = await BenchmarkBatch.findOneAndUpdate(
        { _id: batchId, execution_started_at: null },
        {
            $set: {
                execution_started_at: new Date(),
                execution_pid: process.pid,
                last_activity_at: new Date()
            }
        },
        { new: true }
    );

    if (!batch) {
        const existingBatch = await BenchmarkBatch.findById(batchId);
        if (!existingBatch) {
            logger.error('Batch not found', { batchId });
        } else {
            logger.warn('Skipping duplicate batch execution - already locked', {
                batchId, pid: process.pid, lockedBy: existingBatch.execution_pid
            });
        }
        return;
    }

    logger.info('Batch execution lock acquired', { batchId, pid: process.pid });

    const executionConfig = normalizeExecutionConfig(options.execution_config || batch.execution_config || {});
    activeBatchId = batchId;

    const recordBatchTimelineEvent = async (event, data = {}) => {
        try {
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                {
                    $push: {
                        timeline: {
                            $each: [{ timestamp: new Date(), event, ...data }],
                            $slice: -2500
                        }
                    },
                    $set: { last_activity_at: new Date() }
                }
            );
        } catch (err) {
            logger.debug('Failed to record timeline event', { batchId, event, error: err.message });
        }
    };

    await recordBatchTimelineEvent('prep_start', {
        model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null,
        success: true
    });

    // Per-batch judge queue
    const judgeConcurrency = executionMode === 'latency' ? 1 : (judgeConfig.concurrency || 2);
    const judgeQueue = enableQualityScoring ? new ConcurrencyQueue(judgeConcurrency) : null;

    // Periodic heartbeat
    const heartbeatInterval = setInterval(async () => {
        try {
            const heartbeatUpdate = await BenchmarkBatch.updateOne(
                { _id: batchId, status: { $in: ['running', 'judging', 'completed'] } },
                { $set: { last_activity_at: new Date() } }
            );
            if ((heartbeatUpdate && heartbeatUpdate.matchedCount) === 0) {
                clearInterval(heartbeatInterval);
                activeHeartbeatInterval = null;
            }
        } catch (err) {
            logger.warn('Heartbeat failed', { batchId, error: err.message });
        }
    }, 10000);
    activeHeartbeatInterval = heartbeatInterval;

    // Sync total_tests to actual plan
    const plannedTotalTests = models.length * prompts.length;
    if (plannedTotalTests > 0) {
        batch.total_tests = plannedTotalTests;
        await batch.save();
    }

    // Group models by host
    const modelsByHost = {};
    for (const model of models) {
        const targetHost = defaultHost;
        if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
        modelsByHost[targetHost].push(model);
    }

    // Create execution task functions (thunks) for each host
    let testsStarted = false;
    let stopCheckCounter = 0;
    let lastStopCheckAt = 0;
    const STOP_CHECK_EVERY_N = 5;
    const STOP_CHECK_MIN_INTERVAL_MS = 2000;
    const hostTasks = Object.entries(modelsByHost).map(([hostUrl, hostModels]) => async () => {
        try {
            // Determine judge host
            let judgeHostUrl = hostUrl;
            if (!judgeSameHost) {
                judgeHostUrl = HOSTS.primary;
                if (hostUrl === HOSTS.primary) judgeHostUrl = HOSTS.secondary;
                else if (hostUrl === HOSTS.secondary) judgeHostUrl = HOSTS.primary;
            }

            // Warmup judge model on separate host BEFORE tests start (strict: failure aborts)
            if (enableQualityScoring && !judgeSameHost) {
                const jModel = judgeConfig.model || JUDGE_CONFIG.model;
                await warmupModel(judgeHostUrl, jModel, {
                    timelinePrefix: 'judge_warmup',
                    recordTimelineEvent: recordBatchTimelineEvent,
                    strict: true
                });
                logger.info('Judge model ready', { host: judgeHostUrl, model: jModel });
            }

            for (const model of hostModels) {
                const modelWarmupData = await warmupModel(hostUrl, model, {
                    timelinePrefix: 'model_warmup',
                    recordTimelineEvent: recordBatchTimelineEvent
                });

                const hardwareSnapshot = await hardwareProfileService.detectHardware(hostUrl, model);

                // Per-model execution config (registry defaults/overrides > batch config)
                const modelExecConfig = await getModelExecutionConfig(model, executionConfig);
                if (modelExecConfig.num_ctx !== executionConfig.num_ctx) {
                    logger.info('Using per-model execution config', {
                        model, num_ctx: modelExecConfig.num_ctx, batch_num_ctx: executionConfig.num_ctx
                    });
                }

                let currentBatch;
                try {
                    currentBatch = await BenchmarkBatch.findById(batchId);
                    if (!currentBatch) {
                        logger.error('Batch not found during execution', { batchId, model });
                        continue;
                    }
                } catch (batchErr) {
                    logger.error('Failed to fetch batch object', { batchId, model, error: batchErr.message });
                    continue;
                }

                for (const prompt of prompts) {
                    // Check if batch was stopped (throttled)
                    stopCheckCounter += 1;
                    const now = Date.now();
                    const shouldCheckStop =
                        stopCheckCounter === 1 ||
                        (stopCheckCounter % STOP_CHECK_EVERY_N === 0) ||
                        ((now - lastStopCheckAt) >= STOP_CHECK_MIN_INTERVAL_MS);

                    if (shouldCheckStop) {
                        lastStopCheckAt = now;
                        try {
                            const stopCheck = await BenchmarkBatch.findById(batchId).select('status').lean();
                            if (stopCheck && stopCheck.status === 'stopped') {
                                logger.info('Batch execution stopped by user', { batchId });
                                clearInterval(heartbeatInterval);
                                activeHeartbeatInterval = null;
                                activeBatchId = null;
                                return;
                            }
                        } catch (stopCheckErr) {
                            logger.warn('Failed to check batch status', { batchId, model, error: stopCheckErr.message });
                        }
                    }

                    if (!testsStarted) {
                        testsStarted = true;
                        await recordBatchTimelineEvent('tests_start', { success: true });
                    }

                    const testNumber = (currentBatch.completed || 0) + 1;
                    const start = Date.now();

                    try {
                        await currentBatch.updateCurrentTest(
                            model,
                            prompt._id ? prompt._id.toString() : null,
                            prompt.name,
                            'executing',
                            { testNumber, promptLevel: prompt.level }
                        );

                        const url = `${hostUrl}/api/generate`;
                        const numPredict = modelExecConfig.response_max_tokens || 32000;
                        const expectedTokens = prompt.expected_tokens || null;
                        const promptText = applyLengthHint(prompt.prompt, expectedTokens, numPredict, modelExecConfig);
                        const hintApplied = promptText !== prompt.prompt;
                        const hintText = hintApplied ? promptText.slice(prompt.prompt.length).trim() : null;

                        const testController = new AbortController();
                        const testTimeoutId = setTimeout(() => testController.abort(), 180000);

                        const ollamaOptions = { num_predict: numPredict };
                        if (modelExecConfig.num_ctx) {
                            ollamaOptions.num_ctx = modelExecConfig.num_ctx;
                        }

                        const fetchOptions = getFetchOptions(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model,
                                prompt: promptText,
                                stream: false,
                                options: ollamaOptions
                            }),
                            signal: testController.signal
                        });

                        let response;
                        try {
                            response = await fetch(url, fetchOptions);
                        } finally {
                            clearTimeout(testTimeoutId);
                        }

                        const data = await response.json();
                        const latency = Date.now() - start;
                        const tokens = data.eval_count || Math.ceil((data.response || '').length / 4);
                        const tokens_per_sec = (tokens > 0 && latency > 0)
                            ? Number((tokens / (latency / 1000)).toFixed(2))
                            : 0;

                        const responseTruncated = data.done_reason === 'length';
                        if (responseTruncated) {
                            logger.warn('Model response truncated', {
                                model, prompt_name: prompt.name, tokens, num_predict: numPredict, done_reason: data.done_reason
                            });
                        }

                        const hasEmptyResponse = !data.response || data.response.trim().length === 0;
                        if (hasEmptyResponse) {
                            logger.warn('Model produced empty response', {
                                model, prompt_name: prompt.name, prompt_level: prompt.level,
                                prompt_category: prompt.category, done_reason: data.done_reason,
                                eval_count: data.eval_count, latency_ms: latency, host: hostUrl
                            });
                        }

                        const rawResponse = data.response || '';
                        const thinkingExtraction = extractThinkingBlocks(rawResponse);
                        const cleanedResponse = thinkingExtraction.content;
                        const extractedThinking = thinkingExtraction.thinking;

                        if (extractedThinking) {
                            logger.debug('Extracted thinking from response', {
                                model, prompt_name: prompt.name,
                                thinking_length: extractedThinking.length,
                                cleaned_response_length: cleanedResponse.length
                            });
                        }

                        const result = new BenchmarkResult({
                            model,
                            host: hostUrl,
                            judge_host: enableQualityScoring ? judgeHostUrl : null,
                            prompt: promptText,
                            prompt_level: prompt.level,
                            prompt_category: prompt.category,
                            prompt_name: prompt.name,
                            expected_answer: prompt.expected_answer,
                            judge_criteria: prompt.judge_criteria,
                            latency,
                            tokens,
                            tokens_per_sec,
                            response: cleanedResponse,
                            thinking: extractedThinking,
                            success: true,
                            batch_id: batchId,
                            timestamp: new Date(),
                            quality_score: null,
                            scoring_method: enableQualityScoring ? 'pending' : 'disabled',
                            judge_model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null,
                            hardware_snapshot: hardwareSnapshot,
                            truncation: {
                                response_truncated: responseTruncated,
                                response_tokens: tokens,
                                response_limit: numPredict,
                                done_reason: data.done_reason || null
                            },
                            execution_settings: {
                                num_predict: numPredict,
                                hint_applied: hintApplied,
                                hint_text: hintText
                            },
                            warmup: modelWarmupData ? {
                                prompt: modelWarmupData.prompt,
                                response: modelWarmupData.response,
                                latency_ms: modelWarmupData.latency_ms,
                                already_loaded: modelWarmupData.already_loaded
                            } : null
                        });

                        await result.save();
                        const resultId = result._id;

                        await currentBatch.recordTestComplete(
                            model,
                            prompt._id ? prompt._id.toString() : null,
                            latency, true, null, prompt.level, hostUrl, tokens_per_sec
                        );

                        await BenchmarkBatch.updateOne(
                            { _id: batchId },
                            {
                                $inc: { completed: 1 },
                                $push: {
                                    results: {
                                        $each: [{
                                            model, host: hostUrl,
                                            judge_host: enableQualityScoring ? judgeHostUrl : null,
                                            prompt_name: prompt.name, success: true,
                                            latency,
                                            response_preview: (data.response || '').substring(0, 100) + '...'
                                        }],
                                        $slice: -1000
                                    }
                                }
                            }
                        );

                        try {
                            const refreshedBatch = await BenchmarkBatch.findById(batchId).select('completed status').lean();
                            if (refreshedBatch) currentBatch.completed = refreshedBatch.completed;
                        } catch (refreshErr) {
                            logger.warn('Failed to refresh batch object', { batchId, model, error: refreshErr.message });
                        }

                        logger.info('Batch test completed', { batchId, model, prompt: prompt.name, latency });

                        // Pipeline: judge on separate machine while next test runs
                        if (enableQualityScoring && judgeQueue) {
                            const { judgeResult } = require('./judging');
                            const capturedResultId = resultId.toString();
                            const capturedJudgeConfig = { ...judgeConfig, host: judgeHostUrl };

                            await judgeQueue.waitForCapacity(10);
                            judgeQueue.add(async () => {
                                try {
                                    await judgeResult(capturedResultId, capturedJudgeConfig);
                                    await BenchmarkBatch.updateOne(
                                        { _id: batchId },
                                        { $inc: { judge_completed: 1 }, $set: { last_activity_at: new Date() } }
                                    );
                                } catch (scoreErr) {
                                    logger.warn('Pipelined judging failed', {
                                        batchId, model, prompt: prompt.name, error: scoreErr.message
                                    });
                                    await BenchmarkBatch.updateOne(
                                        { _id: batchId },
                                        { $inc: { judge_completed: 1, judge_failed: 1 } }
                                    );
                                }
                            }).catch(enqueueErr => {
                                logger.error('Failed to enqueue judge task', {
                                    batchId, model, prompt: prompt.name, error: enqueueErr.message
                                });
                            });
                        }

                    } catch (err) {
                        const errorDuration = Date.now() - start;
                        const classified = classifyBenchmarkError(err);

                        try {
                            const result = new BenchmarkResult({
                                model, host: hostUrl,
                                prompt: prompt.prompt,
                                prompt_level: prompt.level,
                                prompt_category: prompt.category,
                                prompt_name: prompt.name,
                                error: err.message,
                                infra_error: classified.infra,
                                error_type: classified.type,
                                error_http_status: classified.httpStatus,
                                success: false,
                                batch_id: batchId,
                                timestamp: new Date(),
                                quality_score: null,
                                scoring_method: enableQualityScoring ? 'exec_failed' : 'disabled',
                                judge_model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null,
                                judge_host: enableQualityScoring ? judgeHostUrl : null
                            });

                            await result.save();

                            await currentBatch.recordTestComplete(
                                model,
                                prompt._id ? prompt._id.toString() : null,
                                errorDuration, false, err, prompt.level, hostUrl, null
                            );

                            await BenchmarkBatch.updateOne(
                                { _id: batchId },
                                {
                                    $inc: { completed: 1, failed: 1 },
                                    $push: {
                                        results: {
                                            $each: [{ model, prompt_name: prompt.name, success: false, error: err.message }],
                                            $slice: -1000
                                        }
                                    }
                                }
                            );

                            const refreshedBatch = await BenchmarkBatch.findById(batchId).select('completed status').lean();
                            if (refreshedBatch) currentBatch.completed = refreshedBatch.completed;

                            logger.error('Batch test failed', { batchId, model, prompt: prompt.name, error: err.message });
                        } catch (saveErr) {
                            logger.error('Failed to save error result', {
                                batchId, model, prompt: prompt.name,
                                originalError: err.message, saveError: saveErr.message
                            });
                        }
                    }
                }
            }
        } catch (hostErr) {
            logger.error('Host execution failed - continuing with other hosts', {
                batchId, host: hostUrl, models: hostModels, error: hostErr.message, stack: hostErr.stack
            });
            await recordBatchTimelineEvent('host_execution_failed', {
                host: hostUrl, models: hostModels, error: hostErr.message
            }).catch(err => logger.error('Failed to record host failure event', { error: err.message }));
        }
    });

    // Execute serially (latency mode) or in parallel (throughput mode)
    if (executionMode === 'latency') {
        for (const task of hostTasks) {
            await task();
        }
    } else {
        await Promise.all(hostTasks.map(task => task()));
    }

    // Drain pipelined judge queue
    if (enableQualityScoring && judgeQueue) {
        const judgeableCount = await BenchmarkResult.countDocuments({ batch_id: batchId, success: true });
        await BenchmarkBatch.updateOne(
            { _id: batchId },
            { $set: { generated_at: new Date(), judge_total: judgeableCount, judge_status: 'running' } }
        );

        logger.info('Tests done, draining pipelined judge queue', { batchId, queueStatus: judgeQueue.getStatus() });

        const drainResult = await judgeQueue.drain({
            timeoutMs: 30 * 60 * 1000,
            stallTimeoutMs: 2 * 60 * 1000,
            onProgress: (status) => logger.debug('Judge queue progress', { batchId, ...status })
        });

        if (drainResult.timedOut) {
            logger.error('Judge queue drain timed out', { batchId, reason: drainResult.reason });
            await BenchmarkBatch.updateOne({ _id: batchId }, { $set: { judge_status: 'failed' } });
        } else {
            await BenchmarkBatch.updateOne({ _id: batchId }, { $set: { judge_status: 'completed' } });
        }

        logger.info('Judge queue drained', { batchId, completed: drainResult.completed, failed: drainResult.failed });
    }

    // Check if stopped during execution/judging
    const postExecBatch = await BenchmarkBatch.findById(batchId).select('status').lean();
    if (postExecBatch && postExecBatch.status === 'stopped') {
        clearInterval(heartbeatInterval);
        activeHeartbeatInterval = null;
        activeBatchId = null;
        return;
    }

    clearInterval(heartbeatInterval);
    activeHeartbeatInterval = null;
    activeBatchId = null;

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

        // Update hardware profiles for all tested model+host combinations
        try {
            const uniqueCombos = await BenchmarkResult.distinct('model', { batch_id: batchId, success: true });

            for (const model of uniqueCombos) {
                const hosts = await BenchmarkResult.distinct('host', {
                    batch_id: batchId, model, success: true,
                    'hardware_snapshot.backend': { $ne: null }
                });

                for (const host of hosts) {
                    const sampleResult = await BenchmarkResult.findOne({
                        batch_id: batchId, model, host,
                        'hardware_snapshot.backend': { $ne: null }
                    });

                    if (sampleResult && sampleResult.hardware_snapshot) {
                        await hardwareProfileService.updateProfile({
                            host, model,
                            hardwareSnapshot: sampleResult.hardware_snapshot,
                            workspaceId: finalBatch.workspaceId
                        });
                    }
                }
            }

            logger.info('Hardware profiles updated', { batchId, models: uniqueCombos.length });
        } catch (err) {
            logger.warn('Failed to update hardware profiles', { batchId, error: err.message });
        }
    }
}

/**
 * Stop a running batch
 */
async function stopBatch(batchId) {
    const batch = await BenchmarkBatch.findById(batchId);

    if (!batch) {
        throw new Error('Batch not found');
    }

    const stoppableStatuses = new Set(['pending', 'running']);
    if (!stoppableStatuses.has(batch.status)) {
        return { batch, alreadyStopped: true };
    }

    await batch.markAsStopped();
    logger.info('Batch stopped by user', { batchId });

    return { batch, alreadyStopped: false };
}

module.exports = {
    runTest,
    startBatch,
    executeBatch,
    stopBatch,
    getActiveBatchId,
    getActiveHeartbeatInterval,
    clearActiveBatch
};
