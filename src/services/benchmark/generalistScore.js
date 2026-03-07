/**
 * Generalist Quality Score Calculator
 * ====================================
 *
 * SINGLE SOURCE OF TRUTH for quality scoring across all benchmark leaderboards.
 *
 * Documentation: docs/operations/GENERALIST_SCORING_SYSTEM.md
 *
 * FORMULA:
 *   generalistScore = weightedQuality - coveragePenalty + consistencyBonus
 *
 * WHERE:
 *   - weightedQuality: Normalized weighted avg of category scores (0-100)
 *   - coveragePenalty: Points deducted for missing category coverage
 *   - consistencyBonus: +5 if avg within-category stddev < threshold
 *
 * USED BY:
 *   - Model Dashboard (results.js) - generalist score feeds composite calculation
 *   - Generalist Leaderboard API (/api/benchmark/generalist-leaderboard)
 *   - Frontend generalist-leaderboard.js (fetches from API, no local calc)
 *
 * DESIGN RATIONALE:
 *   - Coverage penalty prevents gaming by only running easy tests
 *   - Within-category consistency rewards reliable/predictable models
 *   - Infrastructure failures are exempted from coverage penalty
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');

// Explicit input quality scale for generalist normalization.
// Use BENCHMARK_QUALITY_INPUT_SCALE=0-100 only if legacy data is still stored on 0-100.
const QUALITY_INPUT_SCALE = String(process.env.BENCHMARK_QUALITY_INPUT_SCALE || '0-10') === '0-100'
    ? '0-100'
    : '0-10';

/**
 * COVERAGE PENALTY
 *
 * Models lose points for each category they haven't tested.
 * Penalty = categoryWeight × COVERAGE_PENALTY_MAX
 *
 * Example: Skipping 'coding' (15% weight) costs 0.15 × 20 = 3 points
 *
 * This prevents gaming by only running easy tests in one category.
 */
const COVERAGE_PENALTY_MAX = 20;

/**
 * WITHIN-CATEGORY CONSISTENCY BONUS
 *
 * Measures reliability: does the model produce consistent quality for similar tasks?
 *
 * - Low stddev within a category = reliable/predictable
 * - High stddev = inconsistent/unpredictable
 *
 * If average within-category stddev < threshold, model gets +5 bonus.
 * StdDev is on 0-100 scale (quality scores normalized to 0-100).
 */
const CONSISTENCY_STDDEV_THRESHOLD = 15;
const CONSISTENCY_BONUS = 5;

/**
 * Normalize quality score to 0-100 scale
 * Quality scores are stored as 0-10, generalist uses 0-100
 */
function normalizeQualityTo100(rawQuality) {
    const value = Number(rawQuality);
    if (!Number.isFinite(value)) return 0;

    if (QUALITY_INPUT_SCALE === '0-100') {
        return Math.max(0, Math.min(100, value));
    }

    return Math.max(0, Math.min(10, value)) * 10;
}

/**
 * Normalize category key into canonical benchmark category naming.
 * Handles legacy aliases and snake_case variants.
 */
function normalizeCategoryKey(rawCategory) {
    if (!rawCategory) return null;
    const normalized = String(rawCategory).trim().toLowerCase().replace(/_/g, '-');
    if (!normalized) return null;
    if (normalized === 'code') return 'coding';
    return normalized;
}

/**
 * Normalize a weight map so values sum to 1.0 while preserving key order.
 */
function normalizeWeightMap(weights) {
    const entries = Object.entries(weights || {});
    if (entries.length === 0) return {};
    const total = entries.reduce((sum, [, w]) => sum + (Number(w) || 0), 0);
    if (!Number.isFinite(total) || total <= 0) return {};

    const normalized = {};
    for (const [category, weight] of entries) {
        normalized[category] = (Number(weight) || 0) / total;
    }
    return normalized;
}

