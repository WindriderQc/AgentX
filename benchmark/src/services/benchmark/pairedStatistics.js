'use strict';

/**
 * Paired statistics for comparing two artifacts prompt by prompt.
 *
 * Every function is pure. Intervals are reported two ways: a paired t
 * interval, and a percentile bootstrap over prompts with a seeded generator so
 * the same inputs always return the same interval. The bootstrap is the
 * significance test because prompt-level deltas are bounded and rarely normal.
 */

const { tCritical95 } = require('./generalistScoreNormalizers');

const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;
const MIN_BOOTSTRAP_ITERATIONS = 200;
const MAX_BOOTSTRAP_ITERATIONS = 20000;
const DEFAULT_BOOTSTRAP_SEED = 1;
const MIN_PAIRS = 3;
const LOW_PAIR_COUNT = 10;
// One-sided normal quantile for 80 % power.
const Z_POWER_80 = 0.8416;

const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStdDev(values) {
    if (values.length < 2) return null;
    const average = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1));
}

// mulberry32: small, fast and reproducible; quality is ample for resampling.
function seededRandom(seed) {
    let state = (Number(seed) >>> 0) || 1;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function percentile(sorted, fraction) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function normalizeBootstrapOptions({ iterations, seed } = {}) {
    const parsed = Number.isFinite(Number(iterations)) ? Math.floor(Number(iterations)) : DEFAULT_BOOTSTRAP_ITERATIONS;
    return {
        iterations: Math.min(MAX_BOOTSTRAP_ITERATIONS, Math.max(MIN_BOOTSTRAP_ITERATIONS, parsed)),
        seed: Number.isSafeInteger(Number(seed)) ? Number(seed) : DEFAULT_BOOTSTRAP_SEED
    };
}

/** 95 % percentile bootstrap interval of the mean of `values`. */
function bootstrapMeanInterval(values, options = {}) {
    if (values.length < 2) return null;
    const { iterations, seed } = normalizeBootstrapOptions(options);
    const random = seededRandom(seed);
    const means = new Array(iterations);
    for (let draw = 0; draw < iterations; draw++) {
        let sum = 0;
        for (let pick = 0; pick < values.length; pick++) sum += values[Math.floor(random() * values.length)];
        means[draw] = sum / values.length;
    }
    means.sort((a, b) => a - b);
    return [percentile(means, 0.025), percentile(means, 0.975)];
}

/**
 * Summarize paired deltas (B − A, in points). `significant` is true when the
 * bootstrap interval excludes zero. `minimumDetectableDelta` is the smallest
 * mean difference these prompts would detect at 5 % two-sided and 80 % power,
 * given the observed spread: an approximation, not a guarantee.
 */
function summarizePairedDeltas(deltas, options = {}) {
    const n = deltas.length;
    const meanDelta = mean(deltas);
    if (n < MIN_PAIRS) {
        return { method: 'insufficient_pairs', n, meanDelta: round1(meanDelta), stdDev: null,
            tInterval: null, bootstrapInterval: null, significant: false, minimumDetectableDelta: null, lowPairCount: true };
    }
    const stdDev = sampleStdDev(deltas);
    const standardError = stdDev / Math.sqrt(n);
    const t = tCritical95(n - 1);
    const bootstrap = bootstrapMeanInterval(deltas, options);
    const significant = Boolean(bootstrap) && (bootstrap[0] > 0 || bootstrap[1] < 0);
    return {
        method: 'paired_bootstrap',
        n,
        meanDelta: round1(meanDelta),
        stdDev: round1(stdDev),
        tInterval: [round1(meanDelta - (t * standardError)), round1(meanDelta + (t * standardError))],
        bootstrapInterval: bootstrap && [round1(bootstrap[0]), round1(bootstrap[1])],
        significant,
        minimumDetectableDelta: round1((t + Z_POWER_80) * standardError),
        lowPairCount: n < LOW_PAIR_COUNT
    };
}

module.exports = {
    DEFAULT_BOOTSTRAP_ITERATIONS,
    MIN_BOOTSTRAP_ITERATIONS,
    MAX_BOOTSTRAP_ITERATIONS,
    MIN_PAIRS,
    mean,
    sampleStdDev,
    seededRandom,
    bootstrapMeanInterval,
    normalizeBootstrapOptions,
    summarizePairedDeltas
};
