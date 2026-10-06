'use strict';

/**
 * Response budgets in preflight (#397).
 *
 * For each candidate, the window and output budget the launch will freeze,
 * resolved from Core's inference contract exactly as the launch resolves them,
 * with the budget's source (caller, the documented default or Core's reserve).
 * For the judge, the window it reads and, per selected prompt category, what
 * the category requires of it (scoring/judgeRequirements.js): a window that
 * holds the longest prompt, the longest candidate answer and its verdict (a
 * judge input Core has to truncate leaves that row unscored), reasoning where
 * the questions verify a derivation, and a calibration that covers the
 * category. Informational: nothing here blocks a launch.
 */

const { normalizeExecutionConfig } = require('./config');
const { resolveCandidateContract, resolveContractNumCtx } = require('./inferenceContractSnapshot');
const { normalizeJudgeNumCtx } = require('../scoring/judgeRuntimeConfig');
const { assessJudgeRequirements, categoryPromptSizes } = require('../scoring/judgeRequirements');

const DEFAULT_JUDGE_NUM_PREDICT = 800;

/** The prompts a launch with these levels or prompt ids would run. */
function loadSelectedPrompts({ levels, promptIds }) {
    const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
    const ids = Array.isArray(promptIds) ? [...new Set(promptIds.map(String).filter(Boolean))] : [];
    const filter = ids.length ? { _id: { $in: ids } } : { level: { $in: Array.isArray(levels) ? levels : [1, 2, 3, 4, 5] } };
    return BenchmarkPrompt.find(filter).select('category prompt expected_answer reference_answer judge_criteria').lean();
}

function assessCategories(judge, categories) {
    return require('./judgeQualification').assessJudgeCategories(judge, categories);
}

async function candidateBudget({ host, model }, config, resolve) {
    try {
        const { execution } = await resolve(model, host, config);
        return {
            host,
            model,
            num_ctx: execution.num_ctx,
            num_ctx_source: execution.num_ctx_source,
            num_predict: execution.num_predict,
            num_predict_source: execution.num_predict_source,
            input_tokens: execution.num_ctx - execution.num_predict,
            error: null,
        };
    } catch (error) {
        return { host, model, num_ctx: null, num_ctx_source: null, num_predict: null, num_predict_source: null,
            input_tokens: null, error: error.message };
    }
}

async function judgeWindow(judgeConfig, resolveNumCtx) {
    const explicit = normalizeJudgeNumCtx(judgeConfig.num_ctx);
    if (explicit) return { num_ctx: explicit, num_ctx_source: 'explicit' };
    try {
        return await resolveNumCtx(judgeConfig.model, judgeConfig.host);
    } catch (error) {
        return { num_ctx: null, num_ctx_source: null, error: error.message };
    }
}

/**
 * @param {Array<{host, model}>} targets
 * @param {object|null} executionConfig - the launch's execution_config
 * @param {object} judgeConfig - { host, model, num_ctx?, num_predict?, think?, target? }
 * @param {object} [options] - { levels, promptIds } of the launch, and test seams
 * @returns {Promise<{ candidates: object[], judge: object|null, warnings: string[] }>}
 */
async function checkResponseBudgets(targets, executionConfig, judgeConfig = {}, {
    levels, promptIds,
    resolveCandidate = resolveCandidateContract,
    resolveJudgeNumCtx = resolveContractNumCtx,
    loadPrompts = loadSelectedPrompts,
    assessJudgeCategories = assessCategories,
} = {}) {
    let config;
    try {
        config = normalizeExecutionConfig(executionConfig || {});
    } catch (error) {
        return { candidates: [], judge: null, warnings: [`Response budgets are unresolved: ${error.message}`] };
    }
    const candidates = await Promise.all((targets || []).map(target => candidateBudget(target, config, resolveCandidate)));
    const warnings = candidates.filter(row => row.error)
        .map(row => `Response budget of ${row.model} on ${row.host} is unresolved: ${row.error}`);

    const harnessJudge = judgeConfig?.target?.executionKind === 'harness';
    if (harnessJudge || !judgeConfig?.host || !judgeConfig?.model) return { candidates, judge: null, warnings };

    const window = await judgeWindow(judgeConfig, resolveJudgeNumCtx);
    const judgeNumPredict = Number(judgeConfig.num_predict) > 0 ? Number(judgeConfig.num_predict) : DEFAULT_JUDGE_NUM_PREDICT;
    const longestAnswer = Math.max(0, ...candidates.map(row => Number(row.num_predict) || 0));
    if (window.error) warnings.push(`Judge window of ${judgeConfig.model} on ${judgeConfig.host} is unresolved: ${window.error}`);
    if (window.profile_qualified === false) {
        warnings.push(`The profile of judge ${judgeConfig.model} on ${judgeConfig.host} is not current: `
            + `it judges at the context Core serves it (${window.num_ctx} tokens), which no current profile verifies. `
            + 'Profile it again on that host to verify this window.');
    }

    const sizes = categoryPromptSizes(await loadPrompts({ levels, promptIds }).catch(() => []));
    const validation = await assessJudgeCategories({ host: judgeConfig.host, model: judgeConfig.model }, Object.keys(sizes))
        .catch(error => Object.fromEntries(Object.keys(sizes).map(category => [category,
            { status: 'unvalidated', cases: 0, mae: null, causes: [`qualification_unreadable: ${error.message}`] }])));
    const requirements = assessJudgeRequirements({
        judge: { model: judgeConfig.model, numCtx: window.num_ctx ?? null, numPredict: judgeNumPredict, think: judgeConfig.think === true },
        sizes,
        longestAnswer,
        validation,
    });
    const fits = Object.values(requirements.categories).map(category => category.fits);
    const judge = {
        host: judgeConfig.host,
        model: judgeConfig.model,
        num_ctx: window.num_ctx ?? null,
        num_ctx_source: window.num_ctx_source ?? null,
        num_predict: judgeNumPredict,
        think: judgeConfig.think === true,
        profile_qualified: window.profile_qualified ?? null,
        fits: fits.includes(false) ? false : (fits.length && fits.every(value => value === true) ? true : null),
        categories: requirements.categories,
    };
    warnings.push(...requirements.warnings);
    return { candidates, judge, warnings };
}

module.exports = { checkResponseBudgets };
