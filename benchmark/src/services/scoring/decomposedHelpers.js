'use strict';

/**
 * Pure helpers of the decomposed judge: the dimension-weight table, the
 * graded-answer parser, the explanation line, the question-bank accessors
 * and the supplied-dimension shape. None of them calls a judge.
 *
 * Moved out of `decomposedJudge.js` unchanged so that file stays within the
 * size limit; `decomposedJudge` re-exports the ones callers already used.
 */

const logger = require('../../../config/logger');
const { ENHANCED_SCORING_CONFIGS, PRIMARY_DIMENSION_CAP_MARGIN, DEFAULT_SCORING_CATEGORY } = require('./scoringConfigs');

// Share of the grade the prompt's own criteria take when it carries some.
const SPECIFIC_CRITERIA_WEIGHT = 0.25;
const { DECOMPOSED_QUESTIONS } = require('../decomposedJudgeQuestions');

/**
 * Resolve the dimension-weight table used to aggregate per-dimension scores
 * into `quality_score`. Contract §2.3 mandates a
 * weighted average over `ENHANCED_SCORING_CONFIGS[category].core_dimensions`;
 * the unweighted mean is never acceptable.
 *
 * Priority:
 *   1. Caller-provided `_dimensionWeights` (non-empty object).
 *   2. `ENHANCED_SCORING_CONFIGS[category].core_dimensions` (canonical source).
 *   3. Equal-distribution weights over the dimensions actually present in
 *      `questions` — explicit, and used only as a last resort when the
 *      category is missing from ENHANCED_SCORING_CONFIGS (which is itself a
 *      warning-worthy configuration drift).
 *
 * Exported for testing so we can assert the same defaults that `score()`
 * applies end-to-end without spinning up the whole judge pipeline.
 *
 * @param {Object|null} callerWeights - Optional weights from the caller (e.g. qualityScorer)
 * @param {string} category - Canonical scoring category (already normalized)
 * @param {Object} questions - The DECOMPOSED_QUESTIONS entry for the category
 *                             (shape: `{ [dimensionName]: Array<{q,weight,invert}> }`)
 * @returns {Object} `{ [dimensionName]: number }` — always non-empty
 */
function resolveDimensionWeights(callerWeights, category, questions) {
    // 1. Explicit caller weights take precedence.
    if (callerWeights && typeof callerWeights === 'object') {
        const keys = Object.keys(callerWeights);
        if (keys.length > 0) {
            return callerWeights;
        }
    }

    // 2. Canonical category config.
    const config = ENHANCED_SCORING_CONFIGS[category];
    if (config && Array.isArray(config.core_dimensions) && config.core_dimensions.length > 0) {
        const weights = {};
        for (const dim of config.core_dimensions) {
            weights[dim.name] = dim.weight;
        }
        return weights;
    }

    // 3. Explicit equal-distribution fallback. This is the "never unweighted
    // mean" guardrail — we still produce a weight table, but we log it because
    // reaching this branch means a category is registered in
    // DECOMPOSED_QUESTIONS but absent from ENHANCED_SCORING_CONFIGS, which is
    // a configuration bug we want to hear about.
    const dimensionNames = questions && typeof questions === 'object'
        ? Object.keys(questions)
        : [];
    if (dimensionNames.length === 0) {
        // Nothing to weight. Caller will short-circuit to overallScore=0 when
        // totalWeight is 0; returning an empty object keeps that behaviour.
        logger.warn('Decomposed judge: no dimensions available for weight resolution', {
            category
        });
        return {};
    }
    const equal = 1 / dimensionNames.length;
    const weights = {};
    for (const name of dimensionNames) {
        weights[name] = equal;
    }
    logger.warn('Decomposed judge: category missing from ENHANCED_SCORING_CONFIGS, using explicit equal-distribution weights', {
        category,
        dimensions: dimensionNames,
        weightPerDimension: equal
    });
    return weights;
}

/**
 * Match a graded answer. Options are tried longest first so "3 or more" wins
 * over "3", and a bare count matches its option ("3+" reads as "3 or more").
 */
