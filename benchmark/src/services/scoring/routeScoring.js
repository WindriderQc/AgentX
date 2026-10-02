'use strict';

/**
 * Route a response to its scoring strategy, deterministic, reference or
 * decomposed judge, by category and by prompt-level signals, together with
 * the helper that derives the category dimension weights every decomposed
 * dispatch must carry.
 *
 * Moved out of `qualityScorer.js` unchanged so that file stays within the
 * size limit; `qualityScorer` re-exports both, so callers see one module.
 */

const logger = require('../../../config/logger');
const deterministicScorer = require('../deterministicScorer');
const decomposedJudge = require('../decomposedJudge');
const referenceScorer = require('../referenceScorer');
const {
    DEFAULT_SCORING_CATEGORY,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_STRATEGIES,
    normalizeScoringCategory
} = require('./scoringConfigs');
const { resolvePlan, PLANS } = require('./scoringPlan');

/**
 * Contract §2.3 (row 19): every decomposed dispatch path must carry
 * the category's dimension-weight table into `decomposedJudge.score()` so the
 * downstream weighted-average aggregation is category-aware regardless of
 * caller.
 *
 * This helper is the single source of truth for deriving `_dimensionWeights`
 * from a prompt. `routeScoring()`, judgeValidation, retroCalibration, and any
 * future direct caller must go through this helper rather than building the
 * weight map ad hoc. If a category has no ENHANCED_SCORING_CONFIGS entry the
 * helper returns null and `decomposedJudge.score()` derives an explicit
 * equal-distribution fallback (never an implicit unweighted mean).
 *
 * @param {Object} prompt - Prompt object (may have `scoring_type` or `category`)
 * @returns {Object|null} `{ [dimensionName]: weight }` or null if category unknown
 */
function getCategoryDimensionWeights(prompt) {
    const requestedCategory = (prompt && (prompt.scoring_type || prompt.category)) || null;
    const normalizedCategory = normalizeScoringCategory(requestedCategory, DEFAULT_SCORING_CATEGORY);
    const category = ENHANCED_SCORING_CONFIGS[normalizedCategory]
        ? normalizedCategory
        : DEFAULT_SCORING_CATEGORY;
    const config = ENHANCED_SCORING_CONFIGS[category];
    if (!config || !Array.isArray(config.core_dimensions) || config.core_dimensions.length === 0) {
        return null;
    }
    const weights = {};
    for (const dim of config.core_dimensions) {
        weights[dim.name] = dim.weight;
    }
    return weights;
}

/**
 * Route scoring to the appropriate strategy based on category and prompt
 */
