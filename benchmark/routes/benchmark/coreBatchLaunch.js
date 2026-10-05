/**
 * Benchmark Routes - Core batch launch
 * POST /batch: validate, admit the judge, run preflight and start a batch.
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const mongoose = require('mongoose');
const benchmarkService = require('../../src/services/benchmark');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const { validateJudgeModel } = require('../../src/services/benchmark/judgeModelValidator');
const { validateExecutionHost } = require('../../src/services/benchmark/executionHostValidator');
const { runPreflight } = require('../../src/services/benchmark/preflight');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const buddySurface = require('../../src/services/benchmark/buddySurfaceEvents');
const { resolveMultiJudge } = require('../../src/services/benchmark/resolveMultiJudge');
const {
    filterJudgeDefaultsForExecutionHost,
    resolveBatchMultiJudgeInput
} = require('../../src/services/benchmark/multiJudgeDefaults');
const { findActiveProfilingForHost } = require('../../src/services/profiler/activeProfileState');
const {
    buildOllamaTarget,
    normalizeBatchTargets,
    normalizeBenchmarkTarget
} = require('../../../shared/benchmarkTargetContract');
const { resolveHarnessTarget } = require('../../src/services/benchmark/harnessBrokerClient');
const {
    JUDGE_FALLBACK_MODEL,
    readJudgeDefaults,
    isDuplicateKeyError,
    resolveBatchJudgeTarget,
    buildActiveBatchConflict,
    buildActiveProfilingConflict
} = require('./coreShared');
const { checkJudgeLimits } = require('../../src/services/benchmark/judgeLaunchLimits');
/**
 * POST /api/benchmark/batch
 * Start a batch benchmark test with quality scoring
 */
