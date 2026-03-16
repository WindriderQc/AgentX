'use strict';
/**
 * Judge Config Resolver
 *
 * Extracted from qualityScorer.js — pinned judge config normalization
 * and prompt-level judge metadata. Keeps qualityScorer.js within the
 * 600-line service limit.
 *
 * Exports:
 *   hasExplicitJudgeConfigValue  — checks config key presence
 *   resolveJudgeConfigForPrompt  — resolves judge model/host for a prompt
 *
 * Consumed by: src/services/qualityScorer.js
 */

const judgeTierResolver = require('./judgeTierResolver');

function normalizeJudgeConfigContract(config = {}) {
    const normalized = { ...config };

    delete normalized.judge_same_host;
    delete normalized.judge_tier_auto_upgrade;

    normalized.mode = 'pinned';

    return normalized;
}

/**
 * Returns true when a config object has a non-empty value for the given key.
 *
 * @param {Object|null} config
 * @param {string} key
 * @returns {boolean}
 */
function hasExplicitJudgeConfigValue(config, key) {
    return Object.prototype.hasOwnProperty.call(config || {}, key)
        && config[key] !== undefined
        && config[key] !== null
        && config[key] !== '';
}

/**
 * Resolve the effective pinned judge model and host for a given prompt.
 *
 * The benchmark product now uses pinned judge selection only. This helper
 * merges explicit host/model overrides and returns tier metadata for UI and
 * preflight reporting.
 *
 * @param {Object} prompt
 * @param {Object} mergedJudgeConfig  - pre-merged { ...JUDGE_CONFIG, ...judgeConfig }
 * @param {Object} rawJudgeConfig     - raw caller-supplied judgeConfig
 * @returns {Promise<{ mergedJudgeConfig, judgeTierMeta }>}
 */
async function resolveJudgeConfigForPrompt(prompt, mergedJudgeConfig, rawJudgeConfig) {
    const normalizedConfig = normalizeJudgeConfigContract(rawJudgeConfig || {});
    const promptLevel = Number(prompt?.level ?? prompt?.prompt_level ?? 5);
    const requiredTier = normalizedConfig?.preferred_tier
        || prompt?.required_judge_tier
        || judgeTierResolver.getRequiredTier(promptLevel);

    if (normalizedConfig.model) {
        mergedJudgeConfig.model = normalizedConfig.model;
    }
    if (normalizedConfig.host) {
        mergedJudgeConfig.host = normalizedConfig.host;
    }

    return {
        mergedJudgeConfig,
        judgeTierMeta: {
            tier: judgeTierResolver.inferJudgeTier(mergedJudgeConfig.model) || null,
            tier_downgraded: false,
            required_tier: requiredTier,
            mode: 'pinned'
        }
    };
}

module.exports = {
    hasExplicitJudgeConfigValue,
    resolveJudgeConfigForPrompt,
    normalizeJudgeConfigContract
};
