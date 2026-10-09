'use strict';

const RESPONSE_TOKEN_LIMIT = 50000;
const DEFAULT_RESPONSE_MIN_TOKENS = 100;
const DEFAULT_RESPONSE_MAX_TOKENS = 32000;
const EXECUTION_TIMEOUT_LIMITS = Object.freeze({
    per_test_timeout_ms: [30000, 3600000],
    warmup_timeout_cold: [30000, 600000],
    warmup_timeout_loaded: [10000, 180000],
    judge_drain_timeout_ms: [300000, 3600000],
    judge_stall_timeout_ms: [30000, 600000]
});
const EARLY_STOP_POLICY = Object.freeze({ enabledByDefault: true, minJudged: 5, threshold: 2 });

function invalid(message) {
    return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_EXECUTION_CONFIG' });
}

// Fresh requests fail explicitly; they do not get a smaller output budget.
function validateResponseBudgets(config = {}) {
    for (const key of ['response_min_tokens', 'response_max_tokens']) {
        const value = config[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > RESPONSE_TOKEN_LIMIT)) {
            throw invalid(`execution_config.${key} must be an integer between 1 and ${RESPONSE_TOKEN_LIMIT}`);
        }
    }
    if ((config.response_max_tokens ?? DEFAULT_RESPONSE_MAX_TOKENS) < (config.response_min_tokens ?? DEFAULT_RESPONSE_MIN_TOKENS)) {
        throw invalid('execution_config.response_max_tokens must be at least response_min_tokens (default 100)');
    }
    if (config.early_stop_enabled !== undefined && typeof config.early_stop_enabled !== 'boolean') {
        throw invalid('execution_config.early_stop_enabled must be a boolean');
    }
}

function validateExecutionPolicy(config) {
    if (config == null) return;
    if (typeof config !== 'object' || Array.isArray(config)) throw invalid('execution_config must be an object');
    validateResponseBudgets(config);
    for (const [key, [minimum, maximum]] of Object.entries(EXECUTION_TIMEOUT_LIMITS)) {
        const value = config[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
            throw invalid(`execution_config.${key} must be an integer between ${minimum} and ${maximum}`);
        }
    }
}

module.exports = { RESPONSE_TOKEN_LIMIT, EXECUTION_TIMEOUT_LIMITS, EARLY_STOP_POLICY,
    DEFAULT_RESPONSE_MIN_TOKENS, DEFAULT_RESPONSE_MAX_TOKENS,
    validateResponseBudgets, validateExecutionPolicy };
