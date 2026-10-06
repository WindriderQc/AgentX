'use strict';

const { checkJudgeLimits, normalizeJudgeThink } = require('./judgeLaunchLimits');

function diagnosticInput(body, referenceSet) {
    const { num_ctx, num_predict, timeout, think, case_ids } = body;
    const limits = checkJudgeLimits({ num_predict, timeout, think });
    const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
    if (limits.error) throw error(limits.error);
    if (num_ctx !== undefined && (!Number.isSafeInteger(num_ctx) || num_ctx < 512)) {
        throw error('num_ctx must be an integer of at least 512');
    }
    let cases = referenceSet;
    if (case_ids !== undefined) {
        if (!Array.isArray(case_ids) || !case_ids.length || case_ids.some(id => typeof id !== 'string')) {
            throw error('case_ids must be a nonempty array of reference case IDs');
        }
        const ids = new Set(case_ids);
        const missing = [...ids].filter(id => !referenceSet.some(item => item.id === id));
        if (missing.length) throw error(`Unknown reference case IDs: ${missing.join(', ')}`, 422);
        cases = referenceSet.filter(item => ids.has(item.id));
    }
    // Qualification readers currently match host/model, not operator settings.
    // A targeted or explicitly configured diagnostic must never replace that record.
    const diagnostic = case_ids !== undefined
        || ['num_predict', 'timeout', 'think'].some(key => Object.hasOwn(body, key));
    return { cases, diagnostic, warnings: limits.warnings,
        options: { num_ctx, num_predict, timeout, think: normalizeJudgeThink(think) } };
}

function reportedJudgeConfig(config) {
    const { host, model, num_ctx, num_predict, timeout, think, temperature, seed,
        voting_count, max_retries, execution_contract } = config;
    return { host, model, num_ctx, num_predict, timeout, think, temperature, seed,
        voting_count, max_retries, execution_contract };
}

module.exports = { diagnosticInput, reportedJudgeConfig };
