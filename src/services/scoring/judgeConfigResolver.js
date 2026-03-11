'use strict';
/**
 * Judge Config Resolver
 *
 * Extracted from qualityScorer.js — judge model selection helpers and cache.
 * Keeps qualityScorer.js within the 600-line service limit.
 *
 * Exports:
 *   hasExplicitJudgeConfigValue  — checks config key presence
 *   getJudgeCandidatesCached     — TTL-cached ModelRegistry lookup
 *   resolveJudgeConfigForPrompt  — resolves judge model/host for a prompt
 *   clearJudgeCandidateCache     — test helper
 *
 * Consumed by: src/services/qualityScorer.js
 */

const logger = require('../../../config/logger');
const ModelRegistry = require('../../../models/ModelRegistry');
const judgeTierResolver = require('./judgeTierResolver');

const JUDGE_CANDIDATE_CACHE_TTL_MS = 30000;
let judgeCandidateCache = {
    ts: 0,
    candidates: []
};

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
 * Return judge-capable models from the ModelRegistry with a 30-second TTL cache.
 *
 * @returns {Promise<Array<{modelName, host, capabilities}>>}
 */
async function getJudgeCandidatesCached() {
    const now = Date.now();
    if (now - judgeCandidateCache.ts <= JUDGE_CANDIDATE_CACHE_TTL_MS && judgeCandidateCache.candidates.length > 0) {
        return judgeCandidateCache.candidates;
    }

    try {
        const models = await ModelRegistry.find({ categories: 'judge' })
            .select('modelName host capabilities')
            .lean();

        const candidates = (models || []).map((model) => {
            const inferredTier = judgeTierResolver.inferJudgeTier(model.modelName);
            return {
                modelName: model.modelName,
                host: model.host || null,
                capabilities: {
                    judgeTier: model.capabilities?.judgeTier || inferredTier || null,
                    judgeReliability: model.capabilities?.judgeReliability,
                    avgJudgeLatencyMs: model.capabilities?.avgJudgeLatencyMs
                }
            };
        });

        judgeCandidateCache = {
            ts: now,
            candidates
        };

        return candidates;
    } catch (err) {
        logger.debug('Failed to load judge candidates from model registry', { error: err.message });
        return [];
    }
}

/**
 * Resolve the effective judge model and host for a given prompt.
 *
 * When auto-upgrade is disabled (default) or an explicit model is set,
 * returns the merged config unchanged. Otherwise performs a tier-aware
 * model lookup from the registry.
 *
 * @param {Object} prompt
 * @param {Object} mergedJudgeConfig  - pre-merged { ...JUDGE_CONFIG, ...judgeConfig }
 * @param {Object} rawJudgeConfig     - raw caller-supplied judgeConfig
 * @returns {Promise<{ mergedJudgeConfig, judgeTierMeta }>}
 */
async function resolveJudgeConfigForPrompt(prompt, mergedJudgeConfig, rawJudgeConfig) {
    const promptLevel = Number(prompt?.level ?? prompt?.prompt_level ?? 5);
    const requiredTier = rawJudgeConfig?.preferred_tier
        || prompt?.required_judge_tier
        || judgeTierResolver.getRequiredTier(promptLevel);

    const explicitModel = hasExplicitJudgeConfigValue(rawJudgeConfig, 'model');
    // Auto-upgrade is opt-in (off by default) — respects explicit UI model selection
    const autoUpgradeEnabled = rawJudgeConfig?.judge_tier_auto_upgrade === true;

    const defaultMeta = {
        tier: judgeTierResolver.inferJudgeTier(mergedJudgeConfig.model) || null,
        tier_downgraded: false,
        required_tier: requiredTier
    };

    // Skip tier resolution when: explicit model is set OR auto-upgrade is disabled (default)
    if (explicitModel || !autoUpgradeEnabled) {
        return { mergedJudgeConfig, judgeTierMeta: defaultMeta };
    }

    const candidates = await getJudgeCandidatesCached();
    if (!candidates.length) {
        return { mergedJudgeConfig, judgeTierMeta: defaultMeta };
    }

    const resolution = judgeTierResolver.resolveJudgeModel(candidates, {
        promptLevel,
        preferredTier: requiredTier,
        preferredHost: mergedJudgeConfig.host
    });

    if (resolution?.model) {
        mergedJudgeConfig.model = resolution.model;
    }
    if (resolution?.host) {
        mergedJudgeConfig.host = resolution.host;
    }

    return {
        mergedJudgeConfig,
        judgeTierMeta: {
            tier: resolution?.tier || defaultMeta.tier,
            tier_downgraded: !!resolution?.tier_downgraded,
            required_tier: resolution?.required_tier || requiredTier
        }
    };
}

/**
 * Reset the candidate cache — for use in tests only.
 */
function clearJudgeCandidateCache() {
    judgeCandidateCache = { ts: 0, candidates: [] };
}

module.exports = {
    hasExplicitJudgeConfigValue,
    getJudgeCandidatesCached,
    resolveJudgeConfigForPrompt,
    clearJudgeCandidateCache
};
