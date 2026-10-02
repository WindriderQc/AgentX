/**
 * Benchmark Routes - Core batch control
 * Stop, resume and rerun-invalid for an existing batch.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { stopJudging } = require('../../src/services/benchmark/judging');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const { runPreflight } = require('../../src/services/benchmark/preflight');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const buddySurface = require('../../src/services/benchmark/buddySurfaceEvents');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const { findActiveProfilingForHost } = require('../../src/services/profiler/activeProfileState');
const { buildOllamaTarget } = require('../../../shared/benchmarkTargetContract');
const { resolveHarnessTarget } = require('../../src/services/benchmark/harnessBrokerClient');
const {
    buildActiveBatchConflict,
    buildActiveProfilingConflict,
    releaseStoppedBatchClaims
} = require('./coreShared');

/**
 * POST /api/benchmark/batch/:id/stop
 * Stop a running batch
 */
router.post('/batch/:id/stop', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
        const { batch, alreadyStopped, managedLocally } = await benchmarkService.stopBatch(req.params.id);

        // Also stop any active judging
        stopJudging(req.params.id);
        // A live in-process orchestrator owns its claim/dedication teardown and
        // releases them only after every cancelled task has settled. Direct
        // release remains the recovery path for an orphaned/non-local batch.
        const claimReleaseHosts = managedLocally ? [] : releaseStoppedBatchClaims(batch);

        res.json({
            status: 'success',
            message: alreadyStopped ? `Batch already ${batch.status}` : 'Batch stopped',
            data: {
                batch_id: batch._id,
                status: batch.status,
                already_stopped: alreadyStopped,
                cleanup_managed_by_runner: managedLocally === true,
                claim_release_started: claimReleaseHosts.length > 0,
                claim_release_hosts: claimReleaseHosts
            }
        });
    } catch (err) {
        logger.error('Failed to stop batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/resume
 * Resume a stopped/failed/interrupted batch from its checkpoint
 */
router.post('/batch/:id/resume', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
        const batch = await BenchmarkBatch.findById(req.params.id)
            .select('judge_config plan.judge_model plan.exec_hosts')
            .lean();
        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }
        let resumedJudgeConfig = { ...(batch.judge_config || {}) };
        if (batch.judge_config?.target?.executionKind === 'harness') {
            const currentTarget = await resolveHarnessTarget(batch.judge_config.target, { force: true });
            resumedJudgeConfig = {
                ...resumedJudgeConfig,
                target: currentTarget,
                host: `harness:${currentTarget.harness.name}`,
                model: currentTarget.model
            };
        } else {
            const readiness = await resolveReadyJudgeTarget({
                host: batch.judge_config?.host || batch.plan?.exec_hosts?.[0]?.judge_host,
                model: batch.judge_config?.model || batch.plan?.judge_model
            });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Batch resume'));
            }
            resumedJudgeConfig = {
                ...resumedJudgeConfig,
                target: buildOllamaTarget(readiness.target.host, readiness.target.model),
                host: readiness.target.host,
                model: readiness.target.model
            };
        }
        const data = await benchmarkService.resumeBatch(req.params.id, {
            judgeConfig: resumedJudgeConfig,
            paidApproval: req.body?.paid_approval || null
        });
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to resume batch', { error: err.message });
        const statusCode = err.statusCode || (err.message.includes('not found') ? 404
            : err.message.includes('Cannot resume') ? 409 : 500);
        res.status(statusCode).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/rerun-invalid
 * Build or launch an exact rerun for rows excluded from leaderboard.
 * Body: { launch?: boolean, allow_superset?: boolean, execution_config?: object }
 */
router.post('/batch/:id/rerun-invalid', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id).lean();
        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        const invalidRows = await BenchmarkResult.find({
            batch_id: batch._id,
            excluded_from_leaderboard: true
        }).select('model prompt_name prompt_level prompt_category').lean();

        if (invalidRows.length === 0) {
            return res.status(404).json({
                status: 'error',
                error: 'No excluded/invalid rows found for this batch'
            });
        }

        const promptNames = [...new Set(invalidRows.map(r => r.prompt_name).filter(Boolean))];
        const prompts = await BenchmarkPrompt.find({ name: { $in: promptNames } })
            .select('_id name level category')
            .lean();
        const promptByName = new Map(prompts.map(p => [p.name, p]));
        const missingPromptNames = promptNames.filter(name => !promptByName.has(name));
        if (missingPromptNames.length > 0) {
            return res.status(422).json({
                status: 'error',
                error: `Cannot map invalid rows back to prompt ids: ${missingPromptNames.join(', ')}`
            });
        }

        const models = [...new Set(invalidRows.map(r => r.model).filter(Boolean))];
        const promptIds = prompts.map(p => String(p._id));
        const levels = [...new Set(prompts.map(p => Number(p.level)).filter(Boolean))].sort((a, b) => a - b);
        const rectangularCount = models.length * promptIds.length;
        const isExactRectangularRerun = rectangularCount === invalidRows.length;
        const allowSuperset = req.body?.allow_superset === true;

        const executionOverrides = req.body?.execution_config;
        if (executionOverrides != null
            && (typeof executionOverrides !== 'object' || Array.isArray(executionOverrides))) {
            return res.status(400).json({
                status: 'error',
                error: 'execution_config must be an object when provided'
            });
        }
        const executionConfig = {
            ...(batch.execution_config || {}),
            ...(executionOverrides || {})
        };

        const payload = {
            host: batch.host,
            models,
            levels,
            prompt_ids: promptIds,
            run_name: `Rerun invalid - ${batch.run_name || batch._id}`,
            judge_config: batch.judge_config || undefined,
            execution_config: executionConfig,
            execution_mode: batch.execution_mode || 'latency',
            depth_config: null,
            tags: [...new Set([...(batch.tags || []), 'rerun-invalid', `source:${batch._id}`])],
            description: `Exact rerun for ${invalidRows.length} invalid/excluded row(s) from batch ${batch._id}${executionOverrides ? ' with explicit execution overrides' : ''}.`
        };

        if (!req.body?.launch) {
            return res.json({
                status: 'success',
                data: {
                    launchable: isExactRectangularRerun,
                    exact_rectangular_rerun: isExactRectangularRerun,
                    invalid_rows: invalidRows.length,
                    would_run_tests: rectangularCount,
                    payload
                }
            });
        }

        if (!isExactRectangularRerun && !allowSuperset) {
            return res.status(409).json({
                status: 'error',
                error: 'Invalid rows do not form an exact model x prompt rectangle; refusing to auto-launch a superset rerun',
                data: {
                    invalid_rows: invalidRows.length,
                    would_run_tests: rectangularCount,
                    payload
                }
            });
        }

        const readiness = await resolveReadyJudgeTarget({
            host: payload.judge_config?.host,
            model: payload.judge_config?.model
        });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Corrected rerun'));
        }
        payload.judge_config = {
            ...(payload.judge_config || {}),
            host: readiness.target.host,
            model: readiness.target.model
        };

        const activeBatches = await BenchmarkBatch.getActive();
        if (activeBatches.length > 0) {
            return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
        }

        const activeProfiling = findActiveProfilingForHost({ hostUrl: payload.host });
        if (activeProfiling.length > 0) {
            return res.status(409).json(buildActiveProfilingConflict(payload.host, activeProfiling));
        }

        const preflightJudgeConfig = payload.judge_config || {};
        buddySurface.emitLifecycle('preflight_start', `Preflight: validating ${payload.models.length} model(s) for corrected rerun…`);
        const preflightResult = await runPreflight({
            targets: payload.models.map((modelName) => ({ host: payload.host, model: modelName })),
            judgeConfig: preflightJudgeConfig,
            levels: payload.levels,
            prompt_ids: payload.prompt_ids,
            executionConfig: payload.execution_config
        });
        if (!preflightResult.ready) {
            buddySurface.emitLifecycle(
                'preflight_blocked',
                `Corrected rerun blocked: ${(preflightResult.issues || []).slice(0, 2).join('; ') || 'requirements not met'}`
            );
            return res.status(422).json({
                status: 'error',
                error: 'Corrected rerun preflight failed',
                issues: preflightResult.issues,
                preflight: preflightResult,
                payload
            });
        }
        buddySurface.emitLifecycle('preflight_ok', `Corrected rerun preflight passed — relaunching ${payload.models.length} model(s).`);

        const data = await benchmarkService.startBatch(payload);
        return res.json({
            status: 'success',
            data: {
                ...data,
                preflight: preflightResult,
                source_batch_id: batch._id,
                invalid_rows: invalidRows.length,
                exact_rectangular_rerun: isExactRectangularRerun
            }
        });
    } catch (err) {
        logger.error('Failed to rerun invalid batch rows', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