/**
 * Resolve active category weights from the current benchmark prompt catalog.
 * Falls back to configured defaults when prompts are unavailable.
 */
async function getActiveCategoryWeights() {
    try {
        const promptCategories = await BenchmarkPrompt.distinct('category');
        const available = new Set(
            (Array.isArray(promptCategories) ? promptCategories : [])
                .map(normalizeCategoryKey)
                .filter((cat) => cat && Object.prototype.hasOwnProperty.call(GENERALIST_CATEGORY_WEIGHTS, cat))
        );

        if (available.size === 0) {
            return { ...GENERALIST_CATEGORY_WEIGHTS };
        }

        const active = {};
        for (const [category, weight] of Object.entries(GENERALIST_CATEGORY_WEIGHTS)) {
            if (available.has(category)) {
                active[category] = weight;
            }
        }

        return normalizeWeightMap(active);
    } catch (_) {
        return { ...GENERALIST_CATEGORY_WEIGHTS };
    }
}

/**
 * Calculate generalist score from category data
 * @param {Object} categoryScores - Map of category -> { avg, count, stddev, attempted }
 * @returns {Object} Generalist score breakdown
 */
function calculateGeneralistScoreFromCategories(categoryScores, categoryWeights = GENERALIST_CATEGORY_WEIGHTS) {
    let weightedSum = 0;
    let coveragePenalty = 0;
    let weightsCovered = 0;

    const categoryAverages = {};
    const categoryStdDevs = [];
    let testedCategories = 0;

    for (const [category, weight] of Object.entries(categoryWeights || {})) {
        const categoryData = categoryScores[category];

        const hasScore = !!(categoryData && (categoryData.count > 0 || categoryData.avg > 0));
        const attempted = !!(categoryData && categoryData.attempted);

        if (hasScore) {
            testedCategories++;
            const avgScore = categoryData.avg !== undefined
                ? normalizeQualityTo100(categoryData.avg)
                : 0;

            categoryAverages[category] = avgScore;
            weightedSum += avgScore * weight;
            weightsCovered += weight;

            // Track within-category stddev (normalized to 0-100 scale)
            if (categoryData.stddev !== undefined && categoryData.count >= 2) {
                // stddev is on 0-10 scale from DB, normalize to 0-100
                categoryStdDevs.push(categoryData.stddev * 10);
            }
        } else if (attempted) {
            // Attempted but failed due to infrastructure - do not penalize coverage
            testedCategories++;
            categoryAverages[category] = 0;
        } else {
            categoryAverages[category] = 0;
            coveragePenalty += weight * COVERAGE_PENALTY_MAX;
        }
    }

    const totalCategories = Object.keys(categoryWeights || {}).length;
    const coveragePercent = totalCategories > 0
        ? (testedCategories / totalCategories) * 100
        : 0;

    // Within-category consistency: average stddev across tested categories
    // Lower stddev = more consistent = bonus
    let avgStdDev = 0;
    let consistencyBonus = 0;
    if (categoryStdDevs.length > 0) {
        avgStdDev = categoryStdDevs.reduce((a, b) => a + b, 0) / categoryStdDevs.length;
        if (avgStdDev < CONSISTENCY_STDDEV_THRESHOLD) {
            consistencyBonus = CONSISTENCY_BONUS;
        }
    }

    // Normalize by covered weight so missing categories don't automatically depress quality
    const normalizedQuality = weightsCovered > 0 ? (weightedSum / weightsCovered) : 0;

    // Quality gate: consistency bonus only applies to models with meaningful output.
    // Models scoring < 10/100 weighted quality (e.g., all-zero from empty responses)
    // should not earn a bonus for being "consistently" non-functional.
    const MIN_QUALITY_FOR_BONUS = 10;
    if (normalizedQuality < MIN_QUALITY_FOR_BONUS) {
        consistencyBonus = 0;
    }

    const generalistScore = Math.max(0, normalizedQuality - coveragePenalty + consistencyBonus);

    return {
        generalistScore: Math.round(generalistScore * 10) / 10,
        weightedSum: Math.round(normalizedQuality * 10) / 10,
        coveragePenalty: Math.round(coveragePenalty * 10) / 10,
        consistencyBonus,
        avgWithinCategoryStdDev: Math.round(avgStdDev * 10) / 10,
        coverage: Math.round(coveragePercent),
        categoryAverages,
        testedCategories
    };
}

