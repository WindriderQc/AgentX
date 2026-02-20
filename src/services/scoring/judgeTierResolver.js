/**
 * Judge Tier Resolver
 *
 * Maps prompt difficulty levels to required judge tiers and resolves
 * the best available judge model for a given benchmark context.
 *
 * Tier hierarchy (ascending quality):
 *   basic    → ~2-3B models, fast but inconsistent (quick screening only)
 *   standard → 7-8B models, reliable for most evaluations (default)
 *   advanced → 14B+ or specialized reasoning, high consistency
 *   premium  → 70B+ frontier, highest quality, VRAM-heavy
 *
 * The resolver is designed to be host-aware: given a host's available
 * models + their registered tiers, it picks the best fit. If the
 * required tier isn't available, it falls back to the highest available
 * tier and flags the result as `tier_downgraded`.
 */

const logger = require('../../../config/logger');

// ── Tier ordering (numeric rank for comparison) ──────────────────────
const TIER_RANK = {
    basic: 1,
    standard: 2,
    advanced: 3,
    premium: 4
};

// ── Prompt level → minimum judge tier mapping ────────────────────────
// Levels 1-3:  basic is fine (trivial prompts, clear right/wrong)
// Levels 4-6:  standard required (key differentiation zone)
// Levels 7-8:  advanced preferred (nuanced evaluation)
// Levels 9-10: premium preferred (complex multi-constraint problems)
const LEVEL_TIER_MAP = {
    1: 'basic',
    2: 'basic',
    3: 'basic',
    4: 'standard',
    5: 'standard',
    6: 'standard',
    7: 'advanced',
    8: 'advanced',
    9: 'premium',
    10: 'premium'
};

// ── Default judge presets ────────────────────────────────────────────
const JUDGE_PRESETS = {
    fast: {
        minTier: 'basic',
        temperature: 0.1,
        num_ctx: 4096,
        timeout: 15000,
        num_predict: 400,
        description: 'Fast screening — small model, low context'
    },
    balanced: {
        minTier: 'standard',
        temperature: 0.1,
        num_ctx: 4096,
        timeout: 30000,
        num_predict: 800,
        description: 'Default for most benchmarks — 7B model'
    },
    precise: {
        minTier: 'advanced',
        temperature: 0.05,
        num_ctx: 8192,
        timeout: 60000,
        num_predict: 800,
        description: 'High consistency — 14B+ model, low temperature'
    },
    premium: {
        minTier: 'premium',
        temperature: 0.0,
        num_ctx: 8192,
        timeout: 120000,
        num_predict: 1000,
        description: 'Maximum quality — 70B+ model, zero temperature'
    }
};

/**
 * Get the minimum required judge tier for a prompt level.
 * @param {number} level - Prompt difficulty level (1-10)
 * @returns {string} Tier name ('basic' | 'standard' | 'advanced' | 'premium')
 */
function getRequiredTier(level) {
    const clamped = Math.max(1, Math.min(10, Math.round(level || 5)));
    return LEVEL_TIER_MAP[clamped] || 'standard';
}

/**
 * Check whether a judge tier meets or exceeds the required tier.
 * @param {string} availableTier - Tier of the judge model
 * @param {string} requiredTier  - Minimum tier needed
 * @returns {boolean}
 */
function tierMeetsRequirement(availableTier, requiredTier) {
    const available = TIER_RANK[availableTier] || 0;
    const required = TIER_RANK[requiredTier] || 0;
    return available >= required;
}

/**
 * Resolve the best judge model from a list of candidates.
 *
 * @param {Array<Object>} candidates - Models with judge capability:
 *   [{ modelName, capabilities: { judgeTier, judgeReliability, avgJudgeLatencyMs }, host }]
 * @param {Object} options
 * @param {number}  options.promptLevel    - Prompt difficulty (1-10)
 * @param {string}  [options.preferredTier] - Override: force this tier minimum
 * @param {string}  [options.preferredHost] - Prefer models on this host
 * @returns {Object} { model, host, tier, tier_downgraded, preset, warning }
 */