router.post('/batch', async (req, res) => {
    let { host, models, targets, levels, prompt_ids, run_name, judge_config, execution_config, execution_mode, depth_config, tags, description, multi_judge, paid_approval, campaign_kind } = req.body;

    // Validation
    if ((!Array.isArray(targets) || targets.length === 0) && (!host || !models || !Array.isArray(models))) {
        return res.status(400).json({
            status: 'error',
            error: 'targets (array), or legacy host + models (array), are required'
        });
    }
    if (!levels || !Array.isArray(levels)) {
        return res.status(400).json({ status: 'error', error: 'levels (array) are required' });
    }

    let normalizedTargets;
    try {
        normalizedTargets = normalizeBatchTargets({ host, models, targets });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ status: 'error', code: error.code, error: error.message });
    }
    const localTargets = normalizedTargets.filter((target) => target.executionKind === 'ollama');
    const harnessTargets = normalizedTargets.filter((target) => target.executionKind === 'harness');
    host = localTargets[0]?.host || 'harness';
    models = normalizedTargets.map((target) => target.model);

    // Input length limits
    if (run_name && String(run_name).length > 200) {
        return res.status(400).json({ status: 'error', error: 'run_name must be 200 characters or less' });
    }
    if (description && String(description).length > 2000) {
        return res.status(400).json({ status: 'error', error: 'description must be 2000 characters or less' });
    }
    if (tags && Array.isArray(tags)) {
        if (tags.length > 20) {
            return res.status(400).json({ status: 'error', error: 'Maximum 20 tags allowed' });
        }
        if (tags.some(t => String(t).length > 50)) {
            return res.status(400).json({ status: 'error', error: 'Each tag must be 50 characters or less' });
        }
    }
    if (normalizedTargets.length > 50) {
        return res.status(400).json({ status: 'error', error: 'Maximum 50 models allowed per batch' });
    }
    if (levels.length > 5) {
        return res.status(400).json({ status: 'error', error: 'Maximum 5 levels allowed' });
    }
    if (prompt_ids !== undefined) {
        if (!Array.isArray(prompt_ids)) {
            return res.status(400).json({ status: 'error', error: 'prompt_ids must be an array when provided' });
        }
        if (prompt_ids.length > 100) {
            return res.status(400).json({ status: 'error', error: 'Maximum 100 prompt_ids allowed per batch' });
        }
        const invalidPromptIds = prompt_ids
            .map(id => String(id))
            .filter(id => !mongoose.Types.ObjectId.isValid(id));
        if (invalidPromptIds.length > 0) {
            return res.status(400).json({
                status: 'error',
                error: `Invalid prompt_ids: ${invalidPromptIds.join(', ')}`
            });
        }
    }

    // A judge limit above the usual size is reported, not refused.
    let launchWarnings = [];

    // Validate advanced judge_config fields if provided
    if (judge_config && typeof judge_config === 'object') {
        const jc = judge_config;
        const judgeLimits = checkJudgeLimits(jc);
        if (judgeLimits.error) return res.status(400).json({ status: 'error', error: judgeLimits.error });
        launchWarnings = judgeLimits.warnings;
        if (jc.temperature !== undefined && (typeof jc.temperature !== 'number' || jc.temperature < 0 || jc.temperature > 1)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.temperature must be a number between 0 and 1' });
        }
        if (jc.num_ctx != null && (typeof jc.num_ctx !== 'number' || jc.num_ctx < 512)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.num_ctx must be a number of at least 512' });
        }
        if (jc.max_retries !== undefined && (typeof jc.max_retries !== 'number' || jc.max_retries < 0 || jc.max_retries > 5)) {
            return res.status(400).json({ status: 'error', error: 'judge_config.max_retries must be a number between 0 and 5' });
        }
        if (jc.voting_count !== undefined && (typeof jc.voting_count !== 'number' || ![1, 3, 5].includes(jc.voting_count))) {
            return res.status(400).json({ status: 'error', error: 'judge_config.voting_count must be 1, 3, or 5' });
        }
    }

    // Validate advanced execution_config fields if provided
    if (execution_config && typeof execution_config === 'object') {
        const ec = execution_config;
        if (ec.per_test_timeout_ms !== undefined && (typeof ec.per_test_timeout_ms !== 'number' || ec.per_test_timeout_ms < 30000 || ec.per_test_timeout_ms > 1200000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.per_test_timeout_ms must be between 30000 and 1200000' });
        }
        if (ec.warmup_timeout_cold !== undefined && (typeof ec.warmup_timeout_cold !== 'number' || ec.warmup_timeout_cold < 30000 || ec.warmup_timeout_cold > 600000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.warmup_timeout_cold must be between 30000 and 600000' });
        }
        if (ec.warmup_timeout_loaded !== undefined && (typeof ec.warmup_timeout_loaded !== 'number' || ec.warmup_timeout_loaded < 10000 || ec.warmup_timeout_loaded > 180000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.warmup_timeout_loaded must be between 10000 and 180000' });
        }
        if (ec.judge_drain_timeout_ms !== undefined && (typeof ec.judge_drain_timeout_ms !== 'number' || ec.judge_drain_timeout_ms < 300000 || ec.judge_drain_timeout_ms > 3600000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.judge_drain_timeout_ms must be between 300000 and 3600000' });
        }
        if (ec.judge_stall_timeout_ms !== undefined && (typeof ec.judge_stall_timeout_ms !== 'number' || ec.judge_stall_timeout_ms < 30000 || ec.judge_stall_timeout_ms > 600000)) {
            return res.status(400).json({ status: 'error', error: 'execution_config.judge_stall_timeout_ms must be between 30000 and 600000' });
        }
        if (ec.think !== undefined) {
            const validThink = typeof ec.think === 'boolean'
                || ['auto', 'on', 'off', 'true', 'false', 'enabled', 'disabled', 'force', 'forced', 'never', 'best_qualified'].includes(String(ec.think).trim().toLowerCase());
            if (!validThink) {
                return res.status(400).json({ status: 'error', error: 'execution_config.think must be a boolean or one of: auto, on, off, best_qualified' });
            }
        }
        if (ec.response_mode !== undefined) {
            const validMode = ['final_only', 'native', 'explicit_thinking', 'profile_auto', 'best_qualified'].includes(
                String(ec.response_mode).trim().toLowerCase()
            );
            if (!validMode) {
                return res.status(400).json({ status: 'error', error: 'execution_config.response_mode must be one of: final_only, native, explicit_thinking, profile_auto, best_qualified' });
            }
        }
    }

    campaign_kind = normalizedTargets.some((target) => target.mode === 'native_agent') ? 'native_agent' : 'model';

    let readyJudgeConfig;
    let harnessJudgeTarget = null;
    try {
        normalizedTargets = await Promise.all(normalizedTargets.map(async (target) => (
            target.executionKind === 'harness'
                ? resolveHarnessTarget(target, { force: true })
                : target
        )));
        const unavailableCandidate = normalizedTargets.find((target) => target.capabilities.candidate !== true);
        if (unavailableCandidate) {
            return res.status(422).json({
                status: 'error', code: 'TARGET_CANDIDATE_NOT_ALLOWED',
                error: `Target ${unavailableCandidate.id} is not catalogued for candidate execution`
            });
        }

        if (judge_config?.target?.executionKind === 'harness') {
            harnessJudgeTarget = await resolveHarnessTarget(
                normalizeBenchmarkTarget(judge_config.target),
                { force: true }
            );
            if (harnessJudgeTarget.mode !== 'isolated_model' || harnessJudgeTarget.capabilities.judge !== true) {
                return res.status(422).json({
                    status: 'error',
                    code: 'HARNESS_JUDGE_NOT_ALLOWED',
                    error: 'Only isolated_model harness targets with judge capability may judge'
                });
            }
            readyJudgeConfig = {
                ...(judge_config || {}),
                target: harnessJudgeTarget,
                host: `harness:${harnessJudgeTarget.harness.name}`,
                model: harnessJudgeTarget.model
            };
        } else {
            // Resolve local judges through the same readiness authority used by
            // Courthouse. Cloud judges are catalog-bound above instead.
            const judgeReadiness = await resolveReadyJudgeTarget({
                host: judge_config?.host,
                model: judge_config?.model
            });
            if (!judgeReadiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(judgeReadiness, 'Benchmark launch'));
            }
            readyJudgeConfig = {
                ...(judge_config || {}),
                target: buildOllamaTarget(judgeReadiness.target.host, judgeReadiness.target.model),
                host: judgeReadiness.target.host,
                model: judgeReadiness.target.model
            };
        }

        // Ollama keeps its existing host/model validation. Harness targets are
        // validated against the broker catalog and never sent to /api/tags.
        const localGroups = new Map();
        for (const target of normalizedTargets.filter((entry) => entry.executionKind === 'ollama')) {
            const group = localGroups.get(target.host) || [];
            group.push(target.model);
            localGroups.set(target.host, group);
        }
        for (const [localHost, localModels] of localGroups.entries()) {
            const hostCheck = await validateExecutionHost(localHost, localModels);
            if (!hostCheck.valid) {
                return res.status(422).json({
                    status: 'error',
                    error: hostCheck.error,
                    ...(hostCheck.available_models && { available_models: hostCheck.available_models })
                });
            }
        }
    } catch (error) {
        return res.status(error.statusCode || 422).json({ status: 'error', code: error.code, error: error.message });
    }

    // Dedication check removed — the batch orchestrator handles dedication
    // lifecycle automatically (detect pins → run batch → restore pins).

    try {
        // ENFORCE SINGLE BATCH: Check for existing active batches
        const activeBatches = await BenchmarkBatch.getActive();

        if (activeBatches.length > 0) {
            return res.status(409).json(buildActiveBatchConflict(activeBatches[0]));
        }

        for (const localHost of new Set(localTargets.map((target) => target.host))) {
            const activeProfiling = findActiveProfilingForHost({ hostUrl: localHost });
            if (activeProfiling.length > 0) {
                return res.status(409).json(buildActiveProfilingConflict(localHost, activeProfiling));
            }
        }

        // Multi-judge is opt-in. Hard L4/L5 suites still preserve explicit
        // off/custom choices, but omission resolves to the global default.
        const multiJudgeHostDefaults = harnessJudgeTarget
            ? {}
            : filterJudgeDefaultsForExecutionHost(readJudgeDefaults(), host);
        const resolvedMultiJudge = resolveMultiJudge(
            resolveBatchMultiJudgeInput(levels, multi_judge),
            { hostDefaults: multiJudgeHostDefaults }
        );
        if (harnessJudgeTarget && resolvedMultiJudge.enabled) {
            return res.status(422).json({
                status: 'error',
                code: 'HARNESS_MULTI_JUDGE_NOT_SUPPORTED',
                error: 'A harness judge must run as one exact isolated target; disable multi-judge for this batch'
            });
        }
        const judgeConfigWithMulti = {
            ...readyJudgeConfig,
            multi_judge: resolvedMultiJudge
        };

        let normalizedJudgeConfig;
        let actualJudgeHost;
        let judgeModel;
        if (harnessJudgeTarget) {
            normalizedJudgeConfig = judgeConfigWithMulti;
            actualJudgeHost = `harness:${harnessJudgeTarget.harness.name}`;
            judgeModel = harnessJudgeTarget.model;
        } else {
            ({
                normalizedJudgeConfig,
                validationHost: actualJudgeHost,
                validationModel: judgeModel
            } = await resolveBatchJudgeTarget(host, judgeConfigWithMulti));
        }

        if (!harnessJudgeTarget && actualJudgeHost && judgeModel) {
            let validation = await validateJudgeModel(actualJudgeHost, judgeModel, { metadataOnly: true });

            // Tiered judge: if the resolved default judge isn't on this host
            // and the caller did NOT pin a model, fall back to the lighter judge
            // instead of failing the batch. An explicit judge_config.model is
            // never silently downgraded. On a host with both models present this
            // path is dead (14b validates), so it changes nothing on the current
            // cluster — it only rescues 7b-only hosts. No judge-mixing risk: the
            // host runs all-14b or all-7b, never both in one batch.
            const callerPinnedModel = !!(judge_config && judge_config.model);
            if (!validation.valid && !callerPinnedModel
                && JUDGE_FALLBACK_MODEL && JUDGE_FALLBACK_MODEL !== judgeModel) {
                const fallbackValidation = await validateJudgeModel(actualJudgeHost, JUDGE_FALLBACK_MODEL, { metadataOnly: true });
                if (fallbackValidation.valid) {
                    logger.warn('Judge model unavailable on host; falling back to lighter judge', {
                        host: actualJudgeHost,
                        requested: judgeModel,
                        fallback: JUDGE_FALLBACK_MODEL
                    });
                    judgeModel = JUDGE_FALLBACK_MODEL;
                    normalizedJudgeConfig = { ...normalizedJudgeConfig, model: JUDGE_FALLBACK_MODEL };
                    validation = fallbackValidation;
                }
            }

            if (!validation.valid) {
                return res.status(422).json({
                    status: 'error',
                    error: `Judge model validation failed on ${actualJudgeHost}: ${validation.error}`,
                    available_models: validation.available_models || [],
                    latency_ms: validation.latency_ms
                });
            }
        }

        const preflightJudgeConfig = {
            ...normalizedJudgeConfig,
            host: actualJudgeHost || normalizedJudgeConfig.host,
            model: judgeModel || normalizedJudgeConfig.model
        };

        buddySurface.emitLifecycle('preflight_start', `Preflight: validating ${normalizedTargets.length} target(s) before launch…`);
        const localPreflightTargets = normalizedTargets
            .filter((target) => target.executionKind === 'ollama')
            .map((target) => ({ host: target.host, model: target.model }));
        const preflight = await runPreflight({
            targets: localPreflightTargets,
            judgeConfig: harnessJudgeTarget
                ? { ...preflightJudgeConfig, target: harnessJudgeTarget }
                : preflightJudgeConfig,
            levels,
            prompt_ids,
            executionConfig: execution_config || null
        });
        preflight.checks.harness = {
            targets: normalizedTargets.length - localPreflightTargets.length,
            judge: Boolean(harnessJudgeTarget),
            catalog_revalidated: true
        };

        if (!preflight.ready) {
            buddySurface.emitLifecycle(
                'preflight_blocked',
                `Preflight blocked launch: ${(preflight.issues || []).slice(0, 2).join('; ') || 'requirements not met'}`
            );
            return res.status(422).json({
                status: 'error',
                error: 'Benchmark preflight failed',
                issues: preflight.issues,
                preflight
            });
        }
        // Pre-run only: no judge/scoring active yet, so a suggesting intent is allowed.
        buddySurface.emitLifecycle('preflight_ok', `Preflight passed — ready to launch ${normalizedTargets.length} target(s).`);

        const data = await benchmarkService.startBatch({
            host,
            models,
            targets: normalizedTargets,
            levels,
            prompt_ids,
            run_name,
            judge_config: normalizedJudgeConfig,
            execution_config,
            execution_mode: execution_mode || 'latency',
            depth_config: depth_config || null,
            tags,
            description,
            paid_approval,
            campaign_kind
        });

        res.json({
            status: 'success',
            data: {
                ...data,
                preflight,
                warnings: launchWarnings,
                message: 'Batch test started with quality scoring'
            }
        });
    } catch (err) {
        if (String(err.message || '').startsWith('Prompt IDs not found:')) {
            return res.status(422).json({ status: 'error', error: err.message });
        }
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
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

module.exports = router;
