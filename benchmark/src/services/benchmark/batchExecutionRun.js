/**
 * Batch execution run: execution lock, admission heartbeat, progress
 * flushing, orchestration and terminal state persistence.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { normalizeExecutionConfig } = require('./config');
const { runBatchOrchestrator, abortActiveBatchRequests } = require('./batchOrchestrator');
const {
    buildIdleCurrentTest,
    deriveTerminalBatchOutcome,
    setBatchPhase: _setBatchPhase
} = require('./batchHelpers');
const { emitBuddyEvent } = require('../../clients/buddyEventClient');
const {
    acquireWorkloadAdmission,
    releaseWorkloadAdmission
} = require('../../clients/coreApiClient');
const { startBenchmarkClaimHeartbeat } = require('./benchmarkClaimLifecycle');
const { batchAdmissionScope } = require('./batchAdmissionScope');
const { normalizeBatchTargets } = require('../../../../shared/benchmarkTargetContract');
const { markReconciliationPending, retainAdmissionHeartbeat } = require('./batchAuthorityRecovery');
const { normalizeJudgeThink } = require('./judgeLaunchLimits');
const {
    getActiveBatchId,
    getActiveHeartbeatInterval,
    setActiveBatchId,
    setActiveHeartbeatInterval
} = require('./batchActiveState');

async function updateHardwareProfiles(batchId) {
    // Hardware profile updates are handled by the Model Profiler service
    logger.debug('Hardware profile update skipped — use Model Profiler routes', { batchId });
}

async function executeBatch(batchId, defaultHost, models, prompts, options = {}) {
    const judgeConfig = { ...(options.judge_config || {}), think: normalizeJudgeThink(options.judge_config?.think) ?? false };
    const executionMode = options.execution_mode || 'latency';

    // Re-attest the Core-owned global admission before the first execution
    // lock write. The receipt cached by startBatch/resumeBatch may have expired
    // and maintenance may have acquired the exclusive lease meanwhile.
    const executionTargets = normalizeBatchTargets({
        host: defaultHost,
        models,
        targets: options.targets || null
    });
    const executionAdmission = await acquireWorkloadAdmission(String(batchId), {
        requestId: `benchmark:${batchId}`,
        ...batchAdmissionScope(executionTargets, judgeConfig),
        batchId: String(batchId),
        ttlMs: options.execution_config?.estimated_duration_ms || null
    });
    const admissionAbort = new AbortController();
    const admissionHeartbeat = startBenchmarkClaimHeartbeat(
        [],
        String(batchId),
        options.execution_config?.estimated_duration_ms || null,
        {
            source: 'benchmark',
            onFatal: error => {
                if (!admissionAbort.signal.aborted) admissionAbort.abort(error);
                abortActiveBatchRequests(batchId, { reason: error, userInitiated: false });
            }
        }
    );
    await admissionHeartbeat.ready;
    try {
        admissionHeartbeat.assertActive();
    } catch (error) {
        await admissionHeartbeat.drain();
        throw error;
    }
    options.onAdmissionReady?.();

    const now = new Date();
    const lockTimeoutMs = 10 * 60 * 1000;  // 10 minutes
    const activityTimeoutMs = 5 * 60 * 1000; // 5 minutes
    const lockTimeout = new Date(now - lockTimeoutMs);
    const activityTimeout = new Date(now - activityTimeoutMs);

    let batch;
    try {
        batch = await BenchmarkBatch.findOneAndUpdate(
        {
            _id: batchId,
            $or: [
                { execution_started_at: null },
                {
                    execution_started_at: { $lt: lockTimeout },
                    last_activity_at: { $lt: activityTimeout }
                }
            ]
        },
        {
            $set: {
                execution_started_at: now,
                execution_pid: process.pid,
                last_activity_at: now
            }
        },
            { new: true, signal: admissionAbort.signal }
        );
        admissionHeartbeat.assertActive();
    } catch (error) {
        try {
            await BenchmarkBatch.updateOne(
                {
                    _id: batchId,
                    execution_pid: process.pid,
                    execution_started_at: now
                },
                {
                    $set: {
                        execution_started_at: null,
                        execution_pid: null,
                        authority_state: 'authority_invalidated',
                        authority_reconciliation_reason: 'execution_lock_acknowledgement_lost'
                    }
                }
            );
        } catch (compensationError) {
            markReconciliationPending(error, compensationError, 'BATCH_LOCK_RECONCILIATION_PENDING', {
                workloadId: String(batchId), batchId, resultId: batchId, phase: 'execution lock'
            });
        }
        if (error?.retainAdmission === true) {
            retainAdmissionHeartbeat(admissionHeartbeat, options.execution_config?.estimated_duration_ms || null, {
                workloadId: String(batchId),
                phase: 'execution_lock'
            });
        } else {
            await admissionHeartbeat.drain();
        }
        throw error;
    }

    if (!batch) {
        const existingBatch = await BenchmarkBatch.findById(batchId);
        if (!existingBatch) {
            logger.error('Batch not found', { batchId });
        } else {
            logger.warn('Skipping duplicate batch execution - already locked', {
                batchId,
                pid: process.pid,
                lockedBy: existingBatch.execution_pid
            });
        }
        if (executionAdmission?.idempotent !== true) {
            const released = await releaseWorkloadAdmission(String(batchId));
            if (released?.released !== true) {
                retainAdmissionHeartbeat(admissionHeartbeat, options.execution_config?.estimated_duration_ms || null, {
                    workloadId: String(batchId),
                    phase: 'duplicate_execution'
                });
                const error = new Error(released?.reason || 'Workload admission release failed after duplicate execution');
                error.code = 'WORKLOAD_ADMISSION_RELEASE_FAILED';
                error.retainAdmission = true;
                throw error;
            }
        }
        await admissionHeartbeat.drain();
        return;
    }

    if (batch.execution_pid && batch.execution_pid !== process.pid) {
        logger.warn('Re-acquiring execution lock for abandoned batch', {
            batchId,
            previousPid: batch.execution_pid,
            pid: process.pid
        });
    }

    logger.info('Batch execution lock acquired', { batchId, pid: process.pid });

    emitBuddyEvent(
        'batch_started',
        'benchmark',
        `Benchmark batch started: ${models.length} models, ${prompts.length} prompts`
    );

    const executionConfig = normalizeExecutionConfig(options.execution_config || batch.execution_config || {});
    setActiveBatchId(batchId);
    let heartbeatInterval = null;
    let hostLifecycleRestored = false;
    let terminalStatePersisted = false;
    let admissionRetentionRequired = false;

    const stopHeartbeat = () => {
        const interval = heartbeatInterval;
        if (!interval) {
            return;
        }

        clearInterval(interval);
        if (getActiveHeartbeatInterval() === interval) {
            setActiveHeartbeatInterval(null);
        }
        heartbeatInterval = null;
    };

    const clearActiveState = () => {
        stopHeartbeat();
        if (getActiveBatchId() === batchId) {
            setActiveBatchId(null);
        }
    };

    const recordBatchTimelineEvent = async (event, data = {}) => {
        try {
            // Separate known schema fields from ad-hoc details
            const { model, host, prompt_id, prompt_level, duration_ms, tokens_per_sec, time_to_first_token_ms, success, error, ...extras } = data;
            const entry = {
                batchId,
                timestamp: new Date(),
                event,
                model: model ?? null,
                host: host ?? null,
                prompt_id: prompt_id ?? null,
                prompt_level: prompt_level ?? null,
                duration_ms: duration_ms ?? null,
                tokens_per_sec: tokens_per_sec ?? null,
                time_to_first_token_ms: time_to_first_token_ms ?? null,
                success: success ?? null,
                error: error ?? null
            };
            if (Object.keys(extras).length > 0) {
                entry.details = extras;
            }
            await BenchmarkTimelineEntry.create(entry);
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $set: { last_activity_at: new Date() } }
            );
        } catch (err) {
            logger.debug('Failed to record timeline event', {
                batchId,
                event,
                error: err.message
            });
        }
    };

    const progressFlushThreshold = executionMode === 'throughput' ? 8 : 4;
    const progressFlushIntervalMs = 1500;
    const pendingBatchProgress = {
        completed: 0,
        failed: 0,
        results: [],
        dirtySince: 0
    };

    function queueBatchProgress(resultSummary, { failed = false } = {}) {
        pendingBatchProgress.completed += 1;
        if (failed) {
            pendingBatchProgress.failed += 1;
        }
        pendingBatchProgress.results.push(resultSummary);
        if (!pendingBatchProgress.dirtySince) {
            pendingBatchProgress.dirtySince = Date.now();
        }
    }

    async function flushBatchProgress(force = false) {
        if (pendingBatchProgress.completed === 0 && pendingBatchProgress.results.length === 0) {
            return;
        }

        const ageMs = pendingBatchProgress.dirtySince
            ? (Date.now() - pendingBatchProgress.dirtySince)
            : 0;

        if (!force && pendingBatchProgress.results.length < progressFlushThreshold && ageMs < progressFlushIntervalMs) {
            return;
        }

        const results = pendingBatchProgress.results.slice();
        const completed = pendingBatchProgress.completed;
        const failed = pendingBatchProgress.failed;
        const update = {
            $inc: { completed },
            $set: { last_activity_at: new Date() }
        };

        if (failed > 0) {
            update.$inc.failed = failed;
        }
        if (results.length > 0) {
            update.$push = {
                results: {
                    $each: results,
                    $slice: -1000
                }
            };
        }

        try {
            admissionHeartbeat.assertActive();
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                update,
                { signal: admissionAbort.signal }
            );
            admissionHeartbeat.assertActive();
        } catch (error) {
            if (admissionAbort.signal.aborted || admissionHeartbeat.getFailure?.()) {
                // Counter acknowledgement is ambiguous at lease loss. Mark the
                // projection non-terminal and recoverable from result rows;
                // never publish it as completed evidence.
                try {
                    await BenchmarkBatch.updateOne(
                        { _id: batchId, status: { $in: ['pending', 'running', 'judging'] } },
                        {
                            $set: {
                                status: 'interrupted',
                                failure_reason: 'authority_lost_during_progress_write',
                                authority_state: 'authority_invalidated',
                                authority_reconciliation_reason: 'authority_lost_during_progress_write',
                                last_activity_at: new Date(),
                                current_test: buildIdleCurrentTest(),
                                active_slot: null,
                                execution_pid: null
                            }
                        }
                    );
                } catch (compensationError) {
                    markReconciliationPending(error, compensationError, 'BATCH_PROGRESS_RECONCILIATION_PENDING', {
                        workloadId: String(batchId), batchId, resultId: batchId, phase: 'batch progress'
                    });
                }
            }
            throw error;
        }

        pendingBatchProgress.completed = 0;
        pendingBatchProgress.failed = 0;
        pendingBatchProgress.results = [];
        pendingBatchProgress.dirtySince = 0;
    }

    try {
        admissionHeartbeat.assertActive();
        await recordBatchTimelineEvent('prep_start', {
            model: judgeConfig.model || JUDGE_CONFIG.model,
            success: true
        });

        const setBatchPhase = (phase, detail = null) =>
            _setBatchPhase(BenchmarkBatch, batchId, phase, detail);
        await setBatchPhase('preparing', 'Building host plan and resolving prompts…');

        heartbeatInterval = setInterval(async () => {
            try {
                const heartbeatUpdate = await BenchmarkBatch.updateOne(
                    { _id: batchId, status: { $in: ['running', 'judging', 'completed'] } },
                    { $set: { last_activity_at: new Date() } }
                );
                if ((heartbeatUpdate && heartbeatUpdate.matchedCount) === 0) {
                    stopHeartbeat();
                }
            } catch (err) {
                logger.warn('Heartbeat failed', { batchId, error: err.message });
            }
        }, 10000);
        setActiveHeartbeatInterval(heartbeatInterval);

        const plannedRepeats = Math.max(1, Math.min(5, Number(executionConfig.repeats) || 1));
        const plannedTotalTests = models.length * prompts.length * plannedRepeats;
        if (plannedTotalTests > 0) {
            const priorTotalTests = batch.total_tests;
            batch.total_tests = plannedTotalTests;
            admissionHeartbeat.assertActive();
            try {
                await batch.save({ signal: admissionAbort.signal });
                admissionHeartbeat.assertActive();
            } catch (error) {
                try {
                    await BenchmarkBatch.updateOne(
                        { _id: batchId, total_tests: plannedTotalTests },
                        { $set: { total_tests: priorTotalTests } }
                    );
                } catch (compensationError) {
                    markReconciliationPending(error, compensationError, 'BATCH_PLAN_RECONCILIATION_PENDING', {
                        workloadId: String(batchId), batchId, resultId: batchId, phase: 'batch plan'
                    });
                }
                throw error;
            }
        }

        const orchestrationOutcome = await runBatchOrchestrator({
            batchId,
            defaultHost,
            models,
            targets: options.targets || batch.targets || [],
            spendGrant: options.spend_grant || batch.spend_grant || null,
            qualityCohortFingerprint: options.quality_cohort_fingerprint || batch.quality_cohort_fingerprint || null,
            batchContractFingerprint: options.batch_contract_fingerprint || batch.batch_contract_fingerprint || null,
            prompts,
            judgeConfig,
            executionConfig,
            executionMode,
            recordBatchTimelineEvent,
            queueBatchProgress,
            flushBatchProgress,
            setBatchPhase,
            handleGracefulStop: clearActiveState
        });
        hostLifecycleRestored = true;
        admissionHeartbeat.assertActive();

        await flushBatchProgress(true);

        if (orchestrationOutcome?.stopped) {
            const stoppedSnapshot = await BenchmarkBatch.findById(batchId).select('status').lean();
            terminalStatePersisted = ['stopped', 'failed', 'completed', 'interrupted'].includes(stoppedSnapshot?.status);
            return orchestrationOutcome;
        }

        const finalSnapshot = await BenchmarkBatch.findById(batchId);
        if (finalSnapshot) {
            const outcome = deriveTerminalBatchOutcome({
                totalTests: finalSnapshot.total_tests,
                completed: finalSnapshot.completed,
                failed: finalSnapshot.failed
            });
            const completedAt = new Date();
            // Finalization is one conditional transition. A stop that wins
            // before this write cannot be overwritten by a stale document
            // save; a completion that wins first makes a later stop idempotent.
            const finalBatch = await BenchmarkBatch.findOneAndUpdate(
                {
                    _id: batchId,
                    status: { $in: ['pending', 'running', 'judging'] }
                },
                {
                    $set: {
                        status: outcome.status,
                        failure_reason: outcome.failureReason || null,
                        completed_at: completedAt,
                        last_activity_at: completedAt,
                        current_test: buildIdleCurrentTest(),
                        active_slot: null,
                        execution_pid: null
                    }
                },
                { new: true }
            );

            if (!finalBatch) {
                logger.info('Skipped batch finalization because a terminal transition already won', {
                    batchId
                });
                const terminalSnapshot = await BenchmarkBatch.findById(batchId).select('status').lean();
                terminalStatePersisted = ['stopped', 'failed', 'completed', 'interrupted'].includes(terminalSnapshot?.status);
                return;
            }
            terminalStatePersisted = true;

            if (outcome.failureReason === 'zero_cells_executed') {
                logger.error('Batch finalized with zero cells executed — host or model orchestration silently failed', {
                    batchId,
                    totalTests: finalBatch.total_tests
                });
            }
            await finalBatch.calculateMetrics();

            logger.info('Batch completed with metrics', {
                batchId,
                total_duration: finalBatch.execution_metrics?.total_duration_ms,
                tests_per_minute: finalBatch.execution_metrics?.tests_per_minute
            });

            const completedTests = finalBatch.completed || 0;
            const failedTests = finalBatch.failed || 0;
            emitBuddyEvent(
                'batch_completed',
                'benchmark',
                `Benchmark batch done: ${completedTests} tests, ${failedTests} failed`
            );

            try {
                await updateHardwareProfiles(batchId);
            } catch (err) {
                logger.warn('Failed to update hardware profiles', {
                    batchId,
                    error: err.message
                });
            }
        }
    } catch (err) {
        hostLifecycleRestored = err?.hostLifecycleRestored === true;
        admissionRetentionRequired = err?.retainAdmission === true;
        const authorityLost = admissionAbort.signal.aborted
            || admissionHeartbeat.getFailure?.()
            || err?.code === 'BENCHMARK_CLAIM_LOST'
            || err?.code === 'BENCHMARK_CLAIM_STOPPED';
        if (authorityLost) {
            throw (err?.retainAdmission === true
                ? err
                : admissionAbort.signal.reason instanceof Error
                ? admissionAbort.signal.reason
                : admissionHeartbeat.getFailure?.() || err);
        }
        await flushBatchProgress(true).catch((flushErr) => {
            logger.warn('Failed to flush pending batch progress after crash', {
                batchId,
                error: flushErr.message
            });
        });

        const failedAt = new Date();
        let failureTransition;
        let terminalPersistenceError = null;
        try {
            failureTransition = await BenchmarkBatch.updateOne(
                {
                    _id: batchId,
                    status: { $in: ['pending', 'running', 'judging'] }
                },
                {
                    $set: {
                        status: 'failed',
                        judge_status: 'failed',
                        authority_state: 'authority_invalidated',
                        authority_reconciliation_reason: 'execution_crash',
                        completed_at: failedAt,
                        last_activity_at: failedAt,
                        current_test: buildIdleCurrentTest(),
                        active_slot: null,
                        execution_pid: null
                    }
                }
            );
        } catch (persistErr) {
            terminalPersistenceError = persistErr;
            failureTransition = null;
            logger.error('Failed to persist batch crash state', {
                batchId,
                error: persistErr.message
            }
            );
        }

        if (terminalPersistenceError) {
            markReconciliationPending(err, terminalPersistenceError, 'BATCH_TERMINAL_RECONCILIATION_PENDING', {
                workloadId: String(batchId), batchId, resultId: batchId, phase: 'batch terminal persistence'
            });
            admissionRetentionRequired = true;
        }

        // A concurrent user stop is a successful terminal transition, not a
        // crash. Never overwrite it or emit misleading failure telemetry.
        if (failureTransition && failureTransition.matchedCount === 0) {
            let terminalBatch = null;
            try {
                terminalBatch = await BenchmarkBatch.findById(batchId)
                    .select('status')
                    .lean();
            } catch (_lookupErr) {
                terminalBatch = null;
            }
            if (terminalBatch?.status === 'stopped') {
                terminalStatePersisted = true;
                logger.info('Suppressed batch crash because user stop won the terminal race', {
                    batchId
                });
                return { stopped: true, cancelled: true };
            }
        }
        if (failureTransition && failureTransition.matchedCount !== 0) {
            terminalStatePersisted = true;
        }

        logger.error('Batch execution crashed', {
            batchId,
            error: err.message,
            stack: err.stack
        });

        emitBuddyEvent(
            'batch_failed',
            'benchmark',
            `Benchmark batch crashed: ${(err.message || 'unknown').slice(0, 120)}`,
            'high'
        );

        await BenchmarkTimelineEntry.create({
            batchId,
            timestamp: new Date(),
            event: 'execution_crash',
            success: false,
            error: err.message
        }).catch(() => {}); // best-effort

        throw err;
    } finally {
        const authorityLost = admissionAbort.signal.aborted || admissionHeartbeat.getFailure?.();
        if (!authorityLost) {
            await flushBatchProgress(true).catch((flushErr) => {
                logger.warn('Failed to flush pending batch progress during cleanup', {
                    batchId,
                    error: flushErr.message
                });
            });
        }
        // Maintenance may proceed only after every claimed host has been
        // restored under its fence and the terminal batch transition is
        // durable. A failed restore or failed terminal write intentionally
        // leaves the global admission recoverable until its TTL/reaper path.
        if (!authorityLost && !admissionRetentionRequired && hostLifecycleRestored && terminalStatePersisted) {
            admissionHeartbeat.assertActive();
            try {
                const released = await releaseWorkloadAdmission(String(batchId));
                if (released?.released !== true) {
                    throw new Error(released?.reason || 'Workload admission release was not acknowledged');
                }
                await admissionHeartbeat.drain();
            } catch (releaseError) {
                logger.error('Benchmark terminal state persisted but workload admission release failed', {
                    batchId,
                    reason: releaseError.message
                });
                retainAdmissionHeartbeat(admissionHeartbeat, options.execution_config?.estimated_duration_ms || null, {
                    workloadId: String(batchId),
                    phase: 'terminal_release'
                });
            }
        } else {
            retainAdmissionHeartbeat(admissionHeartbeat, options.execution_config?.estimated_duration_ms || null, {
                workloadId: String(batchId),
                phase: authorityLost ? 'authority_lost' : 'terminal_reconciliation'
            });
        }
        clearActiveState();
    }
}

module.exports = { executeBatch };