async function routeScoring(response, prompt, judgeConfig) {
    const requestedCategory = prompt.scoring_type || prompt.category;
    const normalizedCategory = normalizeScoringCategory(requestedCategory, DEFAULT_SCORING_CATEGORY);
    const category = CATEGORY_STRATEGIES[normalizedCategory]
        ? normalizedCategory
        : DEFAULT_SCORING_CATEGORY;
    const strategy = CATEGORY_STRATEGIES[category] || CATEGORY_STRATEGIES[DEFAULT_SCORING_CATEGORY];
    const level = prompt.level || 5;

    logger.debug('Routing scoring', {
        prompt: prompt.name || 'unknown',
        requestedCategory,
        category,
        strategy: strategy.primary,
        level
    });

    // Contract §2.1/§2.2 (rows 21, 22): prompt-level signal
    // overrides category default strategy. The category default is 'decomposed'
    // for both instruction and translation, but specific prompt attributes
    // trigger a more targeted scorer first:
    //   - instruction + output_contract.type==='json_schema' → deterministic first
    //   - translation + reference_answer → reference first (via reference_fallback)
    let effectivePrimary = strategy.primary;
    const resolvedPlan = resolvePlan(prompt, CATEGORY_STRATEGIES);
    if (resolvedPlan.error) {
        logger.warn('Invalid scoring_plan, falling back to llm_judge', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            declared: prompt.scoring_plan,
            error: resolvedPlan.error
        });
    }
    if (resolvedPlan.source === 'explicit') {
        if (resolvedPlan.plan === PLANS.LLM_JUDGE) return null;
        if (resolvedPlan.plan === PLANS.DECOMPOSED) effectivePrimary = 'decomposed';
        if (resolvedPlan.plan === PLANS.REFERENCE) effectivePrimary = 'reference';
        if (resolvedPlan.plan === PLANS.DETERMINISTIC) effectivePrimary = 'deterministic';
        if (resolvedPlan.plan === PLANS.HYBRID) effectivePrimary = 'hybrid';
        if (resolvedPlan.plan === PLANS.CRITERIA) {
            logger.warn('criteria scoring_plan is no longer executable; routing to LLM judge', {
                prompt: prompt.name || 'unknown'
            });
            return null;
        }
    }
    if (category === 'instruction' && prompt.output_contract && prompt.output_contract.type === 'json_schema') {
        effectivePrimary = 'deterministic';
        logger.debug('Prompt-level override: instruction with json_schema → deterministic first', {
            prompt: prompt.name || 'unknown'
        });
    }

    let result = null;
    const normalizeDeterministic = (detResult, methodLabel = 'deterministic') => {
        if (!detResult) return null;
        const score = Number(detResult.score);
        const quality = Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0;
        return {
            quality_score: quality,
            scoring_method: methodLabel,
            scoring_type: category,
            deterministic_type: detResult.deterministic_type || detResult.method || null,
            matched_expected: !!detResult.matched,
            explanation: detResult.details || 'Deterministic scoring',
            breakdown: { overall: quality },
            judge_confidence: 1.0,
            needs_review: false
        };
    };

    // Phase 1: Try deterministic scoring if configured (or prompt-level override)
    if (effectivePrimary === 'deterministic' || effectivePrimary === 'hybrid' || effectivePrimary === 'auto') {
        if (prompt.deterministic_scoring) {
            result = deterministicScorer.score(response, prompt);
            // Preserve Phase 1's numeric abstention: an ordinary extraction
            // mismatch must reach the judge, not become terminal on this pass.
            // Other deterministic contracts (e.g. malformed JSON) stay terminal.
            const numericResult = result?.deterministic_type === 'numeric' || result?.method === 'numeric_eval';
            const forbiddenViolation = result?.results?.some((entry) => entry.forbidden && entry.found);
            if (result && !result.indeterminate
                && (!numericResult || result.matched || forbiddenViolation || prompt.deterministic_scoring.strict === true)) {
                logger.info('Deterministic scoring completed', {
                    prompt: prompt.name || 'unknown',
                    type: result.deterministic_type,
                    score: result.score,
                    matched: result.matched
                });
                return normalizeDeterministic(result);
            }
        }

        if (category === 'math' && prompt.expected_answer && !prompt.deterministic_scoring) {
            const numResult = deterministicScorer.numericEval(response, prompt.expected_answer);
            if (numResult.matched) {
                logger.info('Math deterministic scoring', {
                    prompt: prompt.name || 'unknown',
                    score: numResult.score,
                    matched: numResult.matched
                });
                return normalizeDeterministic({
                    ...numResult,
                    deterministic_type: 'numeric'
                }, 'deterministic');
            }
        }

        // Contract §2.1 (row 21): instruction prompts with
        // json_schema output_contract get deterministic JSON comparison even
        // without explicit deterministic_scoring config, when expected_answer
        // is available.
        if (category === 'instruction' && prompt.output_contract
            && prompt.output_contract.type === 'json_schema' && prompt.expected_answer) {
            const jsonResult = deterministicScorer.jsonCompare(response, prompt.expected_answer);
            if (jsonResult && jsonResult.score > 0) {
                logger.info('Instruction JSON-schema deterministic scoring', {
                    prompt: prompt.name || 'unknown',
                    score: jsonResult.score,
                    matched: jsonResult.matched
                });
                return normalizeDeterministic({
                    ...jsonResult,
                    deterministic_type: 'json'
                }, 'deterministic');
            }
        }
    }

    // Phase 1.5: Criteria-based hybrid scoring (disabled)
    // Regex matching on judge_criteria is unreliable for both code and format
    // verification. Prompts with deterministic_scoring are caught in Phase 1;
    // everything else goes to decomposed LLM judge (Phase 3) which evaluates
    // category-specific dimensions (correctness, instruction_adherence, etc.).

    // Phase 2: Try reference-based scoring for prompts with reference answers
    // A dimension the caller already measured (executed reference tests)
    // must reach the decomposed judge, the only path that honours it; the
    // reference scorer would grade the whole answer by similarity instead.
    const suppliedDimensions = !!(prompt._suppliedDimensions && typeof prompt._suppliedDimensions === 'object');
    if ((effectivePrimary === 'reference' || strategy.reference_fallback) && prompt.reference_answer && !suppliedDimensions) {
        result = await referenceScorer.score(response, prompt, judgeConfig);
        if (result) {
            logger.info('Reference scoring used', {
                prompt: prompt.name || 'unknown',
                score: result.quality_score
            });
            return result;
        }
    }

    // Phase 3: Use decomposed judging for complex evaluations
    if (strategy.primary === 'decomposed' || strategy.llm_strategy === 'decomposed') {
        // Contract §2.3 (row 19): derive `_dimensionWeights` via
        // the single shared helper so every decomposed dispatch path — routed,
        // direct, validation, calibration — uses the same weight table. The
        // helper returns null when the category has no ENHANCED_SCORING_CONFIGS
        // entry, in which case `decomposedJudge.score()` builds an explicit
        // equal-distribution fallback. Either way, the unweighted mean is
        // never possible.
        const dimensionWeights = getCategoryDimensionWeights({ ...prompt, scoring_type: category });
        result = await decomposedJudge.score(response, { ...prompt, _dimensionWeights: dimensionWeights }, judgeConfig);
        if (result) {
            logger.info('Decomposed judging used', {
                prompt: prompt.name || 'unknown',
                score: result.quality_score
            });
            return result;
        }
    }

    // Phase 4: Fall back to standard LLM judge
    return null;
}

module.exports = {
    routeScoring,
    getCategoryDimensionWeights
};