/**
 * Get category scores for all models from database
 * Includes within-category stddev for consistency measurement
 * @param {Object} matchQuery - MongoDB match query for filtering
 * @returns {Map} Model key -> category scores
 */
async function getCategoryScoresByModel(matchQuery = { success: true }) {
    const baseMatch = { ...(matchQuery || {}) };
    delete baseMatch.success;

    const successMatch = { ...baseMatch, success: true };
    const infraFailureMatch = {
        ...baseMatch,
        success: false,
        $or: [
            { infra_error: true },
            { error_type: 'infra' },
            { error: { $regex: /(ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|fetch failed|timed\s*out|timeout|aborted|HTTP\s+(5\d\d|429|408)\s*:)/i } }
        ]
    };

    const [categoryStats, infraAttempts] = await Promise.all([
        BenchmarkResult.aggregate([
            { $match: successMatch },
            {
                $group: {
                    _id: {
                        model: '$model',
                        host: '$host',
                        category: '$prompt_category'
                    },
                    avg_quality: {
                        $avg: {
                            $cond: [
                                { $ne: ['$quality_score', null] },
                                '$quality_score',
                                null
                            ]
                        }
                    },
                    // Within-category standard deviation for consistency measurement
                    stddev_quality: {
                        $stdDevPop: {
                            $cond: [
                                { $ne: ['$quality_score', null] },
                                '$quality_score',
                                null
                            ]
                        }
                    },
                    count: { $sum: 1 }
                }
            }
        ]),
        BenchmarkResult.aggregate([
            { $match: infraFailureMatch },
            {
                $group: {
                    _id: {
                        model: '$model',
                        host: '$host',
                        category: '$prompt_category'
                    },
                    count: { $sum: 1 }
                }
            }
        ])
    ]);

    // Group by model/host
    const modelCategoryMap = new Map();

    for (const stat of categoryStats) {
        const key = `${stat._id.model}@@${stat._id.host}`;
        const category = normalizeCategoryKey(stat._id.category);
        if (!category || !Object.prototype.hasOwnProperty.call(GENERALIST_CATEGORY_WEIGHTS, category)) continue;

        if (!modelCategoryMap.has(key)) {
            modelCategoryMap.set(key, {});
        }

        if (category && stat.avg_quality !== null) {
            modelCategoryMap.get(key)[category] = {
                avg: stat.avg_quality,
                stddev: stat.stddev_quality || 0,
                count: stat.count,
                attempted: true
            };
        }
    }

    // Mark infra-attempted categories as attempted to avoid coverage penalty
    for (const att of infraAttempts) {
        const key = `${att._id.model}@@${att._id.host}`;
        const category = normalizeCategoryKey(att._id.category);
        if (!category || !Object.prototype.hasOwnProperty.call(GENERALIST_CATEGORY_WEIGHTS, category)) continue;
        if (!modelCategoryMap.has(key)) {
            modelCategoryMap.set(key, {});
        }
        if (!modelCategoryMap.get(key)[category]) {
            modelCategoryMap.get(key)[category] = { attempted: true, count: 0 };
        } else {
            modelCategoryMap.get(key)[category].attempted = true;
        }
    }

    return modelCategoryMap;
}

/**
 * Get empty response rates per model+host.
 * Returns Map of "model@@host" -> { emptyCount, totalCount, emptyRate }
 */
