/**
 * Benchmark batch execution internals.
 */

const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { JUDGE_CONFIG } = require('../qualityScorer');
const hardwareProfileService = require('../hardwareProfileService');
const ConcurrencyQueue = require('./ConcurrencyQueue');
const { applyLengthHint } = require('./config');
const { classifyBenchmarkError } = require('./errorClassifier');
const { extractThinkingBlocks } = require('../../helpers/ollamaResponseHandler');
const { warmupModel } = require('./modelWarmup');
const { judgeResult } = require('./judging');
const { benchmarkFetch: fetch } = require('./http');
const { resolveJudgeHost } = require('./judgeHostResolution');

function groupModelsByHost(defaultHost, models) {
    const modelsByHost = {};
    for (const model of models) {
        const targetHost = defaultHost;
        if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
        modelsByHost[targetHost].push(model);
    }
    return modelsByHost;
}

function createCurrentTestPersistenceStrategy(executionMode) {
    let currentTestWriteCount = 0;
    let lastCurrentTestWriteAt = 0;
    const writeEvery = executionMode === 'throughput' ? 3 : 1;
    const minIntervalMs = executionMode === 'throughput' ? 1500 : 0;
    return () => {
        if (executionMode !== 'throughput') return true;
        currentTestWriteCount += 1;
        const now = Date.now();
        const shouldWrite = currentTestWriteCount === 1
            || (currentTestWriteCount % writeEvery === 0)
            || ((now - lastCurrentTestWriteAt) >= minIntervalMs);
        if (shouldWrite) lastCurrentTestWriteAt = now;
        return shouldWrite;
    };
}

