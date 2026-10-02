/**
 * Executes one local Ollama benchmark prompt through Core inference and
 * persists its result. Created per batch by the orchestrator.
 */

const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { withBenchmarkServiceAuth } = require('../../helpers/coreServiceAuth');

// Benchmark test runs route through core's /api/inference/generate. The
// proxy applies a caller-aware lane policy:
// the scoped Benchmark credential plus `callerDetail: 'benchmark-batch-<id>'`
// selects the **direct lane** —
// no probe, no admission gate, no Mongo lookups, async telemetry write.
// This delivers full direct-bypass throughput WITHOUT losing inference
// telemetry; verified end-to-end on 2026-04-30 (p50 68.63 tok/s on
// gemma4:26b L1, 14/14 telemetry rows landed).
const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const { buildPromptHints } = require('./config');
const { classifyBenchmarkError } = require('./errorClassifier');
const { extractThinkingBlocks } = require('../../helpers/ollamaResponseHandler');
const { benchmarkFetch: fetch } = require('./http');
const { persistSuccessfulResult, persistFailedResult } = require('./batchResultPersistence');
const { promptExecConfig } = require('./inferenceContractSnapshot');
const { registerActiveBatchController, wasControllerStoppedByUser } = require('./batchRequestRegistry');

function createPromptExecutor(context) {
    const executePrompt = async ({
        hostUrl,
        judgeHostUrl,
        model,
        prompt,
        currentBatch,
        testNumber,
        modelExecConfig: modelConfig,
        hardwareSnapshot,
        modelWarmupData,
        performanceBaseline,
        pendingModelTimeline,
        repeatIndex = 0,
        repeatTotal = 1,
        repeatGroupId = null,
        executionTarget = null
    }) => {
        const {
            batchId,
            judgeConfig,
            queueBatchProgress,
            flushBatchProgress,
            qualityCohortFingerprint,
            batchCancellationController,
            claimIdentityFor,
            hasLocalHarness,
            shouldPersistCurrentTest,
            shouldStopBatch,
            enqueueJudgeTask,
            deferJudgeTask,
            assertClaimActive
        } = context;
        const start = Date.now();
        const modelExecConfig = promptExecConfig(modelConfig, prompt), think = modelExecConfig.think === true;
        let testController = null;
        let frozenPromptText = prompt.prompt;

        try {
            pendingModelTimeline.push({
                timestamp: new Date(),
                event: 'test_start',
                model,
                prompt_id: prompt._id ? prompt._id.toString() : null,
                prompt_level: prompt.level,
                success: null
            });
            if (shouldPersistCurrentTest()) {
                await currentBatch.updateCurrentTest(
                    model,
                    prompt._id ? prompt._id.toString() : null,
                    prompt.name,
                    'executing',
                    {
                        testNumber,
                        promptLevel: prompt.level,
                        recordTimeline: false,
                        promptCategory: prompt.category || null,
                        promptText: (prompt.prompt || '').substring(0, 500)
                    }
                );
            }

            const numPredict = modelExecConfig.response_max_tokens || 32000;
            const promptHints = buildPromptHints(
                prompt.prompt,
                prompt.expected_tokens || null,
                numPredict,
                modelExecConfig
            );
            const promptText = promptHints.promptText;
            frozenPromptText = promptText;
            const hintApplied = promptHints.applied;
            const hintText = promptHints.hintText;
            const ollamaOptions = { num_predict: numPredict };
            if (modelExecConfig.num_ctx) ollamaOptions.num_ctx = modelExecConfig.num_ctx;
            // Pin sampling params for fairness across models/hosts. Without these,
            // each Modelfile contributes its own defaults and Ollama version drift
            // contributes more — score variance partly reflects RNG, not skill.
            if (Number.isFinite(modelExecConfig.temperature)) ollamaOptions.temperature = modelExecConfig.temperature;
            if (Number.isFinite(modelExecConfig.top_p)) ollamaOptions.top_p = modelExecConfig.top_p;
            if (Number.isFinite(modelExecConfig.top_k)) ollamaOptions.top_k = modelExecConfig.top_k;
            if (Number.isFinite(modelExecConfig.repeat_penalty)) ollamaOptions.repeat_penalty = modelExecConfig.repeat_penalty;
            if (Number.isFinite(modelExecConfig.seed)) ollamaOptions.seed = modelExecConfig.seed;

            const useChat = modelExecConfig.api_mode !== 'generate';
            const sendThink = modelExecConfig.send_think !== false;
            const url = `${CORE_URL}/api/inference/generate`;
            const requestBody = {
                model,
                host: hostUrl,
                stream: false,
                responseMode: 'normalized',
                callerDetail: `benchmark-batch-${batchId}`,
                ...(claimIdentityFor(hostUrl) || {}),
                options: ollamaOptions,
                ...(sendThink ? {
                    suppressThinking: !think,
                    includeThinking: think,
                    think
                } : {}),
                ...(useChat
                    ? { messages: [{ role: 'user', content: promptText }] }
                    : { prompt: promptText })
            };

            // Re-check immediately before registering the request. Once this
            // await resolves there is no event-loop yield between registration
            // and fetch, so a concurrent stop either sees the controller or has
            // already persisted a stopped status here.
            if (await shouldStopBatch(model, { force: true })) {
                return { infraError: false, stopped: true, cancelled: true };
            }

            testController = new AbortController();
            const fetchOptions = getFetchOptions(url, {
                method: 'POST',
                headers: withBenchmarkServiceAuth({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(requestBody),
                signal: testController.signal
            });

            let response;
            let data;
            const testTimeoutId = setTimeout(() => testController.abort(), modelExecConfig.per_test_timeout_ms || 600000);
            const unregisterController = registerActiveBatchController(batchId, testController);
            try {
                response = await fetch(url, fetchOptions);
                // Headers alone do not complete a request. Keep the timeout and
                // stop registry active until the response body is consumed.
                try {
                    data = await response.json();
                } catch (error) {
                    if (!response.ok) {
                        error.message = `HTTP ${response.status}: Core inference returned a non-JSON error response`;
                    }
                    throw error;
                }
            } finally {
                clearTimeout(testTimeoutId);
                unregisterController();
            }

            // A body implementation may resolve concurrently with abort
            // delivery. Preserve the user's stop decision in that race.
            if (wasControllerStoppedByUser(testController)) {
                return { infraError: false, stopped: true, cancelled: true };
            }

            if (!response.ok || data?.status === 'error' || data?.ok === false) {
                const detail = data?.message
                    || (typeof data?.error === 'string' ? data.error : data?.error?.message)
                    || 'Core inference request failed';
                const error = new Error(`HTTP ${response.status}: ${String(detail).slice(0, 1000)}`);
                error.code = data?.code || 'CORE_INFERENCE_FAILED';
                throw error;
            }

            const latency = Date.now() - start;
            const responseText = useChat ? (data.message?.content || '') : (data.response || '');
            const tokenEstimateText = `${responseText || ''}${data.thinking || data.message?.thinking || ''}`;
            const tokens = data.eval_count || Math.ceil(tokenEstimateText.length / 4);
            // Non-streamed batch execution cannot observe wall-to-wall TTFT.
            // Preserve Ollama's prompt evaluation duration under its truthful
            // name and leave the legacy TTFT field null.
            const promptEvalDurationMs = data.prompt_eval_duration > 0
                ? Number((data.prompt_eval_duration / 1e6).toFixed(1))
                : null;
            const timeToFirstTokenMs = null;
            const tokensPerSec = (tokens > 0 && latency > 0)
                ? Number((tokens / (latency / 1000)).toFixed(2))
                : 0;
            const responseTruncated = data.done_reason === 'length';

            if (responseTruncated) {
                logger.warn('Model response truncated', {
                    model,
                    prompt_name: prompt.name,
                    tokens,
                    num_predict: numPredict,
                    done_reason: data.done_reason
                });
            }

            // Silent input truncation detection. Ollama drops prompt tokens when
            // num_ctx < (prompt_tokens + num_predict) without raising an error —
            // the model emits a confident, plausible-sounding answer to a
            // truncated prompt, and the judge can't tell it didn't see the full
            // question. We compare prompt_eval_count to the available input
            // budget (num_ctx − num_predict) and flag when usage hits the
            // ceiling, which is the signature of silent truncation.
            const promptEvalCount = Number(data.prompt_eval_count) || 0;
            const ctxUsed = modelExecConfig.num_ctx || null;
            const inputBudget = ctxUsed ? Math.max(0, ctxUsed - numPredict) : null;
            // ~96% of budget = budget exhausted. False positives possible on
            // prompts that legitimately fill the window, but those still warrant
            // review (the judge can't trust the answer either way).
            const inputTruncated = !!(inputBudget && promptEvalCount > 0 && promptEvalCount >= Math.floor(inputBudget * 0.96));
            if (inputTruncated) {
                logger.warn('Suspected silent input truncation', {
                    model,
                    prompt_name: prompt.name,
                    prompt_eval_count: promptEvalCount,
                    num_ctx: ctxUsed,
                    num_predict: numPredict,
                    input_budget: inputBudget
                });
            }

            const hasRawEmptyResponse = !responseText || responseText.trim().length === 0;
            if (hasRawEmptyResponse) {
                logger.warn('Model produced empty response', {
                    model,
                    prompt_name: prompt.name,
                    prompt_level: prompt.level,
                    prompt_category: prompt.category,
                    done_reason: data.done_reason,
                    eval_count: data.eval_count,
                    latency_ms: latency,
                    host: hostUrl,
                    api_mode: useChat ? 'chat' : 'generate'
                });
            }

            // A successful HTTP response without content or completion
            // evidence cannot be graded. Its cause is still unknown.
            const looksLikeNoRun =
                hasRawEmptyResponse &&
                (tokens === 0 || !data.eval_count) &&
                !data.done_reason;
            if (looksLikeNoRun) {
                const err = new Error(
                    `Inference returned no content or completion evidence (0 tokens, ${latency}ms). ` +
                    `The runtime cause is unknown.`
                );
                err.name = 'ModelDidNotRunError';
                err.infra = true;
                throw err;
            }

            const thinkingExtraction = extractThinkingBlocks(responseText, data.thinking || null);
            const cleanedResponse = thinkingExtraction.content;
            const extractedThinking = thinkingExtraction.thinking;
            const hasEmptyResponse = !cleanedResponse || cleanedResponse.trim().length === 0;

            if (extractedThinking) {
                logger.debug('Extracted thinking from response', {
                    model,
                    prompt_name: prompt.name,
                    thinking_length: extractedThinking.length,
                    cleaned_response_length: cleanedResponse.length
                });
            }
            if (!hasRawEmptyResponse && hasEmptyResponse) {
                logger.warn('Model produced no visible response after thinking extraction', {
                    model,
                    prompt_name: prompt.name,
                    prompt_level: prompt.level,
                    prompt_category: prompt.category,
                    done_reason: data.done_reason,
                    eval_count: data.eval_count,
                    thinking_length: extractedThinking ? extractedThinking.length : 0,
                    latency_ms: latency,
                    host: hostUrl,
                    api_mode: useChat ? 'chat' : 'generate'
                });
            }

            // Progressive update: mark as responded with preview data for live detail cards
            if (shouldPersistCurrentTest()) {
                await currentBatch.updateCurrentTestStage('responded', {
                    response_preview: cleanedResponse.substring(0, 300),
                    latency,
                    tokens,
                    tokens_per_sec: tokensPerSec,
                    time_to_first_token_ms: null,
                    prompt_eval_duration_ms: promptEvalDurationMs
                }).catch(err => logger.debug('Failed to update responded stage', { error: err.message }));
            }

            const resultId = await persistSuccessfulResult({
                batchId,
                judgeConfig,
                queueBatchProgress,
                flushBatchProgress,
                model,
                hostUrl,
                judgeHostUrl,
                prompt,
                promptText,
                latency,
                tokens,
                tokensPerSec,
                timeToFirstTokenMs,
                promptEvalDurationMs,
                cleanedResponse,
                extractedThinking,
                hasEmptyResponse,
                responseTruncated,
                doneReason: data.done_reason,
                numPredict,
                hintApplied,
                hintText,
                answerContract: promptHints.answerContract,
                lengthHintApplied: promptHints.lengthHintApplied,
                hardwareSnapshot,
                modelWarmupData,
                performanceBaseline,
                currentBatch,
                pendingModelTimeline,
                inputTruncated,
                promptEvalCount,
                inputBudget,
                executionSettings: {
                    sampling_profile: modelExecConfig.sampling_profile || 'controlled',
                    sampling_source: modelExecConfig.sampling_source || 'controlled_override',
                    num_ctx: ctxUsed,
                    num_ctx_source: modelExecConfig.num_ctx_source || null,
                    think,
                    think_mode: modelExecConfig.think_mode || (think ? 'on' : 'off'),
                    think_resolved_by: modelExecConfig.think_resolved_by || null,
                    thinking_profile_policy: modelExecConfig.thinking_profile_policy || null,
                    thinking_profile_host_id: modelExecConfig.thinking_profile_host_id || null,
                    thinking_profile_model_name: modelExecConfig.thinking_profile_model_name || null,
                    thinking_policy_reason: modelExecConfig.thinking_policy_reason || null,
                    thinking_final_answer_policy: modelExecConfig.thinking_final_answer_policy || null,
                    thinking_final_answer_text: promptHints.thinkingFinalAnswerContract?.text || null,
                    temperature: ollamaOptions.temperature ?? null,
                    top_p: ollamaOptions.top_p ?? null,
                    top_k: ollamaOptions.top_k ?? null,
                    repeat_penalty: ollamaOptions.repeat_penalty ?? null,
                    seed: ollamaOptions.seed ?? null,
                    rankable_mode: modelExecConfig.rankable_mode === true,
                    inference_contract_fingerprint: modelExecConfig.inference_contract_fingerprint || null,
                    inference_contract_request_fingerprint: modelExecConfig.inference_contract_request_fingerprint || null,
                    artifact_digest: modelExecConfig.artifact_digest || null
                },
                repeatIndex,
                repeatTotal,
                repeatGroupId,
                executionTarget,
                qualityCohortFingerprint,
                signal: batchCancellationController.signal,
                assertAuthorityActive: assertClaimActive
            });

            if (!hasEmptyResponse) {
                if (hasLocalHarness || judgeHostUrl === hostUrl) {
                    deferJudgeTask({ hostUrl, judgeHostUrl, model, prompt, resultId });
                } else {
                    await enqueueJudgeTask(model, prompt, judgeHostUrl, resultId);
                }
            }
        } catch (err) {
            if (wasControllerStoppedByUser(testController) || batchCancellationController.signal.aborted) {
                logger.info('Cancelled in-flight benchmark request after user stop', {
                    batchId,
                    model,
                    prompt: prompt.name,
                    host: hostUrl
                });
                return { infraError: false, stopped: true, cancelled: true };
            }

            const classified = classifyBenchmarkError(err);
            await persistFailedResult({
                batchId,
                judgeConfig,
                queueBatchProgress,
                flushBatchProgress,
                model,
                hostUrl,
                judgeHostUrl,
                prompt,
                promptText: frozenPromptText,
                err,
                errorDuration: Date.now() - start,
                currentBatch,
                pendingModelTimeline,
                repeatIndex,
                repeatTotal,
                repeatGroupId,
                executionSettings: {
                    sampling_profile: modelExecConfig.sampling_profile || 'controlled',
                    sampling_source: modelExecConfig.sampling_source || 'controlled_override',
                    think,
                    think_mode: modelExecConfig.think_mode || null,
                    rankable_mode: modelExecConfig.rankable_mode === true,
                    inference_contract_fingerprint: modelExecConfig.inference_contract_fingerprint || null,
                    inference_contract_request_fingerprint: modelExecConfig.inference_contract_request_fingerprint || null,
                    artifact_digest: modelExecConfig.artifact_digest || null
                },
                executionTarget,
                qualityCohortFingerprint,
                signal: batchCancellationController.signal,
                assertAuthorityActive: assertClaimActive
            });
            if (classified.infra) return { infraError: true };
        }
        // A stop can arrive after the result was persisted while an async judge
        // task is being scheduled. Treat that edge as cancelled before the
        // prompt loop records a resumable checkpoint or starts more work.
        if (batchCancellationController.signal.aborted) {
            return { infraError: false, stopped: true, cancelled: true };
        }
        return { infraError: false };
    };
    return executePrompt;
}

module.exports = { createPromptExecutor };
