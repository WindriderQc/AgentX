/**
 * Judging Module
 * Standalone judge/scoring orchestration for benchmark results.
 * Decoupled from execution.js - testing completes independently,
 * judging runs as a separate background operation.
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG } = require('../qualityScorer');
const { classifyBenchmarkError } = require('./errorClassifier');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const ConcurrencyQueue = require('./ConcurrencyQueue');

// Track active judging jobs (batchId -> { queue, stopped })
const activeJudgingJobs = new Map();

/**
 * Validate whether judging can be started for a batch and count eligible results.
 * @param {string} batchId
 * @param {Object} options
 * @param {boolean} options.force - when true, all successful results are eligible
 * @returns {Promise<{pendingCount:number,batchStatus:string}>}
 */
async function preflightJudgeBatch(batchId, options = {}) {
    const { force = false } = options;

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

    const filter = {
        batch_id: batchId,
        success: true,
        response: { $type: 'string', $nin: ['', null] }
    };

    if (!force) {
        filter.scoring_method = { $in: ['pending', 'llm_failed'] };
    }

    const pendingCount = await BenchmarkResult.countDocuments(filter);
    if (pendingCount === 0) {
        throw new Error(force
            ? 'No judgeable successful results found (non-empty response required)'
            : 'No pending judgeable results found (non-empty response required)');
    }

    return {
        pendingCount,
        batchStatus: batch.status || 'unknown'
    };
}

/**
 * Single source of truth for writing judge scores to a BenchmarkResult.
 * Eliminates duplication between execution.js and routes/benchmark.js.
 *
 * @param {string} resultId - BenchmarkResult _id
 * @param {Object} scores - Output from scoreResponse()
 * @param {Object} resultData - { latency, tokens_per_sec, prompt_category, scoring_type }
 * @returns {Object} { quality_score, scoring_method, composite_score, judge_confidence, needs_review }
 */
async function applyScoresToResult(resultId, scores, resultData) {
    const categoryOrProfile = resultData.prompt_category || 'interactive';

    const composite = calculateCompositeScore({
        latency: resultData.latency,
        tokens_per_sec: resultData.tokens_per_sec,
        quality_score: scores.quality_score
    }, categoryOrProfile);

    // Build truncation update if present
    const truncationUpdate = scores.truncation ? {
        'truncation.judge_truncated': scores.truncation.judge_truncated,
        'truncation.judge_tokens': scores.truncation.judge_tokens
    } : {};

    // Handle llm_failed case
    const isJudgeFailed = scores.scoring_method === 'llm_failed';
    let judgeFailureUpdate = {};
    if (isJudgeFailed) {
        const judgeErrorMessage = scores.error || scores.explanation || 'Judge failed';
        const classified = classifyBenchmarkError(judgeErrorMessage);
        judgeFailureUpdate = {
            error: judgeErrorMessage,
            infra_error: classified.infra,
            error_type: classified.type,
            error_http_status: classified.httpStatus
        };
    }

    await BenchmarkResult.updateOne(
        { _id: resultId },
        {
            $set: {
                quality_score: scores.quality_score,
                quality_breakdown: scores.breakdown,
                quality_explanation: scores.explanation,
                judge_prompt: scores.judge_prompt,
                judge_model: scores.judge_model,
                judge_raw_response: scores.judge_raw_response,
                judge_hardware_snapshot: scores.judge_hardware_snapshot || null,
                scoring_method: scores.scoring_method,
                scoring_type: scores.scoring_type || resultData.scoring_type || 'reasoning',
                scoring_time_ms: scores.scoring_time_ms,
                quick_pattern: scores.quick_pattern,
                composite_score: composite.composite_score,
                composite_profile_used: composite.composite_profile_used,
                normalized_scores: composite.normalized,
                judge_confidence: scores.judge_confidence,
                prompt_complexity: scores.prompt_complexity,
                needs_review: scores.needs_review || false,
                review_reason: scores.review_reason || null,
                ...truncationUpdate,
                ...judgeFailureUpdate
            }
        }
    );

    return {
        quality_score: scores.quality_score,
        scoring_method: scores.scoring_method,
        composite_score: composite.composite_score,
        judge_confidence: scores.judge_confidence,
        needs_review: scores.needs_review || false
    };
}

/**
 * Judge a single result by ID.
 *
 * @param {string} resultId - BenchmarkResult _id
 * @param {Object} judgeConfig - { host, model } overrides (merged with JUDGE_CONFIG defaults)
 * @returns {Object} Result from applyScoresToResult
 */
async function judgeResult(resultId, judgeConfig = {}) {
    const result = await BenchmarkResult.findById(resultId);
    if (!result) {
        throw new Error(`Result not found: ${resultId}`);
    }
    if (!result.success) {
        throw new Error('Cannot judge failed test executions');
    }
    if (!result.response) {
        throw new Error('No response to judge');
    }

    // Look up original prompt for scoring_dimensions and reference_answer
    // These fields live on BenchmarkPrompt, not BenchmarkResult
    let originalPrompt = null;
    if (result.prompt_name) {
        originalPrompt = await BenchmarkPrompt.findOne({ name: result.prompt_name })
            .select('scoring_dimensions reference_answer')
            .lean();
    }

    const promptData = {
        prompt: result.prompt,
        name: result.prompt_name,
        level: result.prompt_level,
        category: result.prompt_category,
        expected_answer: result.expected_answer,
        scoring_type: result.scoring_type,
        deterministic_scoring: result.deterministic_scoring,
        scoring_dimensions: originalPrompt?.scoring_dimensions || undefined,
        reference_answer: originalPrompt?.reference_answer || undefined
    };

    const mergedConfig = {
        model: judgeConfig.model || result.judge_model || JUDGE_CONFIG.model,
        host: judgeConfig.host || result.judge_host || JUDGE_CONFIG.host
    };

    const scores = await scoreResponse({
        response: result.response,
        prompt: promptData,
        judgeConfig: mergedConfig
    });

    return applyScoresToResult(resultId, scores, {
        latency: result.latency,
        tokens_per_sec: result.tokens_per_sec,
        prompt_category: result.prompt_category,
        scoring_type: result.scoring_type
    });
}

