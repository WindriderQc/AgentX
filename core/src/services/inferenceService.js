'use strict';

const logger = require('../../config/logger');
const { normalizeHostUrl, validateHostUrl } = require('../helpers/ollamaHostConfig');
const { buildRequestSummary, summarizeRecommendation, buildRoutingDifference } = require('./routing/routingTraceSummary');
const { ensureTaskModelOverridesLoaded, getAdvisoryModelForTask, getModelForTask } = require('./modelRouterConfig');
const { getTargetForModel, resolveHostKey } = require('./modelRouter');
const { emit: emitBuddyEvent } = require('./buddyEvents');
const { getModelReadiness } = require('./modelReadinessService');
const { scheduleShadowEvaluation } = require('./routing/shadowEvaluation');
const { DECISION_MODES, REJECTION_REASONS, ROUTE_OUTCOME_CODES, ROUTE_OUTCOME_STAGES, fingerprintRuntimeOptions } = require('./routing/routeDecision');
const { tryDegradedResponse } = require('./routing/degradedRetryResponse');
const { executeAdmittedOllamaAttempt, settleAdmissionFailure } = require('./routing/inferenceAttemptExecutor');
const { buildInferenceClientData, classifyHttpRetryFailure, buildInferenceResponseHeaders, setRouteOutcomeHeader } = require('./routing/inferenceResponsePresenter');
const { prepareInferenceRuntime } = require('./inferenceRuntimePolicy');
const lanePolicy = require('./inferenceLanePolicy');
const { resolveCallerPolicy } = require('./routing/callerPolicy');
const { assertHostAvailableForConsumer } = require('./benchmarkClaimGuard');
const { fallbackAfterRefusal, refusedBeforeDispatch } = require('./routing/taskFallbackLadder');
const { createGenerateRouteDecisionBuilder, observeRouteDecision, createAttemptRecorder } = require('./routing/inferenceRouteRecorder');
const { evaluateResponseAlerts, evaluateTransportFailureAlert } = require('./routing/inferenceAlerts');
const { createGenerateRoutingTrace } = require('./routing/generateRoutingTrace');
const { buildClaimAdmissionRejection } = require('./routing/claimAdmissionRejection');
const { resolveInferenceTimeout } = require('./routing/inferenceTimeoutPolicy');

const LADDER_RETRY = Symbol('taskFallbackLadderRetry');

const INFERENCE_FETCH_TIMEOUT_MS = parseInt(process.env.INFERENCE_FETCH_TIMEOUT_MS, 10) || 600000;

function requireProfiledModels() {
  return process.env.REQUIRE_PROFILED_MODELS === 'true';
}

/** Execute a generation request without HTTP, sockets, or response mutation.
 * Caller policy and attribution are resolved at the transport boundary.
 * An undefined result means the caller cancelled; no response should be sent.
 */
async function executeInference(body = {}, options = {}) {
    const first = await executeInferenceOnce(body, options);
    const failed = first?.[LADDER_RETRY];
    if (!failed || options.signal?.aborted) return first;
    // #135: a light task refused before any output goes to the next rung, once.
    const ladderTarget = await fallbackAfterRefusal(String(body.taskType).trim(), failed);
    return ladderTarget ? executeInferenceOnce(body, { ...options, ladderTarget }) : first;
}

