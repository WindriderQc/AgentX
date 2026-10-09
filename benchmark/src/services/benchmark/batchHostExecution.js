/**
 * Runs the local Ollama models of one host group: baseline, warmup, the
 * prompt/repeat loop with checkpoints, infra recovery and early stop.
 * Created per batch by the orchestrator.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { warmupModel } = require('./modelWarmup');
const { withInference, runPromptAfterYield } = require('./workloadYield');
const { capturePerformanceBaseline } = require('./performanceBaseline');
const { evaluateAndPersistEarlyStop, EARLY_STOP_MIN_JUDGED } = require('./earlyStop');
const buddySurface = require('./buddySurfaceEvents');
const { assertFrozenArtifactDigest, getFrozenModelExecutionConfig } = require('./inferenceContractSnapshot');
const { pairKey: completionPairKey } = require('./resumeRevalidation');

function createHostBatchRunner(context, executePrompt) {
    const runModelPromptLoop = async (hostUrl, judgeHostUrl, model) => {
        const {
            batchId,
            prompts,
            executionConfig,
            recordBatchTimelineEvent,
            setBatchPhase,
            handleGracefulStop,
            batchCancellationController,
            claimIdentityFor,
            localTargetByKey,
            completedPairs,
            isResuming,
            sharedModels,
            resumeRevalidation,
            executionState,
            shouldStopBatch,
            loadCurrentBatch,
            flushModelTimeline,
            assertClaimActive,
            inferenceContractCampaign
        } = context;
        if (await shouldStopBatch(model, { force: true })) {
            logger.info('Skipping model because batch is stopped', { batchId, model, host: hostUrl });
            return { stopped: true, cancelled: false };
        }

        const modelExecConfig = isResuming
            ? await resumeRevalidation.validateModel(
                inferenceContractCampaign,
                model,
                hostUrl,
                executionConfig
            )
            : getFrozenModelExecutionConfig(
                inferenceContractCampaign,
                model,
                hostUrl,
                executionConfig
            );
        if (!isResuming) {
            await assertFrozenArtifactDigest(inferenceContractCampaign, model, hostUrl);
        }
        if (modelExecConfig.num_ctx !== executionConfig.num_ctx) {
            logger.info('Using per-model execution config', {
                model,
                num_ctx: modelExecConfig.num_ctx,
                batch_num_ctx: executionConfig.num_ctx
            });
        }

        await setBatchPhase('baseline', `Performance baseline: ${model} on ${hostUrl}`);
        const performanceBaseline = await capturePerformanceBaseline({
            batchId,
            model,
            hostUrl,
            numCtx: modelExecConfig.num_ctx || null,
            claimIdentity: claimIdentityFor(hostUrl),
            assertClaimActive,
            signal: batchCancellationController.signal
        });
        assertClaimActive();
        if (await shouldStopBatch(model, { force: true })) {
            logger.info('Stopping before model warmup because batch is stopped', { batchId, model, host: hostUrl });
            return { stopped: true, cancelled: false };
        }

        const warmupTimeoutCold = executionConfig.warmup_timeout_cold || 180000;
        const warmupTimeoutLoaded = executionConfig.warmup_timeout_loaded || 90000;
        await setBatchPhase('warmup', `Warming up ${model} on ${hostUrl} (cold ≤${Math.round(warmupTimeoutCold/1000)}s)`);
        const modelWarmupData = await withInference(String(batchId), () => warmupModel(hostUrl, model, {
            timelinePrefix: 'model_warmup',
            recordTimelineEvent: recordBatchTimelineEvent,
            num_ctx: modelExecConfig.num_ctx || null,
            warmupTimeoutCold,
            warmupTimeoutLoaded,
            onPhaseDetail: (detail) => setBatchPhase('warmup', detail),
            claimIdentity: claimIdentityFor(hostUrl),
            assertClaimActive,
            signal: batchCancellationController.signal
        }), { signal: batchCancellationController.signal });
        // Reload the model after an infra error or a household turn (#62).
        const rewarm = timelinePrefix => warmupModel(hostUrl, model, { timelinePrefix, recordTimelineEvent: recordBatchTimelineEvent,
            num_ctx: modelExecConfig.num_ctx || null, onPhaseDetail: (detail) => setBatchPhase('warmup', detail), claimIdentity: claimIdentityFor(hostUrl), assertClaimActive });
        if (await shouldStopBatch(model, { force: true })) {
            logger.info('Stopping after model warmup because batch is stopped', { batchId, model, host: hostUrl });
            return { stopped: true, cancelled: false };
        }

        const hardwareSnapshot = null; // hardware detection now handled by profiler pipeline
        const currentBatch = await loadCurrentBatch(model);
        if (!currentBatch) return;
        const pendingModelTimeline = [];

        const INFRA_ERROR_CIRCUIT_BREAKER_THRESHOLD = 3;
        let consecutiveInfraErrors = 0;

        let earlyStopped = false;
        let promptsCompletedForModel = 0;

        const repeats = Math.max(1, Math.min(5, Number(modelExecConfig.repeats) || 1));

        try {
            for (const prompt of prompts) {
                if (earlyStopped) break;
                // repeat_group_id ties together N runs of the same (model, host, prompt).
                // Stable across the loop so analytics can aggregate variance per group.
                const repeatGroupId = JSON.stringify([batchId, hostUrl, model, prompt.name || prompt._id]);

                for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
                    // Single-host models retain their legacy checkpoint keys.
                    const pairKey = completionPairKey(model, prompt, repeatIndex, sharedModels.has(model) ? hostUrl : null);
                    if (completedPairs.has(pairKey)) continue;

                    if (await shouldStopBatch(model)) {
                        logger.info('Batch execution stopped by user', { batchId });
                        handleGracefulStop();
                        return { stopped: true, cancelled: false };
                    }
                    assertClaimActive();

                    if (consecutiveInfraErrors >= INFRA_ERROR_CIRCUIT_BREAKER_THRESHOLD) {
                        logger.warn(`Circuit breaker: skipping remaining prompts on ${hostUrl} after ${consecutiveInfraErrors} consecutive infra errors`, {
                            batchId,
                            model,
                            host: hostUrl,
                            infraErrorCount: consecutiveInfraErrors
                        });
                        break;
                    }

                    if (!executionState.testsStarted) {
                        executionState.testsStarted = true;
                        await recordBatchTimelineEvent('tests_start', { success: true });
                        await setBatchPhase('executing', null);
                        // Rate-limited: fires once per batch when the run phase begins.
                        buddySurface.emitLifecycle('run_phase', 'Running benchmark prompts across models…');
                    }

                    const execResult = await runPromptAfterYield(String(batchId), {
                        rewarm: () => rewarm('yield_recovery_warmup'), signal: batchCancellationController.signal
                    }, () => executePrompt({
                        hostUrl,
                        judgeHostUrl,
                        model,
                        prompt,
                        currentBatch,
                        testNumber: (currentBatch.completed || 0) + 1,
                        modelExecConfig,
                        hardwareSnapshot,
                        modelWarmupData,
                        performanceBaseline,
                        pendingModelTimeline,
                        repeatIndex,
                        repeatTotal: repeats,
                        repeatGroupId: repeats > 1 ? repeatGroupId : null,
                        executionTarget: localTargetByKey.get(`${hostUrl}\0${model}`) || null
                    }));

                    if (execResult?.stopped || batchCancellationController.signal.aborted) {
                        executionState.stopped = true;
                        logger.info('Batch request cancelled; stopping prompt loop', {
                            batchId,
                            model,
                            prompt: prompt.name,
                            host: hostUrl
                        });
                        handleGracefulStop();
                        return {
                            stopped: true,
                            cancelled: execResult?.cancelled === true || batchCancellationController.signal.aborted
                        };
                    }

                    // Record checkpoint for resume support
                    completedPairs.add(pairKey);
                    BenchmarkBatch.updateOne({ _id: batchId }, {
                        $addToSet: { 'checkpoint.completed_pairs': pairKey },
                        $set: { 'checkpoint.last_model': model, 'checkpoint.last_prompt': prompt.name, 'checkpoint.updated_at': new Date() }
                    }).catch(() => {}); // best-effort, don't block execution

                    if (execResult?.infraError) {
                        consecutiveInfraErrors++;
                        logger.warn('Infra error on prompt — re-warming model before next prompt', { batchId, model, host: hostUrl, consecutiveInfraErrors });
                        try {
                            await setBatchPhase('warmup', `Recovery warmup: ${model} on ${hostUrl}`);
                            await withInference(String(batchId), () => rewarm('infra_recovery_warmup'));
                            await setBatchPhase('executing', null);
                            logger.info('Model recovered after infra error', { batchId, model, host: hostUrl });
                        } catch (recoveryErr) {
                            logger.error('Model recovery warmup failed', { batchId, model, host: hostUrl, error: recoveryErr.message });
                        }
                        // Bail out of repeat loop on infra error — outer prompt loop's
                        // circuit breaker handles whether to continue.
                        break;
                    } else {
                        consecutiveInfraErrors = 0;
                    }

                    promptsCompletedForModel += 1;

                    // Judge runs async; once enough prompts have been generated for
                    // this model, evaluateAndPersistEarlyStop checks already-judged
                    // results in DB and decides whether the running quality average
                    // is low enough to halt remaining prompts for this model only.
                    if (!earlyStopped && promptsCompletedForModel >= EARLY_STOP_MIN_JUDGED) {
                        earlyStopped = await evaluateAndPersistEarlyStop({
                            batchId, model, hostUrl, executionConfig, recordBatchTimelineEvent
                        });
                        if (earlyStopped) break;
                    }
                }
                if (earlyStopped) break;
            }
        } finally {
            await flushModelTimeline(pendingModelTimeline);
        }
    };

    const runHostBatch = async (hostUrl, hostModels) => {
        const {
            batchId,
            recordBatchTimelineEvent,
            hasLocalHarness,
            resolveJudgeTargetForHost,
            shouldStopBatch
        } = context;
        if (await shouldStopBatch(null, { force: true })) {
            return { stopped: true, cancelled: false };
        }

        // Resolve the judge host once per host group. If this fails, the whole
        // host group is unrecoverable (no judge available) — that's the only
        // "host-level" failure left worth aborting the group for.
        let judgeHostUrl;
        try {
            judgeHostUrl = await resolveJudgeTargetForHost(hostUrl, { warmup: !hasLocalHarness });
        } catch (hostErr) {
            logger.error('Host execution failed - judge resolution error, skipping all models on this host', {
                batchId,
                host: hostUrl,
                models: hostModels,
                error: hostErr.message,
                stack: hostErr.stack
            });
            await recordBatchTimelineEvent('host_execution_failed', {
                host: hostUrl,
                models: hostModels,
                error: hostErr.message
            }).catch((err) => logger.error('Failed to record host failure event', { error: err.message }));
            // Whole host group is unrecoverable (no judge) — blocked, not warning.
            // Allowed mid-critical: blocked is never silenced.
            buddySurface.emitLifecycle(
                'run_blocked',
                `Host failed — judge unavailable on ${hostUrl}; skipping ${hostModels.length} model(s).`
            );
            return { stopped: false, cancelled: false };
        }

        // Per-model try/catch so model #1 throwing (typically warmupModel
        // rejecting on cold-load or VRAM exhaustion) doesn't silently skip
        // models #2..N. Pre-fix, a single throw in the outer loop bailed the
        // whole host group; this is what produced a live batch's completed=0/315
        // (symptom-handled by the zero-cells finalizer guard).
        for (const model of hostModels) {
            if (await shouldStopBatch(model, { force: true })) {
                logger.info('Stopping host model loop because batch is stopped', { batchId, host: hostUrl, model });
                return { stopped: true, cancelled: false };
            }

            const modelStartedAt = new Date();
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $push: { model_timings: { model, started_at: modelStartedAt, completed_at: null, duration_ms: null } } }
            ).catch((err) => logger.warn('Failed to record model start timing', { batchId, model, error: err.message }));

            let stopAfterModel = null;
            try {
                const modelResult = await runModelPromptLoop(hostUrl, judgeHostUrl, model);
                if (modelResult?.stopped) {
                    stopAfterModel = modelResult;
                }
            } catch (modelErr) {
                logger.error('Model execution failed - continuing with next model on this host', {
                    batchId,
                    host: hostUrl,
                    model,
                    error: modelErr.message,
                    stack: modelErr.stack
                });
                await recordBatchTimelineEvent('model_execution_failed', {
                    host: hostUrl,
                    model,
                    error: modelErr.message
                }).catch((err) => logger.error('Failed to record model failure event', { error: err.message }));
                // One model failed but the batch continues — warning, not blocked.
                // Allowed mid-critical: warning is never silenced.
                buddySurface.emitLifecycle('run_warning', `Model failed and was skipped: ${model} on ${hostUrl}.`);
                // Resume-blocked errors must fail the whole batch closed, not be
                // swallowed by the per-model catch above.
                if (modelErr.resumeBlocked === true) {
                    throw modelErr;
                }
                // Fall through to record model_timings completion so the failed
                // model shows up in the timeline with a duration.
            }

            const modelCompletedAt = new Date();
            const modelDurationMs = modelCompletedAt - modelStartedAt;
            await BenchmarkBatch.updateOne(
                { _id: batchId, 'model_timings.model': model },
                { $set: { 'model_timings.$.completed_at': modelCompletedAt, 'model_timings.$.duration_ms': modelDurationMs } }
            ).catch((err) => logger.warn('Failed to record model complete timing', { batchId, model, error: err.message }));
            if (stopAfterModel) {
                return stopAfterModel;
            }
        }
        return { stopped: false, cancelled: false };
    };

    return runHostBatch;
}

module.exports = { createHostBatchRunner };
