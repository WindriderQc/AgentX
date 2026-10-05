'use strict';

/**
 * Route-decision and attempt-record builders for one generate request.
 * Extracted verbatim from inferenceService.js: the factories close over the
 * same per-request values the inline closures used, so persisted attempts and
 * structured rejects keep the same shape.
 */

const logger = require('../../../config/logger');
const { getRoutingConfigVersion } = require('../modelRouterConfig');
const { recordInference, resolveHostKey } = require('../modelRouter');
const { buildRouteDecision, ROUTE_OUTCOME_CODES, ROUTE_OUTCOME_STAGES } = require('./routeDecision');
const { summarizeOllamaOutcome } = require('../laneObservabilityService');
const { fallbackReasonCode } = require('./taskFallbackLadder');
const { ollamaPhaseTimings } = require('../../helpers/ollamaResponseHandler');

function safeRoutingConfigVersion() {
    return typeof getRoutingConfigVersion === 'function'
        ? getRoutingConfigVersion()
        : 'router-unversioned-v1';
}

/** One payload-free builder for persisted attempts and structured rejects.
 * `current` returns the routing values that change while the request is
 * resolved (model, target, routedHostKey, routingSource, safeRequestedHost).
 */
function createGenerateRouteDecisionBuilder({
    current, startedAt, telemetryContext, decisionMode, taskType, body, consumerContract,
    requestedModel, requestedPolicy, effectivePolicy, laneName, policyDowngraded,
}) {
    return (overrides = {}) => {
        const { model, target, routedHostKey, routingSource, safeRequestedHost } = current();
        const {
            selectedModel = model || null,
            selectedHost = routedHostKey || resolveHostKey(target),
            selectedHostUrl = target,
            primaryModel = model || null,
            primaryHost = routedHostKey || resolveHostKey(target),
            primaryHostUrl = target,
            selectionSource = routingSource,
            attempt = telemetryContext.attempt,
            attemptOptions,
            fallbackUsed = false,
            fallbackReason = null,
            rejections = [],
            outcomeStage = ROUTE_OUTCOME_STAGES.UNKNOWN,
            outcomeCode = ROUTE_OUTCOME_CODES.UNKNOWN,
            outcomeReasonCode = null,
            durationMs = Date.now() - startedAt,
        } = overrides;
        try {
            return buildRouteDecision({
                configVersion: safeRoutingConfigVersion(),
                mode: decisionMode,
                taskType: taskType || null,
                caller: 'proxy',
                callerDetail: body.callerDetail || null,
                consumerContract,
                correlationId: telemetryContext.correlationId,
                workItemId: telemetryContext.workItemId,
                runtime: telemetryContext.runtime,
                attempt,
                requestedModel: requestedModel || null,
                requestedHost: resolveHostKey(safeRequestedHost),
                requestedHostUrl: safeRequestedHost,
                primaryModel,
                primaryHost,
                primaryHostUrl,
                selectedModel,
                selectedHost,
                selectedHostUrl,
                selectionSource,
                requestedPolicy,
                effectivePolicy,
                effectiveLane: laneName,
                policyDowngraded,
                outcomeStage,
                outcomeCode,
                outcomeReasonCode,
                rejections,
                fallbackUsed,
                fallbackReason,
                degraded: Boolean(fallbackUsed),
                degradedReason: fallbackReason,
                runtimeOptions: attemptOptions,
                totalMs: durationMs,
            });
        } catch (err) {
            logger.debug('[InferenceProxy] route decision build failed', { error: err.message });
            return null;
        }
    };
}

function observeRouteDecision(routeDecision) {
    logger.info('[InferenceProxy] route outcome', {
        routeDecision,
        outcomeCode: routeDecision?.outcome?.code || ROUTE_OUTCOME_CODES.UNKNOWN,
    });
    return routeDecision;
}