async function executeInferenceOnce(body = {}, {
    callerContext, telemetryContext = { runtime: 'agentx', attempt: 1 },
    consumerContract = null, signal, timeoutMs = INFERENCE_FETCH_TIMEOUT_MS, ladderTarget = null,
} = {}) {
    const headers = {};
    const result = (status, data) => ({ ok: status >= 200 && status < 300, status, body: data, headers });
    const refusedResult = (err, response) => {
        if (lane.route && !requestedModel && !hostOverride && !ladderTarget && taskType && refusedBeforeDispatch(err)) {
            response[LADDER_RETRY] = { model, host: routedHostKey, url: target, degraded: taskFallback };
        }
        return response;
    };
    const isCancelled = () => signal?.aborted === true;
    if (isCancelled()) return undefined;
    if (!callerContext) {
        const policy = resolveCallerPolicy(body.callerDetail || '');
        callerContext = { principal: 'core-inference', requestedPolicy: policy, effectivePolicy: policy };
    }
    const startedAt = Date.now();
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const taskType = typeof body.taskType === 'string' ? body.taskType.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const messages = Array.isArray(body.messages) ? body.messages : null;
    const system = typeof body.system === 'string' ? body.system : undefined;
    const stream = body.stream === true;
    const responseMode = typeof body.responseMode === 'string' ? body.responseMode.trim().toLowerCase() : '';
    const rawResponseRequested = body.rawResponse === true || responseMode === 'raw';
    // num_ctx policy:
    // - explicit caller options always win (benchmark/profiler/direct sweeps)
    // - routed daily lanes may inherit HostPreference.pinnedModels[*].contextSize
    // - routed daily lanes enforce the inference contract's output reserve as
    //   num_predict so Modelfile defaults cannot silently cap replies at 512
    let options = { ...(body.options || {}) };
    let numCtxSource = options.num_ctx != null ? 'caller' : 'modelfile';
    const requestedThink = body.think;
    let think = requestedThink;
    const thinkingMode = body.thinkingMode ?? body.thinking_mode;
    let keepAlive = body.keep_alive ?? body.keepAlive;
    const hostOverride = typeof body.host === 'string' ? body.host.trim() : '';
    const crossModelFallbackOptIn = body.allowCrossModelFallback === true;

    const { name: laneName, policy: lane } = lanePolicy.resolvePolicyLane(
        callerContext.effectivePolicy
    );
    const benchmarkClaimAuthorized = callerContext.principal === 'benchmark-service'
        && laneName === 'direct';
    const requestedTools = body.tools;
    if (requestedTools !== undefined
        && (!benchmarkClaimAuthorized || !Array.isArray(requestedTools) || requestedTools.length > 64)) {
        return result(benchmarkClaimAuthorized ? 400 : 403, {
            status: 'error',
            code: benchmarkClaimAuthorized ? 'INFERENCE_TOOLS_INVALID' : 'INFERENCE_TOOLS_FORBIDDEN',
            message: benchmarkClaimAuthorized
                ? 'Benchmark tool schemas must be a bounded array.'
                : 'Native tool schemas are restricted to an authenticated benchmark campaign.'
        });
    }
    if (callerContext.principal === 'benchmark-service'
        && (!body.workloadAdmissionId || !body.workloadGeneration)) {
        return result(403, {
            status: 'error',
            code: 'BENCHMARK_WORKLOAD_PROOF_REQUIRED',
            message: 'Benchmark inference requires an exact Core-minted workload admission id and generation'
        });
    }
    const routeManaged = lane.route === true && !hostOverride;
    const timeout = resolveInferenceTimeout({
        requestedTimeoutMs: body.timeoutMs, benchmarkAuthorized: benchmarkClaimAuthorized, defaultTimeoutMs: timeoutMs, stream,
    });
    if (timeout.error) return result(timeout.error.status, {
        status: 'error', code: timeout.error.code, message: timeout.error.message,
    });
    timeoutMs = timeout.timeoutMs;

    let model = requestedModel;
    let target = null;
    let routedHostKey = null;
    let safeRequestedHost = null;
    let routingSource = hostOverride ? 'host_override' : 'model_router';
    let taskFallback = null; // set when a fallback ladder rung serves this task (#135)

    let decisionMode = DECISION_MODES.DEFAULT;
    if (hostOverride || (requestedModel && !taskType)) decisionMode = DECISION_MODES.EXPLICIT_MODEL;
    else if (taskType) decisionMode = DECISION_MODES.EXPLICIT_TASK;

    const requestedPolicy = callerContext.requestedPolicy?.id || null;
    const effectivePolicy = callerContext.effectivePolicy?.id || null;
    const policyDowngraded = Boolean(
        requestedPolicy && effectivePolicy && requestedPolicy !== effectivePolicy
    );

    const buildGenerateRouteDecision = createGenerateRouteDecisionBuilder({
        current: () => ({ model, target, routedHostKey, routingSource, safeRequestedHost }),
        startedAt, telemetryContext, decisionMode, taskType, body, consumerContract,
        requestedModel, requestedPolicy, effectivePolicy, laneName, policyDowngraded,
    });

    const observeRouteOutcome = (evidence) => (
        observeRouteDecision(buildGenerateRouteDecision(evidence))
    );

    const rejectRoute = ({ status, payload, ...evidence }) => {
        observeRouteOutcome(evidence);
        setRouteOutcomeHeader(headers, evidence.outcomeCode);
        return result(status, payload);
    };

    try {
    if (!requestedModel && !taskType) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.VALIDATION,
            outcomeCode: ROUTE_OUTCOME_CODES.REQUEST_TARGET_REQUIRED,
            payload: { status: 'error', message: 'model or taskType is required' },
        });
    }
    if (!prompt && !messages) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.VALIDATION,
            outcomeCode: ROUTE_OUTCOME_CODES.REQUEST_PAYLOAD_REQUIRED,
            payload: { status: 'error', message: 'prompt or messages is required' },
        });
    }

    // Allowlist check. When the caller passes a `host` string it
    // MUST resolve to a configured Ollama host (URL allowlist with loopback
    // equivalence, or by host name/id). When the field is absent we fall
    // through to model-router resolution unchanged.
    const generateHostCheck = validateHostUrl(hostOverride);
    if (!generateHostCheck.valid) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.POLICY,
            outcomeCode: ROUTE_OUTCOME_CODES.HOST_OVERRIDE_REJECTED,
            rejections: [{ model: requestedModel || null, reason: REJECTION_REASONS.POLICY_EXCLUDED }],
            payload: { status: 'error', message: generateHostCheck.message },
        });
    }
    const allowlistedHostOverride = generateHostCheck.host || '';
    safeRequestedHost = allowlistedHostOverride || null;
    const routingTrace = createGenerateRoutingTrace({
        requestedModel, taskType, safeRequestedHost, body, laneName, lane, crossModelFallbackOptIn, routeManaged,
    });

    if (lane.route && !model && taskType) {
        await ensureTaskModelOverridesLoaded();
        const configured = getModelForTask(taskType) || {};
        routingTrace.configured = {
            model: configured.model || null,
            host: configured.host || null,
            hostUrl: configured.url || null
        };
        const recommendation = ladderTarget || await getAdvisoryModelForTask(taskType, {
            caller: body.callerDetail || 'inference-proxy',
            durationMs: Number(body.durationMs) || 30000,
            createSoftClaim: true
        });
        routingTrace.recommendation = summarizeRecommendation(recommendation);
        model = recommendation.model;
        target = hostOverride
            ? normalizeHostUrl(allowlistedHostOverride)
            : normalizeHostUrl(recommendation.url);
        routedHostKey = hostOverride ? resolveHostKey(target) : (recommendation.host || resolveHostKey(target));
        routingSource = hostOverride ? 'host_override' : (recommendation.source || 'task_router');
        taskFallback = hostOverride ? null : (recommendation.degraded || null);
    } else if (!lane.route && !model && taskType) {
        // Direct lane: bench/profiler must specify model + host explicitly.
        // We do not run task→model routing for direct callers — they self-route.
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.POLICY,
            outcomeCode: ROUTE_OUTCOME_CODES.DIRECT_MODEL_REQUIRED,
            rejections: [{ reason: REJECTION_REASONS.POLICY_EXCLUDED }],
            payload: {
                status: 'error',
                message: 'direct-lane callers must specify `model` (and optionally `host`); taskType routing is not run for this lane'
            },
        });
    } else {
        target = hostOverride
            ? normalizeHostUrl(allowlistedHostOverride)
            : normalizeHostUrl(getTargetForModel(model));
        routedHostKey = resolveHostKey(target);
        routingTrace.recommendation = hostOverride ? null : {
            model,
            host: routedHostKey || null,
            hostUrl: target,
            source: 'model_target',
            reason: 'Selected from model-to-host routing because no task-only recommendation was requested.',
            claimId: null,
            claimExpiresAt: null,
            readiness: null,
            scheduler: null
        };
    }

    if (!target) {
        const blockedByClaim = routingTrace.recommendation?.source === 'scheduler-blocked'
            || routingTrace.recommendation?.scheduler?.blockedByBenchmarkClaim === true;
        return rejectRoute({
            status: blockedByClaim ? 503 : 500,
            outcomeStage: ROUTE_OUTCOME_STAGES.SELECTION,
            outcomeCode: blockedByClaim
                ? ROUTE_OUTCOME_CODES.BENCHMARK_CLAIMED
                : ROUTE_OUTCOME_CODES.NO_HOST_AVAILABLE,
            rejections: [{
                model: model || null,
                reason: blockedByClaim
                    ? REJECTION_REASONS.BENCHMARK_CLAIMED
                    : REJECTION_REASONS.HOST_UNCONFIGURED,
            }],
            payload: {
                status: 'error',
                code: blockedByClaim ? 'NO_UNCLAIMED_OLLAMA_HOST' : undefined,
                message: blockedByClaim
                    ? (routingTrace.recommendation?.reason || `No unclaimed Ollama host available for request: ${taskType || model}`)
                    : `No Ollama host configured for request: ${taskType || model}`
            },
        });
    }

    try {
        await assertHostAvailableForConsumer(target, {
            callerDetail: body.callerDetail || null,
            claimBatchId: body.claimBatchId || null,
            claimGeneration: body.claimGeneration || null,
            workloadAdmissionId: body.workloadAdmissionId || null,
            workloadGeneration: body.workloadGeneration || null,
            benchmarkAuthorized: benchmarkClaimAuthorized,
            model,
            path: '/api/inference/generate'
        });
    } catch (err) {
        return refusedResult(err, rejectRoute(buildClaimAdmissionRejection(err, {
            headers, target, routedHostKey, model, laneName,
        })));
    }

    // Exact-artifact invariant: never rewrite the caller-selected model tag.
    if (body.useAdapted === true) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.POLICY,
            outcomeCode: ROUTE_OUTCOME_CODES.ADAPTED_MODEL_RETIRED,
            rejections: [{
                model,
                host: routedHostKey || resolveHostKey(target),
                hostUrl: target,
                reason: REJECTION_REASONS.POLICY_EXCLUDED,
            }],
            payload: {
                status: 'error',
                code: 'ADAPTED_MODEL_RESOLUTION_RETIRED',
                message: 'useAdapted is retired; request the exact installed model tag explicitly'
            },
        });
    }
    const artifactResolution = {
        source: 'exact_artifact',
        requested: model,
        resolved: model,
        rewritten: false
    };
    routingTrace.artifactResolution = artifactResolution;

    if (lane.route && requireProfiledModels()) {
        const readinessState = await getModelReadiness(model, target);
        if (readinessState.readiness?.isReady !== true) {
            return rejectRoute({
                status: 409,
                outcomeStage: ROUTE_OUTCOME_STAGES.QUALIFICATION,
                outcomeCode: ROUTE_OUTCOME_CODES.MODEL_PROFILE_REQUIRED,
                rejections: [{
                    model,
                    host: routedHostKey || resolveHostKey(target),
                    hostUrl: target,
                    reason: REJECTION_REASONS.CAPABILITY_UNQUALIFIED,
                }],
                payload: {
                    status: 'error',
                    message: `Model "${model}" is not profiled on the selected host. Enable profiling first or disable REQUIRE_PROFILED_MODELS.`,
                    data: {
                        model,
                        host: target,
                        readiness: readinessState.readiness
                    }
                },
            });
        }
    }

    const runtime = await prepareInferenceRuntime({
        model, host: target, prompt, messages, system, tools: requestedTools, options, keepAlive,
        think, thinkingMode, taskType, callerDetail: body.callerDetail,
        laneName, rawResponseRequested, stream,
        includeArtifactIdentity: requireProfiledModels(),
    }, lane.route ? 'generate' : 'direct');
    ({ options, keepAlive, numCtxSource } = runtime);
    const { inferenceContract, thinkingPolicy } = runtime;
    if (numCtxSource === 'host_preference_pin') routingSource += '+pin-ctx';
    if (requireProfiledModels() && inferenceContract.qualification?.qualified !== true) {
        return rejectRoute({
            status: 409,
            outcomeStage: ROUTE_OUTCOME_STAGES.QUALIFICATION,
            outcomeCode: ROUTE_OUTCOME_CODES.ARTIFACT_QUALIFICATION_REQUIRED,
            rejections: [{
                model,
                host: routedHostKey || resolveHostKey(target),
                hostUrl: target,
                reason: REJECTION_REASONS.CAPABILITY_UNQUALIFIED,
            }],
            payload: {
                status: 'error',
                code: 'EXACT_ARTIFACT_PROFILE_REQUIRED',
                message: `Model "${model}" is not qualified for this exact host digest/runtime. Re-profile it before inference.`,
                data: { model, host: target, qualification: inferenceContract.qualification, artifact: inferenceContract.artifact }
            },
        });
    }
    think = thinkingPolicy.think;
    routingTrace.thinking = thinkingPolicy;
    routingTrace.inferenceContract = inferenceContract;

    // Choose Ollama API: /api/chat if messages provided, else /api/generate
    const useChat = !!messages;
    const ollamaUrl = `${target}/api/${useChat ? 'chat' : 'generate'}`;

    const ollamaPayload = useChat
        ? {
            model,
            messages,
            stream,
            options,
            ...(requestedTools !== undefined && { tools: requestedTools }),
            ...(think !== undefined && { think }), ...(body.format !== undefined && { format: body.format }), // Ollama structured output
            ...(keepAlive !== undefined && { keep_alive: keepAlive })
        }
        : { model, prompt, system, stream, options, ...(think !== undefined && { think }), ...(body.format !== undefined && { format: body.format }), ...(keepAlive !== undefined && { keep_alive: keepAlive }) };
    routingTrace.request.summary = buildRequestSummary({ prompt, messages, system, options, stream, think, keepAlive });
    routingTrace.selected = {
        model,
        hostKey: routedHostKey || resolveHostKey(target) || null,
        hostUrl: target,
        routingSource
    };
    routingTrace.ollama = {
        api: useChat ? 'chat' : 'generate',
        endpoint: `/api/${useChat ? 'chat' : 'generate'}`,
        url: ollamaUrl,
        stream,
        thinkConfigured: think !== undefined,
        keepAliveConfigured: keepAlive !== undefined,
        optionsFingerprint: fingerprintRuntimeOptions(options)
    };
    routingTrace.difference = buildRoutingDifference(routingTrace);

    // Admission gate — per-(host, model) semaphore. Streaming is tracked too:
    // benchmark claims must drain every already-admitted inference before Core
    // snapshots and mutates Ollama residency. Bypassing streams made that
    // snapshot race an unobservable long-running generation.
    //
    // Lane policy:
    //   - direct lane: skip admission (bench/profiler self-sequence per host)
    //   - interactive: KEEP admission — load-bearing for cron fairness
    //   - automated:   keep admission
    const skipGate = !lane.admit;

    const dispatchAttemptRecord = createAttemptRecorder({
        lane, inferenceContract, taskFallback, routingSource, buildGenerateRouteDecision,
        body, consumerContract, telemetryContext, laneName, taskType,
    });

    let primaryAttemptRecorded = false;
    const dispatchPrimaryAttemptRecord = (entry) => {
        primaryAttemptRecorded = true;
        return dispatchAttemptRecord(entry);
    };
    const recordClientCancellation = () => {
        if (primaryAttemptRecorded) return;
        dispatchPrimaryAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            durationMs: Date.now() - startedAt,
            status: 'error',
            error: 'Inference request cancelled: caller disconnected',
            outcomeCode: ROUTE_OUTCOME_CODES.CALLER_DISCONNECTED,
            outcomeReasonCode: 'caller_disconnected',
        });
    };

    const attemptDegradedResponse = (failure) => tryDegradedResponse({
        failure,
        body,
        consumerContract,
        telemetryContext,
        taskType,
        model,
        target,
        options,
        numCtxSource,
        artifactResolution,
        ollamaPayload,
        useChat,
        prompt,
        messages,
        system,
        requestedThink,
        thinkingMode,
        lane,
        laneName,
        rawResponseRequested,
        stream,
        skipGate,
        routingSource,
        routingTrace,
        requestedModel,
        dispatchAttemptRecord,
        observeRouteDecision,
        buildRoutingDifference,
        timeoutMs,
        routeManaged,
        signal,
        callerPrincipal: callerContext.principal,
    });

    try {
        const primaryAttempt = await executeAdmittedOllamaAttempt({
            hostUrl: target,
            model,
            payload: ollamaPayload,
            useChat,
            stream,
            skipGate,
            timeoutMs,
            signal,
            principal: callerContext.principal,
            workloadAdmissionId: body.workloadAdmissionId || null,
            workloadGeneration: body.workloadGeneration || null,
            admissionKind: `inference-${laneName}${stream ? '-stream' : ''}`, cacheLabels: { consumerContract, taskType },
            afterAdmission: () => assertHostAvailableForConsumer(target, {
                callerDetail: body.callerDetail || null,
                claimBatchId: body.claimBatchId || null,
                claimGeneration: body.claimGeneration || null,
                workloadAdmissionId: body.workloadAdmissionId || null,
                workloadGeneration: body.workloadGeneration || null,
                benchmarkAuthorized: benchmarkClaimAuthorized,
                model,
                path: '/api/inference/generate:post-admission'
            })
        });
        const { response, raw, data } = primaryAttempt;

        if (isCancelled()) {
            recordClientCancellation();
            return undefined;
        }

        Object.assign(headers, buildInferenceResponseHeaders({
            model,
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            routingSource,
            laneName,
            rawResponseRequested,
            stream,
            thinkingPolicy,
            inferenceContract,
            taskType,
            taskFallback,
            routeOutcomeCode: response.ok
                ? ROUTE_OUTCOME_CODES.EXECUTION_SUCCEEDED
                : ROUTE_OUTCOME_CODES.UPSTREAM_ERROR,
        }));

        const primaryRouteDecision = dispatchPrimaryAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptData: data,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            waits: primaryAttempt.waits, promptCache: primaryAttempt.promptCache,
            durationMs: Date.now() - startedAt,
            status: response.ok ? 'success' : 'error',
            outcomeReasonCode: response.ok ? null : `upstream_http_${response.status}`,
        });
        observeRouteDecision(primaryRouteDecision);

        evaluateResponseAlerts({ lane, response, startedAt, routedHostKey, target, model, body, taskType, laneName });

        if (!response.ok) {
            if (isCancelled()) return undefined;
            const degradedResult = await attemptDegradedResponse(
                classifyHttpRetryFailure(response.status, data, raw)
            );
            if (isCancelled()) return undefined;
            if (degradedResult.response) return degradedResult.response;
            if (degradedResult.routeDecision) observeRouteDecision(degradedResult.routeDecision);
            else observeRouteOutcome({
                    outcomeStage: ROUTE_OUTCOME_STAGES.FALLBACK,
                    outcomeCode: degradedResult.outcomeCode,
                    outcomeReasonCode: degradedResult.reasonCode,
                });
            setRouteOutcomeHeader(headers, degradedResult.outcomeCode);
            emitBuddyEvent('inference_error', 'infrastructure', 'Inference failed: ' + model + ' (' + response.status + ')', 'high');
            if (isCancelled()) return undefined;
            return result(response.status, {
                status: 'error',
                message: data?.error || raw || 'Ollama request failed',
            });
        }

        const clientData = buildInferenceClientData(
            data,
            model,
            inferenceContract,
            body,
            rawResponseRequested,
            stream,
            taskFallback
        );
        if (isCancelled()) return undefined;

        // Shadow route evaluation, deliberately AFTER the reply is
        // sent. Inline it would add a Mongo read and a scoring pass to the
        // hottest path on the platform, and any bug in it would become a
        // user-visible failure. Deferred, the worst case is a missing
        // comparison sample. No-op unless ROUTE_RESOLVER_SHADOW is enabled.
        scheduleShadowEvaluation(
            { model, hostUrl: target },
            {
                taskType: taskType || null,
                requestedModel: requestedModel || null,
                caller: 'proxy',
                callerDetail: body.callerDetail || null,
                correlationId: telemetryContext.correlationId,
                cloudEligible: false,
                requiredContextTokens: options.num_ctx,
            }
        );
        return result(200, clientData);
    } catch (err) {
        const settled = settleAdmissionFailure(err, {
            cancelled: isCancelled(), onCancelled: recordClientCancellation, host: target, model, lane: laneName,
        });
        if (settled.cancelled) return undefined;
        if (settled.response) return result(settled.response.status, settled.response.body);

        // A claim, hold or admission refusal before dispatch is a busy answer
        // with its own code, not a response-processing fault.
        if (err.isOllamaAttemptError !== true && refusedBeforeDispatch(err)) {
            return refusedResult(err, rejectRoute(buildClaimAdmissionRejection(err, {
                headers, target, routedHostKey, model, laneName,
            })));
        }

        if (err.isOllamaAttemptError !== true) {
            logger.error('[InferenceProxy] response processing failed', {
                host: target,
                model,
                error: err.message,
            });
            observeRouteOutcome({
                outcomeStage: ROUTE_OUTCOME_STAGES.EXECUTION,
                outcomeCode: ROUTE_OUTCOME_CODES.RESPONSE_PROCESSING_ERROR,
            });
            setRouteOutcomeHeader(headers, ROUTE_OUTCOME_CODES.RESPONSE_PROCESSING_ERROR);
            return result(500, { status: 'error', message: 'Inference response processing failed' });
        }

        const isTimeout = err.isOllamaTimeout === true || err.name === 'AbortError';
        if (isTimeout) {
            logger.warn('[InferenceProxy] fetch timeout — gate slot released', {
                host: target, model, timeoutMs, lane: laneName
            });
        }

        const primaryFailureDecision = dispatchPrimaryAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            waits: err.inferenceWaits, promptCache: err.inferencePromptCache,
            durationMs: Date.now() - startedAt,
            status: isTimeout ? 'timeout' : 'error',
            error: isTimeout ? `fetch_timeout_${timeoutMs}ms` : err.message,
            outcomeReasonCode: isTimeout
                ? `fetch_timeout_${timeoutMs}ms`
                : 'connection_failure',
        });
        observeRouteDecision(primaryFailureDecision);

        evaluateTransportFailureAlert({ lane, isTimeout, err, routedHostKey, target, model, taskType, laneName });

        const degradedResult = await attemptDegradedResponse(
            isTimeout
                ? { kind: 'timeout', streamStarted: false }
                : { kind: 'connection' }
        );
        if (isCancelled()) return undefined;
        if (degradedResult.response) return degradedResult.response;
        if (degradedResult.routeDecision) observeRouteDecision(degradedResult.routeDecision);
        else observeRouteOutcome({
                outcomeStage: ROUTE_OUTCOME_STAGES.FALLBACK,
                outcomeCode: degradedResult.outcomeCode,
                outcomeReasonCode: degradedResult.reasonCode,
            });
        setRouteOutcomeHeader(headers, degradedResult.outcomeCode);

        emitBuddyEvent('inference_error', 'infrastructure',
            isTimeout
                ? 'Inference timeout: ' + model + ' @ ' + target
                : 'Host unreachable: ' + model + ' @ ' + target,
            'high');
        if (isCancelled()) return undefined;
        const failed = result(isTimeout ? 504 : 502, { status: 'error', message: err.message });
        return degradedResult.routeDecision ? failed : refusedResult(err, failed);
    }
    } catch (err) {
        const errorCode = typeof err?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(err.code)
            ? err.code
            : 'INFERENCE_PRE_DISPATCH_ERROR';
        logger.error('[InferenceProxy] pre-dispatch failed', {
            phase: 'pre_dispatch',
            errorCode,
            outcomeCode: ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR,
        });
        observeRouteOutcome({
            outcomeStage: ROUTE_OUTCOME_STAGES.SELECTION,
            outcomeCode: ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR,
            outcomeReasonCode: errorCode,
        });
        setRouteOutcomeHeader(headers, ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR);
        return result(Number.isInteger(err?.statusCode) ? err.statusCode : 500, {
            status: 'error',
            message: err?.message || 'Internal server error',
        });
    }
}

module.exports = { executeInference };
