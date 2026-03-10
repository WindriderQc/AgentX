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
const hardwareProfileService = require('../hardwareProfileService');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const ConcurrencyQueue = require('./ConcurrencyQueue');
const { multiJudgeScore, shouldEscalateToMultiJudge } = require('./multiJudge');

// Active judging job state and helpers managed by judgeMonitor.js
const {
    activeJudgingJobs,
    persistJudgeCounters,
    stopJudging,
    stopAllJudging,
    getJudgingStatus
} = require('./judgeMonitor');


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
                judge_tier: scores.judge_tier || null,
                judge_tier_downgraded: scores.judge_tier_downgraded || false,
                judge_consensus: scores.judge_consensus || null,
                judge_divergence: scores.judge_divergence !== undefined ? scores.judge_divergence : null,
                judge_tiebreaker_used: !!scores.judge_tiebreaker_used,
                judge_escalated: !!scores.judge_escalated,
                scoring_method: scores.scoring_method,
                scoring_type: scores.scoring_type || resultData.scoring_type || 'reasoning',
                scoring_time_ms: scores.scoring_time_ms,
                quick_pattern: scores.quick_pattern,
                composite_score: composite.composite_score,
                composite_profile_used: composite.composite_profile_used,
                normalized_scores: composite.normalized,
                accuracy_score: scores.accuracy_score !== undefined ? scores.accuracy_score : null,
                compliance_score: scores.compliance_score !== undefined ? scores.compliance_score : null,
                semantic_score: scores.semantic_score !== undefined ? scores.semantic_score : null,
                format_score: scores.format_score !== undefined ? scores.format_score : null,
                format_compliant: scores.format_compliant !== undefined ? scores.format_compliant : null,
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
 * @param {Object} _batchHardwareSnapshot - Pre-detected hardware snapshot
 * @param {Object} [multiJudgeConfig] - Multi-judge settings:
 *   { enabled, judges: [{ model, host, tier }], tiebreaker: { model, host, tier } }
 * @returns {Object} Result from applyScoresToResult
 */
