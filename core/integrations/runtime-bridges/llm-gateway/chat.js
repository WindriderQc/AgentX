'use strict';

// One OpenAI-compatible chat path for every gateway client. Inference, admission,
// the principal alias and coding settlement stay Core's; a client only changes
// the attested caller and consumer contract. Protocol front-ends (chat
// completions, responses) render the same result in their own shape.
const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const { setTimeout: delay } = require('node:timers/promises');
const {
  applyRoutingHeaders,
  pipeRuntimeStream,
  requestAbort,
  sendRuntimeError,
  uniqueEffectiveModels
} = require('../common');
const { ollamaMessages } = require('../hermes/messages');
const { settledStream } = require('../openclaw/settled-stream');
const { isPreRoutingValidationRefusal } = require('../../../src/extensions/trustedRuntimeServices');
const { PRINCIPAL_MODEL_ALIAS, resolvePrincipalAlias } = require('../principal-model');

const HARNESS_VERSION = '1.2.0';

function approvedModels(snapshot) {
  const models = new Set(uniqueEffectiveModels(snapshot).map((task) => task.model));
  if (snapshot.tasks?.daily_operator?.model) models.add(PRINCIPAL_MODEL_ALIAS);
  const authority = String(process.env.HERMES_AUTHORITY_MODEL || '').trim();
  if (authority) models.add(authority);
  return [...models];
}

function requireApprovedModel(snapshot, model) {
  const requested = String(model || '').trim();
  if (!requested) {
    const error = new Error('model is required');
    error.statusCode = 400;
    error.code = 'MODEL_REQUIRED';
    throw error;
  }
  if (!approvedModels(snapshot).includes(requested)) {
    const error = new Error('model is not approved by the effective AgentX runtime policy');
    error.statusCode = 409;
    error.code = 'MODEL_NOT_EFFECTIVE';
    throw error;
  }
  return requested;
}

function openAiUsage(body) {
  return {
    prompt_tokens: Number(body?.prompt_eval_count || 0),
    completion_tokens: Number(body?.eval_count || 0),
    total_tokens: Number(body?.prompt_eval_count || 0) + Number(body?.eval_count || 0)
  };
}

function openAiToolCalls(calls) {
  return (calls || []).map((call, index) => ({
    id: call?.id || `call_agentx_${index}_${randomUUID()}`,
    type: 'function',
    function: {
      name: String(call?.function?.name || ''),
      arguments: typeof call?.function?.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call?.function?.arguments || {})
    }
  }));
}

