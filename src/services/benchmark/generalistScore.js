/**
 * Generalist Quality Score Calculator
 * Single source of truth for quality scoring with coverage penalty and consistency bonus.
 * Used by both Model Dashboard (composite calculation) and Generalist Leaderboard.
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');

// Category weights for "Generalist Champion" scoring
// Must match frontend generalist-leaderboard.js for consistency
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

// Max penalty for missing coverage (scaled by category weight)
const COVERAGE_PENALTY_MAX = 20;

// Consistency bonus threshold and value
const CONSISTENCY_STDDEV_THRESHOLD = 10;
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
 * Calculate standard deviation
 */
function calculateStdDev(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const squaredDiffs = arr.map(x => Math.pow(x - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(variance);
}

/**
 * Calculate generalist score from category data
 * @param {Object} categoryScores - Map of category -> { total, count } or { avg }
 * @returns {Object} Generalist score breakdown
 */
function calculateGeneralistScoreFromCategories(categoryScores) {
    let weightedSum = 0;
    let coveragePenalty = 0;
    let consistencyBonus = 0;

    const categoryAverages = {};
    const scores = [];
    let testedCategories = 0;

    for (const [category, weight] of Object.entries(GENERALIST_CATEGORY_WEIGHTS)) {
        const categoryData = categoryScores[category];

        if (categoryData && (categoryData.count > 0 || categoryData.avg > 0)) {
            testedCategories++;
            // Support both { total, count } and { avg } formats
            const avgScore = categoryData.avg !== undefined
                ? normalizeQualityTo100(categoryData.avg)
                : normalizeQualityTo100(categoryData.total / categoryData.count);

            categoryAverages[category] = avgScore;
            scores.push(avgScore);
            weightedSum += avgScore * weight;
        } else {
            categoryAverages[category] = 0;
            coveragePenalty += weight * COVERAGE_PENALTY_MAX;
        }
    }

    const totalCategories = Object.keys(GENERALIST_CATEGORY_WEIGHTS).length;
    const coveragePercent = (testedCategories / totalCategories) * 100;

    // Consistency bonus for low variance across categories
    let stdDev = 0;
    let consistencyScore = 0;
    if (scores.length > 3) {
        stdDev = calculateStdDev(scores);
        if (stdDev < CONSISTENCY_STDDEV_THRESHOLD) {
            consistencyBonus = CONSISTENCY_BONUS;
        }
        consistencyScore = Math.max(0, 100 - stdDev);
    }

    const generalistScore = Math.max(0, weightedSum - coveragePenalty + consistencyBonus);

    return {
        generalistScore: Math.round(generalistScore * 10) / 10,
        weightedSum: Math.round(weightedSum * 10) / 10,
        coveragePenalty: Math.round(coveragePenalty * 10) / 10,
        consistencyBonus,
        coverage: Math.round(coveragePercent),
        consistencyScore: Math.round(consistencyScore),
        categoryAverages,
        stdDev: Math.round(stdDev * 10) / 10,
        testedCategories
    };
}

/**
 * Get category scores for all models from database
 * @param {Object} matchQuery - MongoDB match query for filtering
 * @returns {Map} Model key -> category scores
 */
async function getCategoryScoresByModel(matchQuery = { success: true }) {
    const categoryStats = await BenchmarkResult.aggregate([
        { $match: matchQuery },
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
                count: { $sum: 1 }
            }
        }
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
                count: stat.count
            };
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
    normalizeQualityTo100,
    calculateStdDev,
    calculateGeneralistScoreFromCategories,
    getCategoryScoresByModel,
    calculateAllGeneralistScores
};
