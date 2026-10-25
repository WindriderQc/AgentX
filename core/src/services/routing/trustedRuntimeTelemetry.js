'use strict';

// The InferenceLog row a trusted runtime inference records. Payload-free.
const { fallbackReasonCode } = require('./taskFallbackLadder');
const { ollamaPhaseTimings } = require('../../helpers/ollamaResponseHandler');
const { trustedRuntimeOutcome } = require('./inferenceFailureReasons');

function telemetryEntry(
  request,
  metadata,
  startedAt,
  status,
  data = null,
  error = null,
  attribution = null
) {
  return {
    host: metadata.hostUrl,
    model: metadata.model,
    caller: request.mode === 'embed' ? 'embedding' : 'proxy',
    callerDetail: request.callerDetail || 'trusted-extension',
    consumerContract: metadata.consumerContract || null,
    runtime: attribution?.runtime || null,
    workItemId: attribution?.workItemId || null,
    correlationId: attribution?.correlationId || null,
    attempt: attribution?.attempt || 1,
    taskType: request.taskType || null,
    routed: true,
    routedModel: metadata.model,
    routedHost: metadata.hostKey,
    routedHostUrl: metadata.hostUrl,
    routingTrace: {
      selected: { routingSource: metadata.routingSource || null },
      ...(metadata.topology && { topology: metadata.topology }),
      ...(metadata.conversationContinuity && { continuity: metadata.conversationContinuity }),
      ...(metadata.retry && { retry: metadata.retry })
    },
    fallbackUsed: metadata.routing?.degraded === true,
    fallbackReason: fallbackReasonCode(metadata.routing),
    num_ctx: metadata.options?.num_ctx ?? null,
    num_ctx_source: metadata.numCtxSource || null,
    tokensIn: data?.prompt_eval_count || data?.usage?.prompt_tokens || 0,
    tokensOut: data?.eval_count || data?.usage?.completion_tokens || 0,
    ...ollamaPhaseTimings(data),
    waits: metadata.waits || null,
    promptCache: metadata.promptCache || null,
    retry: metadata.retry || null,
    durationMs: Date.now() - startedAt,
    status,
    ...trustedRuntimeOutcome(status, error, metadata),
    error
  };
}

module.exports = { telemetryEntry };
