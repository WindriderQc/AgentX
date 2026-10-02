'use strict';
/**
 * Leaderboard performance and attempt summary.
 *
 * The browser used to fetch "the last 200 successful results" per model and
 * host, with none of the leaderboard's own filters, and derive speed, latency
 * and a success rate from that sample. The speed mixed hosts, contexts and
 * campaigns; the success rate divided successes by successes.
 *
 * This module computes both on the server, per model, host and quality cohort:
 * - `performance` over exactly the rows that carry the entry's score;
 * - `attempts` over every row of the same scope, whatever its outcome, so the
 *   success rate has a real denominator and its exclusions are visible.
 *
 * Throughput has two definitions and they are never mixed:
 * - `tokensPerSecTotal`: stored `tokens_per_sec`, output tokens over the whole
 *   request time, including prompt evaluation;
 * - `tokensPerSecGeneration`: output tokens over the time after prompt
 *   evaluation, derived only when `prompt_eval_duration_ms` was recorded.
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');

// Match keys that select rows by outcome or by score. Removing them from a
// leaderboard match yields the scope of every attempt in the same cohort.
const OUTCOME_KEYS = Object.freeze([
    'success', 'infra_error', 'needs_review', 'excluded_from_leaderboard',
    'quality_score', 'composite_score', 'deterministic_score', 'subjective_score'
]);

function attemptScope(scoreMatch) {
    const scope = {};
    for (const [key, value] of Object.entries(scoreMatch || {})) {
        if (!OUTCOME_KEYS.includes(key)) scope[key] = value;
    }
    return scope;
}

function entryKey(model, host, cohort) {
    return `${model}@@${host || ''}@@${cohort || ''}`;
}

function round(value, digits) {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function majorMinor(version) {
    const match = /^(\d+)\.(\d+)/.exec(String(version || ''));
    return match ? `${match[1]}.${match[2]}` : null;
}

function countBy(values) {
    const counts = {};
    for (const value of values) {
        const key = value === null || value === undefined || value === '' ? 'unversioned' : String(value);
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

/**
 * Performance over the rows that carry the score.
 * @param {object} scoreMatch
 * @param {string|null} scoreField - the axis field; its plain mean per cohort is
 *   reported so history cohorts, which get no generalist score, still show a number
 * @returns {Map<string, object>} keyed by entryKey(model, host, cohort)
 */
