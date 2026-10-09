/**
 * Runs every prompt of one harness benchmark target through the harness
 * broker and persists its results. Created per batch by the orchestrator.
 */

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { buildPromptHints, seedForRepeat } = require('./config');
const { persistSuccessfulResult, persistFailedResult } = require('./batchResultPersistence');
const { loadRepoTasks } = require('../qualification/repoTaskFixtures');
const { executionHost } = require('../../../../shared/benchmarkTargetContract');
const { executeHarnessTarget, resolveHarnessTarget } = require('./harnessBrokerClient');
const { registerActiveBatchController, wasControllerStoppedByUser } = require('./batchRequestRegistry');

function createHarnessTargetRunner(context) {
    const runHarnessTarget = async (selectedTarget) => {
        const {
            batchId,
            prompts,
            executionConfig,
            judgeConfig,
            queueBatchProgress,
            flushBatchProgress,
            recordBatchTimelineEvent,
            setBatchPhase,
            spendGrant,
            qualityCohortFingerprint,
            batchContractFingerprint,
            batchCancellationController,
            claimIdentityFor,
            hasLocalHarness,
            completedPairs,
            executionState,
            resolveJudgeTargetForHost,
            enqueueJudgeTask,
            deferJudgeTask,
            shouldStopBatch,
            loadCurrentBatch,
            flushModelTimeline,
            assertClaimActive,
            claimedHostUrls
        } = context;
        const target = await resolveHarnessTarget(selectedTarget, { force: true });
        const hostUrl = executionHost(target);
        const judgeHostUrl = await resolveJudgeTargetForHost(hostUrl, { warmup: !hasLocalHarness });
        const currentBatch = await loadCurrentBatch(target.model);
        if (!currentBatch) return { stopped: true, cancelled: false };
        const pendingModelTimeline = [];
        const repeats = Math.max(1, Math.min(5, Number(executionConfig.repeats) || 1));

        try {
            for (const prompt of prompts) {
                const repeatGroupId = `${batchId}:${target.id}:${prompt.name || prompt._id}`;
                for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
                    const pairKey = `${target.id}::${prompt.name}::r${repeatIndex}`;
                    if (completedPairs.has(pairKey)) continue;
                    if (await shouldStopBatch(target.model, { force: true })) {
                        return { stopped: true, cancelled: batchCancellationController.signal.aborted };
                    }

                    if (!executionState.testsStarted) {
                        executionState.testsStarted = true;
                        await recordBatchTimelineEvent('tests_start', { success: true });
                        await setBatchPhase('executing', null);
                    }

                    const startedAt = Date.now();
                    const numPredict = executionConfig.response_max_tokens || 32000;
                    const promptHints = buildPromptHints(
                        prompt.prompt,
                        prompt.expected_tokens || null,
                        numPredict,
                        executionConfig
                    );
                    const controller = new AbortController();
                    const unregisterController = registerActiveBatchController(batchId, controller);
                    const timeoutId = setTimeout(
                        () => controller.abort(),
                        executionConfig.per_test_timeout_ms || 600000
                    );
                    let execution = null;
                    try {
                        pendingModelTimeline.push({
                            timestamp: new Date(), event: 'test_start', model: target.model,
                            host: hostUrl, prompt_id: prompt._id ? prompt._id.toString() : null,
                            prompt_level: prompt.level, success: null
                        });
                        const repoTask = prompt.evaluation_authority === 'executable'
                            ? loadRepoTasks().find(task => task.id === prompt.executable_fixture_id) : null;
                        if (prompt.evaluation_authority === 'executable' && !repoTask) throw new Error('Product repository fixture is unavailable');
                        execution = await executeHarnessTarget({
                            batchId,
                            batchFingerprint: batchContractFingerprint,
                            cellId: `${target.id}:${prompt._id || prompt.name}:${repeatIndex}`,
                            target,
                            repoFixture: repoTask ? { id: repoTask.id, fingerprint: repoTask.fixtureFingerprint } : null,
                            promptText: promptHints.promptText,
                            parameters: {
                                temperature: executionConfig.temperature,
                                topP: executionConfig.top_p,
                                seed: seedForRepeat(executionConfig, repeatIndex),
                                maxTokens: numPredict,
                                timeoutMs: executionConfig.per_test_timeout_ms || 600000,
                                thinking: executionConfig.think === true
                            },
                            spendGrant,
                            runtimeClaims: target.tier === 'local'
                                ? claimedHostUrls.map(host => ({ host, ...claimIdentityFor(host) })) : [],
                            role: 'candidate',
                            signal: controller.signal
                        });
                        const usage = execution.receipt.usage;
                        const cleanedResponse = execution.output;
                        const resultId = await persistSuccessfulResult({
                            batchId,
                            judgeConfig,
                            queueBatchProgress,
                            flushBatchProgress,
                            model: target.model,
                            hostUrl,
                            judgeHostUrl,
                            prompt,
                            promptText: promptHints.promptText,
                            latency: usage.durationMs || (Date.now() - startedAt),
                            tokens: usage.outputTokens,
                            tokensPerSec: usage.durationMs > 0 ? usage.outputTokens / (usage.durationMs / 1000) : null,
                            timeToFirstTokenMs: null,
                            cleanedResponse,
                            extractedThinking: execution.thinking || '',
                            hasEmptyResponse: cleanedResponse.trim().length === 0,
                            responseTruncated: execution.finishReason === 'length',
                            doneReason: execution.finishReason,
                            numPredict,
                            hintApplied: promptHints.applied,
                            hintText: promptHints.hintText,
                            answerContract: promptHints.answerContract,
                            lengthHintApplied: promptHints.lengthHintApplied,
                            hardwareSnapshot: null,
                            modelWarmupData: null,
                            performanceBaseline: null,
                            currentBatch,
                            pendingModelTimeline,
                            inputTruncated: false,
                            promptEvalCount: usage.inputTokens,
                            inputBudget: executionConfig.input_token_ceiling || null,
                            executionSettings: {
                                sampling_profile: executionConfig.sampling_profile || 'controlled',
                                sampling_source: executionConfig.sampling_source || 'controlled_override',
                                num_ctx: target.contextWindow,
                                num_ctx_source: 'target_catalog',
                                think: executionConfig.think === true,
                                think_mode: executionConfig.think_mode || (executionConfig.think === true ? 'on' : 'off'),
                                temperature: executionConfig.temperature ?? null,
                                top_p: executionConfig.top_p ?? null,
                                seed: seedForRepeat(executionConfig, repeatIndex),
                                rankable_mode: true,
                                inference_contract_fingerprint: target.profile.fingerprint,
                                artifact_digest: execution.receipt.identity.model.digest || null
                            },
                            repeatIndex,
                            repeatTotal: repeats,
                            repeatGroupId: repeats > 1 ? repeatGroupId : null,
                            executionTarget: target,
                            executionReceipt: execution.publicReceipt,
                            providerUsage: usage,
                            providerCost: {
                                estimated: target.pricing?.estimated === true && usage.costSource !== 'provider-reported',
                                costNanodollars: usage.costNanodollars,
                                pricing: target.pricing,
                                observedAt: new Date().toISOString()
                            },
                            qualityCohortFingerprint,
                            signal: batchCancellationController.signal,
                            assertAuthorityActive: assertClaimActive
                        });
                        if (cleanedResponse.trim()) {
                            if (hasLocalHarness || judgeHostUrl === hostUrl) deferJudgeTask({ hostUrl, judgeHostUrl, model: target.model, prompt, resultId });
                            else await enqueueJudgeTask(target.model, prompt, judgeHostUrl, resultId);
                        }
                    } catch (error) {
                        if (wasControllerStoppedByUser(controller) || batchCancellationController.signal.aborted) {
                            return { stopped: true, cancelled: true };
                        }
                        await persistFailedResult({
                            batchId, judgeConfig, queueBatchProgress, flushBatchProgress,
                            model: target.model, hostUrl, judgeHostUrl, prompt, err: error,
                            errorDuration: Date.now() - startedAt, currentBatch, pendingModelTimeline,
                            repeatIndex, repeatTotal: repeats,
                            repeatGroupId: repeats > 1 ? repeatGroupId : null,
                            executionSettings: {
                                sampling_profile: executionConfig.sampling_profile || 'controlled',
                                sampling_source: executionConfig.sampling_source || 'controlled_override',
                                think: executionConfig.think === true,
                                think_mode: executionConfig.think_mode || (executionConfig.think === true ? 'on' : 'off'),
                                rankable_mode: true,
                                inference_contract_fingerprint: target.profile.fingerprint
                            },
                            executionTarget: target,
                            executionReceipt: execution?.publicReceipt || error.executionReceipt || null,
                            providerUsage: execution?.receipt?.usage || error.executionReceipt?.usage || null,
                            qualityCohortFingerprint,
                            promptText: promptHints.promptText,
                            signal: batchCancellationController.signal,
                            assertAuthorityActive: assertClaimActive
                        });
                    } finally {
                        clearTimeout(timeoutId);
                        unregisterController();
                    }

                    completedPairs.add(pairKey);
                    await BenchmarkBatch.updateOne({ _id: batchId }, {
                        $addToSet: { 'checkpoint.completed_pairs': pairKey },
                        $set: {
                            'checkpoint.last_model': target.id,
                            'checkpoint.last_prompt': prompt.name,
                            'checkpoint.updated_at': new Date()
                        }
                    }).catch(() => {});
                }
            }
            return { stopped: false, cancelled: false };
        } finally {
            await flushModelTimeline(pendingModelTimeline);
        }
    };
    return runHarnessTarget;
}

module.exports = { createHarnessTargetRunner };
