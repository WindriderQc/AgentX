'use strict';

const {
  applyRoutingHeaders,
  pipeRuntimeStream,
  publicError,
  enforceEffectiveModel,
  requestAbort,
  sendRuntimeError,
  uniqueEffectiveModels
} = require('../common');
const { PIPELINE_MODEL_ALIAS } = require('../pipeline-attribution');
const { settledStream } = require('./settled-stream');
const { sendBusyReply, wantsBusyReply } = require('./busy-reply');
const {
  LOCAL_INFERENCE_CONFLICTS, PRIMARY_WAIT_WITH_FALLBACK_MS, applyDegradedHeaders, conversationFallbackTask,
  markBody, noticeFrame, runWithConversationFallback
} = require('./conversation-fallback');

const OPENCLAW_CONSUMER_CONTRACT = 'openclaw-runtime-v1';

function modelDetails(task) {
  return {
    parent_model: '',
    format: 'agentx-routed',
    family: 'agentx',
    families: ['agentx'],
    parameter_size: '',
    quantization_level: ''
  };
}

function modelInfo(task) {
  const context = Number(task?.contextSize) || null;
  return {
    modelfile: context ? `PARAMETER num_ctx ${context}` : '',
    parameters: context ? `num_ctx ${context}` : '',
    template: '',
    details: modelDetails(task),
    model_info: context ? { 'agentx.context_length': context } : {},
    capabilities: [
      'completion',
      ...(task?.inferenceContract?.capabilities?.tools?.supported ? ['tools'] : []),
      ...(task?.inferenceContract?.capabilities?.thinking?.supported ? ['thinking'] : [])
    ]
  };
}