async function performanceByEntry(scoreMatch, scoreField = null) {
    const rows = await BenchmarkResult.aggregate([
        { $match: scoreMatch },
        { $sort: { timestamp: -1 } },
        // $push skips a document whose field is missing (rows written before a
        // field existed), which would drop those rows from the counts and shift
        // the per-row arrays paired by index below. $ifNull keeps one slot per row.
        {
            $group: {
                _id: { model: '$model', host: '$host', cohort: '$quality_cohort_fingerprint' },
                rows: { $sum: 1 },
                scoreMean: scoreField ? { $avg: `$${scoreField}` } : { $first: null },
                tokensPerSec: { $push: { $ifNull: ['$tokens_per_sec', null] } },
                tokens: { $push: { $ifNull: ['$tokens', null] } },
                latency: { $push: { $ifNull: ['$latency', null] } },
                promptEval: { $push: { $ifNull: ['$prompt_eval_duration_ms', null] } },
                ttft: { $push: { ms: { $ifNull: ['$time_to_first_token_ms', null] }, measurement: { $ifNull: ['$ttft_measurement', null] } } },
                baselines: { $push: { ms: { $ifNull: ['$performance_baseline.timeToFirstTokenMs', null] }, measurement: { $ifNull: ['$performance_baseline.ttftMeasurement', null] } } },
                judges: { $push: { $ifNull: ['$judge_model', null] } },
                scorerVersions: { $push: { $ifNull: ['$scorer_version', null] } },
                contexts: { $push: { $ifNull: ['$execution_settings.num_ctx', null] } },
                thinkingRows: { $sum: { $cond: [{ $eq: ['$execution_settings.think', true] }, 1, 0] } },
                thinkingMode: { $max: { $cond: [{ $eq: ['$execution_settings.think_mode', 'best_qualified'] }, 1, 0] } },
                thinkMinLevel: { $max: { $ifNull: ['$execution_settings.think_min_level', null] } },
                earliest: { $min: '$timestamp' },
                latest: { $max: '$timestamp' }
            }
        }
    ]);

    const byEntry = new Map();
    for (const row of rows) {
        const latencies = (row.latency || []).map(Number).filter(value => value > 0);
        const totalTps = (row.tokensPerSec || []).map(Number).filter(value => value > 0);
        const generationTps = [];
        for (let i = 0; i < (row.tokens || []).length; i++) {
            const promptEvalRaw = row.promptEval?.[i];
            // Rows that did not record prompt evaluation time cannot yield a
            // generation rate; Number(null) would silently read as 0 ms.
            if (promptEvalRaw === null || promptEvalRaw === undefined) continue;
            const tokens = Number(row.tokens[i]);
            const latency = Number(row.latency?.[i]);
            const promptEval = Number(promptEvalRaw);
            const generationMs = latency - promptEval;
            if (tokens > 0 && Number.isFinite(promptEval) && promptEval >= 0 && generationMs > 0) {
                generationTps.push(tokens / (generationMs / 1000));
            }
        }
        const measuredTtft = (row.ttft || [])
            .filter(entry => entry && entry.measurement === 'streamed_wall_clock' && Number(entry.ms) > 0)
            .map(entry => Number(entry.ms));
        // Rows arrive newest first: the baseline is the newest one recorded.
        const hostBaseline = (row.baselines || [])
            .find(entry => entry && entry.measurement === 'streamed_wall_clock' && Number(entry.ms) > 0) || null;
        const judgeCounts = countBy((row.judges || []).filter(Boolean));
        const topJudge = Object.entries(judgeCounts).sort((a, b) => b[1] - a[1])[0] || null;
        const scorerVersions = countBy(row.scorerVersions || []);
        const majorMinors = new Set(Object.keys(scorerVersions).map(majorMinor).filter(Boolean));

        byEntry.set(entryKey(row._id.model, row._id.host, row._id.cohort), {
            rows: row.rows,
            // Plain mean of the axis field, on that field's own scale. It is not
            // the generalist score: no weights, no coverage or difficulty penalty.
            score: scoreField ? {
                field: scoreField,
                scale: scoreField === 'composite_score' ? 100 : 10,
                mean: round(row.scoreMean, 2),
                sampleSize: row.rows
            } : null,
            tokensPerSecTotal: {
                definition: 'output tokens over the whole request time, including prompt evaluation',
                mean: round(mean(totalTps), 1),
                median: round(median(totalTps), 1),
                sampleSize: totalTps.length
            },
            tokensPerSecGeneration: {
                definition: 'output tokens over the time after prompt evaluation',
                mean: round(mean(generationTps), 1),
                median: round(median(generationTps), 1),
                sampleSize: generationTps.length
            },
            latencyMs: {
                mean: round(mean(latencies), 0),
                p95: round(percentile(latencies, 0.95), 0),
                sampleSize: latencies.length
            },
            ttftMs: {
                measured: { mean: round(mean(measuredTtft), 1), sampleSize: measuredTtft.length },
                hostBaseline: hostBaseline ? Number(hostBaseline.ms) : null
            },
            judgeModel: topJudge ? topJudge[0] : null,
            judgeModels: judgeCounts,
            contexts: countBy((row.contexts || []).filter(value => value !== null && value !== undefined)),
            scorerVersions,
            mixedScorerVersions: majorMinors.size > 1,
            // Thinking mode (best_qualified): the rows answered with thinking.
            thinking: {
                mode: row.thinkingMode === 1 ? 'best_qualified' : null,
                minLevel: row.thinkMinLevel ?? null,
                rows: row.thinkingRows || 0
            },
            earliestTimestamp: row.earliest || null,
            latestTimestamp: row.latest || null
        });
    }
    return byEntry;
}

