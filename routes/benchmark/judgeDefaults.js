/**
 * Benchmark Routes - Judge Defaults & Roster
 *
 * Per-host default judge model configuration and judge roster with full stats.
 *
 * GET   /api/benchmark/judge-defaults              — get all per-host defaults
 * PUT   /api/benchmark/judge-defaults              — set default judge for a host
 * GET   /api/benchmark/judge-roster                — all judges from registry with stats + per-host availability
 * PATCH /api/benchmark/judge-roster/:modelName/tier — update judgeTier for a registry model
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger');
const ModelRegistry = require('../../models/ModelRegistry');
const BenchmarkResult = require('../../models/BenchmarkResult');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { benchmarkFetch: fetch } = require('../../src/services/benchmark/http');
const judgeTierResolver = require('../../src/services/scoring/judgeTierResolver');

const VALID_TIERS = ['basic', 'standard', 'advanced', 'premium'];

// ---------------------------------------------------------------------------
// Persistence — simple JSON file so defaults survive restarts without a new
// collection. Stored alongside other config files.
// ---------------------------------------------------------------------------

const DEFAULTS_PATH = path.join(process.cwd(), 'config', 'judge-host-defaults.json');

function readDefaults() {
    try {
        if (!fs.existsSync(DEFAULTS_PATH)) return {};
        const raw = fs.readFileSync(DEFAULTS_PATH, 'utf8');
        return JSON.parse(raw) || {};
    } catch {
        return {};
    }
}

function writeDefaults(data) {
    fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Judge registry helpers
// ---------------------------------------------------------------------------

const TIER_RANK = { basic: 1, standard: 2, advanced: 3, premium: 4 };

function normalizeTier(tier) {
    return TIER_RANK[tier] ? tier : null;
}

/**
 * Fetch model list from an Ollama host. Returns [] on failure.
 */
