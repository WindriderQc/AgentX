/**
 * Batch creation: prompt selection, plan and contract fingerprints, spend
 * grant, durable batch insert and admission hand-off to the executor.
 */

const logger = require('../../../config/logger');
const mongoose = require('mongoose');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { seedPrompts } = require('./init');
const { samplePromptsByDepth } = require('./promptSampling');
const { buildExecutionPlan } = require('./batchPlanner');
const {
    acquireWorkloadAdmission,
    releaseWorkloadAdmission
} = require('../../clients/coreApiClient');
const { startBenchmarkClaimHeartbeat } = require('./benchmarkClaimLifecycle');
const { batchAdmissionScope } = require('./batchAdmissionScope');
const {
    buildOllamaTarget,
    buildPromptFingerprint, buildQualityCohortFingerprint,
    normalizeBatchTargets,
    normalizeBenchmarkTarget
} = require('../../../../shared/benchmarkTargetContract');
const { createSpendGrant } = require('./harnessBrokerClient');
const { fingerprint } = require('../../../../shared/workerContract');
const { markReconciliationPending, retainAdmissionHeartbeat } = require('./batchAuthorityRecovery');
const { executeBatch } = require('./batchExecutionRun');
const { normalizeJudgeThink } = require('./judgeLaunchLimits');
const { resolveJudgeConfig } = require('../scoring/resolveJudgeConfig');
const { freezeJudgeConfig } = require('./judgeExecutionContract');

