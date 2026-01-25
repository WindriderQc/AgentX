// results-analysis.js - Model analysis, anomaly detection, quality breakdown

import * as state from './state.js';
import { toFiniteNumber, percentile, summarizeNumbers, countBy, topCounts } from './utils.js';
import { getAnomalyThresholds } from './batch-config.js';

/**
 * Pick representative result ID for a category
 */
export function pickRepresentativeResultId(mode) {
    const results = state.currentBatchResults;
    if (!Array.isArray(results) || results.length === 0) return null;

    let candidate = null;

    switch (mode) {
        case 'failure':
            candidate = results.find(r => r.success === false);
            break;

        case 'worst_latency':
            candidate = results.reduce((worst, r) => {
                const lat = toFiniteNumber(r.latency);
                if (lat === null) return worst;
                const worstLat = worst ? toFiniteNumber(worst.latency) : null;
                return (worstLat === null || lat > worstLat) ? r : worst;
            }, null);
            break;

        case 'worst_throughput':
            candidate = results.reduce((worst, r) => {
                const tps = toFiniteNumber(r.tokens_per_sec);
                if (tps === null || tps <= 0) return worst;
                const worstTps = worst ? toFiniteNumber(worst.tokens_per_sec) : null;
                return (worstTps === null || tps < worstTps) ? r : worst;
            }, null);
            break;

        case 'longest_judge':
            candidate = results.reduce((worst, r) => {
                const ms = toFiniteNumber(r.scoring_time_ms);
                if (ms === null) return worst;
                const worstMs = worst ? toFiniteNumber(worst.scoring_time_ms) : null;
                return (worstMs === null || ms > worstMs) ? r : worst;
            }, null);
            break;

        case 'lowest_quality':
            candidate = results
                .filter(r => r.success !== false && toFiniteNumber(r.quality_score) !== null)
                .reduce((worst, r) => {
                    const q = toFiniteNumber(r.quality_score);
                    const worstQ = worst ? toFiniteNumber(worst.quality_score) : null;
                    return (worstQ === null || q < worstQ) ? r : worst;
                }, null);
            break;

        default:
            return null;
    }

    if (!candidate) return null;

    // Return ID or index
    if (candidate.id) return String(candidate.id);
    if (candidate._id) return String(candidate._id);
    const idx = results.indexOf(candidate);
    return idx >= 0 ? String(idx) : null;
}

/**
 * Pick representative result for a specific model
 */
export function pickRepresentativeResultIdForModel(model, mode) {
    const results = state.currentBatchResults;
    if (!Array.isArray(results) || results.length === 0) return null;

    const modelResults = results.filter(r => r.model === model);
    if (modelResults.length === 0) return null;

    let candidate = null;

    switch (mode) {
        case 'failure':
            candidate = modelResults.find(r => r.success === false);
            break;

        case 'worst_latency':
            candidate = modelResults.reduce((worst, r) => {
                const lat = toFiniteNumber(r.latency);
                if (lat === null) return worst;
                const worstLat = worst ? toFiniteNumber(worst.latency) : null;
                return (worstLat === null || lat > worstLat) ? r : worst;
            }, null);
            break;

        case 'worst_throughput':
            candidate = modelResults.reduce((worst, r) => {
                const tps = toFiniteNumber(r.tokens_per_sec);
                if (tps === null || tps <= 0) return worst;
                const worstTps = worst ? toFiniteNumber(worst.tokens_per_sec) : null;
                return (worstTps === null || tps < worstTps) ? r : worst;
            }, null);
            break;

        case 'longest_judge':
            candidate = modelResults.reduce((worst, r) => {
                const ms = toFiniteNumber(r.scoring_time_ms);
                if (ms === null) return worst;
                const worstMs = worst ? toFiniteNumber(worst.scoring_time_ms) : null;
                return (worstMs === null || ms > worstMs) ? r : worst;
            }, null);
            break;

        case 'lowest_quality':
            candidate = modelResults
                .filter(r => r.success !== false && toFiniteNumber(r.quality_score) !== null)
                .reduce((worst, r) => {
                    const q = toFiniteNumber(r.quality_score);
                    const worstQ = worst ? toFiniteNumber(worst.quality_score) : null;
                    return (worstQ === null || q < worstQ) ? r : worst;
                }, null);
            break;

        default:
            return null;
    }

    if (!candidate) return null;

    if (candidate.id) return String(candidate.id);
    if (candidate._id) return String(candidate._id);
    const idx = results.indexOf(candidate);
    return idx >= 0 ? String(idx) : null;
}