async function getEmptyResponseRates(matchQuery = {}) {
    const baseMatch = { ...(matchQuery || {}) };
    delete baseMatch.success;

    const stats = await BenchmarkResult.aggregate([
        { $match: { ...baseMatch, success: true } },
        {
            $group: {
                _id: { model: '$model', host: '$host' },
                total: { $sum: 1 },
                empty: {
                    $sum: {
                        $cond: [{ $eq: ['$scoring_method', 'empty_response'] }, 1, 0]
                    }
                }
            }
        }
    ]);

    const rates = new Map();
    for (const s of stats) {
        const key = `${s._id.model}@@${s._id.host}`;
        rates.set(key, {
            emptyCount: s.empty,
            totalCount: s.total,
            emptyRate: s.total > 0 ? s.empty / s.total : 0
        });
    }
    return rates;
}

/** Threshold: models with more than 50% empty responses are filtered from leaderboard */
const EMPTY_RESPONSE_FILTER_THRESHOLD = 0.5;

/**
 * Calculate generalist scores for all models
 * @param {Object} matchQuery - MongoDB match query for filtering
 * @returns {Map} Model key -> generalist score data (includes `filtered` flag for dead models)
 */
async function calculateAllGeneralistScores(matchQuery = { success: true }, { categoryWeights = GENERALIST_CATEGORY_WEIGHTS } = {}) {
    const [categoryMap, emptyRates] = await Promise.all([
        getCategoryScoresByModel(matchQuery),
        getEmptyResponseRates(matchQuery)
    ]);

    const generalistScores = new Map();

    for (const [key, categoryScores] of categoryMap) {
        const emptyInfo = emptyRates.get(key);
        const emptyRate = emptyInfo ? emptyInfo.emptyRate : 0;

        if (emptyRate > EMPTY_RESPONSE_FILTER_THRESHOLD) {
            generalistScores.set(key, {
                generalistScore: 0,
                weightedSum: 0,
                coveragePenalty: 0,
                consistencyBonus: 0,
                avgWithinCategoryStdDev: 0,
                coverage: 0,
                categoryAverages: {},
                testedCategories: 0,
                filtered: true,
                filterReason: 'excessive_empty_responses',
                emptyRate: Math.round(emptyRate * 100)
            });
            continue;
        }

        const scoreData = calculateGeneralistScoreFromCategories(categoryScores, categoryWeights);
        scoreData.filtered = false;
        scoreData.emptyRate = Math.round(emptyRate * 100);
        generalistScores.set(key, scoreData);
    }

    return generalistScores;
}

/**
 * Calculate 95% confidence interval half-width for a score.
 * Uses t-distribution approximation for small samples.
 * @param {number} stddev - Standard deviation (0-100 scale)
 * @param {number} n - Sample size
 * @returns {number} Margin of error (half-width of 95% CI)
 */
function confidenceMargin(stddev, n) {
    if (!n || n < 2 || !Number.isFinite(stddev)) return null;
    // t-value approximation for 95% CI with small samples
    const tValues = { 2: 12.71, 3: 4.30, 4: 3.18, 5: 2.78, 6: 2.57, 7: 2.45, 8: 2.36, 9: 2.31, 10: 2.26 };
    const t = n <= 10 ? (tValues[n] || 2.26) : (n <= 30 ? 2.04 : 1.96);
    return Math.round((t * stddev / Math.sqrt(n)) * 10) / 10;
}

module.exports = {
    GENERALIST_CATEGORY_WEIGHTS,
    COVERAGE_PENALTY_MAX,
    CONSISTENCY_BONUS,
    CONSISTENCY_STDDEV_THRESHOLD,
    EMPTY_RESPONSE_FILTER_THRESHOLD,
    normalizeQualityTo100,
    normalizeCategoryKey,
    getActiveCategoryWeights,
    calculateGeneralistScoreFromCategories,
    getCategoryScoresByModel,
    getEmptyResponseRates,
    calculateAllGeneralistScores,
    confidenceMargin
};
