/**
 * Benchmark Pre-flight Validation
 * ================================
 *
 * Checks to run before starting a benchmark batch:
 * - Target models are loaded and responsive on their hosts
 * - Judge model passes basic connectivity check
 * - Prompt coverage meets minimums per category
 * - No orphaned running batches
 *
 * Used by: batch start API, CI automation
 */

const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const ModelRegistry = require('../../../models/ModelRegistry');
const { BENCHMARK_CATEGORIES, CATEGORY_MIN_JUDGE_TIER } = require('../../../config/categories');
const judgeTierResolver = require('../scoring/judgeTierResolver');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { benchmarkFetch: fetch } = require('./http');

const MIN_PROMPTS_PER_CATEGORY = 3;
const WARN_PROMPTS_PER_CATEGORY = 5;
const HOST_CHECK_TIMEOUT_MS = 10000;

function normalizeModelName(modelName) {
    return String(modelName || '').trim().replace(/:latest$/i, '');
}

function normalizeHostUrl(hostUrl) {
    const raw = String(hostUrl || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    return `http://${raw}`;
}

function compareTierRank(left, right) {
    return (judgeTierResolver.TIER_RANK[left] || 0) - (judgeTierResolver.TIER_RANK[right] || 0);
}

function getStrongestRequiredTier(levels, categories) {
    let strongest = 'basic';

    for (const level of levels || []) {
        const tier = judgeTierResolver.getRequiredTier(level);
        if (compareTierRank(tier, strongest) > 0) {
            strongest = tier;
        }
    }

    for (const category of categories || []) {
        const tier = CATEGORY_MIN_JUDGE_TIER[category];
        if (tier && compareTierRank(tier, strongest) > 0) {
            strongest = tier;
        }
    }

    return strongest;
}

/**
 * Check if an Ollama host is responsive and a model is available.
 * @param {string} hostUrl - Ollama host URL
 * @param {string} model - Model to check (optional, just pings /api/tags if null)
 * @returns {Object} { ok, latency_ms, error, models_loaded }
 */
async function checkHostModel(hostUrl, model = null) {
    const normalizedHost = normalizeHostUrl(hostUrl);
    if (!normalizedHost) {
        return { ok: false, latency_ms: 0, error: 'Host URL is required' };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HOST_CHECK_TIMEOUT_MS);

    try {
        const response = await fetch(`${normalizedHost}/api/tags`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return { ok: false, latency_ms: Date.now() - start, error: `HTTP ${response.status}` };
        }

        const data = await response.json();
        const availableModels = (data.models || []).map((m) => normalizeModelName(m.name || m.model));
        const latency = Date.now() - start;

        if (model) {
            const normalizedModel = normalizeModelName(model);
            const found = availableModels.includes(normalizedModel);
            if (!found) {
                return {
                    ok: false,
                    latency_ms: latency,
                    error: `Model '${normalizedModel}' not found on host`,
                    models_loaded: availableModels.slice(0, 10)
                };
            }
        }

        return { ok: true, latency_ms: latency, models_loaded: availableModels.slice(0, 10) };
    } catch (err) {
        clearTimeout(timeoutId);
        const msg = err.name === 'AbortError'
            ? `Host unreachable (timeout ${HOST_CHECK_TIMEOUT_MS}ms)`
            : err.message;
        return { ok: false, latency_ms: Date.now() - start, error: msg };
    }
}

/**
 * Check prompt coverage across categories and levels.
 * @param {number[]} levels - Which levels will be tested
 * @returns {Object} { ok, categories, warnings, blockers }
 */
async function checkPromptCoverage(levels = [1, 2, 3, 4, 5]) {
    const prompts = await BenchmarkPrompt.aggregate([
        { $match: { level: { $in: levels } } },
        { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);

    const countsByCategory = {};
    for (const p of prompts) {
        countsByCategory[p._id] = p.count;
    }

    const warnings = [];
    const blockers = [];
    const categories = {};

    for (const [cat, count] of Object.entries(countsByCategory)) {
        const categoryMeta = BENCHMARK_CATEGORIES[cat] || null;
        categories[cat] = {
            count,
            label: categoryMeta?.label || cat
        };

        if (count < MIN_PROMPTS_PER_CATEGORY) {
            warnings.push(`${cat}: ${count} prompt(s) at selected levels (recommended ${MIN_PROMPTS_PER_CATEGORY}+)`);
        } else if (count < WARN_PROMPTS_PER_CATEGORY) {
            warnings.push(`${cat}: ${count} prompt(s) at selected levels (recommended ${WARN_PROMPTS_PER_CATEGORY}+)`);
        }
    }

    if (prompts.length === 0) {
        blockers.push(`No benchmark prompts found for selected levels: ${levels.join(', ')}`);
    }

    return {
        ok: blockers.length === 0,
        totalPrompts: prompts.reduce((sum, p) => sum + p.count, 0),
        categories,
        warnings,
        blockers
    };
}

async function checkJudgeConfiguration(judgeConfig = {}, levels = [], promptCoverage = null) {
    const host = normalizeHostUrl(judgeConfig.host || JUDGE_CONFIG.host);
    const model = normalizeModelName(judgeConfig.model || JUDGE_CONFIG.model);

    if (!host || !model) {
        return {
            ok: false,
            host,
            model,
            warnings: [],
            blockers: ['Judge host/model is not configured'],
            required_tier: null,
            resolved_tier: null,
            reliability: null
        };
    }

    const promptCategories = promptCoverage
        ? Object.keys(promptCoverage.categories || {})
        : [];
    const requiredTier = getStrongestRequiredTier(levels, promptCategories);
    const warnings = [];
    const blockers = [];

    let registryEntry = null;
    try {
        registryEntry = await ModelRegistry.findOne({
            modelName: { $in: [model, `${model}:latest`] }
        }).select('modelName capabilities host').lean();
    } catch (err) {
        warnings.push(`Judge registry lookup failed: ${err.message}`);
    }

    const resolvedTier = registryEntry?.capabilities?.judgeTier
        || judgeTierResolver.inferJudgeTier(model)
        || null;
    const reliability = registryEntry?.capabilities?.judgeReliability ?? null;
    const avgJudgeLatencyMs = registryEntry?.capabilities?.avgJudgeLatencyMs ?? null;
    const meetsTier = resolvedTier
        ? judgeTierResolver.tierMeetsRequirement(resolvedTier, requiredTier)
        : null;

    if (resolvedTier && meetsTier === false) {
        blockers.push(`Judge tier '${resolvedTier}' is below required tier '${requiredTier}' for selected prompts`);
    } else if (!resolvedTier) {
        warnings.push('Judge tier metadata unavailable; exactitude risk cannot be fully assessed');
    }

    if (typeof reliability === 'number') {
        if (reliability < 0.6) {
            blockers.push(`Judge reliability ${reliability.toFixed(2)} is below minimum 0.60`);
        } else if (reliability < 0.75) {
            warnings.push(`Judge reliability ${reliability.toFixed(2)} is below recommended 0.75`);
        }
    } else {
        warnings.push('Judge reliability metadata unavailable; calibration is recommended');
    }

    return {
        ok: blockers.length === 0,
        host,
        model,
        required_tier: requiredTier,
        resolved_tier: resolvedTier,
        reliability,
        avgJudgeLatencyMs,
        warnings,
        blockers
    };
}

/**
 * Check for orphaned running batches.
 * @returns {Object} { ok, orphanedBatches }
 */
async function checkOrphanedBatches() {
    const running = await BenchmarkBatch.find({
        status: { $in: ['running', 'judging'] }
    }).select('_id status started_at last_activity_at').lean();

    const now = Date.now();
    const orphaned = running.filter(b => {
        const lastActivity = b.last_activity_at
            ? new Date(b.last_activity_at).getTime()
            : b.started_at ? new Date(b.started_at).getTime() : now;
        return (now - lastActivity) > 300000; // 5 minutes inactive
    });

    return {
        ok: orphaned.length === 0,
        activeBatches: running.length,
        orphanedBatches: orphaned.map(b => ({
            id: b._id,
            status: b.status,
            started_at: b.started_at
        }))
    };
}

/**
 * Run all pre-flight checks.
 * @param {Object} options
 * @param {Array<{host, model}>} options.targets - Models to check
 * @param {Object} options.judgeConfig - Judge configuration (host, model)
 * @param {number[]} options.levels - Prompt levels to test
 * @returns {Object} Full pre-flight report
 */
async function runPreflight(options = {}) {
    const { targets = [], judgeConfig = {}, levels = [1, 2, 3, 4, 5] } = options;
    const uniqueTargets = [...new Map(
        (targets || [])
            .map((target) => ({
                host: normalizeHostUrl(target?.host),
                model: normalizeModelName(target?.model)
            }))
            .filter((target) => target.host && target.model)
            .map((target) => [`${target.host}@@${target.model}`, target])
    ).values()];

    const checks = {
        hosts: [],
        judge: null,
        prompts: null,
        batches: null
    };

    // Run all checks in parallel
    const hostChecks = uniqueTargets.map(async (t) => {
        const result = await checkHostModel(t.host, t.model);
        return { ...t, ...result };
    });

    const [hostResults, promptResult, batchResult] = await Promise.all([
        Promise.all(hostChecks),
        checkPromptCoverage(levels),
        checkOrphanedBatches()
    ]);
    const judgeResult = await checkJudgeConfiguration(judgeConfig, levels, promptResult);

    checks.hosts = hostResults;
    checks.judge = judgeResult;
    checks.prompts = promptResult;
    checks.batches = batchResult;

    const allHostsOk = checks.hosts.every(h => h.ok);
    const judgeOk = checks.judge && checks.judge.ok;
    const promptsOk = checks.prompts.ok;
    const batchesOk = checks.batches.ok;

    const ready = allHostsOk && judgeOk && promptsOk && batchesOk;

    const issues = [];
    if (!allHostsOk) {
        const failed = checks.hosts.filter(h => !h.ok);
        issues.push(`${failed.length} host(s) unreachable or missing models`);
    }
    if (!judgeOk) issues.push(...checks.judge.blockers);
    if (!promptsOk) issues.push(...checks.prompts.blockers);
    if (!batchesOk) issues.push(`${checks.batches.orphanedBatches.length} orphaned batch(es) detected`);

    logger.info('Pre-flight check completed', { ready, issues });

    return {
        ready,
        issues,
        checks
    };
}

module.exports = {
    MIN_PROMPTS_PER_CATEGORY,
    WARN_PROMPTS_PER_CATEGORY,
    checkHostModel,
    checkPromptCoverage,
    checkJudgeConfiguration,
    checkOrphanedBatches,
    runPreflight
};