/**
 * Detect batch anomalies
 */
export function detectBatchAnomalies(batch, results) {
    const anomalies = [];
    const thresholds = getAnomalyThresholds();

    const completed = Number(batch.completed) || 0;
    const failed = Number(batch.failed) || 0;
    const judgeCompleted = Number(batch.judge_completed) || 0;
    const judgeFailed = Number(batch.judge_failed) || 0;

    // Execution failure rate
    if (completed > 0) {
        const execFailRate = (failed / completed) * 100;
        if (execFailRate > thresholds.exec_fail_pct) {
            anomalies.push(`High execution failure rate: ${execFailRate.toFixed(1)}% (threshold: ${thresholds.exec_fail_pct}%)`);
        }
    }

    // Judge failure rate
    if (judgeCompleted > 0) {
        const judgeFailRate = (judgeFailed / judgeCompleted) * 100;
        if (judgeFailRate > thresholds.judge_fail_pct) {
            anomalies.push(`High judge failure rate: ${judgeFailRate.toFixed(1)}% (threshold: ${thresholds.judge_fail_pct}%)`);
        }
    }

    // Judge lag
    if (batch.judge_stats && batch.judge_stats.lag > thresholds.lag_factor) {
        anomalies.push(`Judge is lagging: ${batch.judge_stats.lag} items in queue (threshold: ${thresholds.lag_factor})`);
    }

    return anomalies;
}

/**
 * Detect per-model anomalies
 */
export function detectModelAnomalies(results, thresholds) {
    const modelAnomalies = [];
    const minSamples = thresholds.model_min_n || 5;

    // Group results by model
    const byModel = {};
    results.forEach(r => {
        if (!r.model) return;
        if (!byModel[r.model]) byModel[r.model] = [];
        byModel[r.model].push(r);
    });

    // Calculate per-model stats
    for (const [model, modelResults] of Object.entries(byModel)) {
        if (modelResults.length < minSamples) continue;

        const failed = modelResults.filter(r => r.success === false).length;
        const failRate = (failed / modelResults.length) * 100;

        if (failRate > thresholds.model_exec_out_pct) {
            modelAnomalies.push({
                model,
                type: 'high_failure_rate',
                message: `Failure rate ${failRate.toFixed(1)}% exceeds threshold ${thresholds.model_exec_out_pct}%`
            });
        }

        // Check throughput
        const tpsValues = modelResults
            .map(r => toFiniteNumber(r.tokens_per_sec))
            .filter(v => v !== null && v > 0);

        if (tpsValues.length >= minSamples) {
            const sorted = tpsValues.slice().sort((a, b) => a - b);
            const median = percentile(sorted, 0.5);

            // Count how many are below median
            const belowMedian = tpsValues.filter(v => v < median * 0.5).length;
            const belowPct = (belowMedian / tpsValues.length) * 100;

            if (belowPct > thresholds.model_tps_below_median_pct) {
                modelAnomalies.push({
                    model,
                    type: 'slow_throughput',
                    message: `${belowPct.toFixed(1)}% of tests below half median throughput`
                });
            }
        }
    }

    return modelAnomalies;
}

/**
 * Calculate batch distributions
 */
export function calculateBatchDistributions(results) {
    const latencies = results
        .map(r => toFiniteNumber(r.latency))
        .filter(v => v !== null);

    const tps = results
        .map(r => toFiniteNumber(r.tokens_per_sec))
        .filter(v => v !== null && v > 0);

    const qualities = results
        .filter(r => r.success !== false)
        .map(r => toFiniteNumber(r.quality_score))
        .filter(v => v !== null);

    const judgeTimes = results
        .map(r => toFiniteNumber(r.scoring_time_ms))
        .filter(v => v !== null);

    return {
        latency: summarizeNumbers(latencies),
        throughput: summarizeNumbers(tps),
        quality: summarizeNumbers(qualities),
        judge_time: summarizeNumbers(judgeTimes)
    };
}

