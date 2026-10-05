'use strict';

/**
 * The judge's output budget and timeout at batch launch.
 *
 * These were sized so a small judge could run on any host, and launches above
 * them were refused. A larger judge on stronger hardware needs more, so a value
 * above the usual size is now the operator's choice, accepted with a warning
 * that says what it costs. The maxima only reject nonsense. Judge reasoning is
 * off by default and on only by the operator's choice, with the same warning.
 */

const JUDGE_NUM_PREDICT_USUAL = 4096;
const JUDGE_NUM_PREDICT_MAX = 32768;
const JUDGE_TIMEOUT_USUAL_MS = 120000;
const JUDGE_TIMEOUT_MAX_MS = 1800000;

/**
 * The judge's reasoning setting: off unless the operator chose it. A boolean
 * only: Core's thinking policy does not carry Ollama's effort levels. Returns
 * undefined for any other value.
 */
function normalizeJudgeThink(value) {
    if (value === undefined || value === null || value === false) return false;
    return value === true ? true : undefined;
}

/** @returns {{ error: string|null, warnings: string[] }} */
function checkJudgeLimits(judgeConfig = {}) {
    const { num_predict: numPredict, timeout } = judgeConfig || {};
    const warnings = [];
    const think = normalizeJudgeThink(judgeConfig?.think);
    if (think === undefined) {
        return { error: 'judge_config.think must be a boolean', warnings };
    }
    if (numPredict !== undefined && (typeof numPredict !== 'number' || numPredict < 100 || numPredict > JUDGE_NUM_PREDICT_MAX)) {
        return { error: `judge_config.num_predict must be a number between 100 and ${JUDGE_NUM_PREDICT_MAX}`, warnings };
    }
    if (timeout !== undefined && (typeof timeout !== 'number' || timeout < 5000 || timeout > JUDGE_TIMEOUT_MAX_MS)) {
        return { error: `judge_config.timeout must be a number between 5000 and ${JUDGE_TIMEOUT_MAX_MS}`, warnings };
    }
    if (numPredict > JUDGE_NUM_PREDICT_USUAL) {
        warnings.push(`judge_config.num_predict ${numPredict} is above ${JUDGE_NUM_PREDICT_USUAL}: each verdict may take longer and holds the judge host longer. Kept as chosen.`);
    }
    if (timeout > JUDGE_TIMEOUT_USUAL_MS) {
        warnings.push(`judge_config.timeout ${timeout} ms is above ${JUDGE_TIMEOUT_USUAL_MS} ms: a stalled verdict is detected later. Kept as chosen.`);
    }
    if (think !== false) {
        warnings.push(`judge_config.think ${think}: the judge reasons before each verdict, which takes longer, and these results form their own scoring cohort. Kept as chosen.`);
        if (!(numPredict > JUDGE_NUM_PREDICT_USUAL)) {
            warnings.push(`judge reasoning shares judge_config.num_predict (${numPredict ?? 'default'}) with the verdict; a verdict cut at that budget cannot be scored. A budget above ${JUDGE_NUM_PREDICT_USUAL} leaves it room. Kept as chosen.`);
        }
    }
    return { error: null, warnings };
}

module.exports = {
    JUDGE_NUM_PREDICT_USUAL,
    JUDGE_NUM_PREDICT_MAX,
    JUDGE_TIMEOUT_USUAL_MS,
    JUDGE_TIMEOUT_MAX_MS,
    checkJudgeLimits,
    normalizeJudgeThink
};
