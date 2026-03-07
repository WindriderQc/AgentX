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

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');

const MIN_PROMPTS_PER_CATEGORY = 3;
const WARN_PROMPTS_PER_CATEGORY = 5;
const HOST_CHECK_TIMEOUT_MS = 10000;

/**
 * Check if an Ollama host is responsive and a model is available.
 * @param {string} hostUrl - Ollama host URL
 * @param {string} model - Model to check (optional, just pings /api/tags if null)
 * @returns {Object} { ok, latency_ms, error, models_loaded }
 */
async function checkHostModel(hostUrl, model = null) {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HOST_CHECK_TIMEOUT_MS);

    try {
        const response = await fetch(`${hostUrl}/api/tags`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return { ok: false, latency_ms: Date.now() - start, error: `HTTP ${response.status}` };
        }

        const data = await response.json();
        const availableModels = (data.models || []).map(m => m.name || m.model);
        const latency = Date.now() - start;

        if (model) {
            const found = availableModels.some(m =>
                m === model || m.startsWith(model + ':') || model.startsWith(m)
            );
            if (!found) {
                return {
                    ok: false,
                    latency_ms: latency,
                    error: `Model '${model}' not found on host`,
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

    for (const [cat, weight] of Object.entries(GENERALIST_CATEGORY_WEIGHTS)) {
        const count = countsByCategory[cat] || 0;
        categories[cat] = { count, weight };

        if (count < MIN_PROMPTS_PER_CATEGORY) {
            blockers.push(`${cat}: ${count} prompts (minimum ${MIN_PROMPTS_PER_CATEGORY})`);
        } else if (count < WARN_PROMPTS_PER_CATEGORY) {
            warnings.push(`${cat}: ${count} prompts (recommended ${WARN_PROMPTS_PER_CATEGORY}+)`);
        }
    }

    return {
        ok: blockers.length === 0,
        totalPrompts: prompts.reduce((sum, p) => sum + p.count, 0),
        categories,
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

    const checks = {
        hosts: [],
        judge: null,
        prompts: null,
        batches: null
    };

    // Run all checks in parallel
    const hostChecks = targets.map(async (t) => {
        const result = await checkHostModel(t.host, t.model);
        return { ...t, ...result };
    });

    const judgeCheck = judgeConfig.host
        ? checkHostModel(judgeConfig.host, judgeConfig.model)
        : Promise.resolve(null);

    const [hostResults, judgeResult, promptResult, batchResult] = await Promise.all([
        Promise.all(hostChecks),
        judgeCheck,
        checkPromptCoverage(levels),
        checkOrphanedBatches()
    ]);

    checks.hosts = hostResults;
    checks.judge = judgeResult;
    checks.prompts = promptResult;
    checks.batches = batchResult;

    const allHostsOk = checks.hosts.every(h => h.ok);
    const judgeOk = !judgeConfig.host || (checks.judge && checks.judge.ok);
    const promptsOk = checks.prompts.ok;
    const batchesOk = checks.batches.ok;

    const ready = allHostsOk && judgeOk && promptsOk && batchesOk;

    const issues = [];
    if (!allHostsOk) {
        const failed = checks.hosts.filter(h => !h.ok);
        issues.push(`${failed.length} host(s) unreachable or missing models`);
    }
    if (!judgeOk) issues.push('Judge model not available');
    if (!promptsOk) issues.push(`${checks.prompts.blockers.length} category(s) below minimum prompt count`);
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
    checkOrphanedBatches,
    runPreflight
};