async function judgeResult(resultId, judgeConfig = {}, _batchHardwareSnapshot = null, multiJudgeConfig = null) {
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
            .select('scoring_dimensions reference_answer output_contract judge_criteria required_judge_tier')
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
        reference_answer: originalPrompt?.reference_answer || undefined,
        output_contract: originalPrompt?.output_contract || undefined,
        judge_criteria: originalPrompt?.judge_criteria || result.judge_criteria || undefined,
        required_judge_tier: originalPrompt?.required_judge_tier || undefined
    };

    const mergedConfig = {
        model: judgeConfig.model || result.judge_model || JUDGE_CONFIG.model,
        host: judgeConfig.host || result.judge_host || JUDGE_CONFIG.host
    };

    const baseScores = await scoreResponse({
        response: result.response,
        prompt: promptData,
        judgeConfig: mergedConfig,
        _batchHardwareSnapshot
    });

    const useMultiJudge = shouldEscalateToMultiJudge({
        category: result.prompt_category,
        scoringMethod: baseScores.scoring_method,
        judgeConfidence: baseScores.judge_confidence,
        needsReview: baseScores.needs_review,
        multiJudgeConfig
    });

    if (useMultiJudge) {
        const mjResult = await multiJudgeScore({
            response: result.response,
            prompt: promptData,
            judges: multiJudgeConfig.judges,
            tiebreakerJudge: multiJudgeConfig.tiebreaker || null,
            _batchHardwareSnapshot,
            seedJudgeResult: {
                judge_model: baseScores.judge_model || mergedConfig.model,
                judge_host: baseScores.judge_host || mergedConfig.host,
                judge_tier: baseScores.judge_tier || 'unknown',
                quality_score: baseScores.quality_score,
                explanation: baseScores.explanation,
                scoring_time_ms: baseScores.scoring_time_ms,
                scoring_method: baseScores.scoring_method,
                success: baseScores.quality_score !== null && baseScores.quality_score !== undefined
            }
        });

        // Store all individual judge scores
        const judgeScoreRecords = mjResult.scores
            .filter(s => s.success)
            .map(s => ({
                judge_model: s.judge_model,
                judge_host: s.judge_host,
                judge_tier: s.judge_tier,
                quality_score: s.quality_score,
                explanation: s.explanation,
                scoring_time_ms: s.scoring_time_ms
            }));

        await BenchmarkResult.updateOne(
            { _id: resultId },
            { $set: { judge_scores: judgeScoreRecords } }
        );

        const consensusConfidence = mjResult.consensus === 'agreement'
            ? Math.max(baseScores.judge_confidence || 0, 0.9)
            : mjResult.consensus === 'tiebreaker_resolved'
                ? Math.max(baseScores.judge_confidence || 0, 0.85)
                : Math.min(baseScores.judge_confidence ?? 0.6, 0.6);
        const consensusNeedsReview = mjResult.consensus === 'divergent_unresolved';
        const consensusReviewReason = [
            baseScores.review_reason || null,
            mjResult.divergent ? `Multi-judge divergence ${mjResult.divergence}` : null,
            mjResult.tiebreakerUsed ? 'Escalated to tiebreaker judge' : null
        ].filter(Boolean).join('; ');

        return applyScoresToResult(resultId, {
            ...baseScores,
            quality_score: mjResult.finalScore !== null ? mjResult.finalScore : baseScores.quality_score,
            explanation: `[Multi-judge consensus: ${mjResult.consensus}] ${baseScores.explanation || ''}`.trim(),
            judge_confidence: Math.round(consensusConfidence * 100) / 100,
            needs_review: consensusNeedsReview,
            review_reason: consensusNeedsReview
                ? (consensusReviewReason || 'Multi-judge disagreement requires review')
                : (consensusReviewReason || baseScores.review_reason || null),
            judge_consensus: mjResult.consensus,
            judge_divergence: mjResult.divergence ?? null,
            judge_tiebreaker_used: !!mjResult.tiebreakerUsed,
            judge_escalated: true
        }, {
            latency: result.latency,
            tokens_per_sec: result.tokens_per_sec,
            prompt_category: result.prompt_category,
            scoring_type: result.scoring_type
        });
    }

    return applyScoresToResult(resultId, baseScores, {
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
    let finalStatus = 'failed';
    let timedOut = false;

    try {
        // Detect judge hardware ONCE for entire batch
        let batchHardwareSnapshot = null;
        try {
            const judgeHost = judgeConfig.host || JUDGE_CONFIG.host;
            const judgeModel = judgeConfig.model || JUDGE_CONFIG.model;
            if (judgeHost && judgeModel) {
                const hwPromise = hardwareProfileService.detectHardware(judgeHost, judgeModel);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Hardware detection timeout')), 5000)
                );
                batchHardwareSnapshot = await Promise.race([hwPromise, timeoutPromise]);
                logger.debug('Judge batch hardware detection complete', {
                    batchId,
                    gpu: batchHardwareSnapshot?.gpu_layers,
                    vram: batchHardwareSnapshot?.total_vram_gb
                });
            }
        } catch (hwErr) {
            logger.debug('Judge batch hardware detection failed (non-critical)', { batchId, error: hwErr.message });
        }

        for (const result of pendingResults) {
            if (job.stopped) break;

            queue.add(async () => {
                if (job.stopped) return;

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
            }).catch(async (enqueueErr) => {
                failed++;
                logger.error('Failed to enqueue judge task', {
                    batchId,
                    resultId: result._id.toString(),
                    error: enqueueErr.message
                });
                // Count the lost task so counters stay consistent
                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    { $inc: { judge_completed: 1, judge_failed: 1 } }
                ).catch(() => {});
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

        timedOut = drainResult.timedOut;
        finalStatus = job.stopped ? 'stopped' : (timedOut ? 'failed' : 'completed');

        // Final authoritative reconciliation — all $inc operations are done, safe to $set.
        const [finalJudgeTotal, finalJudgeCompleted, finalJudgeFailed] = await Promise.all([
            BenchmarkResult.countDocuments({
                batch_id: batchId,
                success: true,
                response: { $type: 'string', $nin: ['', null] }
            }),
            BenchmarkResult.countDocuments({
                batch_id: batchId,
                success: true,
                response: { $type: 'string', $nin: ['', null] },
                scoring_method: { $ne: 'pending' }
            }),
            BenchmarkResult.countDocuments({
                batch_id: batchId,
                success: true,
                response: { $type: 'string', $nin: ['', null] },
                scoring_method: 'llm_failed'
            })
        ]);

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $set: {
                    judge_status: finalStatus,
                    judge_total: finalJudgeTotal,
                    judge_completed: finalJudgeCompleted,
                    judge_failed: finalJudgeFailed,
                    last_activity_at: new Date()
                }
            }
        );

        logger.info('Standalone judging completed', {
            batchId,
            finalStatus,
            authoritative: { total: finalJudgeTotal, completed: finalJudgeCompleted, failed: finalJudgeFailed }
        });

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
    } catch (err) {
        finalStatus = activeJudgingJobs.get(batchId)?.stopped ? 'stopped' : 'failed';
        logger.error('Standalone judging crashed', {
            batchId,
            error: err.message,
            stack: err.stack
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
        }).catch((persistErr) => {
            logger.error('Failed to persist judge crash state', {
                batchId,
                error: persistErr.message
            });
        });

        throw err;
    } finally {
        // Guarantee cleanup even on uncaught exceptions — prevents permanent lock
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
