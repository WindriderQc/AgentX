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
 * Get all batch runs
 */
async function getBatches({ limit = 20 } = {}) {
    const batches = await BenchmarkBatch.getRecent(limit);
    return { batches, total: batches.length };
}

/**
 * Get batch progress and results
 */
async function getBatch(batchId) {
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
            timestamp: r.timestamp,
            // Flatten truncation fields for easy access
            response_truncated: r.truncation?.response_truncated || false,
            input_to_judge_truncated: r.truncation?.input_to_judge_truncated || false,
            judge_response_truncated: r.truncation?.judge_truncated || false
        };
    });

    const judge_progress = rawJudgeTotal > 0
        ? Math.min(Math.round(((batch.judge_completed || 0) / rawJudgeTotal) * 100), 100)
        : 0;

    const judge_progress_effective = effectiveJudgeTotal > 0
        ? Math.min(Math.round(((batch.judge_completed || 0) / effectiveJudgeTotal) * 100), 100)
        : 0;

    // Verify actual results count matches batch.completed counter
    // Fix for Bug #4: UI out of sync due to counter/results mismatch
    const actualResultsCount = results.length;
    const batchCompletedCount = Number(batch.completed) || 0;

    if (actualResultsCount !== batchCompletedCount) {
        logger.warn('Batch counter mismatch detected', {
            batchId,
            batchCompleted: batchCompletedCount,
            actualResults: actualResultsCount,
            diff: batchCompletedCount - actualResultsCount
        });
    }

    // Use actual results count for progress calculation to ensure accuracy
    const totalTests = Number(batch.total_tests) || 0;
    const accurateProgress = totalTests > 0
        ? Math.min(100, Math.round((actualResultsCount / totalTests) * 100))
        : batch.progress;

    return {
        ...batch.toObject(),
        completed: actualResultsCount,  // Override with actual count
        judge_total: rawJudgeTotal,
        judge_total_effective: effectiveJudgeTotal,
        results: formattedResults,
        progress: accurateProgress,  // Use accurate progress based on actual results
        judge_progress,
        judge_progress_effective,
        judge_stats: judgeStats,
        success_rate: batch.success_rate,
        _countMismatch: actualResultsCount !== batchCompletedCount  // Debug flag
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