/**
 * Judge all unjudged results in a batch.
 * Runs in background with its own ConcurrencyQueue.
 *
 * @param {string} batchId
 * @param {Object} options
 * @param {Object} options.judgeConfig - { host, model } overrides
 * @param {number} options.concurrency - Parallel judge tasks (default 2)
 * @param {boolean} options.force - Re-judge already scored results (default false)
 * @returns {Object} { judged, failed, timedOut }
 */
async function judgeBatch(batchId, options = {}) {
    const { judgeConfig = {}, concurrency = 2, force = false } = options;

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

    // Find unjudged results (or all if force)
    const filter = {
        batch_id: batchId,
        success: true,
        response: { $type: 'string', $nin: ['', null] }
    };
    if (!force) {
        filter.scoring_method = { $in: ['pending', 'llm_failed'] };
    }

    const pendingResults = await BenchmarkResult.find(filter)
        .select('_id prompt_name prompt_level prompt_category')
        .lean();

    if (pendingResults.length === 0) {
        return { judged: 0, failed: 0, timedOut: false };
    }

    // Acquire judge-status lock to prevent duplicate in-flight judge jobs.
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

    for (const result of pendingResults) {
        if (job.stopped) break;

        queue.add(async () => {
            if (job.stopped) return;

            try {
                await judgeResult(result._id.toString(), judgeConfig);
                judged++;

                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    {
                        $inc: { judge_completed: 1 },
                        $set: { last_activity_at: new Date() }
                    }
                );
            } catch (err) {
                failed++;
                logger.warn('Judge failed for result', {
                    batchId,
                    resultId: result._id.toString(),
                    prompt_name: result.prompt_name,
                    error: err.message
                });

                // Mark result as llm_failed if it wasn't already handled
                await BenchmarkResult.updateOne(
                    { _id: result._id },
                    {
                        $set: {
                            scoring_method: 'llm_failed',
                            quality_explanation: err.message,
                            judge_model: judgeConfig.model || JUDGE_CONFIG.model
                        }
                    }
                ).catch(() => {});

                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    { $inc: { judge_completed: 1, judge_failed: 1 } }
                );
            }
        }).catch((enqueueErr) => {
            logger.error('Failed to enqueue judge task', {
                batchId,
                resultId: result._id.toString(),
                error: enqueueErr.message
            });
        });
    }

    // Drain with timeout protection
    const drainResult = await queue.drain({
        timeoutMs: 30 * 60 * 1000,
        stallTimeoutMs: 2 * 60 * 1000,
        onProgress: (status) => {
            logger.debug('Judge queue progress', { batchId, ...status });
        }
    });

    activeJudgingJobs.delete(batchId);

    // Update batch judge status
    const finalStatus = job.stopped ? 'stopped' : (drainResult.timedOut ? 'failed' : 'completed');
    await BenchmarkBatch.updateOne(
        { _id: batchId },
        {
            $set: {
                judge_status: finalStatus,
                last_activity_at: new Date()
            }
        }
    );

    // Recalculate metrics if judging completed
    if (finalStatus === 'completed') {
        try {
            const freshBatch = await BenchmarkBatch.findById(batchId);
            if (freshBatch) {
                await freshBatch.calculateMetrics();
            }
        } catch (err) {
            logger.warn('Failed to recalculate metrics after judging', { batchId, error: err.message });
        }
    }

    return {
        judged,
        failed,
        timedOut: drainResult.timedOut
    };
}

/**
 * Stop active judging for a batch.
 * @param {string} batchId
 * @returns {boolean} true if judging was active and stopped
 */
function stopJudging(batchId) {
    const job = activeJudgingJobs.get(batchId);
    if (!job) return false;

    job.stopped = true;
    logger.info('Judging stop requested', { batchId });
    return true;
}

/**
 * Get judging status for a batch.
 * Returns live queue stats if active, else batch counters.
 * @param {string} batchId
 * @returns {Object}
 */
async function getJudgingStatus(batchId) {
    const job = activeJudgingJobs.get(batchId);
    if (job) {
        return {
            active: true,
            stopped: job.stopped,
            ...job.queue.getStatus()
        };
    }

    const batch = await BenchmarkBatch.findById(batchId)
        .select('judge_status judge_total judge_completed judge_failed')
        .lean();

    if (!batch) {
        throw new Error(`Batch not found: ${batchId}`);
    }

    return {
        active: false,
        judge_status: batch.judge_status || 'none',
        judge_total: batch.judge_total,
        judge_completed: batch.judge_completed,
        judge_failed: batch.judge_failed
    };
}

/**
 * Stop all active judging jobs (for graceful shutdown).
 */
function stopAllJudging() {
    for (const [batchId, job] of activeJudgingJobs) {
        job.stopped = true;
        logger.info('Stopping judging on shutdown', { batchId });
    }
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
