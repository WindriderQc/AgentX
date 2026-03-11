/**
 * Benchmark Execution Module
 * Core batch management, orchestration, and progress tracking
 */

const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { JUDGE_CONFIG } = require('../qualityScorer');
const hardwareProfileService = require('../hardwareProfileService');
const { normalizeExecutionConfig } = require('./config');
const { seedPrompts } = require('./init');
const { resolveModelNumCtx } = require('../../utils');

const { samplePromptsByDepth } = require('./promptSampling');
const { runTest } = require('./testExecution');
const { buildExecutionPlan } = require('./batchPlanner');
const { runBatchOrchestrator } = require('./batchOrchestrator');

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

async function getModelExecutionConfig(modelName, batchConfig, targetHost) {
    try {
        const numCtx = await resolveModelNumCtx(modelName, {
            targetHost,
            fallback: batchConfig.num_ctx || 8192
        });
        return { ...batchConfig, num_ctx: numCtx };
    } catch (err) {
        logger.debug('Failed to resolve model execution config, using batch config', {
            modelName,
            error: err.message
        });
        return batchConfig;
    }
}

async function startBatch({
    host,
    models,
    levels,
    run_name,
    judge_config = {},
    execution_config = {},
    tags = [],
    description = '',
    execution_mode = 'latency',
    depth_config = null
}) {
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

    const { plan, normalizedExecutionConfig, judgeSameHost } = buildExecutionPlan(
        host,
        models,
        selectedPrompts,
        { judge_config, execution_config }
    );

    const batch = new BenchmarkBatch({
        host,
        models,
        levels,
        judge_config,
        execution_config: normalizedExecutionConfig,
        depth_config: (depth_config && typeof depth_config === 'object') ? depth_config : null,
        run_name: run_name || description || `Batch ${new Date().toLocaleString()}`,
        active_slot: 'benchmark_singleton',
        total_tests: models.length * selectedPrompts.length,
        plan,
        judge_same_host: judgeSameHost,
        judge_total: models.length * selectedPrompts.length,
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
        executeBatch(batchId, host, models, selectedPrompts, {
            judge_config,
            execution_config: normalizedExecutionConfig,
            execution_mode
        }).catch((err) => {
            logger.error('Batch execution failed', { batchId, error: err.message });
        });
    }

    return {
        batch_id: batchId,
        total_tests: batch.total_tests,
        plan
    };
}

async function updateHardwareProfiles(batchId, workspaceId) {
    const uniqueCombos = await BenchmarkResult.distinct('model', {
        batch_id: batchId,
        success: true
    });

    for (const model of uniqueCombos) {
        const hosts = await BenchmarkResult.distinct('host', {
            batch_id: batchId,
            model,
            success: true,
            'hardware_snapshot.backend': { $ne: null }
        });

        for (const host of hosts) {
            const sampleResult = await BenchmarkResult.findOne({
                batch_id: batchId,
                model,
                host,
                'hardware_snapshot.backend': { $ne: null }
            });

            if (sampleResult && sampleResult.hardware_snapshot) {
                await hardwareProfileService.updateProfile({
                    host,
                    model,
                    hardwareSnapshot: sampleResult.hardware_snapshot,
                    workspaceId
                });
            }
        }
    }

    logger.info('Hardware profiles updated', { batchId, models: uniqueCombos.length });
}

async function executeBatch(batchId, defaultHost, models, prompts, options = {}) {
    const judgeConfig = options.judge_config || {};
    const executionMode = options.execution_mode || 'latency';

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
                batchId,
                pid: process.pid,
                lockedBy: existingBatch.execution_pid
            });
        }
        return;
    }

    logger.info('Batch execution lock acquired', { batchId, pid: process.pid });

    const executionConfig = normalizeExecutionConfig(options.execution_config || batch.execution_config || {});
    activeBatchId = batchId;
    let heartbeatInterval = null;

    const stopHeartbeat = () => {
        const interval = heartbeatInterval;
        if (!interval) {
            return;
        }

        clearInterval(interval);
        if (activeHeartbeatInterval === interval) {
            activeHeartbeatInterval = null;
        }
        heartbeatInterval = null;
    };

    const clearActiveState = () => {
        stopHeartbeat();
        if (activeBatchId === batchId) {
            activeBatchId = null;
        }
    };

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
            logger.debug('Failed to record timeline event', {
                batchId,
                event,
                error: err.message
            });
        }
    };

    const progressFlushThreshold = executionMode === 'throughput' ? 8 : 4;
    const progressFlushIntervalMs = 1500;
    const pendingBatchProgress = {
        completed: 0,
        failed: 0,
        results: [],
        dirtySince: 0
    };

    function queueBatchProgress(resultSummary, { failed = false } = {}) {
        pendingBatchProgress.completed += 1;
        if (failed) {
            pendingBatchProgress.failed += 1;
        }
        pendingBatchProgress.results.push(resultSummary);
        if (!pendingBatchProgress.dirtySince) {
            pendingBatchProgress.dirtySince = Date.now();
        }
    }

    async function flushBatchProgress(force = false) {
        if (pendingBatchProgress.completed === 0 && pendingBatchProgress.results.length === 0) {
            return;
        }

        const ageMs = pendingBatchProgress.dirtySince
            ? (Date.now() - pendingBatchProgress.dirtySince)
            : 0;

        if (!force && pendingBatchProgress.results.length < progressFlushThreshold && ageMs < progressFlushIntervalMs) {
            return;
        }

        const results = pendingBatchProgress.results.slice();
        const completed = pendingBatchProgress.completed;
        const failed = pendingBatchProgress.failed;
        const update = {
            $inc: { completed },
            $set: { last_activity_at: new Date() }
        };

        if (failed > 0) {
            update.$inc.failed = failed;
        }
        if (results.length > 0) {
            update.$push = {
                results: {
                    $each: results,
                    $slice: -1000
                }
            };
        }

        await BenchmarkBatch.updateOne({ _id: batchId }, update);

        pendingBatchProgress.completed = 0;
        pendingBatchProgress.failed = 0;
        pendingBatchProgress.results = [];
        pendingBatchProgress.dirtySince = 0;
    }

    try {
        await recordBatchTimelineEvent('prep_start', {
            model: judgeConfig.model || JUDGE_CONFIG.model,
            success: true
        });

        heartbeatInterval = setInterval(async () => {
            try {
                const heartbeatUpdate = await BenchmarkBatch.updateOne(
                    { _id: batchId, status: { $in: ['running', 'judging', 'completed'] } },
                    { $set: { last_activity_at: new Date() } }
                );
                if ((heartbeatUpdate && heartbeatUpdate.matchedCount) === 0) {
                    stopHeartbeat();
                }
            } catch (err) {
                logger.warn('Heartbeat failed', { batchId, error: err.message });
            }
        }, 10000);
        activeHeartbeatInterval = heartbeatInterval;

        const plannedTotalTests = models.length * prompts.length;
        if (plannedTotalTests > 0) {
            batch.total_tests = plannedTotalTests;
            await batch.save();
        }

        await runBatchOrchestrator({
            batchId,
            defaultHost,
            models,
            prompts,
            judgeConfig,
            executionConfig,
            executionMode,
            getModelExecutionConfig,
            recordBatchTimelineEvent,
            queueBatchProgress,
            flushBatchProgress,
            handleGracefulStop: clearActiveState
        });

        await flushBatchProgress(true);

        const postExecBatch = await BenchmarkBatch.findById(batchId).select('status').lean();
        if (postExecBatch && postExecBatch.status === 'stopped') {
            return;
        }

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

            try {
                await updateHardwareProfiles(batchId, finalBatch.workspaceId);
            } catch (err) {
                logger.warn('Failed to update hardware profiles', {
                    batchId,
                    error: err.message
                });
            }
        }
    } catch (err) {
        await flushBatchProgress(true).catch((flushErr) => {
            logger.warn('Failed to flush pending batch progress after crash', {
                batchId,
                error: flushErr.message
            });
        });

        logger.error('Batch execution crashed', {
            batchId,
            error: err.message,
            stack: err.stack
        });

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $set: {
                    status: 'failed',
                    judge_status: 'failed',
                    completed_at: new Date(),
                    last_activity_at: new Date()
                },
                $push: {
                    timeline: {
                        $each: [{
                            timestamp: new Date(),
                            event: 'execution_crash',
                            success: false,
                            error: err.message
                        }],
                        $slice: -2500
                    }
                }
            }
        ).catch((persistErr) => {
            logger.error('Failed to persist batch crash state', {
                batchId,
                error: persistErr.message
            });
        });

        throw err;
    } finally {
        await flushBatchProgress(true).catch((flushErr) => {
            logger.warn('Failed to flush pending batch progress during cleanup', {
                batchId,
                error: flushErr.message
            });
        });
        clearActiveState();
    }
}

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