function registerOpenClawProtocol({
  express, runtimeServices, pipelineAttribution = null, resolveConversationTarget, noThinkModels = new Set(), logger
}) {
  const router = express.Router();

  router.get('/api/version', (_req, res) => res.json({ version: 'agentx-runtime-bridge-v1' }));

  router.get('/api/tags', async (_req, res) => {
    try {
      const snapshot = await runtimeServices.routing.getEffectiveSnapshot({
        includeCatalog: false,
        includeArtifactIdentity: true
      });
      const models = uniqueEffectiveModels(snapshot).map((task) => ({
        name: task.model,
        model: task.model,
        modified_at: snapshot.generatedAt,
        size: 0,
        digest: task.inferenceContract?.artifact?.digest || '',
        details: modelDetails(task)
      }));
      const pipelineTask = snapshot.tasks?.code_generation;
      if (pipelineTask?.model
        && pipelineTask.model !== PIPELINE_MODEL_ALIAS
        && pipelineTask?.inferenceContract?.qualification?.qualified === true) {
        models.push({
          name: PIPELINE_MODEL_ALIAS,
          model: PIPELINE_MODEL_ALIAS,
          modified_at: snapshot.generatedAt,
          size: 0,
          digest: pipelineTask.inferenceContract?.artifact?.digest || '',
          details: modelDetails(pipelineTask)
        });
      }
      return res.json({ models });
    } catch (error) {
      return sendRuntimeError(res, error, logger, 'OpenClaw model discovery');
    }
  });

  router.get('/api/ps', async (_req, res) => {
    try {
      const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
      const models = uniqueEffectiveModels(snapshot)
        .filter((task) => task.hostPreference?.loadedModels?.includes(task.model)
          || task.hostPreference?.loadedModel === task.model)
        .map((task) => ({
          name: task.model,
          model: task.model,
          size: 0,
          size_vram: 0,
          digest: task.inferenceContract?.artifact?.digest || '',
          details: modelDetails(task),
          expires_at: '9999-12-31T23:59:59Z'
        }));
      return res.json({ models });
    } catch (error) {
      return sendRuntimeError(res, error, logger, 'OpenClaw resident model discovery');
    }
  });

  router.post('/api/show', async (req, res) => {
    try {
      const snapshot = await runtimeServices.routing.getEffectiveSnapshot({
        includeCatalog: false,
        includeArtifactIdentity: true
      });
      const requestedModel = String(req.body?.model || '').trim();
      const conversationTarget = await resolveConversationTarget?.(requestedModel);
      const task = requestedModel === PIPELINE_MODEL_ALIAS
        ? snapshot.tasks?.code_generation
        : conversationTarget || enforceEffectiveModel(snapshot, req.body || {});
      if (!task?.model || (requestedModel === PIPELINE_MODEL_ALIAS
        && task?.inferenceContract?.qualification?.qualified !== true)) {
        const error = new Error('Pipeline attribution model alias is unavailable');
        error.statusCode = 409;
        error.code = 'PIPELINE_ATTRIBUTION_MODEL_UNQUALIFIED';
        throw error;
      }
      return res.json(modelInfo(task));
    } catch (error) {
      return sendRuntimeError(res, error, logger, 'OpenClaw model inspection');
    }
  });

  async function infer(req, res, mode) {
    const abort = requestAbort(req, res);
    let streaming = false;
    let pipeline = null;
    try {
      const body = req.body || {};
      // Per-invocation metadata from the existing Benchmark broker. Core checks
      // the exact host claim and workload generation before every model turn.
      const claimHeader = req.get('x-agentx-benchmark-claims');
      const benchmarkClaims = claimHeader ? JSON.parse(claimHeader) : undefined;
      pipeline = String(body.model || '').trim() === PIPELINE_MODEL_ALIAS
        ? await pipelineAttribution?.authorizeAlias(body.model)
        : null;
      if (String(body.model || '').trim() === PIPELINE_MODEL_ALIAS && !pipeline) {
        const error = new Error('Pipeline attribution is unavailable');
        error.statusCode = 503;
        error.code = 'PIPELINE_ATTRIBUTION_UNAVAILABLE';
        throw error;
      }
      const effectiveBody = pipeline ? { ...body, model: pipeline.effectiveModel } : body;
      const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
      const conversationTarget = !pipeline && await resolveConversationTarget?.(String(body.model || '').trim());
      if (!conversationTarget) enforceEffectiveModel(snapshot, effectiveBody);
      const options = { ...(effectiveBody.options || {}) };
      delete options.num_ctx;
      delete options.attribution;
      const request = {
        mode,
        model: String(effectiveBody.model || '').trim(),
        stream: effectiveBody.stream === true,
        options,
        keepAlive: effectiveBody.keep_alive,
        // The operator's no-reasoning list wins over the level the agent asked for.
        think: !pipeline && noThinkModels.has(String(body.model || '').trim()) ? false : effectiveBody.think,
        format: effectiveBody.format,
        tools: effectiveBody.tools,
        ...(conversationTarget && { exclusiveHost: conversationTarget.exclusiveHost !== false }),
        ...(conversationTarget?.numCtx && { options: { ...options, num_ctx: conversationTarget.numCtx } }),
        ...(pipeline?.numCtx && { options: { ...options, num_ctx: pipeline.numCtx } }),
        callerDetail: pipeline ? 'openclaw-pipeline-runtime-bridge' : 'openclaw-runtime-bridge',
        timeoutMs: Number(process.env.OPENCLAW_AGENTX_TIMEOUT_MS || 0) || undefined,
        ...(mode === 'chat' && { messages: effectiveBody.messages }),
        ...(mode === 'generate' && { prompt: effectiveBody.prompt, system: effectiveBody.system }),
        ...(mode === 'embed' && { input: effectiveBody.input, truncate: effectiveBody.truncate })
      };
      const leaseId = pipeline?.attribution.correlationId;
      if (pipeline) request.timeoutMs = Math.min(request.timeoutMs || 600000,
        await pipelineAttribution.revalidate(leaseId));
      // #143: only an opted-in conversation on a routed model may degrade.
      const fallbackTask = !pipeline && !conversationTarget && wantsBusyReply(req, mode)
        && typeof runtimeServices.routing.planFallback === 'function' ? conversationFallbackTask() : null;
      const primaryRun = () => runtimeServices.inference.execute(request, {
        signal: abort.signal,
        consumerContract: pipeline?.consumerContract || OPENCLAW_CONSUMER_CONTRACT,
        // Core logs where this prompt diverges from the last one (cache reuse);
        // the structure stays in telemetry and never reaches Ollama.
        ...(mode === 'chat' && { observePromptPrefix: true }),
        ...(conversationTarget && { hostUrl: conversationTarget.hostUrl }),
        ...(benchmarkClaims && { benchmarkClaims }),
        // A conversational provider (e.g. Telegram) outranks evaluation work,
        // like a household turn. The wait stays under the gateway's provider
        // timeout (~50 s observed), so a still-busy host gets the busy reply.
        ...(!pipeline && wantsBusyReply(req, mode) && { retry: { interactive: true,
          interactiveWaitMs: fallbackTask ? PRIMARY_WAIT_WITH_FALLBACK_MS : 45000 } }),
        ...(pipeline && { attribution: pipeline.attribution,
          ...(pipeline.codingCapacity && { codingCapacity: pipeline.codingCapacity, hostUrl: pipeline.hostUrl }),
          retry: { enabled: true, maxAttempts: 6, maxElapsedMs: Math.min(120000, request.timeoutMs) },
          beforeAttempt: () => pipelineAttribution.revalidate(leaseId),
          onProgress: progress => pipelineAttribution.progress(leaseId, progress) })
      });
      const outcome = fallbackTask
        ? await runWithConversationFallback({ runtimeServices, request, fallbackTask, primaryRun,
          signal: abort.signal, consumerContract: OPENCLAW_CONSUMER_CONTRACT, logger })
        : { result: await primaryRun(), plan: null };
      const { result, plan } = outcome;
      applyRoutingHeaders(res, result.metadata);
      if (plan) {
        applyDegradedHeaders(res, plan.routing);
        logger?.info?.('OpenClaw conversation served by a fallback brain', { reason: plan.routing.reason,
          from: plan.routing.fallbackFrom.model, to: plan.routing.fallbackTo.model });
      }
      if (!result.ok) {
        const message = result.body?.error?.message || result.body?.error || 'AgentX inference failed';
        return res.status(result.status).json({ error: String(message) });
      }
      if (result.stream) {
        streaming = true;
        res.status(result.status);
        res.type('application/x-ndjson');
        // Every native tool loop needs the same terminal-frame settlement.
        const delivery = settledStream(result.stream, result.completion);
        delivery.once('error', (error) => {
          if (pipeline) pipelineAttribution.progress(leaseId, { state: 'recovery_required',
            cause: 'stream_interrupted', attempts: result.retry?.attempts || 1 });
          if (!abort.signal.aborted) logger?.warn?.('OpenClaw inference stream failed', { code: error.code || 'STREAM_ERROR' });
          if (!res.destroyed) res.destroy(error);
        });
        if (pipeline && result.completion) void result.completion.then(() => {
          pipelineAttribution.progress(leaseId, { ...result.retry, state: 'completed' });
        }).catch(() => pipelineAttribution.progress(leaseId, { state: 'recovery_required',
          cause: 'stream_completion_unverified', attempts: result.retry?.attempts || 1 }));
        if (plan) res.write(noticeFrame({ mode, model: plan.model, routing: plan.routing }));
        pipeRuntimeStream(delivery, res, abort.signal);
        return undefined;
      }
      return res.status(result.status).json(plan ? markBody(mode, result.body, plan.routing) : result.body);
    } catch (error) {
      if (pipeline) {
        const progress = error.retry || { state: abort.signal.aborted ? 'cancelled' : 'recovery_required',
          cause: error.failure?.cause || error.code || 'inference_outcome_unknown', attempts: 1 };
        pipelineAttribution.progress(pipeline.attribution.correlationId, progress);
        const safe = publicError(error);
        // Core already exhausted safe retries. A 409 prevents native provider
        // transport rotation from replaying this uncertain logical turn.
        return res.status(409).json({ error: safe.message, code: safe.code, inference: progress });
      }
      // These requests were refused before generation because of host state.
      // Native Ollama 5xx responses trigger profile rotation and another call
      // to the same host. A state conflict leaves configured model fallback to
      // OpenClaw without pretending the provider transport failed.
      if (LOCAL_INFERENCE_CONFLICTS.has(error?.code)) {
        if (wantsBusyReply(req, mode) && !res.headersSent) {
          logger?.info?.('OpenClaw conversation told the local host is busy', { code: error.code, cause: error.failure?.cause || null });
          return sendBusyReply(res, { mode, model: req.body?.model, stream: req.body?.stream === true, error });
        }
        const safe = publicError(error);
        logger?.info?.('OpenClaw inference declined by host state', { code: safe.code });
        return res.status(409).json({ error: safe.message, code: safe.code });
      }
      return sendRuntimeError(res, error, logger, 'OpenClaw inference');
    } finally {
      if (streaming) res.once('close', abort.cleanup);
      else if (!res.headersSent || res.writableEnded) abort.cleanup();
      else res.once('finish', abort.cleanup);
    }
  }

  router.post('/api/chat', (req, res) => infer(req, res, 'chat'));
  router.post('/api/generate', (req, res) => infer(req, res, 'generate'));
  router.post('/api/embed', (req, res) => infer(req, res, 'embed'));

  router.all('/api/*', (req, res) => res.status(404).json({
    error: `unsupported AgentX OpenClaw operation: ${req.method} ${req.path}`
  }));
  return router;
}

module.exports = { OPENCLAW_CONSUMER_CONTRACT, modelInfo, registerOpenClawProtocol };
