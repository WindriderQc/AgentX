/**
 * Benchmark Routes - Core
 * Config, prompts, single test, start batch, stop batch
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const { optionalWorkspaceContext } = require('../../src/middleware/workspace');
const benchmarkService = require('../../src/services/benchmark');
const { JUDGE_CONFIG, ENHANCED_SCORING_CONFIGS } = require('../../src/services/qualityScorer');
const { stopJudging } = require('../../src/services/benchmark/judging');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const ModelRegistry = require('../../models/ModelRegistry');
const { validateJudgeModel } = require('../../src/services/benchmark/judgeModelValidator');
const { HOSTS } = require('../../src/services/modelRouter');
const { callJudge } = require('../../src/services/scoring/judgeCall');
const judgeTierResolver = require('../../src/services/scoring/judgeTierResolver');
const { validateExecutionHost } = require('../../src/services/benchmark/executionHostValidator');
const { runPreflight } = require('../../src/services/benchmark/preflight');

function isDuplicateKeyError(err) {
    return !!(err && (err.code === 11000 || String(err.message || '').includes('E11000')));
}

function buildActiveBatchConflict(active) {
    const inactiveSeconds = active.last_activity_at
        ? Math.floor((Date.now() - new Date(active.last_activity_at).getTime()) / 1000)
        : 0;

    return {
        status: 'error',
        error: 'Another batch is already running',
        active_batch: {
            id: active._id,
            run_name: active.run_name,
            status: active.status,
            progress: active.progress,
            inactive_seconds: inactiveSeconds,
            is_stuck: inactiveSeconds > 300,
            started_at: active.started_at
        },
        message: inactiveSeconds > 300
            ? 'The active batch appears stuck. Use the "Recover" button to stop it before starting a new batch.'
            : `Batch "${active.run_name}" is currently running (${active.progress}% complete). Please wait for it to finish or stop it first.`
    };
}

/**
 * GET /api/benchmark/config
 * Get benchmark configuration including judge settings
 */
router.get('/config', (req, res) => {
    res.json({
        status: 'success',
        data: {
            judge_config: {
                ...JUDGE_CONFIG,
                concurrency: 2,
                judge_same_host: false
            },
            execution_config: benchmarkService.getExecutionConfigDefaults(),
            scoring_configs: ENHANCED_SCORING_CONFIGS,
            judge_presets: judgeTierResolver.JUDGE_PRESETS,
            judge_tier_map: judgeTierResolver.LEVEL_TIER_MAP
        }
    });
});

/**
 * GET /api/benchmark/prompts
 * Get all prompts grouped by level
 */