/** Persist one inference attempt through the lane's sync/async recorder. */
function createAttemptRecorder({
    lane, inferenceContract, taskFallback, routingSource, buildGenerateRouteDecision,
    body, consumerContract, telemetryContext, laneName, taskType,
}) {
    // recordInference dispatcher honoring the lane's sync/async preference.
    // recordInference is self-contained (only reads its `data` arg, no req/res
    // capture) so deferring via process.nextTick is safe.
    const dispatchRecord = (entry) => {
        if (lane.recordInferenceSync) {
            recordInference(entry);
        } else {
            process.nextTick(() => recordInference(entry));
        }
    };

    return ({
        hostUrl,
        hostKey,
        attemptModel,
        attempt,
        attemptData,
        attemptTrace,
        attemptContract = inferenceContract,
        attemptOptions,
        attemptNumCtxSource,
        durationMs,
        status,
        error,
        fallbackUsed = Boolean(taskFallback),
        fallbackReason = fallbackReasonCode(taskFallback),
        outcomeStage,
        outcomeCode,
        outcomeReasonCode,
        rejections = [],
        waits = null,
    }) => {
        const resolvedOutcomeStage = outcomeStage || (
            fallbackUsed ? ROUTE_OUTCOME_STAGES.FALLBACK : ROUTE_OUTCOME_STAGES.EXECUTION
        );
        const resolvedOutcomeCode = outcomeCode || (
            status === 'success'
                ? (fallbackUsed ? ROUTE_OUTCOME_CODES.FALLBACK_SUCCEEDED : ROUTE_OUTCOME_CODES.EXECUTION_SUCCEEDED)
                : status === 'timeout'
                    ? ROUTE_OUTCOME_CODES.UPSTREAM_TIMEOUT
                    : (fallbackUsed ? ROUTE_OUTCOME_CODES.FALLBACK_FAILED : ROUTE_OUTCOME_CODES.UPSTREAM_ERROR)
        );
        const routeDecision = buildGenerateRouteDecision({
            selectedModel: attemptModel,
            selectedHost: hostKey || resolveHostKey(hostUrl),
            selectedHostUrl: hostUrl,
            selectionSource: attemptTrace?.selected?.routingSource || routingSource,
            attempt,
            attemptOptions,
            fallbackUsed,
            fallbackReason,
            rejections,
            outcomeStage: resolvedOutcomeStage,
            outcomeCode: resolvedOutcomeCode,
            outcomeReasonCode: outcomeReasonCode || fallbackReason,
            durationMs,
        });

        dispatchRecord({
            host: hostUrl,
            model: attemptModel,
            caller: 'proxy',
            callerDetail: body.callerDetail || null,
            consumerContract,
            ...telemetryContext,
            routeDecision,
            observability: {
                contract: attemptContract,
                outcome: attemptData && status === 'success'
                    ? summarizeOllamaOutcome(attemptData)
                    : null,
                lane: laneName,
                campaignId: body.campaignId || body.batchId || telemetryContext.workItemId || null,
            },
            attempt,
            taskType: taskType || null,
            routed: !!taskType,
            routedModel: attemptModel,
            routedHost: hostKey || resolveHostKey(hostUrl),
            routedHostUrl: hostUrl,
            routingTrace: attemptTrace,
            num_ctx: attemptOptions?.num_ctx ?? null,
            num_ctx_source: attemptNumCtxSource,
            // Captured before dispatch from Core's context-budget estimator, so a
            // timeout with tokensIn=0 still records how large the request was.
            estimatedInputTokensAtDispatch:
                attemptContract?.contextBudget?.input?.estimatedTokens
                ?? attemptContract?.input?.estimatedTokens
                ?? null,
            tokensIn: attemptData?.prompt_eval_count || 0,
            tokensOut: attemptData?.eval_count || 0,
            ...ollamaPhaseTimings(attemptData),
            waits,
            fallbackUsed,
            fallbackReason,
            durationMs,
            status,
            error: error || null,
        });
        return routeDecision;
    };
}

module.exports = {
    createGenerateRouteDecisionBuilder,
    observeRouteDecision,
    createAttemptRecorder,
};
