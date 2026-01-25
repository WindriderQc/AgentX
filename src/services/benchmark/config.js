/**
 * Benchmark Configuration
 * Default settings and normalization functions for benchmark execution
 */

const DEFAULT_EXECUTION_CONFIG = {
    response_tokens_multiplier: 2.5,
    response_min_tokens: 100,
    response_max_tokens: 4000,
    include_length_hint: true,
    length_hint_template: 'Answer in ~{target} tokens (max {max} tokens).'
};

/**
 * Normalize and validate execution configuration
 * @param {Object} config - User-provided config
 * @returns {Object} - Normalized config with defaults applied
 */
function normalizeExecutionConfig(config = {}) {
    const merged = { ...DEFAULT_EXECUTION_CONFIG, ...(config || {}) };
    const toNumber = (value, fallback, min, max) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        let v = n;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        return v;
    };

    merged.response_tokens_multiplier = toNumber(
        merged.response_tokens_multiplier,
        DEFAULT_EXECUTION_CONFIG.response_tokens_multiplier,
        0.25,
        10
    );
    merged.response_min_tokens = Math.round(toNumber(
        merged.response_min_tokens,
        DEFAULT_EXECUTION_CONFIG.response_min_tokens,
        1,
        50000
    ));
    merged.response_max_tokens = Math.round(toNumber(
        merged.response_max_tokens,
        DEFAULT_EXECUTION_CONFIG.response_max_tokens,
        merged.response_min_tokens,
        50000
    ));
    if (merged.response_max_tokens < merged.response_min_tokens) {
        merged.response_max_tokens = merged.response_min_tokens;
    }
    merged.include_length_hint = !!merged.include_length_hint;
    if (typeof merged.length_hint_template !== 'string' || !merged.length_hint_template.trim()) {
        merged.length_hint_template = DEFAULT_EXECUTION_CONFIG.length_hint_template;
    }
    return merged;
}

/**
 * Apply length hint to prompt text based on execution config
 * @param {string} promptText - Original prompt
 * @param {number} expectedTokens - Expected response tokens
 * @param {number} numPredict - Max tokens to predict
 * @param {Object} config - Execution config
 * @returns {string} - Prompt with length hint appended
 */
function applyLengthHint(promptText, expectedTokens, numPredict, config) {
    if (!config || !config.include_length_hint) return promptText;
    const template = (config.length_hint_template || DEFAULT_EXECUTION_CONFIG.length_hint_template).trim();
    if (!template) return promptText;
    const tokensTarget = Math.round(Number(expectedTokens) || 0);
    const maxTokens = Math.round(Number(numPredict) || 0);
    const hint = template
        .replace(/\{target\}/g, String(tokensTarget))
        .replace(/\{max\}/g, String(maxTokens))
        .replace(/\{min\}/g, String(config.response_min_tokens))
        .replace(/\{multiplier\}/g, String(config.response_tokens_multiplier));
    return `${promptText}\n\n${hint}`;
}

module.exports = {
    DEFAULT_EXECUTION_CONFIG,
    normalizeExecutionConfig,
    applyLengthHint
};
