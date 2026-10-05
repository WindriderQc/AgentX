'use strict';

/**
 * Response budgets in preflight (#397).
 *
 * For each candidate, the window and output budget the launch will freeze,
 * resolved from Core's inference contract exactly as the launch resolves them,
 * with the budget's source (caller, the documented default or Core's reserve).
 * For the judge, the window it reads and whether the longest candidate answer,
 * the task and its own verdict fit in it: a judge input Core has to truncate
 * leaves that row unscored. Informational: nothing here blocks a launch.
 */

const { normalizeExecutionConfig } = require('./config');
const { resolveCandidateContract, resolveContractNumCtx } = require('./inferenceContractSnapshot');
const { normalizeJudgeNumCtx } = require('../scoring/judgeRuntimeConfig');

// The task, its expected answer and the judge's instructions beside the answer.
const JUDGE_PROMPT_ALLOWANCE_TOKENS = 2048;
const DEFAULT_JUDGE_NUM_PREDICT = 800;

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
 * @param {object} judgeConfig - { host, model, num_ctx?, num_predict?, target? }
 * @returns {Promise<{ candidates: object[], judge: object|null, warnings: string[] }>}
 */
async function checkResponseBudgets(targets, executionConfig, judgeConfig = {}, {
    resolveCandidate = resolveCandidateContract,
    resolveJudgeNumCtx = resolveContractNumCtx,
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
    const neededTokens = longestAnswer + JUDGE_PROMPT_ALLOWANCE_TOKENS + judgeNumPredict;
    const judge = {
        host: judgeConfig.host,
        model: judgeConfig.model,
        num_ctx: window.num_ctx ?? null,
        num_ctx_source: window.num_ctx_source ?? null,
        num_predict: judgeNumPredict,
        needed_tokens: longestAnswer > 0 ? neededTokens : null,
        fits: window.num_ctx && longestAnswer > 0 ? neededTokens <= window.num_ctx : null,
    };
    if (window.error) {
        warnings.push(`Judge window of ${judgeConfig.model} on ${judgeConfig.host} is unresolved: ${window.error}`);
    } else if (judge.fits === false) {
        warnings.push(
            `Judge ${judgeConfig.model} reads a ${window.num_ctx}-token window, but a candidate may answer up to ${longestAnswer} tokens; `
            + `with about ${JUDGE_PROMPT_ALLOWANCE_TOKENS} tokens of task and instructions and its own ${judgeNumPredict}-token verdict, `
            + `a full-length answer does not fit and its row stays unscored. Give the judge a larger window or the candidates a smaller response budget.`
        );
    }
    return { candidates, judge, warnings };
}

module.exports = { JUDGE_PROMPT_ALLOWANCE_TOKENS, checkResponseBudgets };