async function startBatch({
    host,
    models,
    targets = null,
    levels,
    prompt_ids = null,
    run_name,
    judge_config = {},
    execution_config = {},
    tags = [],
    description = '',
    execution_mode = 'latency',
    depth_config = null,
    paid_approval = null,
    campaign_kind = 'model'
}) {
    if (!levels || !Array.isArray(levels)) {
        throw new Error('levels (array) are required');
    }
    const normalizedTargets = normalizeBatchTargets({ host, models, targets });
    campaign_kind = normalizedTargets.some((target) => target.mode === 'native_agent') ? 'native_agent' : 'model';
    const defaultHost = normalizedTargets.find((target) => target.executionKind === 'ollama')?.host || 'harness';
    const displayModels = normalizedTargets.map((target) => target.model);
    // Judges score visible final answers; reasoning only by explicit choice (#397).
    judge_config = { ...(judge_config || {}), think: normalizeJudgeThink(judge_config?.think) ?? false };
    const judgeTarget = judge_config.target
        ? normalizeBenchmarkTarget(judge_config.target, { allowMissingCatalogFingerprint: judge_config.target.executionKind === 'ollama' })
        : buildOllamaTarget(judge_config.host || defaultHost, judge_config.model || JUDGE_CONFIG.model);
    if (judgeTarget.mode === 'native_agent' || !judgeTarget.capabilities.judge) {
        throw new Error('Only direct_model or isolated_model targets may be used as judge');
    }
    const plannedBatchId = new mongoose.Types.ObjectId();
    const plannedBatchKey = plannedBatchId.toString();
    const workloadTtlMs = execution_config?.estimated_duration_ms || null;
    await acquireWorkloadAdmission(plannedBatchId.toString(), {
        requestId: `benchmark:${plannedBatchId}`,
        ...batchAdmissionScope(normalizedTargets, { ...judge_config, target: judgeTarget, host: judgeTarget.host }),
        batchId: plannedBatchId.toString(),
        ttlMs: workloadTtlMs
    });
    const creationAbort = new AbortController();
    const creationHeartbeat = startBenchmarkClaimHeartbeat([], plannedBatchKey, workloadTtlMs, {
        source: 'benchmark',
        onFatal: error => {
            if (!creationAbort.signal.aborted) creationAbort.abort(error);
        }
    });
    await creationHeartbeat.ready;
    try {
        creationHeartbeat.assertActive();
    } catch (error) {
        await creationHeartbeat.drain();
        throw error;
    }
    let admissionHandedOff = false;
    try {
    judge_config = resolveJudgeConfig({ ...judge_config, target: judgeTarget, host: judgeTarget.host || `harness:${judgeTarget.harness.name}`, model: judgeTarget.model });
    judge_config = await freezeJudgeConfig(judge_config, { signal: creationAbort.signal });

    await seedPrompts();

    const explicitPromptIds = Array.isArray(prompt_ids)
        ? [...new Set(prompt_ids.map(id => String(id)).filter(Boolean))]
        : [];

    let selectedPrompts = [];
    if (explicitPromptIds.length > 0) {
        const docs = await BenchmarkPrompt.find({ _id: { $in: explicitPromptIds } });
        const byId = new Map(docs.map(doc => [doc._id.toString(), doc]));
        const missing = explicitPromptIds.filter(id => !byId.has(id));
        if (missing.length > 0) {
            throw new Error(`Prompt IDs not found: ${missing.join(', ')}`);
        }
        selectedPrompts = explicitPromptIds.map(id => byId.get(id));
    } else {
        selectedPrompts = await BenchmarkPrompt.getByLevels(levels);
    }

    if (explicitPromptIds.length === 0 && depth_config && typeof depth_config === 'object') {
        selectedPrompts = samplePromptsByDepth(selectedPrompts, depth_config);
    }

    if (explicitPromptIds.length === 0) {
        selectedPrompts.sort((a, b) => (a.level || 0) - (b.level || 0));
    }

    if (selectedPrompts.length === 0) {
        throw new Error('No prompts found for selected levels');
    }
    const persistedLevels = explicitPromptIds.length > 0
        ? [...new Set(selectedPrompts
            .map(prompt => Number(prompt.level))
            .filter(level => Number.isSafeInteger(level) && level >= 1 && level <= 5))]
            .sort((left, right) => left - right)
        : [...levels];
    if (persistedLevels.length === 0) {
        throw new Error('Selected prompts require at least one valid level between 1 and 5');
    }

    const { plan, normalizedExecutionConfig } = buildExecutionPlan(
        defaultHost,
        displayModels,
        selectedPrompts,
        { judge_config, execution_config, targets: normalizedTargets }
    );
    plan.targets = normalizedTargets;

    const repeats = Math.max(1, Math.min(5, Number(normalizedExecutionConfig.repeats) || 1));
    const qualityCohortFingerprint = buildQualityCohortFingerprint({
        scorerVersion: SCORER_VERSION,
        judgeTarget,
        judgeThink: judge_config.think,
        judgeConfig: judge_config,
        executionConfig: normalizedExecutionConfig,
        profileContract: campaign_kind === 'native_agent' ? 'native-agent-v1' : 'isolated-model-v1'
    });
    const batchContractFingerprint = fingerprint({
        schema: 'agentx.benchmark-batch-contract/v1',
        qualityCohortFingerprint,
        promptFingerprints: selectedPrompts.map(buildPromptFingerprint).sort(),
        targetFingerprints: normalizedTargets.map((target) => target.fingerprint).sort(),
        repeats,
        campaignKind: campaign_kind,
        executionMode: execution_mode || 'latency'
    });
    plan.batch_contract_fingerprint = batchContractFingerprint;
    const batch = new BenchmarkBatch({
        _id: plannedBatchId,
        host: defaultHost,
        models: displayModels,
        targets: normalizedTargets,
        campaign_kind,
        levels: persistedLevels,
        prompt_ids: explicitPromptIds,
        judge_config,
        execution_config: normalizedExecutionConfig,
        depth_config: (depth_config && typeof depth_config === 'object') ? depth_config : null,
        run_name: run_name || description || `Batch ${new Date().toLocaleString()}`,
        active_slot: 'benchmark_singleton',
        total_tests: normalizedTargets.length * selectedPrompts.length * repeats,
        plan,
        status: 'running',
        started_at: new Date(),
        tags: Array.isArray(tags) ? tags : [],
        description: typeof description === 'string' ? description : '',
        execution_mode: execution_mode || 'latency',
        quality_cohort_fingerprint: qualityCohortFingerprint,
        batch_contract_fingerprint: batchContractFingerprint
    });

    const spendGrant = await createSpendGrant({
        batchId: batch._id.toString(),
        batchFingerprint: batchContractFingerprint,
        targets: normalizedTargets,
        judgeTarget,
        judgeConfig: judge_config,
        promptCount: selectedPrompts.length,
        repeats,
        executionConfig: normalizedExecutionConfig,
        approval: paid_approval
    });
    batch.spend_grant = spendGrant;

    batch.captureSystemSnapshot();
    try {
        creationHeartbeat.assertActive();
        await batch.save({ signal: creationAbort.signal });
        creationHeartbeat.assertActive();
    } catch (error) {
        // The ObjectId is allocated before admission, so cleanup is exact even
        // when the driver committed the insert but the acknowledgement or
        // post-write heartbeat checkpoint was lost.
        try {
            await BenchmarkBatch.deleteOne({ _id: plannedBatchId });
        } catch (compensationError) {
            markReconciliationPending(error, compensationError, 'BATCH_CREATION_RECONCILIATION_PENDING', {
                workloadId: plannedBatchKey, batchId: plannedBatchId, resultId: plannedBatchId, phase: 'batch creation'
            });
        }
        throw error;
    }
    const batchId = batch._id.toString();
    if (process.env.NODE_ENV !== 'test') {
        let resolveAdmissionReady;
        let rejectAdmissionReady;
        let admissionReadySettled = false;
        const admissionReady = new Promise((resolve, reject) => {
            resolveAdmissionReady = () => {
                admissionReadySettled = true;
                resolve();
            };
            rejectAdmissionReady = error => {
                admissionReadySettled = true;
                reject(error);
            };
        });
        executeBatch(batchId, defaultHost, displayModels, selectedPrompts, {
            targets: normalizedTargets,
            spend_grant: spendGrant,
            quality_cohort_fingerprint: qualityCohortFingerprint,
            batch_contract_fingerprint: batchContractFingerprint,
            judge_config,
            execution_config: normalizedExecutionConfig,
            execution_mode,
            onAdmissionReady: resolveAdmissionReady
        }).catch((err) => {
            if (!admissionReadySettled) rejectAdmissionReady(err);
            logger.error('Batch execution failed', { batchId, error: err.message });
        });
        // Keep the creation admission heartbeat alive until executeBatch has
        // re-attested the same Core-owned token and started its own heartbeat.
        await admissionReady;
        admissionHandedOff = true;
        await creationHeartbeat.drain();
    } else {
        // Tests deliberately do not spawn the background executor. Avoid
        // leaving a phantom global workload after the durable creation check.
        await creationHeartbeat.drain();
        const released = await releaseWorkloadAdmission(plannedBatchKey);
        if (released?.released !== true) {
            const error = new Error(released?.reason || 'Workload admission release failed after test batch creation');
            error.code = 'WORKLOAD_ADMISSION_RELEASE_FAILED';
            throw error;
        }
    }

    return {
        batch_id: batchId,
        total_tests: batch.total_tests,
        plan
    };
    } catch (error) {
        if (!admissionHandedOff && error?.retainAdmission !== true) {
            try {
                const released = await releaseWorkloadAdmission(plannedBatchKey);
                if (released?.released !== true) {
                    throw new Error(released?.reason || 'Workload admission release was not acknowledged');
                }
            } catch (releaseError) {
                markReconciliationPending(error, releaseError, 'BATCH_CREATION_ADMISSION_RECONCILIATION_PENDING', {
                    workloadId: plannedBatchKey, batchId: plannedBatchId, resultId: plannedBatchId, phase: 'batch creation release'
                });
            }
        }
        if (!admissionHandedOff) {
            if (error?.retainAdmission === true) {
                retainAdmissionHeartbeat(creationHeartbeat, workloadTtlMs, {
                    workloadId: plannedBatchKey,
                    phase: 'batch_creation'
                });
            } else {
                await creationHeartbeat.drain();
            }
        }
        throw error;
    }
}

module.exports = { startBatch };
