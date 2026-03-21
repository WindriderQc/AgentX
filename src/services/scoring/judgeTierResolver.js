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
 *   premium  → 70B+ frontier, optional luxury tier (never required)
 *
 * Local-first design: the maximum *required* tier is advanced (14B),
 * achievable on consumer GPUs. Premium exists for users who have the
 * hardware but no prompt level demands it.
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

const TIER_ORDER = ['basic', 'standard', 'advanced', 'premium'];

function tierRankOf(tier) {
    return TIER_RANK[tier] || 0;
}

const TIER_DISPLAY = {
    basic: {
        key: 'basic',
        label: 'Basic',
        shortLabel: 'BASIC',
        icon: 'check',
        modelRange: '2-3B',
        description: 'Small and fast judges for trivial prompts with clear right or wrong answers.',
        governanceNote: 'Good for screening and lightweight checks.'
    },
    standard: {
        key: 'standard',
        label: 'Standard',
        shortLabel: 'STD',
        icon: 'star',
        modelRange: '7-9B',
        description: 'Default governance tier for most evaluations where nuance starts to matter.',
        governanceNote: 'Recommended baseline for routine courthouse governance.'
    },
    advanced: {
        key: 'advanced',
        label: 'Advanced',
        shortLabel: 'ADV',
        icon: 'bolt',
        modelRange: '14-32B',
        description: 'Stronger judges for complex, multi-step, or subtle evaluation decisions.',
        governanceNote: 'Required when prompt complexity reaches the high end.'
    },
    premium: {
        key: 'premium',
        label: 'Premium',
        shortLabel: 'PRO',
        icon: 'gem',
        modelRange: '70B+',
        description: 'Optional flagship tier when hardware allows, but never required by policy.',
        governanceNote: 'Luxury tier only; courthouse policy does not require it.'
    }
};

// ── Prompt level → minimum judge tier mapping ────────────────────────
// Levels 1:    basic is fine (clear right/wrong, lightweight prompts)
// Levels 2-3:  standard required (core differentiation zone)
// Levels 4-5:  advanced required (expert/master evaluation)
//
// Local-first: max required tier is advanced (14B models). Premium is
// never enforced — keeps benchmarking accessible on consumer hardware.
const LEVEL_TIER_MAP = {
    1: 'basic',
    2: 'standard',
    3: 'standard',
    4: 'advanced',
    5: 'advanced'
};

const LEVEL_LABELS = {
    1: 'Basic',
    2: 'Intermediate',
    3: 'Advanced',
    4: 'Expert',
    5: 'Master'
};

const LEVEL_REASON_BY_TIER = {
    basic: 'Level 1 prompts have clear right-or-wrong evaluation and can stay on small judges.',
    standard: 'Levels 2-3 need more nuance and consistency than the basic tier provides.',
    advanced: 'Levels 4-5 need stronger reasoning for subtle quality differences.',
    premium: 'Premium is optional and never required by level policy.'
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
        description: 'Optional luxury tier — 70B+ if available, not required for any level'
    }
};

/**
 * Get the minimum required judge tier for a prompt level.
 * @param {number} level - Prompt difficulty level (1-5)
 * @returns {string} Tier name ('basic' | 'standard' | 'advanced' | 'premium')
 */
function getRequiredTier(level) {
    const clamped = Math.max(1, Math.min(5, Math.round(level || 3)));
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
 * Infer a judge tier from model name conventions when registry lacks metadata.
 * Used as a heuristic fallback during model sync.
 *
 * @param {string} modelName - e.g. 'qwen2.5:7b-instruct-q5_K_M'
 * @returns {string|null} Inferred tier or null
 */
function inferJudgeTier(modelName) {
    if (!modelName) return null;
    const name = modelName.toLowerCase();

    // Known model families where size isn't encoded in the name
    // DeepSeek Coder V2 Lite / V2 Lite Instruct = 16B = advanced
    if (/deepseek[^/]*v2[^/]*lite|deepseek-coder[^/]*lite/.test(name)) return 'advanced';

    // Size extraction — two passes:
    // 1. Separator-prefixed size: :70b, -14b, _7b  (highest confidence)
    // 2. Embedded size: qwen32b, gemma9b, phi3  (fallback, may false-match version nums)
    const sizeMatch =
        name.match(/[:\-_](\d+(?:\.\d+)?)b/) ||
        name.match(/(\d+(?:\.\d+)?)b(?:[:\-_]|$)/);

    if (!sizeMatch) return null;

    const sizeB = parseFloat(sizeMatch[1]);

    if (sizeB >= 65) return 'premium';
    if (sizeB >= 12) return 'advanced';
    if (sizeB >= 5)  return 'standard';
    if (sizeB >= 1)  return 'basic';

    return null;
}

function resolveJudgeTierMetadata(capabilities = {}, modelName = '') {
    const inferredTier = inferJudgeTier(modelName);
    const curatedTier = capabilities.curatedJudgeTier || null;
    const legacyTier = capabilities.judgeTier || null;
    const calibratedTier = capabilities.calibratedJudgeTier || null;
    const recommendedTier = capabilities.recommendedJudgeTier || calibratedTier || null;
    const effectiveTier = curatedTier
        || (legacyTier ? ((tierRankOf(inferredTier) > tierRankOf(legacyTier)) ? inferredTier : legacyTier) : null)
        || recommendedTier
        || inferredTier
        || null;
    let source = null;
    if (curatedTier) {
        source = 'curated';
    } else if (legacyTier && tierRankOf(inferredTier) > tierRankOf(legacyTier)) {
        source = 'inferred';
    } else if (legacyTier) {
        source = 'legacy';
    } else if (capabilities.recommendedJudgeTier) {
        source = 'recommended';
    } else if (calibratedTier) {
        source = 'calibrated';
    } else if (inferredTier) {
        source = 'inferred';
    }

    return {
        effectiveTier,
        curatedTier,
        legacyTier,
        calibratedTier,
        recommendedTier,
        inferredTier,
        source
    };
}

function getTierDefinitions() {
    return TIER_ORDER.reduce((acc, tier) => {
        acc[tier] = {
            ...TIER_DISPLAY[tier],
            rank: TIER_RANK[tier]
        };
        return acc;
    }, {});
}

function getLevelRequirements() {
    return Object.entries(LEVEL_TIER_MAP).map(([level, tier]) => {
        const requiredRank = TIER_RANK[tier] || 0;
        return {
            level: Number(level),
            label: LEVEL_LABELS[level] || `Level ${level}`,
            requiredTier: tier,
            reason: LEVEL_REASON_BY_TIER[tier] || null,
            qualifyingTiers: TIER_ORDER.filter((candidate) => (TIER_RANK[candidate] || 0) >= requiredRank)
        };
    });
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
    TIER_ORDER,
    TIER_DISPLAY,
    LEVEL_TIER_MAP,
    LEVEL_LABELS,
    JUDGE_PRESETS,
    getRequiredTier,
    tierMeetsRequirement,
    inferJudgeTier,
    resolveJudgeTierMetadata,
    getTierDefinitions,
    getLevelRequirements,
    getJudgePreset
};