function openAiCompletion(body, requestedModel) {
  const message = body?.message || {};
  const result = {
    id: `chatcmpl-agentx-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model || requestedModel,
    choices: [{
      index: 0,
      message: {
        role: message.role || 'assistant',
        content: message.content ?? body?.response ?? '',
        ...(Array.isArray(message.tool_calls) && { tool_calls: openAiToolCalls(message.tool_calls) })
      },
      finish_reason: body?.done_reason || (Array.isArray(message.tool_calls) ? 'tool_calls' : 'stop')
    }],
    usage: openAiUsage(body)
  };
  if (message.thinking) result.choices[0].message.reasoning_content = message.thinking;
  return result;
}

class OllamaToOpenAiSse extends Transform {
  constructor(requestedModel) {
    super();
    this.requestedModel = requestedModel;
    this.id = `chatcmpl-agentx-${randomUUID()}`;
    this.buffer = '';
    this.sentRole = false;
    this.sentDone = false;
  }

  _emitChunk(body) {
    const message = body?.message || {};
    const delta = {};
    if (!this.sentRole) {
      delta.role = message.role || 'assistant';
      this.sentRole = true;
    }
    if (message.content) delta.content = message.content;
    if (message.thinking) delta.reasoning_content = message.thinking;
    if (Array.isArray(message.tool_calls)) delta.tool_calls = openAiToolCalls(message.tool_calls);
    const finishReason = body?.done
      ? (body.done_reason || (Array.isArray(message.tool_calls) ? 'tool_calls' : 'stop'))
      : null;
    const chunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body?.model || this.requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
    if (body?.done) chunk.usage = openAiUsage(body);
    this.push(`data: ${JSON.stringify(chunk)}\n\n`);
    if (body?.done && !this.sentDone) {
      this.sentDone = true;
      this.push('data: [DONE]\n\n');
    }
  }

  _drain(final) {
    let boundary;
    while ((boundary = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line) continue;
      try { this._emitChunk(JSON.parse(line)); } catch { /* malformed upstream chunk is ignored */ }
    }
    if (final && this.buffer.trim()) {
      try { this._emitChunk(JSON.parse(this.buffer.trim())); } catch { /* ignored */ }
      this.buffer = '';
    }
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += chunk.toString('utf8');
    this._drain(false);
    callback();
  }

  _flush(callback) {
    this._drain(true);
    if (!this.sentDone) this.push('data: [DONE]\n\n');
    callback();
  }
}

// A coding worker loses its whole conversation when one request is refused, so
// the patient route waits for the host instead: behind another workload, and
// behind a benchmark that reserved the host. Both are refused before anything
// is dispatched, which makes trying again safe.
const PATIENT_WAIT_MS = 8 * 60 * 1000;
const PATIENT_RETRY_MS = 3000;
const HOST_BUSY_CODES = new Set(['RUNTIME_INFERENCE_ADMISSION_DENIED', 'BENCHMARK_CLAIM_ACTIVE']);

async function whenAdmitted(run, { waitMs = 0, retryMs = PATIENT_RETRY_MS, signal } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!HOST_BUSY_CODES.has(error?.code) || signal?.aborted || Date.now() + retryMs > deadline) throw error;
      await delay(retryMs, undefined, { signal });
    }
  }
}

const CHAT_RENDER = Object.freeze({ json: body => body, stream: stream => stream });

// `body` is an OpenAI chat-completions request. `render` turns the chat-shaped
// answer into the front-end's protocol: `json(completion)` for one answer and
// `stream(chatSse)` for a stream of `data:` chunks ending with `[DONE]`.
async function handleChat(req, res, { runtimeServices, logger, client, body, render = CHAT_RENDER, waitMs = 0 }) {
  const abort = requestAbort(req, res);
  let streaming = false;
  let coding;
  let inferenceOptions;
  let settling = false;
  const settleCoding = async state => {
    settling = true;
    try { await coding.finish(state); }
    catch (cause) {
      throw Object.assign(new Error('Coding inference receipt persistence is unverified.', { cause }), {
        code: 'CODING_INFERENCE_SETTLEMENT_UNVERIFIED', statusCode: 503
      });
    }
  };
  try {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({
        error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' }
      });
    }
    const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
    const principalTarget = resolvePrincipalAlias(snapshot, body.model);
    // A report escalation call is authorized by its report execution's own
    // recorded models (#835), checked in prepare(); not by the routing table.
    const escalating = req.headers['x-agentx-report-escalation'] !== undefined && req.headers['x-agentx-report-request'] !== undefined;
    const model = escalating ? String(body.model || '') : requireApprovedModel(snapshot, principalTarget?.model || body.model);
    coding = await require('../../../src/services/pipelineCodingInferenceService').prepare(req.headers, model, abort.signal);
    if (coding?.options?.reportEscalation) {
      const escalation = coding.options.reportEscalation;
      let answered;
      try {
        answered = await require('../../../src/services/pipelineReportEscalation').execute({ identity: escalation,
          messages: ollamaMessages(body.messages), maxTokens: Number(body.max_tokens) || 8192, requestId: escalation.callId,
          remainingNanodollars: escalation.remainingNanodollars, signal: coding.options.signal,
          timeoutMs: Math.max(1, coding.options.reportDeadlineAt - Date.now()) });
      } catch (error) {
        await settleCoding('refused');
        return res.status(error.statusCode || 502).json({ error: { message: error.message, type: 'upstream_error', code: error.code } });
      }
      await settleCoding('completed');
      res.set('X-AgentX-Resolved-Model-Version', answered.model);
      return res.status(200).json(render.json(openAiCompletion(answered.body, answered.model), answered.model));
    }
    inferenceOptions = {
      signal: abort.signal,
      consumerContract: client.consumerContract,
      observePromptPrefix: true,
      ...(principalTarget && { hostUrl: principalTarget.hostUrl }),
      ...(coding?.options || {})
    };
    const result = await whenAdmitted(() => runtimeServices.inference.execute({
      mode: 'chat',
      model,
      ...(principalTarget && { options: { num_ctx: principalTarget.numCtx } }),
      messages: ollamaMessages(body.messages),
      stream: body.stream === true,
      tools: body.tools,
      tool_choice: body.tool_choice,
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_tokens,
      max_completion_tokens: body.max_completion_tokens,
      response_format: body.response_format,
      reasoning_effort: body.reasoning_effort,
      stop: body.stop,
      seed: body.seed,
      presence_penalty: body.presence_penalty,
      frequency_penalty: body.frequency_penalty,
      n: body.n,
      user: body.user,
      callerDetail: client.callerDetail,
      timeoutMs: Number(process.env.HERMES_OPENAI_TIMEOUT_MS || 0) || undefined
    }, inferenceOptions), { waitMs, signal: coding?.options.signal || abort.signal });
    let codingCompletion;
    if (coding) {
      if (result.completion) {
        codingCompletion = result.completion.then(async value => { await settleCoding('completed'); return value; },
          async error => { await settleCoding('unknown'); throw error; });
        if (!result.stream) await codingCompletion;
      } else await settleCoding(result.ok ? 'completed' : 'refused');
    }
    applyRoutingHeaders(res, result.metadata);
    const resolvedModel = String(result.metadata?.model || '').trim();
    res.set('X-AgentX-Fallback-Used', resolvedModel ? String(resolvedModel !== model) : 'unknown');
    res.set('X-AgentX-Resolved-Provider', String(result.metadata?.provider || 'unknown'));
    res.set('X-AgentX-Resolved-Model-Version', String(result.metadata?.modelVersion || resolvedModel || 'unknown'));
    res.set('X-AgentX-Harness-Version', HARNESS_VERSION);
    if (!result.ok) {
      const upstream = result.body?.error;
      const message = typeof upstream === 'string' ? upstream : upstream?.message;
      return res.status(result.status).json({
        error: { message: message || 'AgentX inference failed', type: 'upstream_error' }
      });
    }
    if (result.stream) {
      streaming = true;
      res.status(result.status);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      const completion = codingCompletion || result.completion;
      const admitted = completion ? settledStream(result.stream, completion) : result.stream;
      const chatSse = result.metadata.upstreamProtocol === 'openai' ? admitted : new OllamaToOpenAiSse(model);
      if (chatSse !== admitted) {
        admitted.once('error', error => chatSse.destroy(error));
        admitted.pipe(chatSse);
      }
      const stream = render.stream(chatSse, model);
      if (stream !== chatSse) {
        chatSse.once('error', error => stream.destroy(error));
        chatSse.pipe(stream);
      }
      stream.once('error', (error) => {
        if (!abort.signal.aborted) logger?.warn?.('Gateway inference stream failed', { client: client.id, code: error.code || 'STREAM_ERROR' });
        if (!res.destroyed) res.destroy(error);
      });
      pipeRuntimeStream(stream, res, abort.signal);
      return undefined;
    }
    const chat = result.metadata.upstreamProtocol === 'openai' ? result.body : openAiCompletion(result.body, model);
    return res.status(result.status).json(render.json(chat, model));
  } catch (error) {
    if (coding && !settling) {
      const interrupted = abort.signal.aborted || coding.options.signal?.aborted
        || ['INFERENCE_TIMEOUT', 'INFERENCE_CANCELLED'].includes(error.code);
      const refused = !interrupted && (isPreRoutingValidationRefusal(error, inferenceOptions) || error.failure?.safeToRetry === true);
      try { await settleCoding(refused ? 'refused' : 'unknown'); }
      catch (persistenceError) { error = persistenceError; }
    }
    const safeStatus = Number(error?.statusCode || 500);
    if (!res.headersSent && safeStatus < 500) {
      return res.status(safeStatus).json({
        error: { message: error.message, type: 'invalid_request_error', code: error.code || undefined }
      });
    }
    return sendRuntimeError(res, error, logger, `${client.label} inference`);
  } finally {
    if (streaming) res.once('close', abort.cleanup);
    else if (!res.headersSent || res.writableEnded) abort.cleanup();
    else res.once('finish', abort.cleanup);
  }
}

async function listModels(res, { runtimeServices, logger, client }) {
  try {
    const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
    const created = Math.floor(new Date(snapshot.generatedAt).getTime() / 1000);
    return res.json({
      object: 'list',
      data: approvedModels(snapshot).map((id) => ({
        id,
        object: 'model',
        created,
        owned_by: id.startsWith('openrouter/') ? 'agentx-cloud-router' : 'agentx-local-router'
      }))
    });
  } catch (error) {
    return sendRuntimeError(res, error, logger, `${client.label} model discovery`);
  }
}

module.exports = {
  HARNESS_VERSION,
  OllamaToOpenAiSse,
  PATIENT_WAIT_MS,
  approvedModels,
  handleChat,
  listModels,
  openAiCompletion,
  openAiToolCalls,
  requireApprovedModel,
  whenAdmitted
};