function resolveJudgeModel(candidates, options = {}) {
    const { promptLevel = 5, preferredTier, preferredHost } = options;

    if (!candidates || candidates.length === 0) {
        logger.warn('No judge candidates available');
        return {
            model: null,
            host: null,
            tier: null,
            tier_downgraded: false,
            warning: 'No judge models available in registry'
        };
    }

    const requiredTier = preferredTier || getRequiredTier(promptLevel);
    const requiredRank = TIER_RANK[requiredTier] || 2;

    // Score each candidate
    const scored = candidates
        .filter(c => c.capabilities && c.capabilities.judgeTier)
        .map(c => {
            const tier = c.capabilities.judgeTier;
            const rank = TIER_RANK[tier] || 0;
            const reliability = c.capabilities.judgeReliability || 0.5;
            const latency = c.capabilities.avgJudgeLatencyMs || 5000;
            const hostMatch = preferredHost && c.host === preferredHost ? 1 : 0;

            // Primary: meets tier requirement
            const meetsRequirement = rank >= requiredRank ? 1 : 0;

            // Composite selection score:
            //   tier match (40%) + reliability (30%) + speed (20%) + host preference (10%)
            const latencyScore = Math.max(0, 1 - (latency / 10000)); // 0-10s → 1-0
            const selectionScore =
                meetsRequirement * 0.40 +
                reliability * 0.30 +
                latencyScore * 0.20 +
                hostMatch * 0.10;

            return { ...c, tier, rank, meetsRequirement, selectionScore };
        })
        .sort((a, b) => b.selectionScore - a.selectionScore);

    if (scored.length === 0) {
        // Fallback: candidates exist but none have judgeTier set
        const fallback = candidates[0];
        logger.warn('No candidates have judgeTier set, using first available', {
            model: fallback.modelName
        });
        return {
            model: fallback.modelName,
            host: fallback.host || null,
            tier: 'unknown',
            tier_downgraded: true,
            warning: 'No judgeTier metadata — using unranked model'
        };
    }

    const best = scored[0];
    const downgraded = !best.meetsRequirement;

    if (downgraded) {
        logger.warn('Judge tier downgraded', {
            required: requiredTier,
            available: best.tier,
            model: best.modelName,
            promptLevel
        });
    } else {
        logger.debug('Judge model resolved', {
            model: best.modelName,
            tier: best.tier,
            required: requiredTier,
            promptLevel
        });
    }

    return {
        model: best.modelName,
        host: best.host || null,
        tier: best.tier,
        tier_downgraded: downgraded,
        required_tier: requiredTier,
        prompt_level: promptLevel,
        warning: downgraded
            ? `Required tier '${requiredTier}' not available — downgraded to '${best.tier}'`
            : null
    };
}

/**
 * Infer a judge tier from model name conventions when registry lacks metadata.
 * Used as a heuristic fallback during model sync.
 *
 * @param {string} modelName - e.g. 'qwen2.5:7b-instruct-q5_K_M'
 * @returns {string|null} Inferred tier or null
 */
function inferJudgeTier(modelName) {
    if (!modelName) return null;
    const name = modelName.toLowerCase();

    // Size extraction: look for patterns like :70b, :14b, :7b, :3b, :2b
    const sizeMatch = name.match(/[:\-](\d+(?:\.\d+)?)b/);
    if (!sizeMatch) return null;

    const sizeB = parseFloat(sizeMatch[1]);

    if (sizeB >= 65) return 'premium';
    if (sizeB >= 12) return 'advanced';
    if (sizeB >= 5)  return 'standard';
    if (sizeB >= 1)  return 'basic';

    return null;
}

/**
 * Get preset configuration by name.
 * @param {string} presetName - 'fast' | 'balanced' | 'precise' | 'premium'
 * @returns {Object|null}
 */
function getJudgePreset(presetName) {
    return JUDGE_PRESETS[presetName] || null;
}

module.exports = {
    TIER_RANK,
    LEVEL_TIER_MAP,
    JUDGE_PRESETS,
    getRequiredTier,
    tierMeetsRequirement,
    resolveJudgeModel,
    inferJudgeTier,
    getJudgePreset
};