function parseGradedAnswer(text, options) {
    const lines = String(text || '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    // A final standalone verdict wins over numbered reasoning at the start.
    // No numeric prefix of prose, a decimal or exponent is itself a count.
    const verdict = lines[lines.length - 1] || '';
    return parseGradedHead(verdict, options);
}

/**
 * What a judge question may answer: the rule and meaning lines of its prompt,
 * and the answers themselves. `format` constrains the output to one of those
 * answers (an Ollama JSON-schema string enum). It is used only to retry a
 * reply that ran out of tokens: forcing the answer at once removes the
 * judge's reasoning, which lowers accuracy on a first attempt.
 */
function judgeAnswerSpec({ graded = null, conditional = false } = {}) {
    const gradedOptions = graded ? graded.map(option => `"${option.answer}"`).join(', ') : '';
    const answers = graded ? graded.map(option => option.answer) : (conditional ? ['YES', 'NO', 'NA'] : ['YES', 'NO']);
    const answerRule = graded
        ? `Answer ONLY one of ${gradedOptions} for this specific question`
        : conditional
            ? 'Answer ONLY "YES", "NO" or "NA" for this specific question'
            : 'Answer ONLY "YES" or "NO" for this specific question';
    const naGuideline = conditional
        ? '\n- NA: the question starts with "If" and the task does not call for that at all. Use NA only then.'
        : '';
    const meaning = graded
        ? `Meaning of the answers:\n- Give the count the question asks for, choosing one of ${gradedOptions}. Count only what the task or the expected answer requires.`
        : `Meaning of the answers:\n- YES: the response clearly satisfies what this question asks.\n- NO: it does not.${naGuideline}`;
    return { answerRule, meaning, format: { type: 'string', enum: answers } };
}

/**
 * The yes/no/na verdict of a binary judge answer: at the start, or alone on
 * the final line when the judge reasoned first. Returns the regex match whose
 * group 1 is the verdict, or null.
 */
function matchBinaryVerdict(text) {
    const lower = String(text || '').toLowerCase().trim();
    const head = lower.match(/^[^a-z0-9]*(yes|no|n\/a|na|not applicable)\b/);
    if (head) return head;
    const lines = lower.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    return lines[lines.length - 1].match(/^[^a-z0-9]*(?:final\s+)?(?:answer\s*[:=]\s*)?[^a-z0-9]*(yes|no|n\/a|na|not applicable)[^a-z0-9]*$/);
}

function parseGradedHead(text, options) {
    const answer = String(text || '').trim().toLowerCase()
        .replace(/^(?:final\s+)?(?:answer|count|total)\s*[:=]\s*/, '')
        .replace(/^[*_\x60"'\u201c\u201d\s]+/, '')
        .replace(/[*_\x60"'\u201c\u201d\s]+$/, '')
        .replace(/\.$/, '').trim();
    const exact = options.find(option => option.answer.toLowerCase() === answer);
    if (exact) return exact;
    // Retain the established bare/open count and "7 missing" forms, but
    // reject unlisted prose rather than silently assigning it numeric credit.
    const count = answer.match(/^(\d+)(?:\s*(?:or more|\+)|\s+missing)?$/);
    if (!count) return null;
    const n = Number(count[1]);
    if (!Number.isSafeInteger(n)) return null;
    const numeric = options.find(option => Number(option.answer) === n);
    if (numeric && !/or more|\+/.test(answer)) return numeric;
    const open = options.find(option => /or more|\+$/.test(option.answer));
    return open && n >= Number.parseInt(open.answer, 10) ? open : null;
}

/**
 * Build a rich human-readable explanation from dimension scores
 */
function buildExplanation(overallScore, category, dimensionScores, dimensionBreakdowns) {
    const parts = [];
    for (const [dim, dimScore] of Object.entries(dimensionScores)) {
        const breakdown = (dimensionBreakdowns[dim] || []).filter(q => q.na !== true);
        const dimLabel = dim.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        if (breakdown.some(q => q.supplied)) {
            parts.push(`${dimLabel}: ${dimScore} (reference tests executed)`);
            continue;
        }
        if (dimScore === null) {
            parts.push(`${dimLabel}: not applicable`);
            continue;
        }
        const total = breakdown.length;
        const passed = breakdown.filter(q => q.contributed || (q.graded && q.credit > 0)).length;
        let dimStr = `${dimLabel}: ${dimScore} (${passed}/${total})`;
        if (dimScore < 8.0) {
            const firstFail = breakdown.find(q => !q.contributed);
            if (firstFail) {
                const qText = firstFail.question.length > 60
                    ? firstFail.question.substring(0, 57) + '...'
                    : firstFail.question;
                dimStr += ` -- "${qText}" failed`;
            }
        }
        parts.push(dimStr);
    }
    return `Score ${overallScore}/10 (${category}). ${parts.join('. ')}.`;
}

/**
 * Get available dimensions for a category
 * @param {string} category - Category name
 * @returns {Array<string>} List of dimension names
 */
function getDimensions(category) {
    const questions = DECOMPOSED_QUESTIONS[category] || DECOMPOSED_QUESTIONS[DEFAULT_SCORING_CATEGORY];
    return Object.keys(questions);
}

/**
 * Get questions for a specific category/dimension
 * @param {string} category - Category name
 * @param {string} dimension - Dimension name (optional)
 * @returns {Object|Array} Questions object or array
 */
function getQuestions(category, dimension = null) {
    const questions = DECOMPOSED_QUESTIONS[category] || DECOMPOSED_QUESTIONS[DEFAULT_SCORING_CATEGORY];
    if (dimension) {
        return questions[dimension] || [];
    }
    return questions;
}

/**
 * Dimensions the caller already measured, keyed by name: coding correctness
 * from the executed reference tests. Only finite scores count.
 */
function resolveSuppliedDimensions(prompt) {
    const supplied = prompt && prompt._suppliedDimensions;
    if (!supplied || typeof supplied !== 'object') return {};
    return Object.fromEntries(Object.entries(supplied).filter(([, value]) => Number.isFinite(value)));
}

/**
 * The dimension result for a supplied score: no question asked, one
 * breakdown entry that names its source. `supplied` keeps it out of the
 * judge's pass-rate and discrimination statistics.
 */
function suppliedDimensionResult(score) {
    const bounded = Math.round(Math.max(0, Math.min(10, score)) * 10) / 10;
    return {
        score: bounded,
        errors: 0,
        breakdown: [{
            question: 'Correctness measured by executing the reference tests',
            supplied: 'executable',
            answer: null,
            credit: bounded / 10,
            weight: 1
        }]
    };
}

/**
 * The overall score held to the category's secondary bounds (scoringConfigs.js,
 * #446): each bound is a dimension score plus its margin. A dimension that was
 * not scored (every question not applicable) sets no bound.
 * @returns {{ score: number, bounds: Array<{dimension, score, margin, applied}> }}
 */
function applySecondaryBounds(score, dimensionScores, bounds = []) {
    const limits = bounds.map(({ dimension, margin }) => {
        const dimensionScore = typeof dimensionScores[dimension] === 'number' ? dimensionScores[dimension] : null;
        const limit = dimensionScore === null ? null : Math.round((dimensionScore + margin) * 10) / 10;
        return { dimension, score: dimensionScore, margin, applied: limit !== null && limit < score, limit };
    });
    const bounded = Math.min(score, ...limits.filter(bound => bound.applied).map(bound => bound.limit));
    return { score: bounded, bounds: limits.map(({ limit, ...bound }) => bound) };
}

/**
 * The dimension weights a response is graded with: the category's, scaled to
 * make room for the prompt's own criteria when it carries some.
 */
function effectiveDimensionWeights(baseWeights, withSpecificCriteria) {
    if (!withSpecificCriteria) return { ...baseWeights };
    const weights = {};
    for (const [dimension, weight] of Object.entries(baseWeights)) {
        weights[dimension] = weight * (1 - SPECIFIC_CRITERIA_WEIGHT);
    }
    weights.specific_criteria = SPECIFIC_CRITERIA_WEIGHT;
    return weights;
}

/**
 * The overall grade assembled from dimension scores: their weighted average
 * (contract §2.3; a dimension without a score drops out and the remaining
 * weights are renormalized), held by the primary dimension, then by the
 * category's secondary bounds. Pure, so a stored grade can be assembled again
 * from its stored dimension scores (gradeCarryOver.js).
 * @returns {{ score, uncappedScore, primaryCap, secondary }}
 */
function assembleOverall(category, dimensionScores, dimensionWeights, { secondaryBounds = true } = {}) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [dimension, dimensionScore] of Object.entries(dimensionScores)) {
        if (typeof dimensionScore !== 'number') continue;
        const weight = Number(dimensionWeights[dimension]) || 0;
        weightedSum += dimensionScore * weight;
        totalWeight += weight;
    }
    const uncappedScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;

    // The primary dimension bounds the overall score: secondary dimensions
    // refine the grade of a correct answer, they cannot rescue a wrong one.
    const primaryDimension = ENHANCED_SCORING_CONFIGS[category]?.primary_dimension || null;
    const primaryScore = primaryDimension ? dimensionScores[primaryDimension] : null;
    const capApplies = typeof primaryScore === 'number'
        && uncappedScore > primaryScore + PRIMARY_DIMENSION_CAP_MARGIN;
    const cappedScore = capApplies
        ? Math.round((primaryScore + PRIMARY_DIMENSION_CAP_MARGIN) * 10) / 10
        : uncappedScore;
    const primaryCap = {
        dimension: primaryDimension,
        score: typeof primaryScore === 'number' ? primaryScore : null,
        margin: PRIMARY_DIMENSION_CAP_MARGIN,
        applied: capApplies,
        uncapped_score: uncappedScore
    };

    // A weak dimension the task's quality rests on bounds the grade too (#446).
    const secondary = applySecondaryBounds(cappedScore, dimensionScores,
        secondaryBounds ? ENHANCED_SCORING_CONFIGS[category]?.secondary_bounds : []);
    return { score: secondary.score, uncappedScore, primaryCap, secondary };
}

module.exports = {
    SPECIFIC_CRITERIA_WEIGHT,
    assembleOverall,
    effectiveDimensionWeights,
    applySecondaryBounds,
    resolveDimensionWeights,
    parseGradedAnswer,
    judgeAnswerSpec,
    matchBinaryVerdict,
    buildExplanation,
    getDimensions,
    getQuestions,
    resolveSuppliedDimensions,
    suppliedDimensionResult
};
