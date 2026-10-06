'use strict';

const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const {
  applyRoutingHeaders,
  pipeRuntimeStream,
  requestAbort,
  sendRuntimeError,
  uniqueEffectiveModels
} = require('../common');

const { setTimeout: delay } = require('node:timers/promises');
const { ollamaMessages } = require('./messages');

const HERMES_HARNESS_VERSION = '1.2.0';
const HERMES_CONSUMER_CONTRACT = 'hermes-runtime-v1';

function approvedModels(snapshot) {
  const models = new Set(uniqueEffectiveModels(snapshot).map((task) => task.model));
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
// the patient route waits for the host instead. Admission is refused before
// anything is dispatched, which makes trying again safe.
const PATIENT_WAIT_MS = 8 * 60 * 1000;
const PATIENT_RETRY_MS = 3000;

async function whenAdmitted(run, { waitMs = 0, retryMs = PATIENT_RETRY_MS, signal } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== 'RUNTIME_INFERENCE_ADMISSION_DENIED' || signal?.aborted || Date.now() + retryMs > deadline) throw error;
      await delay(retryMs, undefined, { signal });
    }
  }
}

function registerHermesProtocol({ express, runtimeServices, logger }) {
  const router = express.Router();

  router.post('/patient/v1/chat/completions', (req, _res, next) => {
    req.admissionWaitMs = PATIENT_WAIT_MS;
    req.url = '/v1/chat/completions';
    next();
  });

  router.get('/v1/models', async (_req, res) => {
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
      return sendRuntimeError(res, error, logger, 'Hermes model discovery');
    }
  });

  router.post('/v1/chat/completions', async (req, res) => {
    const abort = requestAbort(req, res);
    let streaming = false;
    try {
      const body = req.body || {};
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return res.status(400).json({
          error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' }
        });
      }
      const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
      const model = requireApprovedModel(snapshot, body.model);
      const result = await whenAdmitted(() => runtimeServices.inference.execute({
        mode: 'chat',
        model,
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
        callerDetail: 'hermes-runtime-bridge',
        timeoutMs: Number(process.env.HERMES_OPENAI_TIMEOUT_MS || 0) || undefined
      }, {
        signal: abort.signal,
        consumerContract: HERMES_CONSUMER_CONTRACT,
        observePromptPrefix: true
      }), { waitMs: req.admissionWaitMs, signal: abort.signal });
      applyRoutingHeaders(res, result.metadata);
      const resolvedModel = String(result.metadata?.model || '').trim();
      res.set('X-AgentX-Fallback-Used', resolvedModel ? String(resolvedModel !== model) : 'unknown');
      res.set('X-AgentX-Resolved-Provider', String(result.metadata?.provider || 'unknown'));
      res.set('X-AgentX-Resolved-Model-Version', String(result.metadata?.modelVersion || resolvedModel || 'unknown'));
      res.set('X-AgentX-Harness-Version', HERMES_HARNESS_VERSION);
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
        const stream = result.metadata.upstreamProtocol === 'openai'
          ? result.stream
          : result.stream.pipe(new OllamaToOpenAiSse(model));
        stream.once('error', (error) => {
          if (!abort.signal.aborted) logger?.warn?.('Hermes inference stream failed', { code: error.code || 'STREAM_ERROR' });
          if (!res.destroyed) res.destroy(error);
        });
        pipeRuntimeStream(stream, res, abort.signal);
        return undefined;
      }
      return res.status(result.status).json(
        result.metadata.upstreamProtocol === 'openai'
          ? result.body
          : openAiCompletion(result.body, model)
      );
    } catch (error) {
      const safeStatus = Number(error?.statusCode || 500);
      if (!res.headersSent && safeStatus < 500) {
        return res.status(safeStatus).json({
          error: { message: error.message, type: 'invalid_request_error', code: error.code || undefined }
        });
      }
      return sendRuntimeError(res, error, logger, 'Hermes inference');
    } finally {
      if (streaming) res.once('close', abort.cleanup);
      else if (!res.headersSent || res.writableEnded) abort.cleanup();
      else res.once('finish', abort.cleanup);
    }
  });

  router.all('/v1/*', (req, res) => res.status(404).json({
    error: {
      message: `unsupported AgentX Hermes operation: ${req.method} ${req.path}`,
      type: 'invalid_request_error'
    }
  }));
  return router;
}

module.exports = {
  HERMES_CONSUMER_CONTRACT,
  OllamaToOpenAiSse,
  approvedModels,
  openAiCompletion,
  openAiToolCalls,
  registerHermesProtocol,
  whenAdmitted,
  requireApprovedModel
};