router.get('/prompts', async (req, res) => {
    try {
        const data = await benchmarkService.getPrompts();

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch prompts', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/test
 * Run a single benchmark test - workspace-aware
 */
router.post('/test', optionalWorkspaceContext, async (req, res) => {
    const { model, host, prompt } = req.body;

    // Validation
    if (!model || !host || !prompt) {
        return res.status(400).json({
            status: 'error',
            error: 'model, host, and prompt are required'
        });
    }

    try {
        const result = await benchmarkService.runTest({
            model,
            host,
            prompt,
            workspaceId: req.workspace ? req.workspace._id : null
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Benchmark test failed', { model, host, error: err.message });

        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * POST /api/benchmark/batch
 * Start a batch benchmark test with quality scoring - workspace-aware
 */
router.post('/batch', optionalWorkspaceContext, async (req, res) => {
    const { host, models, levels, run_name, judge_config, execution_config, execution_mode, depth_config, tags, description } = req.body;

    // Validation
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        return res.status(400).json({
            status: 'error',
            error: 'host, models (array), and levels (array) are required'
        });
    }

    // Verify execution host is an Ollama endpoint and requested models exist
    const hostCheck = await validateExecutionHost(host, models);
    if (!hostCheck.valid) {
        return res.status(422).json({
            status: 'error',
            error: hostCheck.error,
            ...(hostCheck.available_models && { available_models: hostCheck.available_models })
        });
    }

    try {
        // ENFORCE SINGLE BATCH: Check for existing active batches
        const activeBatches = await BenchmarkBatch.getActive();

        if (activeBatches.length > 0) {
            return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
        }

        // Validate judge model on the actual judge host (mirrors execution.js host resolution)
        const judgeSameHost = !!(judge_config && judge_config.judge_same_host);
        const judgeModel = (judge_config && judge_config.model) || JUDGE_CONFIG.model;
        let actualJudgeHost;
        if (judge_config && judge_config.host) {
            // Explicit judge host override from UI
            actualJudgeHost = judge_config.host;
        } else if (judgeSameHost) {
            actualJudgeHost = host;
        } else {
            actualJudgeHost = HOSTS.primary;
            if (host === HOSTS.primary) actualJudgeHost = HOSTS.secondary;
            else if (host === HOSTS.secondary) actualJudgeHost = HOSTS.primary;
        }
        if (actualJudgeHost && judgeModel) {
            const validation = await validateJudgeModel(actualJudgeHost, judgeModel);
            if (!validation.valid) {
                return res.status(422).json({
                    status: 'error',
                    error: `Judge model validation failed on ${actualJudgeHost}: ${validation.error}`,
                    available_models: validation.available_models || [],
                    latency_ms: validation.latency_ms
                });
            }
        }

        const data = await benchmarkService.startBatch({
            host,
            models,
            levels,
            run_name,
            judge_config,
            execution_config,
            execution_mode: execution_mode || 'latency',
            depth_config: depth_config || null,
            tags,
            description,
            workspaceId: req.workspace ? req.workspace._id : null
        });

        res.json({
            status: 'success',
            data: {
                ...data,
                message: 'Batch test started with quality scoring'
            }
        });
    } catch (err) {
        if (isDuplicateKeyError(err)) {
            // Atomic backstop for start-race collisions (two clients pass pre-check simultaneously).
            const activeBatches = await BenchmarkBatch.getActive();
            if (activeBatches.length > 0) {
                return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
            }
            return res.status(409).json({
                status: 'error',
                error: 'Another batch is already running'
            });
        }

        logger.error('Failed to start batch test', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/stop
 * Stop a running batch
 */
router.post('/batch/:id/stop', async (req, res) => {
    try {
        const { batch, alreadyStopped } = await benchmarkService.stopBatch(req.params.id);

        // Also stop any active judging
        stopJudging(req.params.id);

        res.json({
            status: 'success',
            message: alreadyStopped ? `Batch already ${batch.status}` : 'Batch stopped',
            data: {
                batch_id: batch._id,
                status: batch.status,
                already_stopped: alreadyStopped
            }
        });
    } catch (err) {
        logger.error('Failed to stop batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/validate-judge
 * Pre-flight check: validate judge model availability and output capability
 */
router.post('/validate-judge', async (req, res) => {
    const { host, model } = req.body;
    const judgeHost = host || JUDGE_CONFIG.host;
    const judgeModel = model || JUDGE_CONFIG.model;

    if (!judgeHost || !judgeModel) {
        return res.status(400).json({
            status: 'error',
            error: 'host and model are required'
        });
    }

    try {
        const validation = await validateJudgeModel(judgeHost, judgeModel);
        if (validation.valid) {
            res.json({
                status: 'success',
                data: {
                    valid: true,
                    model: judgeModel,
                    host: judgeHost,
                    available_models: validation.available_models,
                    latency_ms: validation.latency_ms
                }
            });
        } else {
            res.status(422).json({
                status: 'error',
                error: validation.error,
                available_models: validation.available_models || [],
                latency_ms: validation.latency_ms
            });
        }
    } catch (err) {
        logger.error('Judge validation failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/calibrate
 * Quick calibration of judge model JSON reliability, consistency, and latency.
 */
router.post('/judge/calibrate', async (req, res) => {
    const { host, model } = req.body || {};
    const judgeHost = host || JUDGE_CONFIG.host;
    const judgeModel = model || JUDGE_CONFIG.model;

    if (!judgeHost || !judgeModel) {
        return res.status(400).json({
            status: 'error',
            error: 'host and model are required'
        });
    }

    const baselineTier = judgeTierResolver.inferJudgeTier(judgeModel) || 'standard';

    const calibrationCases = [
        {
            id: 'json_basic',
            prompt: 'Respond ONLY as JSON: {"overall": 8, "explanation": "ok"}',
            validate: (scores) => typeof scores?.overall === 'number'
        },
        {
            id: 'json_multi_dim',
            prompt: 'Score this response. Return ONLY JSON with numeric keys: {"accuracy": 8, "completeness": 7, "overall": 7.5, "explanation": "brief"}',
            validate: (scores) => {
                const numericKeys = Object.keys(scores || {}).filter((key) => typeof scores[key] === 'number');
                return numericKeys.length >= 2 && typeof scores?.overall === 'number';
            }
        },
        {
            id: 'range_guard',
            prompt: 'Return ONLY JSON with overall score in 0-10: {"overall": 5, "explanation": "range test"}',
            validate: (scores) => typeof scores?.overall === 'number' && scores.overall >= 0 && scores.overall <= 10
        },
        {
            id: 'consistency_a',
            prompt: 'Evaluate this fixed response. Return ONLY JSON: {"overall": 6.5, "explanation": "consistency"}',
            validate: (scores) => typeof scores?.overall === 'number'
        },
        {
            id: 'consistency_b',
            prompt: 'Evaluate this fixed response. Return ONLY JSON: {"overall": 6.5, "explanation": "consistency"}',
            validate: (scores) => typeof scores?.overall === 'number'
        }
    ];

    try {
        const details = [];

        for (const testCase of calibrationCases) {
            const startedAt = Date.now();
            const judgeRes = await callJudge(testCase.prompt, {
                host: judgeHost,
                model: judgeModel,
                timeout: 20000,
                max_retries: 1,
                temperature: 0.1,
                num_predict: 120
            });
            const latencyMs = Date.now() - startedAt;

            const passed = !!(judgeRes.success && testCase.validate(judgeRes.scores));
            details.push({
                id: testCase.id,
                passed,
                latency_ms: latencyMs,
                overall: typeof judgeRes?.scores?.overall === 'number' ? judgeRes.scores.overall : null,
                error: judgeRes.success ? null : judgeRes.error
            });
        }

        const consistencyA = details.find((d) => d.id === 'consistency_a');
        const consistencyB = details.find((d) => d.id === 'consistency_b');
        if (consistencyA && consistencyB && consistencyA.overall !== null && consistencyB.overall !== null) {
            const drift = Math.abs(consistencyA.overall - consistencyB.overall);
            if (drift > 2.0) {
                consistencyA.passed = false;
                consistencyA.error = `consistency drift=${drift.toFixed(2)}`;
            }
        }

        const testsTotal = details.length;
        const testsPassed = details.filter((d) => d.passed).length;
        const reliability = testsTotal > 0 ? testsPassed / testsTotal : 0;
        const avgLatencyMs = Math.round(details.reduce((sum, d) => sum + d.latency_ms, 0) / Math.max(1, details.length));

        let calibratedTier = baselineTier;
        if (reliability < 0.70) {
            calibratedTier = 'basic';
        } else if (reliability < 0.85 && (baselineTier === 'premium' || baselineTier === 'advanced')) {
            calibratedTier = 'standard';
        }

        await ModelRegistry.updateOne(
            { modelName: judgeModel },
            {
                $set: {
                    'capabilities.judgeReliability': reliability,
                    'capabilities.avgJudgeLatencyMs': avgLatencyMs,
                    'capabilities.judgeTier': calibratedTier
                }
            }
        ).catch((err) => {
            logger.debug('Judge calibration metadata persist skipped', { model: judgeModel, error: err.message });
        });

        return res.json({
            status: 'success',
            data: {
                host: judgeHost,
                model: judgeModel,
                baseline_tier: baselineTier,
                tier: calibratedTier,
                reliability,
                avg_latency_ms: avgLatencyMs,
                tests_total: testsTotal,
                tests_passed: testsPassed,
                details
            }
        });
    } catch (err) {
        logger.error('Judge calibration failed', { error: err.message, host: judgeHost, model: judgeModel });
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/judge/calibrate-accuracy
 * Test judge accuracy against gold-standard scored responses.
 * Returns Pearson correlation, MAE, and per-tier breakdown.
 */
router.post('/judge/calibrate-accuracy', async (req, res) => {
    const { host, model } = req.body || {};
    const judgeHost = host || JUDGE_CONFIG.host;
    const judgeModel = model || JUDGE_CONFIG.model;

    if (!judgeHost || !judgeModel) {
        return res.status(400).json({
            status: 'error',
            error: 'host and model are required'
        });
    }

    try {
        const calibrationSet = require('../../data/judge-calibration-set.json');
        const { scoreResponse } = require('../../src/services/qualityScorer');
        const results = [];

        for (const item of calibrationSet) {
            const start = Date.now();
            try {
                const scores = await scoreResponse({
                    response: item.response,
                    prompt: {
                        prompt: item.prompt,
                        category: item.category,
                        expected_answer: item.expected_answer
                    },
                    judgeConfig: { host: judgeHost, model: judgeModel }
                });

                results.push({
                    id: item.id,
                    category: item.category,
                    tier: item.tier,
                    gold_score: item.gold_score,
                    judge_score: scores.quality_score,
                    diff: Math.round((scores.quality_score - item.gold_score) * 10) / 10,
                    abs_diff: Math.round(Math.abs(scores.quality_score - item.gold_score) * 10) / 10,
                    latency_ms: Date.now() - start,
                    success: true
                });
            } catch (err) {
                results.push({
                    id: item.id,
                    category: item.category,
                    tier: item.tier,
                    gold_score: item.gold_score,
                    judge_score: null,
                    diff: null,
                    abs_diff: null,
                    latency_ms: Date.now() - start,
                    success: false,
                    error: err.message
                });
            }
        }

        const successful = results.filter(r => r.success && r.judge_score !== null);
        const n = successful.length;

        // Mean Absolute Error
        const mae = n > 0
            ? Math.round((successful.reduce((s, r) => s + r.abs_diff, 0) / n) * 100) / 100
            : null;

        // Bias (positive = judge scores higher than gold)
        const bias = n > 0
            ? Math.round((successful.reduce((s, r) => s + r.diff, 0) / n) * 100) / 100
            : null;

        // Agreement rate (within +/- 1 point)
        const agreements = successful.filter(r => r.abs_diff <= 1).length;
        const agreementRate = n > 0 ? Math.round((agreements / n) * 100) : 0;

        // Pearson correlation
        let correlation = null;
        if (n >= 3) {
            const goldScores = successful.map(r => r.gold_score);
            const judgeScores = successful.map(r => r.judge_score);
            const meanGold = goldScores.reduce((a, b) => a + b, 0) / n;
            const meanJudge = judgeScores.reduce((a, b) => a + b, 0) / n;
            let num = 0, denGold = 0, denJudge = 0;
            for (let i = 0; i < n; i++) {
                const dg = goldScores[i] - meanGold;
                const dj = judgeScores[i] - meanJudge;
                num += dg * dj;
                denGold += dg * dg;
                denJudge += dj * dj;
            }
            const den = Math.sqrt(denGold * denJudge);
            correlation = den > 0 ? Math.round((num / den) * 1000) / 1000 : 0;
        }

        // Per-tier breakdown
        const byTier = {};
        for (const r of successful) {
            if (!byTier[r.tier]) byTier[r.tier] = { count: 0, totalError: 0, totalBias: 0 };
            byTier[r.tier].count++;
            byTier[r.tier].totalError += r.abs_diff;
            byTier[r.tier].totalBias += r.diff;
        }
        const tierBreakdown = {};
        for (const [tier, stats] of Object.entries(byTier)) {
            tierBreakdown[tier] = {
                count: stats.count,
                mae: Math.round((stats.totalError / stats.count) * 100) / 100,
                bias: Math.round((stats.totalBias / stats.count) * 100) / 100
            };
        }

        const valid = correlation !== null && correlation >= 0.8;

        return res.json({
            status: 'success',
            data: {
                host: judgeHost,
                model: judgeModel,
                valid,
                correlation,
                mae,
                bias,
                agreement_rate: agreementRate,
                total: calibrationSet.length,
                scored: n,
                failed: calibrationSet.length - n,
                tier_breakdown: tierBreakdown,
                results
            }
        });
    } catch (err) {
        logger.error('Judge accuracy calibration failed', { error: err.message, host: judgeHost, model: judgeModel });
        return res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/preflight
 * Run pre-flight validation checks before starting a batch.
 * Body: { targets: [{host, model}], judge_config: {host, model}, levels: [1,2,3,4,5] }
 */
router.post('/preflight', async (req, res) => {
    try {
        const { targets = [], judge_config = {}, levels } = req.body || {};
        const result = await runPreflight({
            targets,
            judgeConfig: judge_config,
            levels: Array.isArray(levels) ? levels : [1, 2, 3, 4, 5]
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Pre-flight check failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
