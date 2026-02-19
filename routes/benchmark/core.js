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
const { validateJudgeModel } = require('../../src/services/benchmark/judgeModelValidator');

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
            scoring_configs: ENHANCED_SCORING_CONFIGS
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
    const { host, models, levels, run_name, judge_config, execution_config, execution_mode, depth_config } = req.body;

    // Validation
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        return res.status(400).json({
            status: 'error',
            error: 'host, models (array), and levels (array) are required'
        });
    }

    try {
        // ENFORCE SINGLE BATCH: Check for existing active batches
        const activeBatches = await BenchmarkBatch.getActive();

        if (activeBatches.length > 0) {
            return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
        }

        // Validate judge model before starting batch
        const judgeHost = (judge_config && judge_config.host) || JUDGE_CONFIG.host;
        const judgeModel = (judge_config && judge_config.model) || JUDGE_CONFIG.model;
        if (judgeHost && judgeModel) {
            const validation = await validateJudgeModel(judgeHost, judgeModel);
            if (!validation.valid) {
                return res.status(422).json({
                    status: 'error',
                    error: `Judge model validation failed: ${validation.error}`,
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

module.exports = router;