async function runBatchOrchestrator({
    batchId,
    defaultHost,
    models,
    prompts,
    judgeConfig,
    executionConfig,
    executionMode,
    getModelExecutionConfig,
    recordBatchTimelineEvent,
    queueBatchProgress,
    flushBatchProgress,
    handleGracefulStop
}) {
    const judgeQueue = new ConcurrencyQueue(executionMode === 'latency' ? 1 : (judgeConfig.concurrency || 2));
    const shouldPersistCurrentTest = createCurrentTestPersistenceStrategy(executionMode);
    const executionState = { testsStarted: false, stopped: false, stopCheckCounter: 0, lastStopCheckAt: 0, stopCheckEvery: 5, stopCheckMinIntervalMs: 2000 };
    const shouldStopBatch = async (model) => {
        if (executionState.stopped) return true;
        executionState.stopCheckCounter += 1;
        const now = Date.now();
        const shouldCheck = executionState.stopCheckCounter === 1
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
    const resolveJudgeTargetForHost = async (hostUrl) => {
        let { judgeHost: judgeHostUrl, effectiveJudgeSameHost, resolution: judgeHostResolution } = resolveJudgeHost(hostUrl, judgeConfig);
        if (judgeHostResolution === 'explicit') {
            logger.info('Using explicit judge host override', { judgeHost: judgeHostUrl, execHost: hostUrl });
        } else if (judgeHostResolution === 'fallback_same_host') {
            logger.info('No separate judge host available, using same-host judging', { host: hostUrl });
        }
        if (!effectiveJudgeSameHost) {
            const judgeModel = judgeConfig.model || JUDGE_CONFIG.model;
            await BenchmarkBatch.findOneAndUpdate({ _id: batchId }, {
                $set: {
                    current_test: { model: judgeModel, stage: 'warmup', prompt_name: judgeHostUrl, started_at: new Date() }
                }
            });
            try {
                await warmupModel(judgeHostUrl, judgeModel, {
                    timelinePrefix: 'judge_warmup',
                    recordTimelineEvent: recordBatchTimelineEvent,
                    strict: true,
                    timeoutOverride: 90000
                });
                logger.info('Judge model ready on separate host', { host: judgeHostUrl, model: judgeModel });
            } catch (warmupErr) {
                logger.warn('Cross-host judge warmup failed, falling back to same-host judging', {
                    judgeHost: judgeHostUrl,
                    execHost: hostUrl,
                    model: judgeModel,
                    error: warmupErr.message
                });
                const originalJudgeHost = judgeHostUrl;
                judgeHostUrl = hostUrl;
                await recordBatchTimelineEvent('judge_warmup_fallback', {
                    model: judgeModel,
                    original_host: originalJudgeHost,
                    fallback_host: hostUrl,
                    error: warmupErr.message
                });
            }
            await BenchmarkBatch.findOneAndUpdate({ _id: batchId }, { $set: { 'current_test.stage': 'idle' } });
        }
        return judgeHostUrl;
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

    const enqueueJudgeTask = async (model, prompt, judgeHostUrl, resultId) => {
        const capturedResultId = resultId.toString();
        const capturedJudgeConfig = { ...judgeConfig, host: judgeHostUrl };

        await judgeQueue.waitForCapacity(10);
        judgeQueue.add(async () => {
            try {
                await judgeResult(capturedResultId, capturedJudgeConfig);
                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    { $inc: { judge_completed: 1 }, $set: { last_activity_at: new Date() } }
                );
            } catch (scoreErr) {
                logger.warn('Pipelined judging failed', {
                    batchId,
                    model,
                    prompt: prompt.name,
                    error: scoreErr.message
                });

                const classifiedJudgeErr = classifyBenchmarkError(scoreErr);
                await BenchmarkResult.updateOne(
                    { _id: capturedResultId },
                    {
                        $set: {
                            scoring_method: 'llm_failed',
                            quality_explanation: scoreErr.message,
                            error: scoreErr.message,
                            infra_error: classifiedJudgeErr.infra,
                            error_type: classifiedJudgeErr.type,
                            error_http_status: classifiedJudgeErr.httpStatus,
                            judge_model: capturedJudgeConfig.model || JUDGE_CONFIG.model,
                            judge_host: capturedJudgeConfig.host || null
                        }
                    }
                ).catch((persistErr) => {
                    logger.warn('Failed to persist pipelined judge failure result', {
                        batchId,
                        resultId: capturedResultId,
                        error: persistErr.message
                    });
                });

                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    { $inc: { judge_completed: 1, judge_failed: 1 } }
                );
            }
        }).catch(async (enqueueErr) => {
            logger.error('Failed to enqueue judge task', {
                batchId,
                model,
                prompt: prompt.name,
                error: enqueueErr.message
            });

            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $inc: { judge_completed: 1, judge_failed: 1 } }
            ).catch(() => {});
        });
    };

    const persistSuccessfulResult = async ({
        model,
        hostUrl,
        judgeHostUrl,
        prompt,
        promptText,
        latency,
        tokens,
        tokensPerSec,
        cleanedResponse,
        extractedThinking,
        hasEmptyResponse,
        responseTruncated,
        doneReason,
        numPredict,
        hintApplied,
        hintText,
        hardwareSnapshot,
        modelWarmupData,
        currentBatch
    }) => {
        const result = new BenchmarkResult({
            model,
            host: hostUrl,
            judge_host: judgeHostUrl,
            prompt: promptText,
            prompt_level: prompt.level,
            prompt_category: prompt.category,
            prompt_name: prompt.name,
            expected_answer: prompt.expected_answer,
            judge_criteria: prompt.judge_criteria,
            latency,
            tokens,
            tokens_per_sec: tokensPerSec,
            response: cleanedResponse,
            thinking: extractedThinking,
            success: true,
            batch_id: batchId,
            timestamp: new Date(),
            quality_score: hasEmptyResponse ? 0 : null,
            quality_explanation: hasEmptyResponse ? 'Model produced empty response' : null,
            scoring_method: hasEmptyResponse ? 'empty_response' : 'pending',
            judge_model: judgeConfig.model || JUDGE_CONFIG.model,
            hardware_snapshot: hardwareSnapshot,
            truncation: {
                response_truncated: responseTruncated,
                response_tokens: tokens,
                response_limit: numPredict,
                done_reason: doneReason || null
            },
            execution_settings: {
                num_predict: numPredict,
                hint_applied: hintApplied,
                hint_text: hintText
            },
            warmup: modelWarmupData ? {
                prompt: modelWarmupData.prompt,
                response: modelWarmupData.response,
                latency_ms: modelWarmupData.latency_ms,
                already_loaded: modelWarmupData.already_loaded
            } : null
        });

        await result.save();
        await currentBatch.recordTestComplete(
            model,
            prompt._id ? prompt._id.toString() : null,
            latency,
            true,
            null,
            prompt.level,
            hostUrl,
            tokensPerSec
        );

        currentBatch.completed = (currentBatch.completed || 0) + 1;
        queueBatchProgress({
            model,
            host: hostUrl,
            judge_host: judgeHostUrl,
            prompt_name: prompt.name,
            success: true,
            latency,
            response_preview: cleanedResponse.substring(0, 100) + '...'
        });
        await flushBatchProgress();

        logger.info('Batch test completed', { batchId, model, prompt: prompt.name, latency });
        return result._id;
    };

    const persistFailedResult = async ({ model, hostUrl, judgeHostUrl, prompt, err, errorDuration, currentBatch }) => {
        const classified = classifyBenchmarkError(err);

        try {
            const result = new BenchmarkResult({
                model,
                host: hostUrl,
                prompt: prompt.prompt,
                prompt_level: prompt.level,
                prompt_category: prompt.category,
                prompt_name: prompt.name,
                error: err.message,
                infra_error: classified.infra,
                error_type: classified.type,
                error_http_status: classified.httpStatus,
                success: false,
                batch_id: batchId,
                timestamp: new Date(),
                quality_score: null,
                scoring_method: 'exec_failed',
                judge_model: judgeConfig.model || JUDGE_CONFIG.model,
                judge_host: judgeHostUrl
            });

            await result.save();
            await currentBatch.recordTestComplete(
                model,
                prompt._id ? prompt._id.toString() : null,
                errorDuration,
                false,
                err,
                prompt.level,
                hostUrl,
                null
            );

            currentBatch.completed = (currentBatch.completed || 0) + 1;
            queueBatchProgress(
                { model, prompt_name: prompt.name, success: false, error: err.message },
                { failed: true }
            );
            await flushBatchProgress();

            logger.error('Batch test failed', { batchId, model, prompt: prompt.name, error: err.message });
        } catch (saveErr) {
            logger.error('Failed to save error result', {
                batchId,
                model,
                prompt: prompt.name,
                originalError: err.message,
                saveError: saveErr.message
            });
        }
    };

    const executePrompt = async ({
        hostUrl,
        judgeHostUrl,
        model,
        prompt,
        currentBatch,
        testNumber,
        modelExecConfig,
        hardwareSnapshot,
        modelWarmupData
    }) => {
        const start = Date.now();

        try {
            if (shouldPersistCurrentTest()) {
                await currentBatch.updateCurrentTest(
                    model,
                    prompt._id ? prompt._id.toString() : null,
                    prompt.name,
                    'executing',
                    { testNumber, promptLevel: prompt.level }
                );
            }

            const numPredict = modelExecConfig.response_max_tokens || 32000;
            const promptText = applyLengthHint(
                prompt.prompt,
                prompt.expected_tokens || null,
                numPredict,
                modelExecConfig
            );
            const hintApplied = promptText !== prompt.prompt;
            const hintText = hintApplied ? promptText.slice(prompt.prompt.length).trim() : null;
            const testController = new AbortController();
            const testTimeoutId = setTimeout(
                () => testController.abort(),
                modelExecConfig.per_test_timeout_ms || 600000
            );
            const ollamaOptions = { num_predict: numPredict };
            if (modelExecConfig.num_ctx) ollamaOptions.num_ctx = modelExecConfig.num_ctx;

            const useChat = modelExecConfig.api_mode !== 'generate';
            const url = `${hostUrl}/api/${useChat ? 'chat' : 'generate'}`;
            const requestBody = useChat
                ? { model, messages: [{ role: 'user', content: promptText }], stream: false, options: ollamaOptions }
                : { model, prompt: promptText, stream: false, options: ollamaOptions };
            const fetchOptions = getFetchOptions(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: testController.signal
            });

            let response;
            try {
                response = await fetch(url, fetchOptions);
            } finally {
                clearTimeout(testTimeoutId);
            }

            const data = await response.json();
            const latency = Date.now() - start;
            const responseText = useChat ? (data.message?.content || '') : (data.response || '');
            const tokens = data.eval_count || Math.ceil(responseText.length / 4);
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

            const hasEmptyResponse = !responseText || responseText.trim().length === 0;
            if (hasEmptyResponse) {
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

            const thinkingExtraction = extractThinkingBlocks(responseText);
            const cleanedResponse = thinkingExtraction.content;
            const extractedThinking = thinkingExtraction.thinking;

            if (extractedThinking) {
                logger.debug('Extracted thinking from response', {
                    model,
                    prompt_name: prompt.name,
                    thinking_length: extractedThinking.length,
                    cleaned_response_length: cleanedResponse.length
                });
            }

            const resultId = await persistSuccessfulResult({
                model,
                hostUrl,
                judgeHostUrl,
                prompt,
                promptText,
                latency,
                tokens,
                tokensPerSec,
                cleanedResponse,
                extractedThinking,
                hasEmptyResponse,
                responseTruncated,
                doneReason: data.done_reason,
                numPredict,
                hintApplied,
                hintText,
                hardwareSnapshot,
                modelWarmupData,
                currentBatch
            });

            if (!hasEmptyResponse) {
                await enqueueJudgeTask(model, prompt, judgeHostUrl, resultId);
            }
        } catch (err) {
            await persistFailedResult({
                model,
                hostUrl,
                judgeHostUrl,
                prompt,
                err,
                errorDuration: Date.now() - start,
                currentBatch
            });
        }
    };

    const runModelPromptLoop = async (hostUrl, judgeHostUrl, model) => {
        const modelExecConfig = await getModelExecutionConfig(model, executionConfig, hostUrl);
        if (modelExecConfig.num_ctx !== executionConfig.num_ctx) {
            logger.info('Using per-model execution config', {
                model,
                num_ctx: modelExecConfig.num_ctx,
                batch_num_ctx: executionConfig.num_ctx
            });
        }

        const modelWarmupData = await warmupModel(hostUrl, model, {
            timelinePrefix: 'model_warmup',
            recordTimelineEvent: recordBatchTimelineEvent,
            num_ctx: modelExecConfig.num_ctx || null
        });
        const hardwareSnapshot = await hardwareProfileService.detectHardware(hostUrl, model);
        const currentBatch = await loadCurrentBatch(model);
        if (!currentBatch) return;

        for (const prompt of prompts) {
            if (await shouldStopBatch(model)) {
                logger.info('Batch execution stopped by user', { batchId });
                await flushBatchProgress(true);
                handleGracefulStop();
                return;
            }

            if (!executionState.testsStarted) {
                executionState.testsStarted = true;
                await recordBatchTimelineEvent('tests_start', { success: true });
            }

            await executePrompt({
                hostUrl,
                judgeHostUrl,
                model,
                prompt,
                currentBatch,
                testNumber: (currentBatch.completed || 0) + 1,
                modelExecConfig,
                hardwareSnapshot,
                modelWarmupData
            });
        }
    };

    const runHostBatch = async (hostUrl, hostModels) => {
        try {
            const judgeHostUrl = await resolveJudgeTargetForHost(hostUrl);
            for (const model of hostModels) {
                const modelStartedAt = new Date();
                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    { $push: { model_timings: { model, started_at: modelStartedAt, completed_at: null, duration_ms: null } } }
                ).catch((err) => logger.warn('Failed to record model start timing', { batchId, model, error: err.message }));

                await runModelPromptLoop(hostUrl, judgeHostUrl, model);

                const modelCompletedAt = new Date();
                const modelDurationMs = modelCompletedAt - modelStartedAt;
                await BenchmarkBatch.updateOne(
                    { _id: batchId, 'model_timings.model': model },
                    { $set: { 'model_timings.$.completed_at': modelCompletedAt, 'model_timings.$.duration_ms': modelDurationMs } }
                ).catch((err) => logger.warn('Failed to record model complete timing', { batchId, model, error: err.message }));
            }
        } catch (hostErr) {
            logger.error('Host execution failed - continuing with other hosts', {
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
        }
    };

    const drainJudgeQueue = async () => {
        const judgeableFilter = {
            batch_id: batchId,
            success: true,
            response: { $type: 'string', $nin: ['', null] }
        };
        const judgeableCount = await BenchmarkResult.countDocuments(judgeableFilter);

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            { $set: { generated_at: new Date(), judge_total: judgeableCount, judge_status: 'running' } }
        );

        logger.info('Tests done, draining pipelined judge queue', {
            batchId,
            queueStatus: judgeQueue.getStatus()
        });

        const drainResult = await judgeQueue.drain({
            timeoutMs: 30 * 60 * 1000,
            stallTimeoutMs: 2 * 60 * 1000,
            onProgress: (status) => logger.debug('Judge queue progress', { batchId, ...status })
        });

        const [finalJudgeableCount, finalJudgeCompleted, finalJudgeFailed] = await Promise.all([
            BenchmarkResult.countDocuments(judgeableFilter),
            BenchmarkResult.countDocuments({ ...judgeableFilter, scoring_method: { $ne: 'pending' } }),
            BenchmarkResult.countDocuments({ ...judgeableFilter, scoring_method: 'llm_failed' })
        ]);

        if (drainResult.timedOut) {
            logger.error('Judge queue drain timed out', { batchId, reason: drainResult.reason });
        }

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $set: {
                    judge_status: drainResult.timedOut ? 'failed' : 'completed',
                    judge_total: finalJudgeableCount,
                    judge_completed: finalJudgeCompleted,
                    judge_failed: finalJudgeFailed
                }
            }
        );

        logger.info('Judge queue drained', {
            batchId,
            completed: drainResult.completed,
            failed: drainResult.failed,
            authoritative: {
                total: finalJudgeableCount,
                completed: finalJudgeCompleted,
                failed: finalJudgeFailed
            }
        });
    };

    const hostTasks = Object.entries(groupModelsByHost(defaultHost, models))
        .map(([hostUrl, hostModels]) => async () => runHostBatch(hostUrl, hostModels));

    if (executionMode === 'latency') {
        for (const task of hostTasks) await task();
    } else {
        await Promise.all(hostTasks.map((task) => task()));
    }

    await flushBatchProgress(true);
    await drainJudgeQueue();
}

module.exports = { runBatchOrchestrator };
