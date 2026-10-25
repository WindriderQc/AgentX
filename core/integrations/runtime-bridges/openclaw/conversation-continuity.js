'use strict';

// Transport only. Core owns selection, refusal evidence, reduced context and
// the admission/settlement of every attempted inference.
const { applyRoutingHeaders, pipeRuntimeStream, publicError } = require('../common');
const { settledStream } = require('./settled-stream');

async function serveContinuity(req, res, { mode, runtimeServices, signal, resolveConversationTarget, noThinkModels }) {
  if (!['chat', 'generate'].includes(mode) || req.get('x-agentx-continuity') !== 'conversation'
    || req.get('x-agentx-busy-reply') !== 'conversation' || req.get('x-agentx-benchmark-claims')
    || req.body?.model === 'agentx-pipeline' || typeof runtimeServices.inference.conversation !== 'function') return false;
  const body = req.body || {};
  const declared = String(req.get('x-agentx-think') || '').trim().toLowerCase();
  if (declared && !['on', 'off'].includes(declared)) throw Object.assign(new Error('x-agentx-think must be on or off'),
    { code: 'OPENCLAW_THINK_HEADER_INVALID', statusCode: 400 });
  const options = { ...body.options };
  delete options.num_ctx;
  delete options.attribution;
  const model = String(body.model || '').trim();
  let result;
  try { result = await runtimeServices.inference.conversation({ mode, model, stream: body.stream === true,
    options, keepAlive: body.keep_alive, format: body.format, tools: body.tools,
    think: declared ? declared === 'on' : noThinkModels?.has(model) ? false : body.think,
    callerDetail: 'openclaw-runtime-bridge',
    timeoutMs: Number(process.env.OPENCLAW_AGENTX_TIMEOUT_MS || 0) || undefined,
    ...(mode === 'chat' ? { messages: body.messages } : { prompt: body.prompt, system: body.system })
  }, { signal, consumerContract: 'openclaw-runtime-v1',
    primaryTarget: await resolveConversationTarget?.(model) }); }
  catch (error) {
    if (!signal?.aborted && ['INFERENCE_TIMEOUT', 'INFERENCE_UPSTREAM_UNAVAILABLE', 'RUNTIME_INFERENCE_COMPLETION_FAILED'].includes(error.code)) {
      const safe = publicError(error);
      res.status(409).json({ error: safe.message, code: safe.code, executionState: 'unknown' });
      return true; // native transport rotation must not replay an uncertain call
    }
    throw error;
  }
  if (!result) return false;
  applyRoutingHeaders(res, result.metadata);
  const continuity = result.metadata?.conversationContinuity;
  if (continuity) {
    res.set('X-AgentX-Conversation-State', continuity.state);
    if (continuity.reason) res.set('X-AgentX-Conversation-Reason', continuity.reason);
    if (continuity.limited) res.set('X-AgentX-Degraded', 'true');
  }
  if (!result.ok) {
    res.status(result.status >= 500 ? 409 : result.status).json(result.body); return true;
  }
  if (result.stream) {
    res.status(result.status).type('application/x-ndjson');
    if (result.conversationNotice) {
      const text = `${result.conversationNotice}\n\n`;
      res.write(JSON.stringify({ model: result.metadata.model, created_at: new Date().toISOString(), done: false,
        ...(mode === 'generate' ? { response: text } : { message: { role: 'assistant', content: text } }) }) + '\n');
    }
    const delivery = settledStream(result.stream, result.completion);
    delivery.once('error', error => res.destroy(error));
    pipeRuntimeStream(delivery, res, signal);
  } else if (body.stream === true) {
    // A status-only response needs no model and preserves Ollama's terminal shape.
    res.status(result.status).type('application/x-ndjson').end(JSON.stringify(result.body) + '\n');
  } else res.status(result.status).json(result.body);
  return true;
}

module.exports = { serveContinuity };
