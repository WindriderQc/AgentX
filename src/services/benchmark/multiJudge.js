/**
 * Multi-Judge Consensus Scoring
 *
 * Scores a benchmark result with multiple judge models and computes
 * a consensus score. Detects divergence between judges and optionally
 * escalates to a higher-tier judge as a tiebreaker.
 *
 * Design:
 *   - 2 judges by default for categories requiring 'standard' tier
 *   - If scores diverge by > DIVERGENCE_THRESHOLD, a 3rd (higher-tier) judge breaks the tie
 *   - Final score = median of all judge scores
 *   - All individual scores stored in BenchmarkResult.judge_scores[]
 *
 * USED BY:
 *   - judging.js (when multi-judge mode is enabled)
 */

const logger = require('../../../config/logger');
const { scoreResponse, JUDGE_CONFIG } = require('../qualityScorer');
const { CATEGORY_MIN_JUDGE_TIER } = require('../../../config/categories');
const { TIER_RANK, tierMeetsRequirement } = require('../scoring/judgeTierResolver');

/** Max score difference (0-10 scale) before escalation to tiebreaker */
const DIVERGENCE_THRESHOLD = 2.0;

/**
 * Compute median of a numeric array.
 */
function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Score a result with multiple judges and return consensus.
 *
 * @param {Object} params
 * @param {string} params.response - Model response to judge
 * @param {Object} params.prompt - Prompt data (prompt, name, level, category, expected_answer, etc.)
 * @param {Array<Object>} params.judges - Array of judge configs [{ model, host, tier }]
 * @param {Object} [params.tiebreakerJudge] - Optional higher-tier judge for divergence resolution
 * @param {Object} [params._batchHardwareSnapshot] - Hardware snapshot for judge host
 * @returns {Object} { finalScore, scores[], divergent, tiebreakerUsed, consensus }
 */