async function fetchHostModels(hostUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${hostUrl}/api/tags`, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.models || []).map(m => {
            const name = String(m.name || m.model || '').replace(/:latest$/i, '');
            return { name, size: m.size || 0, details: m.details || {} };
        });
    } catch {
        clearTimeout(timeoutId);
        return [];
    }
}

/**
 * Load all registry entries that have judge capability (judgeTier set).
 * Also includes models with no registry entry — detected as judge candidates
 * by name heuristics.
 */
async function getJudgeRegistryEntries() {
    const entries = await ModelRegistry.find({
        $or: [
            { 'capabilities.judgeTier': { $exists: true, $ne: null } },
            { 'categories': 'judge' }
        ]
    })
        .select('modelName host categories capabilities tags source')
        .lean();
    return entries;
}

// ---------------------------------------------------------------------------
// GET /api/benchmark/judge-defaults
// ---------------------------------------------------------------------------

router.get('/judge-defaults', (req, res) => {
    try {
        const defaults = readDefaults();
        const hosts = getConfiguredHosts();
        const hostDefaults = hosts.map(h => ({
            hostUrl: h.url,
            hostName: h.name,
            defaultJudgeModel: defaults[h.url] || null
        }));
        res.json({ status: 'success', data: { hosts: hostDefaults, raw: defaults } });
    } catch (err) {
        logger.error('Failed to read judge defaults', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/benchmark/judge-defaults
// Body: { hostUrl: string, judgeModel: string|null }
// ---------------------------------------------------------------------------

router.put('/judge-defaults', (req, res) => {
    try {
        const { hostUrl, judgeModel } = req.body;
        if (!hostUrl || typeof hostUrl !== 'string') {
            return res.status(400).json({ status: 'error', error: 'hostUrl is required' });
        }
        const defaults = readDefaults();
        if (judgeModel) {
            defaults[hostUrl.trim()] = judgeModel.trim();
        } else {
            delete defaults[hostUrl.trim()];
        }
        writeDefaults(defaults);
        logger.info('Judge default updated', { hostUrl, judgeModel });
        res.json({ status: 'success', data: { hostUrl, judgeModel: judgeModel || null } });
    } catch (err) {
        logger.error('Failed to write judge defaults', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/benchmark/judge-roster
// Returns all known judge models with registry metadata + per-host availability
// ---------------------------------------------------------------------------

router.get('/judge-roster', async (req, res) => {
    try {
        const [registryEntries, hosts] = await Promise.all([
            getJudgeRegistryEntries(),
            Promise.resolve(getConfiguredHosts())
        ]);

        const defaults = readDefaults();

        // Fetch live model lists from all hosts in parallel
        const hostModelMaps = await Promise.all(
            hosts.map(async h => {
                const models = await fetchHostModels(h.url);
                return { host: h, models };
            })
        );

        // Build lookup: normalizedModelName → host URLs where it's available
        const modelHostMap = new Map(); // modelName → [{url, name, size}]
        for (const { host, models } of hostModelMaps) {
            for (const m of models) {
                if (!modelHostMap.has(m.name)) modelHostMap.set(m.name, []);
                modelHostMap.get(m.name).push({ url: host.url, name: host.name, size: m.size });
            }
        }

        // Live eval counts from actual benchmark results (registry cache may be stale)
        const evalAgg = await BenchmarkResult.aggregate([
            { $match: { judge_model: { $exists: true, $ne: null } } },
            { $group: { _id: '$judge_model', count: { $sum: 1 } } }
        ]);
        const liveEvalMap = new Map(evalAgg.map(e => [
            String(e._id || '').replace(/:latest$/i, '').trim(),
            e.count
        ]));

        // Enrich registry entries
        const judges = registryEntries.map(entry => {
            const modelName = String(entry.modelName || '').replace(/:latest$/i, '');
            const caps = entry.capabilities || {};
            const tierMeta = judgeTierResolver.resolveJudgeTierMetadata(caps, modelName);
            const tier = tierMeta.effectiveTier;
            const reliability = typeof caps.judgeReliability === 'number' ? caps.judgeReliability : null;
            const avgLatencyMs = typeof caps.avgJudgeLatencyMs === 'number' ? caps.avgJudgeLatencyMs : null;
            const evalCount = liveEvalMap.get(modelName) || (typeof caps.judgeEvalCount === 'number' ? caps.judgeEvalCount : 0);
            const calibratedAt = caps.calibratedAt || null;
            const availableOn = modelHostMap.get(modelName) || [];
            const tierRank = TIER_RANK[tier] || 0;

            return {
                modelName,
                tier,
                tierMeta,
                inferredTier: tierMeta.inferredTier || null,
                hasConflict: !!(tierMeta.source !== 'inferred' && tierMeta.inferredTier && tierMeta.effectiveTier && tierMeta.inferredTier !== tierMeta.effectiveTier),
                tierRank,
                reliability,
                avgLatencyMs,
                evalCount,
                calibratedAt,
                categories: entry.categories || [],
                tags: entry.tags || [],
                availableOn,    // [{url, name, size}]
                source: entry.source || 'registry'
            };
        });

        // Also discover un-registered models on hosts whose names hint judge capability
        const judgeHeuristic = /qwen|mistral|llama.*instruct|gemma|command.*r|deepseek/i;
        const registeredNames = new Set(judges.map(j => j.modelName));
        const unregistered = [];
        for (const [modelName, hostList] of modelHostMap.entries()) {
            if (!registeredNames.has(modelName) && judgeHeuristic.test(modelName)) {
                const inferredTier = judgeTierResolver.inferJudgeTier(modelName);
                unregistered.push({
                    modelName,
                    tier: inferredTier,
                    tierMeta: {
                        effectiveTier: inferredTier,
                        curatedTier: null,
                        calibratedTier: null,
                        recommendedTier: null,
                        inferredTier,
                        source: inferredTier ? 'inferred' : null
                    },
                    tierRank: TIER_RANK[inferredTier] || 0,
                    reliability: null,
                    avgLatencyMs: null,
                    evalCount: 0,
                    calibratedAt: null,
                    categories: [],
                    tags: [],
                    availableOn: hostList,
                    source: 'discovered'
                });
            }
        }

        // Attach live eval counts to discovered models too
        for (const j of unregistered) {
            j.evalCount = liveEvalMap.get(j.modelName) || 0;
        }

        const allJudges = [...judges, ...unregistered]
            .sort((a, b) => b.tierRank - a.tierRank || (b.reliability || 0) - (a.reliability || 0));

        // Build per-host judge panels
        const hostPanels = hosts.map(h => {
            const available = allJudges.filter(j => j.availableOn.some(a => a.url === h.url));
            return {
                hostUrl: h.url,
                hostName: h.name,
                defaultJudgeModel: defaults[h.url] || null,
                judges: available
            };
        });

        res.json({
            status: 'success',
            data: {
                judges: allJudges,
                hostPanels,
                judgeTiers: judgeTierResolver.getTierDefinitions(),
                levelRequirements: judgeTierResolver.getLevelRequirements(),
                tierMap: judgeTierResolver.LEVEL_TIER_MAP,
                tierRank: TIER_RANK,
                defaults
            }
        });
    } catch (err) {
        logger.error('Failed to build judge roster', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/benchmark/judge-roster/:modelName/tier
// Update the judgeTier for a registry model without touching other capabilities.
// Uses dot-notation $set so existing capability fields are preserved.
// ---------------------------------------------------------------------------

router.patch('/judge-roster/:modelName/tier', async (req, res) => {
    try {
        const modelName = decodeURIComponent(req.params.modelName);
        const { tier } = req.body;

        if (!VALID_TIERS.includes(tier)) {
            return res.status(400).json({
                status: 'error',
                error: `Invalid tier '${tier}'. Must be one of: ${VALID_TIERS.join(', ')}`
            });
        }

        const model = await ModelRegistry.findOneAndUpdate(
            { modelName },
            {
                $set: {
                    'capabilities.curatedJudgeTier': tier,
                    'capabilities.judgeTier': tier,
                    lastUpdated: new Date()
                }
            },
            { new: true }
        );

        if (!model) {
            return res.status(404).json({
                status: 'error',
                error: `Model '${modelName}' not in registry. Add it via Model Registry first.`
            });
        }

        logger.info('Judge tier updated via courthouse roster', { modelName, tier });
        res.json({
            status: 'success',
            data: {
                modelName,
                tier,
                tierMeta: judgeTierResolver.resolveJudgeTierMetadata(model.capabilities || {}, modelName)
            }
        });
    } catch (err) {
        logger.error('Failed to update judge tier', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