/**
 * Every attempt in the same scope, by outcome.
 * @returns {Map<string, object>} keyed by entryKey(model, host, cohort)
 */
async function attemptsByEntry(scopeMatch) {
    const rows = await BenchmarkResult.aggregate([
        { $match: scopeMatch },
        {
            $group: {
                _id: { model: '$model', host: '$host', cohort: '$quality_cohort_fingerprint' },
                attempts: { $sum: 1 },
                successes: { $sum: { $cond: [{ $eq: ['$success', true] }, 1, 0] } },
                infraErrors: { $sum: { $cond: [{ $eq: ['$infra_error', true] }, 1, 0] } },
                executionFailures: {
                    $sum: { $cond: [{ $and: [{ $ne: ['$success', true] }, { $ne: ['$infra_error', true] }] }, 1, 0] }
                },
                needsReview: { $sum: { $cond: [{ $eq: ['$needs_review', true] }, 1, 0] } },
                excluded: { $sum: { $cond: [{ $eq: ['$excluded_from_leaderboard', true] }, 1, 0] } },
                unscored: {
                    $sum: { $cond: [{ $and: [{ $eq: ['$success', true] }, { $eq: ['$quality_score', null] }] }, 1, 0] }
                }
            }
        }
    ]);

    const byEntry = new Map();
    for (const row of rows) {
        // Infrastructure errors say nothing about the model, so they leave the
        // denominator; every other attempt counts, scored or not.
        const denominator = row.attempts - row.infraErrors;
        byEntry.set(entryKey(row._id.model, row._id.host, row._id.cohort), {
            attempts: row.attempts,
            successes: row.successes,
            executionFailures: row.executionFailures,
            infraErrors: row.infraErrors,
            needsReview: row.needsReview,
            excluded: row.excluded,
            unscored: row.unscored,
            successRate: denominator > 0 ? Math.round((row.successes / denominator) * 100) : null,
            successRateDenominator: denominator,
            excludedFromDenominator: { infraErrors: row.infraErrors }
        });
    }
    return byEntry;
}

/**
 * Scorer versions behind each entry's score, keyed by model@@host, over the
 * final score match (one cohort or, on the local-only board, every cohort).
 * A score averaged over two scorer generations compares nothing.
 * @returns {Map<string, { counts: object, mixed: boolean }>}
 */
async function scorerVersionsByEntry(scoreMatch) {
    const rows = await BenchmarkResult.aggregate([
        { $match: scoreMatch },
        { $group: { _id: { model: '$model', host: '$host' }, scorerVersions: { $push: { $ifNull: ['$scorer_version', null] } } } }
    ]);
    const byEntry = new Map();
    for (const row of rows) {
        const counts = countBy(row.scorerVersions || []);
        const majorMinors = new Set(Object.keys(counts).map(majorMinor).filter(Boolean));
        byEntry.set(`${row._id.model}@@${row._id.host || ''}`, { counts, mixed: majorMinors.size > 1 });
    }
    return byEntry;
}

/**
 * Summaries for every model/host/cohort in the leaderboard's scope.
 * @param {object} scoreMatch - the leaderboard's score match (rows that carry a score)
 * @param {{ scoreField?: string }} [options] - axis field whose plain mean is reported per cohort
 * @returns {{ lookup: Function }} lookup(model, host, cohort) → { performance, attempts }
 */
async function getLeaderboardPerformanceSummary(scoreMatch, { scoreField = null } = {}) {
    const scope = attemptScope(scoreMatch);
    const [performance, attempts] = await Promise.all([
        performanceByEntry(scoreMatch, scoreField),
        attemptsByEntry(scope)
    ]);
    return {
        scope,
        lookup(model, host, cohort) {
            const key = entryKey(model, host, cohort);
            return {
                performance: performance.get(key) || null,
                attempts: attempts.get(key) || null
            };
        }
    };
}

module.exports = {
    attemptScope,
    entryKey,
    getLeaderboardPerformanceSummary,
    majorMinor,
    scorerVersionsByEntry
};
