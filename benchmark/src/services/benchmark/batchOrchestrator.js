/**
 * Benchmark batch execution internals.
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
// hardwareProfileService removed — profiler handles hardware detection now
const ConcurrencyQueue = require('./ConcurrencyQueue');
const { resolveJudgeHost } = require('./judgeHostResolution');
const { batchAdmissionScope } = require('./batchAdmissionScope');
const { groupModelsByHost, createCurrentTestPersistenceStrategy } = require('./batchHelpers');
const { detectDedication } = require('./dedicationLifecycle');
const { findActiveProfilingForHost } = require('../profiler/activeProfileState');
const { createJudgeOrchestrator } = require('./judgeOrchestration');
const {
    acquireBenchmarkClaims,
    releaseBenchmarkClaims,
    estimateBenchmarkClaimDurationMs,
    startBenchmarkClaimHeartbeat
} = require('./benchmarkClaimLifecycle');
const buddySurface = require('./buddySurfaceEvents');
const {
    loadOrResolveCampaignInferenceContracts
} = require('./inferenceContractSnapshot');
const { createResumeRevalidation, RESUME_CODES, pairKey: completionPairKey, modelsOnMultipleHosts } = require('./resumeRevalidation');
const { checkBatchPreflight, executionModelsFromHostGroups, preflightCounts, runBatchPreflight } = require('./batchPreflightLifecycle');
const { normalizeBatchTargets } = require('../../../../shared/benchmarkTargetContract');
const { getBenchmarkClaimIdentity } = require('../../clients/coreApiClient');

const {
    registerActiveBatchController,
    abortActiveBatchRequests,
    getActiveBatchRequestCount
} = require('./batchRequestRegistry');
const { createPromptExecutor } = require('./batchPromptExecutor');
const { createHarnessTargetRunner } = require('./batchHarnessTargetRunner');
const { createHostBatchRunner } = require('./batchHostExecution');

async function runBatchOrchestrator({
    batchId,
    defaultHost,
    models,
    targets = null,
    spendGrant = null,
    qualityCohortFingerprint = null,
    batchContractFingerprint = null,
    prompts,
    judgeConfig,
    executionConfig,
    executionMode,
    recordBatchTimelineEvent,
    queueBatchProgress,
    flushBatchProgress,
    setBatchPhase,
    handleGracefulStop
}) {
    // No-op fallback so older call sites don't crash if setBatchPhase isn't provided.
    if (typeof setBatchPhase !== 'function') {
        setBatchPhase = async () => {};
    }
    if (typeof handleGracefulStop !== 'function') {
        handleGracefulStop = () => {};
    }
    const batchCancellationController = new AbortController();
    let assertClaimActive = () => true;
    const claimIdentityFor = hostUrl => getBenchmarkClaimIdentity(hostUrl, String(batchId));
    let unregisterBatchCancellation = () => false;
    let orchestrationCompleted = false;
    const normalizedTargets = normalizeBatchTargets({ host: defaultHost, models, targets });
    const localTargets = normalizedTargets.filter((target) => target.executionKind === 'ollama');
    const harnessTargets = normalizedTargets.filter((target) => target.executionKind === 'harness');
    const hasLocalHarness = harnessTargets.some(target => target.tier === 'local');
    const localTargetByKey = new Map(localTargets.map((target) => [`${target.host}\0${target.model}`, target]));
    judgeConfig = {
        ...(judgeConfig || {}),
        batch_id: String(batchId),
        batch_contract_fingerprint: batchContractFingerprint,
        spend_grant: spendGrant || null
    };
    const judgeQueue = new ConcurrencyQueue(executionMode === 'latency' ? 1 : (judgeConfig.concurrency || 2));
    const shouldPersistCurrentTest = createCurrentTestPersistenceStrategy(executionMode);
    const judge = createJudgeOrchestrator({
        batchId,
        judgeConfig,
        judgeQueue,
        executionConfig,
        recordBatchTimelineEvent,
        setBatchPhase,
        cancelSignal: batchCancellationController.signal,
        // Sizes the multi-judge escalation budget for the live pipeline —
        // the same role pendingResults.length plays for standalone re-judges.
        expectedJudgeCount: normalizedTargets.length * (prompts?.length || 0)
    });
    const {
        resolveJudgeTargetForHost,
        enqueueJudgeTask,
        deferJudgeTask,
        enqueueDeferredJudgeTasks,
        drainJudgeQueue,
        cancelAndDrainJudgeQueue,
        disposeCancellationListener
    } = judge;

    // Load checkpoint for resume support — skip completed model+prompt pairs
    const batchDoc = await BenchmarkBatch.findById(batchId).select('checkpoint').lean();
    const completedPairs = new Set(batchDoc?.checkpoint?.completed_pairs || []);
    const isResuming = completedPairs.size > 0;
    const lastCheckpointModel = batchDoc?.checkpoint?.last_model || null;
    // Preserve the legacy host/model grouping contract exactly when callers
    // have not opted into BenchmarkTarget v1. Explicit targets are grouped by
    // their own frozen host identity instead.
    const localHostMap = Array.isArray(targets) && targets.length > 0
        ? localTargets.reduce((groups, target) => {
            (groups[target.host] ||= []).push(target.model);
            return groups;
        }, {})
        : groupModelsByHost(defaultHost, models);
    const requestedHostGroups = Object.entries(localHostMap);
    const sharedModels = modelsOnMultipleHosts(requestedHostGroups);
    if (isResuming && [...completedPairs].some(key => [...sharedModels].some(model => key.startsWith(`${model}::`)))) {
        // Old checkpoints omitted the host. Recover their scope from persisted
        // result identity, never credit one host with another host's work.
        const priorResults = await BenchmarkResult.find({ batch_id: batchId, model: { $in: [...sharedModels] } })
            .select('model host prompt_name repeat_index').lean();
        for (const result of priorResults) {
            const prompt = { name: result.prompt_name };
            const repeatIndex = result.repeat_index ?? 0;
            if (result.host && completedPairs.has(completionPairKey(result.model, prompt, repeatIndex))) {
                completedPairs.add(completionPairKey(result.model, prompt, repeatIndex, result.host));
            }
        }
    }
    let executionHostGroups = requestedHostGroups;
    let inferenceContractCampaign = null;
    const resumeRevalidation = isResuming ? createResumeRevalidation({
        batchId, completedPairs, lastCheckpointModel, recordBatchTimelineEvent
    }) : null;

    const executionState = { testsStarted: false, stopped: false, stopCheckCounter: 0, lastStopCheckAt: 0, stopCheckEvery: 5, stopCheckMinIntervalMs: 2000 };
    const shouldStopBatch = async (model, options = {}) => {
        const force = !!options.force;
        if (batchCancellationController.signal.aborted) {
            executionState.stopped = true;
            return true;
        }
        if (executionState.stopped) return true;
        executionState.stopCheckCounter += 1;
        const now = Date.now();
        const shouldCheck = force
            || executionState.stopCheckCounter === 1
            || (executionState.stopCheckCounter % executionState.stopCheckEvery === 0)
            || ((now - executionState.lastStopCheckAt) >= executionState.stopCheckMinIntervalMs);
        if (!shouldCheck) return false;
        executionState.lastStopCheckAt = now;
        try {
            const stopCheck = await BenchmarkBatch.findById(batchId).select('status').lean();
            if (stopCheck && stopCheck.status === 'stopped') {
                executionState.stopped = true;
                return true;
            }
        } catch (err) {
                logger.warn('Failed to check batch status', { batchId, model, error: err.message });
        }
        return false;
    };

    const loadCurrentBatch = async (model) => {
        try {
            const currentBatch = await BenchmarkBatch.findById(batchId);
            if (!currentBatch) {
                logger.error('Batch not found during execution', { batchId, model });
                return null;
            }
            return currentBatch;
        } catch (err) {
            logger.error('Failed to fetch batch object', { batchId, model, error: err.message });
            return null;
        }
    };

    const flushModelTimeline = async (entries) => {
        if (!Array.isArray(entries) || entries.length === 0) {
            return;
        }

        const docs = entries.map(e => ({ ...e, batchId }));
        await BenchmarkTimelineEntry.insertMany(docs, { ordered: false }).catch(() => {});
        await BenchmarkBatch.updateOne(
            { _id: batchId },
            { $set: { last_activity_at: new Date() } }
        );
    };


    // Prompt, harness and host runners read the mutable lifecycle values
    // (claim assertion, frozen campaign, claimed hosts) at call time.
    const executionContext = {
        batchId,
        prompts,
        executionConfig,
        judgeConfig,
        queueBatchProgress,
        flushBatchProgress,
        recordBatchTimelineEvent,
        setBatchPhase,
        handleGracefulStop,
        spendGrant,
        qualityCohortFingerprint,
        batchContractFingerprint,
        batchCancellationController,
        claimIdentityFor,
        hasLocalHarness,
        localTargetByKey,
        shouldPersistCurrentTest,
        resolveJudgeTargetForHost,
        enqueueJudgeTask,
        deferJudgeTask,
        completedPairs,
        isResuming,
        sharedModels,
        resumeRevalidation,
        executionState,
        shouldStopBatch,
        loadCurrentBatch,
        flushModelTimeline,
        get assertClaimActive() { return assertClaimActive; },
        get inferenceContractCampaign() { return inferenceContractCampaign; },
        get claimedHostUrls() { return claimedHostUrls; }
    };
    const executePrompt = createPromptExecutor(executionContext);
    const runHarnessTarget = createHarnessTargetRunner(executionContext);
    const runHostBatch = createHostBatchRunner(executionContext, executePrompt);

    if (isResuming && requestedHostGroups.length > 0) {
        await setBatchPhase('contract', `Resuming: verifying frozen campaign snapshot for ${lastCheckpointModel || 'next model'}…`);
        inferenceContractCampaign = await resumeRevalidation.loadFrozenCampaign({
            hostGroups: requestedHostGroups,
            executionConfig
        });
        executionHostGroups = await resumeRevalidation.selectPendingHostGroups(
            inferenceContractCampaign,
            requestedHostGroups,
            prompts,
            executionConfig
        );
    }

    const executionModels = executionModelsFromHostGroups(executionHostGroups);
    const preflightResult = await checkBatchPreflight({
        batchId,
        executionModels,
        setBatchPhase
    });
    const { allowanceMs: preflightAllowanceMs } = preflightCounts(preflightResult);
    const hostUrls = executionHostGroups.map(([url]) => url);

    // Include judge hosts in dedication detection so pinned models get unloaded there too
    const judgeSourceHosts = hostUrls.length > 0
        ? hostUrls
        : requestedHostGroups.map(([url]) => url);
    const judgeHostUrls = judgeConfig.target?.executionKind === 'harness'
        ? []
        : [...new Set([
            ...judgeSourceHosts.map(url => resolveJudgeHost(url, judgeConfig).judgeHost),
            ...(judgeSourceHosts.length === 0 && judgeConfig.host ? [judgeConfig.host] : [])
        ].filter(Boolean))];
    const allAffectedHosts = [...new Set([...hostUrls, ...judgeHostUrls])];

    // Server-side profiling guard: refuse to start while a profiler run or
    // profile queue owns any affected host. The UI enforces this lockout in
    // the browser, but out-of-band launches (curl, scripts, another tab) must
    // hit the same wall here.
    assertNoActiveProfiling(allAffectedHosts);

    await setBatchPhase('dedication', `Detecting host dedication on ${allAffectedHosts.length} host(s)…`);
    try {
        if (allAffectedHosts.length > 0) {
            await detectDedication(allAffectedHosts, {
                batchId,
                recordBatchTimelineEvent,
                failClosed: isResuming
            });
        }
    } catch (error) {
        await resumeRevalidation.fail(error, RESUME_CODES.PIN_DETECTION_FAILED);
    }

    // Announce to core that these hosts are in use for the duration of the
    // batch. Other consumers (chat, buddy, bounded API clients) can see status==='benchmarking'
    // on HostPreference and route around them. Claiming is a hard startup
    // guard: if any affected host cannot be reserved, the batch aborts before
    // releasing pinned models.
    //
    // Estimate calc: hosts run in parallel (hostGroups), so hostUrls.length
    // is NOT a multiplier. Models on the same host run serially within the
    // host task. We extend the claim through the post-execution judge drain
    // window so the reaper doesn't drop the signal while judge work is still
    // in flight. Core still caps the stored estimate at 2h.
    // Preflight auto-profiling now runs under this claim (see stage 2 below),
    // so its duration must be part of the estimate: a standard profile is
    // ~20 min, plus short orchestration overhead. Core still caps the stored estimate.
    const claimEstimateMs = estimateBenchmarkClaimDurationMs({
        hostCount: hostUrls.length,
        modelCount: executionModels.length,
        promptCount: prompts.length,
        executionConfig,
        executionMode,
        judgeConfig
    }) + preflightAllowanceMs;
    await setBatchPhase('claiming', `Reserving ${allAffectedHosts.length} host(s) with core…`);
    let claimedHostUrls;
    let orchestrationError = null;
    const admissionScope = batchAdmissionScope(normalizedTargets, judgeConfig);
    try {
        claimedHostUrls = await acquireBenchmarkClaims(allAffectedHosts, batchId, claimEstimateMs, {
            kind: admissionScope.kind,
            admissionHosts: admissionScope.hosts,
            sharedHosts: admissionScope.sharedHosts,
            source: 'benchmark'
        });
    } catch (error) {
        if (!isResuming) throw error;
        await resumeRevalidation.fail(error, RESUME_CODES.CLAIM_ACQUISITION_FAILED);
    }
    const stopClaimHeartbeat = startBenchmarkClaimHeartbeat(
        claimedHostUrls,
        batchId,
        claimEstimateMs,
        {
            onFatal: error => {
                if (!batchCancellationController.signal.aborted) {
                    batchCancellationController.abort(error);
                }
                // Child Core and harness requests own separate controllers.
                // Abort the whole registered set immediately on lease loss;
                // waiting for their next checkpoint would let stale work run.
                abortActiveBatchRequests(batchId, {
                    reason: error,
                    userInitiated: false
                });
            }
        }
    );
    await stopClaimHeartbeat.ready;
    try {
        stopClaimHeartbeat.assertActive();
    } catch (error) {
        if (typeof stopClaimHeartbeat.drain === 'function') await stopClaimHeartbeat.drain();
        else stopClaimHeartbeat();
        const cleanup = await releaseBenchmarkClaims(claimedHostUrls, batchId, {
            releaseWorkloadAdmission: false
        });
        if (cleanup.failed > 0) {
            error.retainAdmission = true;
            error.hostRelease = cleanup;
        }
        throw error;
    }
    assertClaimActive = stopClaimHeartbeat.assertActive;
    await recordBatchTimelineEvent('benchmark_claim_acquired', {
        hosts: claimedHostUrls,
        requested: allAffectedHosts,
        estimatedDurationMs: claimEstimateMs
    }).catch(() => {});
    let hostLifecycleFinalized = false;
    const finalizeHostLifecycle = async () => {
        if (hostLifecycleFinalized) {
            return;
        }
        hostLifecycleFinalized = true;
        if (typeof stopClaimHeartbeat.drainHosts === 'function') await stopClaimHeartbeat.drainHosts();

        const release = await releaseBenchmarkClaims(claimedHostUrls, batchId, {
            releaseWorkloadAdmission: false
        });
        if (typeof stopClaimHeartbeat.drain === 'function') await stopClaimHeartbeat.drain();
        else stopClaimHeartbeat();
        await recordBatchTimelineEvent(release.failed > 0 ? 'benchmark_claim_release_failed' : 'benchmark_claim_released', {
            hosts: claimedHostUrls,
            ...(release.failed > 0 ? { failed: release.failed } : {})
        }).catch(() => {});
        if (release.failed > 0) {
            const detail = release.details?.find(item => !item.released);
            const error = new Error(
                detail?.reason
                || release.workloadAdmission?.reason
                || 'Benchmark runtime restore/release failed'
            );
            error.code = 'BENCHMARK_RUNTIME_RESTORE_FAILED';
            error.release = release;
            throw error;
        }
    };

    // Registered only once claim/dedication lifecycle protection exists. From
    // this point a stop aborts both prompt requests and the local judge queue.
    unregisterBatchCancellation = registerActiveBatchController(batchId, batchCancellationController);

    try {
        assertClaimActive();
        // Claimed model/judge warmup owns unloading competing residents and
        // reloading a mismatched context. Do not issue duplicate empty-prompt
        // requests through Core's text-generation endpoint before that step.
        if (isResuming && requestedHostGroups.length > 0) await resumeRevalidation.recordReady(executionHostGroups);
        await runBatchPreflight({
            preflightResult,
            batchId,
            defaultHost,
            setBatchPhase,
            recordBatchTimelineEvent,
            assertClaimActive,
            claimIdentityFor,
            signal: batchCancellationController.signal
        });

        if (!isResuming && requestedHostGroups.length > 0) {
            await setBatchPhase('contract', 'Freezing deployed artifact and inference budgets for this campaign…');
            inferenceContractCampaign = await loadOrResolveCampaignInferenceContracts({
                batchId,
                hostGroups: requestedHostGroups,
                executionConfig,
                recordBatchTimelineEvent
            });
        }
        const hostTasks = executionHostGroups
            .map(([hostUrl, hostModels]) => async () => runHostBatch(hostUrl, hostModels));
        const harnessTasks = harnessTargets.filter(target => target.tier !== 'local')
            .map((target) => async () => runHarnessTarget(target));
        // A local harness routes through Core and may use a direct contender's
        // host. Reuse serial execution for this phase to avoid model/context
        // reload races; independent direct hosts and cloud targets stay parallel.
        const localHarnessTasks = harnessTargets.filter(target => target.tier === 'local')
            .map((target) => async () => runHarnessTarget(target));
        const executionTasks = [...hostTasks, ...harnessTasks];

        const hostOutcomes = [];
        if (executionMode === 'latency') {
            for (const task of executionTasks) {
                const outcome = await task();
                hostOutcomes.push(outcome);
                if (outcome?.stopped) break;
            }
        } else {
            hostOutcomes.push(...await Promise.all(executionTasks.map((task) => task())));
        }
        for (const task of localHarnessTasks) {
            if (hostOutcomes.some(outcome => outcome?.stopped)) break;
            hostOutcomes.push(await task());
        }

        await flushBatchProgress(true);
        const stoppedOutcome = hostOutcomes.find((outcome) => outcome?.stopped);
        const cancelledAfterExecution = hostOutcomes.some((outcome) => outcome?.cancelled === true);
        const stoppedAfterExecution = stoppedOutcome || await shouldStopBatch(null, { force: true });
        if (stoppedAfterExecution) {
            executionState.stopped = true;
            await cancelAndDrainJudgeQueue();
            handleGracefulStop();
            return {
                stopped: true,
                cancelled: cancelledAfterExecution
            };
        }

        await setBatchPhase('judging', 'Draining judge queue…');
        // Enter the critical judge/scoring window. While active, buddySurface
        // suppresses suggesting/idle (quiet-during-critical); watching +
        // warning/blocked still pass. endJudgePhase() runs in finally so a
        // throw mid-drain cannot leave Buddy permanently muted.
        buddySurface.beginJudgePhase();
        buddySurface.emitLifecycle('judge_start', 'Judging responses…');
        try {
            await enqueueDeferredJudgeTasks();
            await drainJudgeQueue();
        } catch (error) {
            if (batchCancellationController.signal.aborted) {
                executionState.stopped = true;
                await cancelAndDrainJudgeQueue(error);
                handleGracefulStop();
                return { stopped: true, cancelled: true };
            }
            throw error;
        } finally {
            buddySurface.emitLifecycle('judge_done', 'Judging complete.');
            buddySurface.endJudgePhase();
        }
        orchestrationCompleted = true;
        return { stopped: false, cancelled: false };
    } catch (error) {
        orchestrationError = error;
        throw error;
    } finally {
        try {
            if (!orchestrationCompleted || executionState.stopped || batchCancellationController.signal.aborted) {
                await cancelAndDrainJudgeQueue();
            } else {
                disposeCancellationListener();
            }
        } finally {
            unregisterBatchCancellation();
            await finalizeHostLifecycle();
            if (orchestrationError) orchestrationError.hostLifecycleRestored = true;
        }
    }
}

/**
 * Throw when any of the given hosts has an active profiler run or profile
 * queue. Server-side counterpart of the browser profiling lockout — the batch
 * must never unload models out from under a running profile.
 */
function assertNoActiveProfiling(hostUrls) {
    for (const hostUrl of hostUrls) {
        const activeProfiling = findActiveProfilingForHost({ hostUrl });
        if (activeProfiling.length > 0) {
            const active = activeProfiling[0];
            const what = active.type === 'profile-host'
                ? `profile queue (${active.currentModel || 'starting'}, ${active.currentIndex + 1}/${active.total})`
                : `profile job (${active.modelName})`;
            const err = new Error(
                `Host ${hostUrl} has an active ${what}. Wait for profiling to finish before launching a benchmark.`
            );
            err.conflict = 'profiling_active';
            err.hostUrl = hostUrl;
            throw err;
        }
    }
}

module.exports = {
    runBatchOrchestrator,
    abortActiveBatchRequests,
    assertNoActiveProfiling,
    // Exposed for unit testing — not part of the stable API
    _registerActiveBatchController: registerActiveBatchController,
    _getActiveBatchRequestCount: getActiveBatchRequestCount,
    _acquireBenchmarkClaims: acquireBenchmarkClaims,
    _releaseBenchmarkClaims: releaseBenchmarkClaims,
    _estimateBenchmarkClaimDurationMs: estimateBenchmarkClaimDurationMs
};
