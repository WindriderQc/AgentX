/**
 * Benchmark Routes - Core
 * Config, prompts, single test and preflight. Batch launch, batch control and
 * judge checks live in sub-routers mounted here in their original order.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { JUDGE_CONFIG, ENHANCED_SCORING_CONFIGS } = require('../../src/services/qualityScorer');
const { runPreflight } = require('../../src/services/benchmark/preflight');
const { resolveReadyJudgeTarget } = require('../../src/services/benchmark/judgeReadiness');
const { RESPONSE_TOKEN_LIMIT, EXECUTION_TIMEOUT_LIMITS, EARLY_STOP_POLICY, validateExecutionPolicy } = require('../../src/services/benchmark/executionPolicy');
const {
    readJudgeDefaults,
    lookupHostJudgeDefault,
    resolveBatchJudgeTarget,
    judgeValidationAdmissionFailure
} = require('./coreShared');

/**
 * GET /api/benchmark/config
 * Get benchmark configuration including judge settings
 */
router.get('/config', async (req, res) => {
    const judgeDefaults = readJudgeDefaults();

    // Merge judge settings from config file (setup wizard) if available
    const { readConfigFile } = require('../../src/helpers/ollamaHostConfig');
    const fileConfig = readConfigFile();
    const baseJudge = { ...JUDGE_CONFIG, concurrency: 2 };
    if (fileConfig?.judge) {
        if (fileConfig.judge.model) baseJudge.model = fileConfig.judge.model;
        if (fileConfig.judge.host) baseJudge.host = fileConfig.judge.host;
    }

    res.json({
        status: 'success',
        data: {
            judge_config: baseJudge,
            execution_config: benchmarkService.getExecutionConfigDefaults(),
            execution_policy: { responseTokenLimit: RESPONSE_TOKEN_LIMIT,
                timeoutLimits: EXECUTION_TIMEOUT_LIMITS, earlyStop: EARLY_STOP_POLICY },
            scoring_configs: ENHANCED_SCORING_CONFIGS,
            judge_host_defaults: judgeDefaults
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
 * POST /api/benchmark/prompts/sync
 * Explicitly synchronize the product-owned prompt library.
 */
router.post('/prompts/sync', async (req, res) => {
    try {
        const total = await benchmarkService.seedPrompts();
        const data = await benchmarkService.getPrompts();
        res.json({
            status: 'success',
            data: {
                ...data,
                synchronized_total: total
            }
        });
    } catch (err) {
        logger.error('Failed to synchronize prompts', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/test
 * Run a single benchmark test
 */
router.post('/test', async (req, res) => {
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
            prompt
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

router.use(require('./coreBatchLaunch'));
router.use(require('./coreBatchControl'));
router.use(require('./coreJudge'));

/**
 * POST /api/benchmark/preflight
 * Run pre-flight validation checks before starting a batch.
 * Body: { targets: [{host, model}], judge_config: {host, model}, levels: [1,2,3,4,5] }
 */
router.post('/preflight', async (req, res) => {
    try {
        const { targets = [], judge_config = {}, levels, prompt_ids = null, execution_config = null } = req.body || {};
        validateExecutionPolicy(execution_config);
        const readiness = await resolveReadyJudgeTarget({
            host: judge_config.host,
            model: judge_config.model
        });
        if (!readiness.ready) {
            const issue = readiness.error || 'No selected, reachable judge is ready.';
            return res.json({
                status: 'success',
                data: {
                    ready: false,
                    issues: [`Judge: ${issue}`],
                    checks: {
                        judge: {
                            ok: false,
                            host: judge_config.host || null,
                            model: judge_config.model || null,
                            warnings: [],
                            blockers: [issue],
                            readiness: readiness.readiness
                        }
                    }
                }
            });
        }
        const result = await runPreflight({
            targets,
            judgeConfig: {
                ...judge_config,
                host: readiness.target.host,
                model: readiness.target.model
            },
            levels: Array.isArray(levels) ? levels : [1, 2, 3, 4, 5],
            prompt_ids,
            executionConfig: execution_config
        });

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Pre-flight check failed', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

module.exports = router;

// Exposed for unit tests — internal judge-target resolution helpers.
module.exports.resolveBatchJudgeTarget = resolveBatchJudgeTarget;
module.exports.lookupHostJudgeDefault = lookupHostJudgeDefault;
module.exports.judgeValidationAdmissionFailure = judgeValidationAdmissionFailure;
