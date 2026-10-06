'use strict';

/**
 * Carrying a stored grade over to the current scorer version (#461).
 *
 * A scorer change does not invalidate an answer, only what its grade means,
 * and often not even that: scorerVersion.js declares, per version step, which
 * categories a step touches and how their grades carry over. This module
 * decides, for one stored result, what its grade is under the current
 * version, without calling a judge. It never guesses: a grade it cannot
 * derive from what the result stores is not carried, and the answer is then
 * scored again the ordinary way.
 */

const { SCORER_VERSION, SCORER_CARRY_OVER } = require('./scorerVersion');
const { ENHANCED_SCORING_CONFIGS } = require('./scoringConfigs');
const { assembleOverall, effectiveDimensionWeights } = require('./decomposedHelpers');

/** The steps from a stored version to the target, or null when the chain is broken. */
function carryOverSteps(version, target = SCORER_VERSION, chain = SCORER_CARRY_OVER) {
    const steps = [];
    for (let current = version; current !== target;) {
        const step = chain.find(candidate => candidate.from === current);
        if (!step || steps.length >= chain.length) return null;
        steps.push(step);
        current = step.to;
    }
    return steps;
}

/** Stored versions some chain leads from to the target. */
function carriableVersions(target = SCORER_VERSION, chain = SCORER_CARRY_OVER) {
    return chain.map(step => step.from).filter(version => carryOverSteps(version, target, chain));
}

const refused = reason => ({ carried: false, reason });

/**
 * The grade under secondary bounds, from the stored dimension scores. The
 * stored grade must first be reproduced from those scores under the rules it
 * was assembled with; a grade something else shaped (several judges, a format
 * gate, caller weights) does not reproduce and is not carried.
 */
function withSecondaryBounds(result, category) {
    const dimensionScores = result.quality_breakdown;
    const config = ENHANCED_SCORING_CONFIGS[category];
    if (!config || !dimensionScores || typeof dimensionScores !== 'object') return refused('no stored dimension scores');
    const baseWeights = Object.fromEntries(config.core_dimensions.map(dimension => [dimension.name, dimension.weight]));
    const weights = effectiveDimensionWeights(baseWeights, Object.hasOwn(dimensionScores, 'specific_criteria'));
    const before = assembleOverall(category, dimensionScores, weights, { secondaryBounds: false });
    if (before.score !== result.quality_score) return refused('stored grade does not follow from its dimension scores');
    const after = assembleOverall(category, dimensionScores, weights);
    return { carried: true, quality_score: after.score, secondary_bounds: after.secondary.bounds };
}

/**
 * What one stored result's grade is under the target version.
 * @param {object} result  scorer_version, quality_score, scoring_method,
 *                         scoring_type or prompt_category, quality_breakdown,
 *                         judge_quality_score, judge_scores
 * @returns {{ carried: true, quality_score, changed, rules, secondary_bounds? }
 *          | { carried: false, reason }}
 */
function carryGrade(result, { target = SCORER_VERSION, chain = SCORER_CARRY_OVER } = {}) {
    if (typeof result.quality_score !== 'number') return refused('no grade to carry');
    // A human set this grade; no scorer rule produced it.
    if (result.judge_quality_score !== null && result.judge_quality_score !== undefined) return refused('human override');
    const steps = carryOverSteps(result.scorer_version, target, chain);
    if (!steps) return refused('no declared carry-over from this scorer version');
    const category = result.prompt_category;
    let grade = { quality_score: result.quality_score };
    const rules = [];
    for (const step of steps) {
        const rule = step.categories[category];
        if (!rule) continue;
        if (rule === 'judge') return refused(`${step.to} asks the judge something new for ${category}`);
        if (rule !== 'secondary_bounds') return refused(`unknown carry-over rule ${rule}`);
        // Only the decomposed path assembles a grade from dimensions; the
        // other paths never applied these bounds and keep their grade.
        if (result.scoring_method !== 'decomposed') continue;
        if ((result.judge_scores || []).length > 1) return refused('several judges shaped this grade');
        const bounded = withSecondaryBounds({ ...result, quality_score: grade.quality_score },
            result.scoring_type || category);
        if (!bounded.carried) return bounded;
        grade = bounded;
        rules.push(`${step.to}:${rule}`);
    }
    return { carried: true, ...grade, changed: grade.quality_score !== result.quality_score, rules };
}

module.exports = { carryGrade, carryOverSteps, carriableVersions };
