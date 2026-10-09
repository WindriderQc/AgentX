/**
 * Batch resume: renewed spend grant and admission, resumed state commit
 * and admission hand-off to the executor.
 */

const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { samplePromptsByDepth } = require('./promptSampling');
const {
    acquireWorkloadAdmission,
    releaseWorkloadAdmission
} = require('../../clients/coreApiClient');
const { startBenchmarkClaimHeartbeat } = require('./benchmarkClaimLifecycle');
const { batchAdmissionScope } = require('./batchAdmissionScope');
const {
    normalizeBatchTargets,
    normalizeBenchmarkTarget
} = require('../../../../shared/benchmarkTargetContract');
const { createSpendGrant } = require('./harnessBrokerClient');
const { fingerprint } = require('../../../../shared/workerContract');
const { markReconciliationPending, retainAdmissionHeartbeat } = require('./batchAuthorityRecovery');
const { executeBatch } = require('./batchExecutionRun');

/**
 * Resume a stopped/failed batch from its last checkpoint.
 * Re-uses the original batch config; the orchestrator skips completed pairs.
 */
async function resumeBatch(batchId, options = {}) {
    const batch = await BenchmarkBatch.findById(batchId).select('+spend_grant');
    if (!batch) throw new Error('Batch not found');
    if (!['stopped', 'failed', 'interrupted'].includes(batch.status)) {
        throw new Error(`Cannot resume batch in status "${batch.status}"`);
    }

    const totalTests = Number(batch.total_tests) || 0;
    const completed = Number(batch.completed) || 0;
    const judgePending = Number(batch.judge_stats?.pending) || 0;
    const checkpointCount = Array.isArray(batch.checkpoint?.completed_pairs)
        ? batch.checkpoint.completed_pairs.length
        : 0;
    const executionRemaining = totalTests > 0
        ? Math.max(0, totalTests - Math.max(completed, checkpointCount)) > 0
        : false;

    if (!executionRemaining && judgePending <= 0) {
        throw new Error('Cannot resume batch with no remaining work');
    }

    // Rebind the judge before calculating any renewed spend ceiling.
    if (options.judgeConfig && typeof options.judgeConfig === 'object') {
        batch.judge_config = {
            ...(batch.judge_config || {}),
            ...options.judgeConfig
        };
    }

    const explicitPromptIds = Array.isArray(batch.prompt_ids)
        ? batch.prompt_ids.map(id => String(id)).filter(Boolean)
        : [];
    let selectedPrompts;
    if (explicitPromptIds.length > 0) {
        const prompts = await BenchmarkPrompt.find({ _id: { $in: explicitPromptIds } });
        const byId = new Map(prompts.map(doc => [doc._id.toString(), doc]));
        selectedPrompts = explicitPromptIds.map(id => byId.get(id)).filter(Boolean);
    } else {
        const prompts = await BenchmarkPrompt.getByLevels(batch.levels);
        selectedPrompts = (batch.depth_config && typeof batch.depth_config === 'object')
            ? samplePromptsByDepth(prompts, batch.depth_config)
            : prompts;
        selectedPrompts.sort((a, b) => (a.level || 0) - (b.level || 0));
    }

    const normalizedTargets = normalizeBatchTargets({
        host: batch.host,
        models: batch.models,
        targets: batch.targets
    });
    const judgeTarget = normalizeBenchmarkTarget(batch.judge_config.target, {
        allowMissingCatalogFingerprint: batch.judge_config.target.executionKind === 'ollama'
    });
    const repeats = Math.max(1, Math.min(5, Number(batch.execution_config?.repeats) || 1));
    const batchContractFingerprint = batch.batch_contract_fingerprint || fingerprint({
        schema: 'agentx.benchmark-batch-contract/v1',
        qualityCohortFingerprint: batch.quality_cohort_fingerprint || null,
        targetFingerprints: normalizedTargets.map((target) => target.fingerprint).sort(),
        repeats,
        campaignKind: batch.campaign_kind || 'model',
        executionMode: batch.execution_mode || 'latency'
    });
    const renewedSpendGrant = await createSpendGrant({
        batchId,
        batchFingerprint: batchContractFingerprint,
        targets: normalizedTargets,
        judgeTarget,
        judgeConfig: batch.judge_config,
        promptCount: selectedPrompts.length,
        repeats,
        executionConfig: batch.execution_config || {},
        approval: options.paidApproval || null
    });

    const resumeTtlMs = batch.execution_config?.estimated_duration_ms || null;
    await acquireWorkloadAdmission(batchId, {
        requestId: `benchmark:${batchId}`,
        ...batchAdmissionScope(normalizedTargets, batch.judge_config),
        batchId,
        ttlMs: resumeTtlMs
    });
    const resumeAbort = new AbortController();
    const resumeHeartbeat = startBenchmarkClaimHeartbeat([], String(batchId), resumeTtlMs, {
        source: 'benchmark',
        onFatal: error => {
            if (!resumeAbort.signal.aborted) resumeAbort.abort(error);
        }
    });
    await resumeHeartbeat.ready;
    try {
        resumeHeartbeat.assertActive();
    } catch (error) {
        await resumeHeartbeat.drain();
        try {
            const released = await releaseWorkloadAdmission(batchId);
            if (released?.released !== true) {
                throw new Error(released?.reason || 'Workload admission release was not acknowledged');
            }
        } catch (releaseError) {
            markReconciliationPending(error, releaseError, 'BATCH_RESUME_ADMISSION_RECONCILIATION_PENDING', {
                workloadId: String(batchId), batchId, resultId: batchId, phase: 'batch resume admission'
            });
        }
        throw error;
    }
    let admissionHandedOff = false;

    // Commit the resumed state only after any paid plan has been explicitly
    // approved and signed. A refusal therefore happens before the first call
    // and leaves the stopped batch resumable.
    const priorResumeState = {
        spend_grant: batch.spend_grant,
        batch_contract_fingerprint: batch.batch_contract_fingerprint,
        status: batch.status,
        active_slot: batch.active_slot,
        execution_started_at: batch.execution_started_at,
        execution_pid: batch.execution_pid
    };
    batch.spend_grant = renewedSpendGrant;
    batch.batch_contract_fingerprint = batchContractFingerprint;
    batch.status = 'running';
    batch.active_slot = 'benchmark_singleton';
    batch.execution_started_at = null;
    batch.execution_pid = null;
    try {
        resumeHeartbeat.assertActive();
        await batch.save({ signal: resumeAbort.signal });
        resumeHeartbeat.assertActive();
    } catch (error) {
        // A lost acknowledgement or post-write lease can leave the resume
        // transition committed. Revert only the exact state written by this
        // attempt so a concurrent terminal transition is never overwritten.
        try {
            await BenchmarkBatch.updateOne({
                _id: batchId,
                status: 'running',
                active_slot: 'benchmark_singleton',
                execution_started_at: null,
                execution_pid: null,
                batch_contract_fingerprint: batchContractFingerprint
            }, {
                $set: {
                    ...priorResumeState,
                    authority_state: 'authority_invalidated',
                    authority_reconciliation_reason: 'resume_transition_acknowledgement_lost'
                }
            });
        } catch (compensationError) {
            markReconciliationPending(error, compensationError, 'BATCH_RESUME_RECONCILIATION_PENDING', {
                workloadId: String(batchId), batchId, resultId: batchId, phase: 'batch resume transition'
            });
        }
        if (error?.retainAdmission === true) {
            retainAdmissionHeartbeat(resumeHeartbeat, resumeTtlMs, {
                workloadId: batchId,
                phase: 'resume_transition'
            });
        } else {
            try {
                const released = await releaseWorkloadAdmission(batchId);
                if (released?.released !== true) {
                    throw new Error(released?.reason || 'Workload admission release was not acknowledged');
                }
                await resumeHeartbeat.drain();
            } catch (releaseError) {
                markReconciliationPending(error, releaseError, 'BATCH_RESUME_ADMISSION_RECONCILIATION_PENDING', {
                    workloadId: String(batchId), batchId, resultId: batchId, phase: 'batch resume release'
                });
                retainAdmissionHeartbeat(resumeHeartbeat, resumeTtlMs, {
                    workloadId: batchId,
                    phase: 'resume_release'
                });
            }
        }
        throw error;
    }

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
        executeBatch(batchId, batch.host, batch.models, selectedPrompts, {
            targets: normalizedTargets,
            spend_grant: renewedSpendGrant,
            quality_cohort_fingerprint: batch.quality_cohort_fingerprint || null,
            batch_contract_fingerprint: batchContractFingerprint,
            judge_config: batch.judge_config || {},
            execution_config: batch.execution_config || {},
            execution_mode: batch.execution_mode || 'latency',
            onAdmissionReady: resolveAdmissionReady
        }).catch(error => {
            if (!admissionReadySettled) rejectAdmissionReady(error);
            logger.error('Resumed batch execution failed', { batchId, error: error.message });
        });
        try {
            await admissionReady;
            admissionHandedOff = true;
            await resumeHeartbeat.drain();
        } catch (error) {
            if (!admissionHandedOff) {
                try {
                    const released = await releaseWorkloadAdmission(batchId);
                    if (released?.released !== true) {
                        throw new Error(released?.reason || 'Workload admission release was not acknowledged');
                    }
                    await resumeHeartbeat.drain();
                } catch (releaseError) {
                    markReconciliationPending(error, releaseError, 'BATCH_RESUME_HANDOFF_RECONCILIATION_PENDING', {
                        workloadId: String(batchId), batchId, resultId: batchId, phase: 'batch resume handoff'
                    });
                    retainAdmissionHeartbeat(resumeHeartbeat, resumeTtlMs, {
                        workloadId: batchId,
                        phase: 'resume_handoff'
                    });
                }
            }
            throw error;
        }
    } else {
        await resumeHeartbeat.drain();
        const released = await releaseWorkloadAdmission(batchId);
        if (released?.released !== true) {
            const error = new Error(released?.reason || 'Workload admission release failed after test batch resume');
            error.code = 'WORKLOAD_ADMISSION_RELEASE_FAILED';
            throw error;
        }
    }

    return { batch_id: batchId, status: 'resumed', checkpoint: batch.checkpoint };
}

module.exports = { resumeBatch };
