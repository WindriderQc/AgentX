'use strict';

/**
 * What each prompt category requires of its judge (#397).
 *
 * Every category is judged with the decomposed yes/no and listed-count
 * questions (decomposedJudgeQuestions.js). A judge meets a category when:
 * - its window holds the category's longest selected prompt, its expected
 *   answer and criteria, the question, the longest candidate answer and its
 *   own verdict (computed per launch, not declared);
 * - it reasons before answering where the questions ask it to verify a
 *   derivation (declared below);
 * - its newest accuracy calibration covers the category and agrees with the
 *   reference grades there (judgeQualification.js).
 * A judge that does not meet one is flagged in preflight; the catalog is not
 * lowered for it and the launch is not refused.
 */

const { BENCHMARK_CATEGORY_KEYS } = require('../../../../shared/benchmarkCategories');

const REASONING_REASONS = Object.freeze({
    math: 'its questions ask the judge to check every step and calculation',
    reasoning: 'its questions ask the judge to check that each step follows from the previous one',
});

const CATEGORY_JUDGE_REQUIREMENTS = Object.freeze(Object.fromEntries(BENCHMARK_CATEGORY_KEYS.map(category => [
    category,
    Object.freeze({
        reasoning: Object.prototype.hasOwnProperty.call(REASONING_REASONS, category) ? 'recommended' : 'not_needed',
        reasoningReason: REASONING_REASONS[category] || null,
        validation: 'accuracy_calibration_cases',
    }),
])));

// The question, the answer format and the judge's instructions around the task.
const JUDGE_QUESTION_OVERHEAD_TOKENS = 512;

const estimateTokens = text => Math.ceil(String(text || '').length / 4);

/** Estimated tokens of what the judge reads besides the candidate's answer. */
function promptTokensOf(prompt = {}) {
    const criteria = Array.isArray(prompt.judge_criteria) ? prompt.judge_criteria.join('\n') : '';
    const expected = prompt.expected_answer == null ? ''
        : typeof prompt.expected_answer === 'string' ? prompt.expected_answer : JSON.stringify(prompt.expected_answer);
    return estimateTokens(prompt.prompt) + estimateTokens(expected) + estimateTokens(prompt.reference_answer) + estimateTokens(criteria);
}

/** Per selected category: prompt count and the largest judge-side prompt. */
function categoryPromptSizes(prompts = []) {
    const sizes = {};
    for (const prompt of prompts) {
        const category = prompt?.category;
        if (!category) continue;
        const entry = sizes[category] || (sizes[category] = { prompts: 0, promptTokens: 0 });
        entry.prompts += 1;
        entry.promptTokens = Math.max(entry.promptTokens, promptTokensOf(prompt));
    }
    return sizes;
}

/**
 * The judge's standing on each selected category, with one aggregated
 * warning per unmet requirement.
 *
 * @param {object} input
 * @param {{model, numCtx, numPredict, think}} input.judge
 * @param {object} input.sizes - categoryPromptSizes() of the selected prompts
 * @param {number} input.longestAnswer - the longest candidate response budget
 * @param {object} input.validation - per category { status, cases, mae, causes }
 */
function assessJudgeRequirements({ judge, sizes, longestAnswer = 0, validation = {} }) {
    const categories = {};
    const tooSmall = [];
    const unvalidated = [];
    const unreasoned = [];
    for (const [category, size] of Object.entries(sizes)) {
        const declared = CATEGORY_JUDGE_REQUIREMENTS[category] || { reasoning: 'not_needed', reasoningReason: null };
        const windowNeeded = longestAnswer > 0
            ? size.promptTokens + JUDGE_QUESTION_OVERHEAD_TOKENS + longestAnswer + judge.numPredict
            : null;
        const fits = windowNeeded && judge.numCtx ? windowNeeded <= judge.numCtx : null;
        const categoryValidation = validation[category] || { status: 'unvalidated', cases: 0, mae: null, causes: ['no_calibration_record'] };
        categories[category] = {
            prompts: size.prompts,
            prompt_tokens: size.promptTokens,
            window_needed: windowNeeded,
            fits,
            reasoning: declared.reasoning,
            judge_reasons: judge.think === true,
            validation: categoryValidation,
        };
        if (fits === false) tooSmall.push(`${category} (${windowNeeded})`);
        if (categoryValidation.status !== 'validated') unvalidated.push(`${category} (${describeValidation(categoryValidation)})`);
        if (declared.reasoning === 'recommended' && judge.think !== true) unreasoned.push(category);
    }
    const warnings = [];
    if (tooSmall.length) {
        warnings.push(`Judge ${judge.model} reads a ${judge.numCtx}-token window, but a full-length answer needs more for: `
            + `${tooSmall.join(', ')} tokens (longest prompt, ${JUDGE_QUESTION_OVERHEAD_TOKENS} for the question, a ${longestAnswer}-token answer `
            + `and its ${judge.numPredict}-token verdict). Such rows stay unscored.`);
    }
    if (unvalidated.length) {
        warnings.push(`Judge ${judge.model} is not validated for: ${unvalidated.join(', ')}. Its grades there are not backed by a calibration.`);
    }
    if (unreasoned.length) {
        warnings.push(`${unreasoned.join(' and ')} recommend a reasoning judge (${unreasoned.map(category => REASONING_REASONS[category]).join('; ')}); `
            + 'this launch judges without reasoning (judge_config.think).');
    }
    return { categories, warnings };
}

function describeValidation(validation) {
    if (validation.status === 'no_reference_cases') return 'no calibration case';
    if (validation.status === 'failed') return validation.causes?.length ? validation.causes.join(', ') : 'calibration disagrees';
    return validation.causes?.length ? validation.causes.join(', ') : 'no calibration';
}

module.exports = {
    CATEGORY_JUDGE_REQUIREMENTS,
    JUDGE_QUESTION_OVERHEAD_TOKENS,
    assessJudgeRequirements,
    categoryPromptSizes,
    promptTokensOf,
};