async function multiJudgeScore({ response, prompt, judges, tiebreakerJudge = null, _batchHardwareSnapshot = null }) {
    if (!judges || judges.length === 0) {
        throw new Error('At least one judge config is required');
    }

    const results = [];

    // Score with all primary judges in parallel
    const judgePromises = judges.map(async (judgeConfig, idx) => {
        const start = Date.now();
        try {
            const scores = await scoreResponse({
                response,
                prompt,
                judgeConfig: {
                    model: judgeConfig.model,
                    host: judgeConfig.host
                },
                _batchHardwareSnapshot
            });

            return {
                judge_model: judgeConfig.model,
                judge_host: judgeConfig.host,
                judge_tier: judgeConfig.tier || 'unknown',
                quality_score: scores.quality_score,
                explanation: scores.explanation,
                scoring_time_ms: Date.now() - start,
                scoring_method: scores.scoring_method,
                success: true
            };
        } catch (err) {
            logger.warn('Multi-judge: judge failed', {
                judge_model: judgeConfig.model,
                judge_index: idx,
                error: err.message
            });
            return {
                judge_model: judgeConfig.model,
                judge_host: judgeConfig.host,
                judge_tier: judgeConfig.tier || 'unknown',
                quality_score: null,
                explanation: `Judge failed: ${err.message}`,
                scoring_time_ms: Date.now() - start,
                success: false
            };
        }
    });

    const judgeResults = await Promise.all(judgePromises);
    results.push(...judgeResults);

    // Extract successful scores
    const validScores = results
        .filter(r => r.success && r.quality_score !== null && r.quality_score !== undefined)
        .map(r => r.quality_score);

    if (validScores.length === 0) {
        return {
            finalScore: null,
            scores: results,
            divergent: false,
            tiebreakerUsed: false,
            consensus: 'no_valid_scores'
        };
    }

    if (validScores.length === 1) {
        return {
            finalScore: validScores[0],
            scores: results,
            divergent: false,
            tiebreakerUsed: false,
            consensus: 'single_judge'
        };
    }

    // Check divergence
    const maxScore = Math.max(...validScores);
    const minScore = Math.min(...validScores);
    const divergence = maxScore - minScore;
    const divergent = divergence > DIVERGENCE_THRESHOLD;

    // Escalate to tiebreaker if divergent and tiebreaker is available
    let tiebreakerUsed = false;
    if (divergent && tiebreakerJudge) {
        const start = Date.now();
        try {
            logger.info('Multi-judge: divergence detected, escalating to tiebreaker', {
                scores: validScores,
                divergence: divergence.toFixed(1),
                tiebreaker: tiebreakerJudge.model
            });

            const tbScores = await scoreResponse({
                response,
                prompt,
                judgeConfig: {
                    model: tiebreakerJudge.model,
                    host: tiebreakerJudge.host
                },
                _batchHardwareSnapshot
            });

            results.push({
                judge_model: tiebreakerJudge.model,
                judge_host: tiebreakerJudge.host,
                judge_tier: tiebreakerJudge.tier || 'advanced',
                quality_score: tbScores.quality_score,
                explanation: tbScores.explanation,
                scoring_time_ms: Date.now() - start,
                scoring_method: tbScores.scoring_method,
                success: true,
                is_tiebreaker: true
            });

            validScores.push(tbScores.quality_score);
            tiebreakerUsed = true;
        } catch (err) {
            logger.warn('Multi-judge: tiebreaker failed', {
                tiebreaker: tiebreakerJudge.model,
                error: err.message
            });
            results.push({
                judge_model: tiebreakerJudge.model,
                judge_host: tiebreakerJudge.host,
                judge_tier: tiebreakerJudge.tier || 'advanced',
                quality_score: null,
                explanation: `Tiebreaker failed: ${err.message}`,
                scoring_time_ms: Date.now() - start,
                success: false,
                is_tiebreaker: true
            });
        }
    }

    const finalScore = Math.round(median(validScores) * 10) / 10;

    const consensus = divergent
        ? (tiebreakerUsed ? 'tiebreaker_resolved' : 'divergent_unresolved')
        : 'agreement';

    logger.info('Multi-judge consensus', {
        category: prompt.category,
        finalScore,
        individualScores: validScores,
        divergence: divergence.toFixed(1),
        consensus,
        judgeCount: validScores.length
    });

    return {
        finalScore,
        scores: results,
        divergent,
        tiebreakerUsed,
        consensus,
        divergence: Math.round(divergence * 10) / 10
    };
}

/**
 * Determine if a category should use multi-judge scoring.
 * Categories mapped to 'standard' or higher in CATEGORY_MIN_JUDGE_TIER
 * benefit from cross-validation.
 *
 * @param {string} category - Benchmark category
 * @returns {boolean}
 */
function shouldUseMultiJudge(category) {
    const minTier = CATEGORY_MIN_JUDGE_TIER[category] || 'basic';
    return tierMeetsRequirement(minTier, 'standard');
}

/**
 * Calculate inter-judge agreement statistics from an array of multi-judge results.
 *
 * @param {Array<Object>} multiJudgeResults - Array of { scores, divergent, consensus }
 * @returns {Object} { agreementRate, avgDivergence, escalationRate, totalJudged }
 */
function calculateJudgeAgreement(multiJudgeResults) {
    if (!multiJudgeResults || multiJudgeResults.length === 0) {
        return { agreementRate: 0, avgDivergence: 0, escalationRate: 0, totalJudged: 0 };
    }

    let agreements = 0;
    let totalDivergence = 0;
    let escalations = 0;

    for (const r of multiJudgeResults) {
        if (!r.divergent) agreements++;
        totalDivergence += (r.divergence || 0);
        if (r.tiebreakerUsed) escalations++;
    }

    const total = multiJudgeResults.length;
    return {
        agreementRate: Math.round((agreements / total) * 100),
        avgDivergence: Math.round((totalDivergence / total) * 10) / 10,
        escalationRate: Math.round((escalations / total) * 100),
        totalJudged: total
    };
}

module.exports = {
    DIVERGENCE_THRESHOLD,
    multiJudgeScore,
    shouldUseMultiJudge,
    calculateJudgeAgreement,
    median
};
