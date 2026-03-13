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

function normalizeJudgeConfigContract(config = {}) {
    const normalized = { ...config };

    if (normalized.mode === 'pinned' || normalized.mode === 'auto') {
        return normalized;
    }

    if (normalized.pinnedModel === undefined && normalized.model !== undefined) {
        normalized.pinnedModel = normalized.model;
    }
    if (normalized.pinnedHost === undefined && normalized.host !== undefined) {
        normalized.pinnedHost = normalized.host;
    }
    if (!normalized.resolutionPolicy) {
        normalized.resolutionPolicy = 'smallest-qualifying';
    }
    if (normalized.allowSameHost === undefined && normalized.judge_same_host !== undefined) {
        normalized.allowSameHost = !!normalized.judge_same_host;
    }

    if (normalized.judge_tier_auto_upgrade === true) {
        normalized.mode = 'auto';
    } else if (normalized.pinnedModel || normalized.model) {
        normalized.mode = 'pinned';
    } else {
        normalized.mode = 'auto';
    }

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
            const tierMeta = judgeTierResolver.resolveJudgeTierMetadata(
                model.capabilities || {},
                model.modelName
            );
            return {
                modelName: model.modelName,
                host: model.host || null,
                capabilities: {
                    judgeTier: tierMeta.effectiveTier,
                    curatedJudgeTier: tierMeta.curatedTier,
                    calibratedJudgeTier: tierMeta.calibratedTier,
                    recommendedJudgeTier: tierMeta.recommendedTier,
                    inferredJudgeTier: tierMeta.inferredTier,
                    judgeTierSource: tierMeta.source,
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
    const normalizedConfig = normalizeJudgeConfigContract(rawJudgeConfig || {});
    const promptLevel = Number(prompt?.level ?? prompt?.prompt_level ?? 5);
    const requiredTier = normalizedConfig?.preferred_tier
        || prompt?.required_judge_tier
        || judgeTierResolver.getRequiredTier(promptLevel);
    const mode = normalizedConfig?.mode || 'auto';

    if (mode === 'pinned') {
        if (normalizedConfig.pinnedModel) {
            mergedJudgeConfig.model = normalizedConfig.pinnedModel;
        }
        if (normalizedConfig.pinnedHost) {
            mergedJudgeConfig.host = normalizedConfig.pinnedHost;
        }
    }

    const defaultMeta = {
        tier: judgeTierResolver.inferJudgeTier(mergedJudgeConfig.model) || null,
        tier_downgraded: false,
        required_tier: requiredTier,
        mode
    };

    if (mode !== 'auto') {
        return { mergedJudgeConfig, judgeTierMeta: defaultMeta };
    }

    const candidates = await getJudgeCandidatesCached();
    if (!candidates.length) {
        return { mergedJudgeConfig, judgeTierMeta: defaultMeta };
    }

    const resolution = judgeTierResolver.resolveJudgeModel(candidates, {
        promptLevel,
        preferredTier: requiredTier,
        preferredHost: normalizedConfig.preferredHost || mergedJudgeConfig.host
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
            required_tier: resolution?.required_tier || requiredTier,
            mode
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
    normalizeJudgeConfigContract,
    clearJudgeCandidateCache
};
