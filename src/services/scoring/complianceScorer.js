/**
 * Compliance Scorer
 * Evaluates behavioral conformance (conciseness, format, directness)
 * via simple binary YES/NO questions — trivial for 7B models.
 *
 * Distinct from DECOMPOSED_QUESTIONS which evaluate content accuracy.
 * Used in hybrid scoring: deterministic accuracy + LLM compliance.
 */

const logger = require('../../../config/logger');
const { scoreDimension } = require('../decomposedJudge');
const { CATEGORY_STRATEGIES } = require('./scoringConfigs');

const COMPLIANCE_QUESTIONS = [
    { q: 'Does the response avoid unnecessary extra text beyond what was asked for?', weight: 0.40 },
    { q: 'Does the response follow the formatting and structural instructions in the task?', weight: 0.35 },
    { q: 'Does the response directly address the question without hedging or meta-commentary?', weight: 0.25 }
];

/** Default hybrid weights when category has no explicit config */
const DEFAULT_HYBRID_WEIGHTS = { accuracy: 0.70, compliance: 0.30 };

/**
 * Score compliance of a response using binary YES/NO questions.
 * @param {string} response - Model response text
 * @param {Object} prompt - Prompt object (needs .prompt and .expected_answer)
 * @param {Object} judgeConfig - { host, model, timeout, voting_count }
 * @returns {Promise<Object|null>} { score, breakdown } or null on failure
 */
async function scoreCompliance(response, prompt, judgeConfig) {
    try {
        const taskContext = {
            task: prompt.prompt || '',
            expected: prompt.expected_answer || ''
        };

        const result = await scoreDimension(response, COMPLIANCE_QUESTIONS, judgeConfig, taskContext);

        logger.info('Compliance scoring complete', {
            prompt: prompt.name || 'unknown',
            score: result.score,
            questions: COMPLIANCE_QUESTIONS.length
        });

        return result;
    } catch (err) {
        logger.warn('Compliance scoring failed, falling back to pure deterministic', {
            prompt: prompt.name || 'unknown',
            error: err.message
        });
        return null;
    }
}

/**
 * Blend deterministic accuracy score with LLM compliance score.
 * @param {Object} criteriaResult - From criteriaBasedScore(): { score, matched, details, ... }
 * @param {Object} complianceResult - From scoreCompliance(): { score, breakdown }
 * @param {string} category - Prompt category for weight lookup
 * @returns {Object} Normalized hybrid result for qualityScorer
 */
function blendHybridScore(criteriaResult, complianceResult, category) {
    const strategy = CATEGORY_STRATEGIES[category] || {};
    const weights = strategy.hybrid_weights || DEFAULT_HYBRID_WEIGHTS;

    const accuracyScore = Math.max(0, Math.min(10, Number(criteriaResult.score) || 0));
    const complianceScore = Math.max(0, Math.min(10, Number(complianceResult.score) || 0));

    const blended = accuracyScore * weights.accuracy + complianceScore * weights.compliance;
    const qualityScore = Math.max(0, Math.min(10, Math.round(blended * 10) / 10));

    return {
        quality_score: qualityScore,
        scoring_method: 'hybrid',
        scoring_type: category,
        deterministic_type: criteriaResult.deterministic_type || criteriaResult.method || 'criteria',
        matched_expected: !!criteriaResult.matched,
        accuracy_score: accuracyScore,
        compliance_score: complianceScore,
        explanation: `Hybrid: accuracy ${accuracyScore.toFixed(1)} (w=${weights.accuracy}) + compliance ${complianceScore.toFixed(1)} (w=${weights.compliance}) = ${qualityScore.toFixed(1)}`,
        breakdown: {
            overall: qualityScore,
            accuracy: accuracyScore,
            compliance: complianceScore,
            ...complianceResult.breakdown && { compliance_details: complianceResult.breakdown }
        },
        judge_confidence: 0.95,
        needs_review: false
    };
}

module.exports = {
    COMPLIANCE_QUESTIONS,
    scoreCompliance,
    blendHybridScore,
    DEFAULT_HYBRID_WEIGHTS
};
