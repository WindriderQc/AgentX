/**
 * Judging Module
 * Public entry point for benchmark judging orchestration.
 * Per-result judge execution lives in judgeExecutor.js.
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { JUDGE_CONFIG } = require('../qualityScorer');
const hardwareProfileService = require('../hardwareProfileService');
const ConcurrencyQueue = require('./ConcurrencyQueue');
const { applyScoresToResult, judgeResult } = require('./judgeExecutor');

// Active judging job state and helpers managed by judgeMonitor.js
const {
    activeJudgingJobs,
    persistJudgeCounters,
    getAuthoritativeJudgeCounters,
    stopJudging,
    stopAllJudging,
    getJudgingStatus
} = require('./judgeMonitor');

function buildJudgeableResultFilter(batchId, options = {}) {
    const { force = false } = options;
    const filter = {
        batch_id: batchId,
        success: true,
        response: { $type: 'string', $nin: ['', null] }
    };

    if (!force) {
        filter.scoring_method = { $in: ['pending', 'llm_failed'] };
    }

    return filter;
}

async function preflightJudgeBatch(batchId, options = {}) {
    const batch = await BenchmarkBatch.findById(batchId)
        .select('status judge_status')
        .lean();

    if (!batch) {
        throw new Error(`Batch not found: ${batchId}`);
    }

    if (batch.status === 'running') {
        throw new Error('Cannot judge while batch is still running');
    }

    if (batch.judge_status === 'running' || activeJudgingJobs.has(batchId)) {
        throw new Error('Judging is already running for this batch');
    }

    const pendingCount = await BenchmarkResult.countDocuments(
        buildJudgeableResultFilter(batchId, options)
    );

    if (pendingCount === 0) {
        throw new Error(options.force
            ? 'No judgeable successful results found (non-empty response required)'
            : 'No pending judgeable results found (non-empty response required)');
    }

    return {
        pendingCount,
        batchStatus: batch.status || 'unknown'
    };
}

async function detectBatchHardware(batchId, judgeConfig) {
    try {
        const judgeHost = judgeConfig.host || JUDGE_CONFIG.host;
        const judgeModel = judgeConfig.model || JUDGE_CONFIG.model;

        if (!judgeHost || !judgeModel) {
            return null;
        }

        const hardwarePromise = hardwareProfileService.detectHardware(judgeHost, judgeModel);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Hardware detection timeout')), 5000)
        );
        const snapshot = await Promise.race([hardwarePromise, timeoutPromise]);

        logger.debug('Judge batch hardware detection complete', {
            batchId,
            gpu: snapshot?.gpu_layers,
            vram: snapshot?.total_vram_gb
        });

        return snapshot;
    } catch (error) {
        logger.debug('Judge batch hardware detection failed (non-critical)', {
            batchId,
            error: error.message
        });
        return null;
    }
}

async function reconcileJudgeCounters(batchId) {
    const [judgeTotal, judgeCompleted, judgeFailed] = await Promise.all([
        BenchmarkResult.countDocuments(buildJudgeableResultFilter(batchId, { force: true })),
        BenchmarkResult.countDocuments({
            ...buildJudgeableResultFilter(batchId, { force: true }),
            scoring_method: { $ne: 'pending' }
        }),
        BenchmarkResult.countDocuments({
            ...buildJudgeableResultFilter(batchId, { force: true }),
            scoring_method: 'llm_failed'
        })
    ]);

    return {
        judge_total: judgeTotal,
        judge_completed: judgeCompleted,
        judge_failed: judgeFailed
    };
}

async function judgeBatch(batchId, options = {}) {
    const { judgeConfig = {}, concurrency = 2, force = false, multiJudge = null } = options;

    if (activeJudgingJobs.has(batchId)) {
        throw new Error('Judging is already running for this batch');
    }

    const batch = await BenchmarkBatch.findById(batchId);
    if (!batch) {
        throw new Error(`Batch not found: ${batchId}`);
    }
    if (batch.status === 'running') {
        throw new Error('Cannot judge while batch is still running');
    }

    const pendingResults = await BenchmarkResult.find(buildJudgeableResultFilter(batchId, { force }))
        .select('_id prompt_name prompt_level prompt_category')
        .lean();

    if (pendingResults.length === 0) {
        return { judged: 0, failed: 0, timedOut: false };
    }

    const lockUpdate = await BenchmarkBatch.updateOne(
        { _id: batchId, judge_status: { $ne: 'running' } },
        {
            $set: {
                judge_status: 'running',
                judge_total: pendingResults.length,
                judge_completed: 0,
                judge_failed: 0,
                last_activity_at: new Date()
            }
        }
    );

    if (!lockUpdate || lockUpdate.matchedCount === 0) {
        throw new Error('Judging is already running for this batch');
    }

    const queue = new ConcurrencyQueue(concurrency);
    const job = { queue, stopped: false };
    activeJudgingJobs.set(batchId, job);

    let judged = 0;
    let failed = 0;
    let timedOut = false;
    let finalStatus = 'failed';

    try {
        const batchHardwareSnapshot = await detectBatchHardware(batchId, judgeConfig);

        for (const result of pendingResults) {
            if (job.stopped) {
                break;
            }

            queue.add(async () => {
                if (job.stopped) {
                    return;
                }

                try {
                    await judgeResult(result._id.toString(), judgeConfig, batchHardwareSnapshot, multiJudge);
                    judged++;

                    await BenchmarkBatch.updateOne(
                        { _id: batchId },
                        {
                            $inc: { judge_completed: 1 },
                            $set: { last_activity_at: new Date() }
                        }
                    );
                } catch (error) {
                    failed++;
                    logger.warn('Judge failed for result', {
                        batchId,
                        resultId: result._id.toString(),
                        prompt_name: result.prompt_name,
                        error: error.message
                    });

                    await BenchmarkResult.updateOne(
                        { _id: result._id },
                        {
                            $set: {
                                scoring_method: 'llm_failed',
                                quality_explanation: error.message,
                                judge_model: judgeConfig.model || JUDGE_CONFIG.model
                            }
                        }
                    ).catch(() => {});

                    await BenchmarkBatch.updateOne(
                        { _id: batchId },
                        { $inc: { judge_completed: 1, judge_failed: 1 } }
                    );
                }
            }).catch(async (enqueueError) => {
                failed++;
                logger.error('Failed to enqueue judge task', {
                    batchId,
                    resultId: result._id.toString(),
                    error: enqueueError.message
                });

                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    { $inc: { judge_completed: 1, judge_failed: 1 } }
                ).catch(() => {});
            });
        }

        const drainResult = await queue.drain({
            timeoutMs: 30 * 60 * 1000,
            stallTimeoutMs: 2 * 60 * 1000,
            onProgress: (status) => {
                logger.debug('Judge queue progress', { batchId, ...status });
            }
        });

        timedOut = drainResult.timedOut;
        finalStatus = job.stopped ? 'stopped' : (timedOut ? 'failed' : 'completed');

        const authoritative = await reconcileJudgeCounters(batchId);
        await persistJudgeCounters(batchId, {
            judge_status: finalStatus,
            ...authoritative
        });

        logger.info('Standalone judging completed', {
            batchId,
            finalStatus,
            authoritative: {
                total: authoritative.judge_total,
                completed: authoritative.judge_completed,
                failed: authoritative.judge_failed
            }
        });

        if (finalStatus === 'completed') {
            try {
                const freshBatch = await BenchmarkBatch.findById(batchId);
                if (freshBatch) {
                    await freshBatch.calculateMetrics();
                }
            } catch (error) {
                logger.warn('Failed to recalculate metrics after judging', {
                    batchId,
                    error: error.message
                });
            }
        }
    } catch (error) {
        finalStatus = activeJudgingJobs.get(batchId)?.stopped ? 'stopped' : 'failed';
        logger.error('Standalone judging crashed', {
            batchId,
            error: error.message,
            stack: error.stack
        });

        const authoritative = await getAuthoritativeJudgeCounters(batchId).catch(() => ({
            judge_total: 0,
            judge_completed: 0,
            judge_failed: failed
        }));

        await persistJudgeCounters(batchId, {
            judge_status: finalStatus,
            judge_total: authoritative.judge_total,
            judge_completed: authoritative.judge_completed,
            judge_failed: authoritative.judge_failed
        }).catch((persistError) => {
            logger.error('Failed to persist judge crash state', {
                batchId,
                error: persistError.message
            });
        });

        throw error;
    } finally {
        activeJudgingJobs.delete(batchId);
    }

    return {
        judged,
        failed,
        timedOut
    };
}

module.exports = {
    applyScoresToResult,
    judgeResult,
    judgeBatch,
    preflightJudgeBatch,
    stopJudging,
    getJudgingStatus,
    stopAllJudging
};
