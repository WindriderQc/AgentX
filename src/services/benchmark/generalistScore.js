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

/**
 * Category weights for "Generalist Champion" scoring.
 * Weights must sum to 1.0 (100%).
 *
 * Rationale:
 *   - Core capabilities (60%): Essential for general-purpose use
 *   - Specialized (30%): Important but less universally needed
 *   - Quality assurance (10%): Robustness and edge case handling
 */
const GENERALIST_CATEGORY_WEIGHTS = {
    // Core capabilities (60% total weight)
    'coding': 0.15,
    'reasoning': 0.15,
    'factual': 0.10,
    'creative': 0.10,
    'instruction-following': 0.10,

    // Specialized capabilities (30% total weight)
    'math': 0.08,
    'summarization': 0.07,
    'multi-turn-reasoning': 0.07,
    'context-retention': 0.05,
    'translation': 0.03,

    // Quality assurance (10% total weight)
    'edge-cases': 0.05,
    'general': 0.05
};

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
    return value <= 10 ? value * 10 : value;
}

/**
 * Calculate generalist score from category data
 * @param {Object} categoryScores - Map of category -> { avg, count, stddev, attempted }
 * @returns {Object} Generalist score breakdown
 */
function calculateGeneralistScoreFromCategories(categoryScores) {
    let weightedSum = 0;
    let coveragePenalty = 0;
    let weightsCovered = 0;

    const categoryAverages = {};
    const categoryStdDevs = [];
    let testedCategories = 0;

    for (const [category, weight] of Object.entries(GENERALIST_CATEGORY_WEIGHTS)) {
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

    const totalCategories = Object.keys(GENERALIST_CATEGORY_WEIGHTS).length;
    const coveragePercent = (testedCategories / totalCategories) * 100;

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
        const category = stat._id.category;

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
        const category = att._id.category;
        if (!category) continue;
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
 * Calculate generalist scores for all models
 * @param {Object} matchQuery - MongoDB match query for filtering
 * @returns {Map} Model key -> generalist score data
 */
async function calculateAllGeneralistScores(matchQuery = { success: true }) {
    const categoryMap = await getCategoryScoresByModel(matchQuery);
    const generalistScores = new Map();

    for (const [key, categoryScores] of categoryMap) {
        const scoreData = calculateGeneralistScoreFromCategories(categoryScores);
        generalistScores.set(key, scoreData);
    }

    return generalistScores;
}

module.exports = {
    GENERALIST_CATEGORY_WEIGHTS,
    COVERAGE_PENALTY_MAX,
    CONSISTENCY_BONUS,
    CONSISTENCY_STDDEV_THRESHOLD,
    normalizeQualityTo100,
    calculateGeneralistScoreFromCategories,
    getCategoryScoresByModel,
    calculateAllGeneralistScores
};
