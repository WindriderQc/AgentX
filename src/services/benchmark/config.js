/**
 * Benchmark Configuration
 * Default settings and normalization functions for benchmark execution
 */

const DEFAULT_EXECUTION_CONFIG = {
    // Simple config: just set a high limit and let models finish naturally
    response_max_tokens: 32000,  // High enough for any response including <think> reasoning
    response_min_tokens: 100,
    response_tokens_multiplier: 1,  // No multiplier games - just use the max
    // Fallback context window for Ollama when no per-model config exists in the registry.
    // Per-model values are auto-detected by modelSync/parameterDetection.js based on
    // model size and host VRAM, and stored in ModelRegistry.executionDefaults.
    num_ctx: 8192,
    // Per-test abort timeout in ms. 180s was too short for large models (27B+).
    per_test_timeout_ms: 600000,
    // Length hints can constrain models - disabled by default
    include_length_hint: false,
    length_hint_template: 'Keep your response under {max} tokens.',
    // Custom hint - free-form text appended to every prompt
    custom_hint: ''
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
    merged.num_ctx = Math.round(toNumber(
        merged.num_ctx,
        DEFAULT_EXECUTION_CONFIG.num_ctx,
        512,
        131072
    ));
    merged.per_test_timeout_ms = Math.round(toNumber(
        merged.per_test_timeout_ms,
        DEFAULT_EXECUTION_CONFIG.per_test_timeout_ms,
        30000,
        3600000
    ));
    merged.include_length_hint = !!merged.include_length_hint;
    if (typeof merged.length_hint_template !== 'string' || !merged.length_hint_template.trim()) {
        merged.length_hint_template = DEFAULT_EXECUTION_CONFIG.length_hint_template;
    }
    // Custom hint is optional free-form text
    if (typeof merged.custom_hint !== 'string') {
        merged.custom_hint = '';
    }
    merged.custom_hint = merged.custom_hint.trim();
    return merged;
}

/**
 * Apply hints to prompt text based on execution config
 * Supports both length hints (with template variables) and custom hints
 * @param {string} promptText - Original prompt
 * @param {number} expectedTokens - Expected response tokens
 * @param {number} numPredict - Max tokens to predict
 * @param {Object} config - Execution config
 * @returns {string} - Prompt with hints appended
 */
function applyLengthHint(promptText, expectedTokens, numPredict, config) {
    if (!config) return promptText;

    const hints = [];

    // Apply length hint if enabled
    if (config.include_length_hint) {
        const template = (config.length_hint_template || DEFAULT_EXECUTION_CONFIG.length_hint_template).trim();
        if (template) {
            const tokensTarget = Math.round(Number(expectedTokens) || 0);
            const maxTokens = Math.round(Number(numPredict) || 0);
            const lengthHint = template
                .replace(/\{target\}/g, String(tokensTarget))
                .replace(/\{max\}/g, String(maxTokens))
                .replace(/\{min\}/g, String(config.response_min_tokens))
                .replace(/\{multiplier\}/g, String(config.response_tokens_multiplier));
            hints.push(lengthHint);
        }
    }

    // Apply custom hint if provided
    if (config.custom_hint && config.custom_hint.trim()) {
        hints.push(config.custom_hint.trim());
    }

    if (hints.length === 0) return promptText;

    return `${promptText}\n\n${hints.join('\n')}`;
}

module.exports = {
    DEFAULT_EXECUTION_CONFIG,
    normalizeExecutionConfig,
    applyLengthHint
};
