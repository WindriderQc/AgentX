/**
 * Benchmark Batches Module
 * Batch management and statistics
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { HOSTS } = require('../modelRouter');

/**
 * Compute percentile/summary stats from a raw array of numbers.
 * Nulls/non-finite values are excluded.
 */
function computeAggStats(values) {
    const nums = (Array.isArray(values) ? values : [])
        .map(v => Number(v))
        .filter(v => Number.isFinite(v) && v >= 0);
    if (nums.length === 0) return { n: 0 };
    nums.sort((a, b) => a - b);
    const n = nums.length;
    const pct = (p) => {
        const idx = (p / 100) * (n - 1);
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return lo === hi ? nums[lo] : nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
    };
    const mean = nums.reduce((s, v) => s + v, 0) / n;
    return { n, mean, min: nums[0], max: nums[n - 1], p10: pct(10), p50: pct(50), p95: pct(95) };
}

/**
 * Get all batch runs
 */
async function getBatches({ limit = 20 } = {}) {
    const [batches, total] = await Promise.all([
        BenchmarkBatch.getRecent(limit),
        BenchmarkBatch.countDocuments()
    ]);
    return { batches, total };
}

/**
 * Get batch progress and results
 */
async function getBatch(batchId, {
    includeHeavyPayload = false,
    includeFullText = false,
    resultLimit = 500,
    resultOffset = 0,
    includeAllResults = false
} = {}) {
    const batch = await BenchmarkBatch.findById(batchId);

    if (!batch) {
        throw new Error('Batch not found');
    }

    const includeTextPayload = includeHeavyPayload || includeFullText;
    const resultSelect = includeHeavyPayload
        ? null
        : (
            includeTextPayload
                ? '-judge_raw_response -hardware_snapshot -execution_settings -warmup -judge_warmup'
                : '-judge_raw_response -hardware_snapshot -execution_settings -warmup -judge_warmup -prompt -response'
        );

    const normalizedLimit = includeAllResults
        ? null
        : Math.max(1, Math.min(Number(resultLimit) || 500, 5000));
    const normalizedOffset = includeAllResults
        ? 0
        : Math.max(0, Number(resultOffset) || 0);

    const queryOptions = {
        select: resultSelect
    };
    if (normalizedLimit !== null) queryOptions.limit = normalizedLimit;
    if (normalizedOffset > 0) queryOptions.offset = normalizedOffset;

    const [results, totalResultsCount, actualFailedCount, actualJudgeableCount, actualJudgeCompletedCount, actualJudgeFailedCount, judgedAgg, perModelAgg, perModelMetricsAgg] = await Promise.all([
        BenchmarkResult.getByBatch(batchId, queryOptions).lean(),
        BenchmarkResult.countDocuments({ batch_id: batchId }),
        BenchmarkResult.countDocuments({ batch_id: batchId, success: false }),
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
        }),
        BenchmarkResult.aggregate([
            {
                $match: {
                    batch_id: batchId,
                    quality_score: { $ne: null },
                    scoring_time_ms: { $ne: null }
                }
            },
            {
                $group: {
                    _id: null,
                    avg_judge_time_ms: { $avg: '$scoring_time_ms' }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: { batch_id: batchId } },
            {
                $group: {
                    _id: '$model',
                    exec_done: { $sum: 1 },
                    exec_failed: {
                        $sum: {
                            $cond: [{ $eq: ['$success', false] }, 1, 0]
                        }
                    },
                    judge_done: {
                        $sum: {
                            $cond: [
                                { $ne: [{ $ifNull: ['$quality_score', null] }, null] },
                                1,
                                0
                            ]
                        }
                    },
                    judge_failed: {
                        $sum: {
                            $cond: [
                                {
                                    $or: [
                                        { $eq: ['$success', false] },
                                        {
                                            $in: [
                                                { $toLower: { $ifNull: ['$scoring_method', ''] } },
                                                ['llm_failed']
                                            ]
                                        }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: { batch_id: batchId, success: true } },
            {
                $group: {
                    _id: '$model',
                    latencies: { $push: { $ifNull: ['$latency', null] } },
                    tps_values: { $push: { $ifNull: ['$tokens_per_sec', null] } },
                    judge_ms_values: { $push: { $ifNull: ['$scoring_time_ms', null] } },
                    quality_values: { $push: { $ifNull: ['$quality_score', null] } }
                }
            }
        ])
    ]);

    const perModelCounters = perModelAgg.reduce((acc, row) => {
        const model = row && row._id ? String(row._id) : null;
        if (!model) return acc;

        acc[model] = {
            exec_done: Number(row.exec_done) || 0,
            exec_failed: Number(row.exec_failed) || 0,
            judge_done: Number(row.judge_done) || 0,
            judge_failed: Number(row.judge_failed) || 0
        };
        return acc;
    }, {});

    // Enrich perModelCounters with full-population metric stats (bypasses the 500-result sample limit)
    perModelMetricsAgg.forEach(row => {
        const model = row && row._id ? String(row._id) : null;
        if (!model) return;
        if (!perModelCounters[model]) perModelCounters[model] = { exec_done: 0, exec_failed: 0, judge_done: 0, judge_failed: 0 };
        perModelCounters[model].metrics = {
            latency: computeAggStats(row.latencies),
            tokens_per_sec: computeAggStats((row.tps_values || []).filter(v => v > 0)),
            judge_ms: computeAggStats(row.judge_ms_values),
            quality: computeAggStats(row.quality_values)
        };
    });

    const defaultJudgeModel = (batch && batch.judge_config && batch.judge_config.model)
        ? batch.judge_config.model
        : JUDGE_CONFIG.model;

    // Count tier-upgraded results (only meaningful when auto-upgrade is enabled)
    if (batch.judge_config && batch.judge_config.judge_tier_auto_upgrade) {
        judgeStats.tier_upgrades = results.filter(r =>
            r.judge_model && r.judge_model !== defaultJudgeModel
        ).length;
    }

    const judgeSameHost = !!(
        (batch && batch.judge_same_host) ||
        (batch && batch.judge_config && batch.judge_config.judge_same_host) ||
        (batch && batch.plan && batch.plan.judge_same_host)
    );

    // Calculate judge stats from the full batch result set (not only returned page).
    const avgJudgeTime = judgedAgg.length > 0 && judgedAgg[0].avg_judge_time_ms != null
        ? Number(judgedAgg[0].avg_judge_time_ms)
        : 0;

    const rawJudgeTotal = Number(batch.judge_total) || 0;
    const effectiveJudgeTotal = totalResultsCount > 0
        ? actualJudgeableCount
        : (rawJudgeTotal > 0 ? rawJudgeTotal : 0);

    const judgeCompletedCount = totalResultsCount > 0
        ? actualJudgeCompletedCount
        : (Number(batch.judge_completed) || 0);
    const judgeFailedCount = totalResultsCount > 0
        ? actualJudgeFailedCount
        : (Number(batch.judge_failed) || 0);
    const execFailedCount = Number(actualFailedCount) || 0;
    const judgeLag = Math.max(0, effectiveJudgeTotal - judgeCompletedCount);

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

    // Count judge warmup fallback events from timeline
    const timelineEvents = (batch.timeline || []);
    const warmupFallbackCount = timelineEvents.filter(
        e => e.event === 'judge_warmup_fallback'
    ).length;
    const judgeSameHostFallback = warmupFallbackCount > 0;

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
        concurrency: inferredConcurrency,
        warmup_fallback_count: warmupFallbackCount,
        judge_same_host_fallback: judgeSameHostFallback,
        tier_upgrades: 0  // populated below after defaultJudgeModel is resolved
    };

    const inferJudgeHost = (execHost) => {
        if (!execHost) return null;
        if (judgeSameHost) return execHost;
        if (execHost === HOSTS.primary) return HOSTS.secondary;
        if (execHost === HOSTS.secondary) return HOSTS.primary;
        return HOSTS.primary;
    };

    const formattedResults = results.map((r) => {
        const promptText = typeof r.prompt === 'string' ? r.prompt : '';
        const responseText = typeof r.response === 'string' ? r.response : '';

        const inferredJudgeHost = r.judge_host || inferJudgeHost(r.host);
        const inferredJudgeModel = r.judge_model || defaultJudgeModel;
        const inferredScoringMethod = r.scoring_method || (r.success ? 'pending' : 'exec_failed');

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
            quality_breakdown: r.quality_breakdown,
            success: r.success,
            error: r.error,
            prompt: includeTextPayload ? promptText : undefined,  // Full prompt (opt-in only)
            response: includeTextPayload ? responseText : undefined,  // Full response (opt-in only)
            prompt_preview: promptText
                ? `${promptText.substring(0, 140)}...`
                : (r.prompt_name ? `[${r.prompt_name}]` : ''),
            hardware_snapshot: r.hardware_snapshot,  // Backend, VRAM, quantization info
            response_preview: responseText
                ? `${responseText.substring(0, 100)}...`
                : '',
            timestamp: r.timestamp,
            tokens: r.tokens,
            // Warmup and validation data
            warmup: r.warmup,
            judge_warmup: r.judge_warmup,
            judge_raw_response: r.judge_raw_response,
            execution_settings: r.execution_settings,
            // Flatten truncation fields for easy access
            truncation: r.truncation,
            response_truncated: r.truncation?.response_truncated || false,
            judge_response_truncated: r.truncation?.judge_truncated || false
        };
    });

    const judge_progress = rawJudgeTotal > 0
        ? Math.min(Math.round((judgeCompletedCount / rawJudgeTotal) * 100), 100)
        : 0;

    const judge_progress_effective = effectiveJudgeTotal > 0
        ? Math.min(Math.round((judgeCompletedCount / effectiveJudgeTotal) * 100), 100)
        : 0;

    // NOTE: We intentionally do NOT $set judge counters here.
    // During active pipelined judging, execution.js uses $inc for judge_completed/judge_failed.
    // A $set from this read-path would race with those $inc operations and roll back progress.
    // The authoritative counts (from results queries above) are returned in the response
    // for display accuracy, but the batch document is only reconciled after judging completes
    // (see execution.js post-drain and judging.js judgeBatch final status).

    // Verify stored counters against actual persisted results.
    // Results are the source of truth for execution progress.
    const actualResultsCount = totalResultsCount;
    const batchCompletedCount = Number(batch.completed) || 0;
    const batchFailedCount = Number(batch.failed) || 0;
    const hasCounterMismatch = actualResultsCount !== batchCompletedCount || actualFailedCount !== batchFailedCount;

    // Only reconcile counters when batch is NOT actively running.
    // During execution, $inc operations on completed/failed are in flight — a $set here
    // would race and roll back progress (same pattern as judge counter fix).
    const isActiveExecution = ['running', 'judging'].includes(batch.status);

    if (hasCounterMismatch && !isActiveExecution) {
        const completedDiff = batchCompletedCount - actualResultsCount;
        const failedDiff = batchFailedCount - actualFailedCount;
        const mismatchMagnitude = Math.max(Math.abs(completedDiff), Math.abs(failedDiff));

        const logMethod = mismatchMagnitude >= 5 ? 'warn' : 'info';

        logger[logMethod]('Batch counter mismatch detected; reconciling from results', {
            batchId,
            status: batch.status,
            batchCompleted: batchCompletedCount,
            actualResults: actualResultsCount,
            batchFailed: batchFailedCount,
            actualFailed: actualFailedCount,
            completedDiff,
            failedDiff
        });

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $set: {
                    completed: actualResultsCount,
                    failed: actualFailedCount
                }
            }
        );
    }

    // Use actual results count for progress calculation to ensure accuracy
    const totalTests = Number(batch.total_tests) || 0;
    const accurateProgress = totalTests > 0
        ? Math.min(100, Math.round((actualResultsCount / totalTests) * 100))
        : batch.progress;
    const returnedResultsCount = formattedResults.length;
    const truncated = normalizedLimit !== null
        ? (normalizedOffset + returnedResultsCount) < actualResultsCount
        : false;

    return {
        ...batch.toObject(),
        completed: actualResultsCount,  // Override with actual count
        failed: actualFailedCount,
        judge_total: effectiveJudgeTotal,
        judge_total_effective: effectiveJudgeTotal,
        results: formattedResults,
        progress: accurateProgress,  // Use accurate progress based on actual results
        judge_progress,
        judge_progress_effective,
        judge_stats: judgeStats,
        judge_same_host_fallback: judgeSameHostFallback,
        success_rate: batch.success_rate,
        _countMismatch: hasCounterMismatch,  // Debug flag
        per_model_counters: perModelCounters,
        results_meta: {
            returned: returnedResultsCount,
            total: actualResultsCount,
            offset: normalizedOffset,
            limit: normalizedLimit,
            truncated
        }
    };
}

/**
 * Get batch statistics grouped by tag
 */
async function getBatchStatsByTag() {
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
 * Clear all results (for testing)
 */
async function clearResults() {
    const count = await BenchmarkResult.countDocuments();
    await BenchmarkResult.deleteMany({});

    logger.info('Benchmark results cleared', { count });
    return count;
}

/**
 * Clear failed results only (for cleanup)
 */
async function clearFailedResults() {
    const count = await BenchmarkResult.countDocuments({ success: false });
    await BenchmarkResult.deleteMany({ success: false });

    logger.info('Benchmark failed results cleared', { count });
    return count;
}

/**
 * Get real-time statistics for active batches
 */
async function getActiveStats() {
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

module.exports = {
    getBatches,
    getBatch,
    getBatchStatsByTag,
    clearResults,
    clearFailedResults,
    getActiveStats
};