/**
 * Calculate batch breakdowns
 */
export function calculateBatchBreakdowns(results) {
    const byModel = countBy(results, r => r.model);
    const byLevel = countBy(results, r => r.prompt_level || r.level);
    const byCategory = countBy(results, r => r.prompt_category || r.category);
    const byHost = countBy(results, r => r.host);

    return {
        models: topCounts(byModel, 20),
        levels: topCounts(byLevel, 10),
        categories: topCounts(byCategory, 15),
        hosts: topCounts(byHost, 5)
    };
}

/**
 * Find prompt outliers (slowest/fastest per level)
 */
export function findPromptOutliers(results) {
    const outliers = [];

    // Group by level
    const byLevel = {};
    results.forEach(r => {
        const level = r.prompt_level || r.level || 'unknown';
        if (!byLevel[level]) byLevel[level] = [];
        byLevel[level].push(r);
    });

    for (const [level, levelResults] of Object.entries(byLevel)) {
        if (levelResults.length < 3) continue;

        const withLatency = levelResults
            .filter(r => toFiniteNumber(r.latency) !== null)
            .sort((a, b) => b.latency - a.latency);

        if (withLatency.length >= 3) {
            // Slowest
            const slowest = withLatency[0];
            outliers.push({
                type: 'slowest',
                level,
                result: slowest,
                latency: slowest.latency,
                model: slowest.model
            });

            // Fastest
            const fastest = withLatency[withLatency.length - 1];
            outliers.push({
                type: 'fastest',
                level,
                result: fastest,
                latency: fastest.latency,
                model: fastest.model
            });
        }
    }

    return outliers;
}

/**
 * Calculate model stats for batch
 */
export function calculateModelStats(results) {
    const byModel = {};

    results.forEach(r => {
        if (!r.model) return;

        if (!byModel[r.model]) {
            byModel[r.model] = {
                model: r.model,
                execDone: 0,
                execFailedCount: 0,
                judgeDone: 0,
                judgeFailedCount: 0,
                latencies: [],
                tps: [],
                qualities: [],
                judgeTimes: []
            };
        }

        const m = byModel[r.model];
        m.execDone++;

        if (r.success === false) {
            m.execFailedCount++;
        } else {
            const lat = toFiniteNumber(r.latency);
            if (lat !== null) m.latencies.push(lat);

            const t = toFiniteNumber(r.tokens_per_sec);
            if (t !== null && t > 0) m.tps.push(t);

            const q = toFiniteNumber(r.quality_score);
            if (q !== null) {
                m.judgeDone++;
                m.qualities.push(q);
            }

            const jt = toFiniteNumber(r.scoring_time_ms);
            if (jt !== null) m.judgeTimes.push(jt);
        }
    });

    // Calculate aggregates
    return Object.values(byModel).map(m => ({
        model: m.model,
        execDone: m.execDone,
        execFailedCount: m.execFailedCount,
        execRate: m.execDone > 0 ? (m.execDone - m.execFailedCount) / m.execDone : null,
        judgeDone: m.judgeDone,
        judgeFailedCount: m.judgeFailedCount,
        judgeRate: m.judgeDone > 0 ? (m.judgeDone - m.judgeFailedCount) / m.judgeDone : null,
        tpsN: m.tps.length,
        avgTps: m.tps.length > 0 ? m.tps.reduce((a, b) => a + b, 0) / m.tps.length : null,
        judgeMsN: m.judgeTimes.length,
        avgJudgeMs: m.judgeTimes.length > 0 ? m.judgeTimes.reduce((a, b) => a + b, 0) / m.judgeTimes.length : null,
        avgLatency: m.latencies.length > 0 ? m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length : null,
        avgQuality: m.qualities.length > 0 ? m.qualities.reduce((a, b) => a + b, 0) / m.qualities.length : null
    }));
}
