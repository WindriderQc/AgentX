'use strict';

const { randomUUID } = require('node:crypto');
const { parseExecutionSource } = require('./executionSource');

const MODEL_API = '/api/agentx/execution';
const CATALOG_SCHEMA = 'agentx.openclaw-execution-catalog/v1';
const RESULT_SCHEMA = 'agentx.openclaw-model-result/v1';

function failure(code, message, statusCode = 502, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...extra });
}

function connection(env = process.env) {
  if (!env.OPENCLAW_GATEWAY_URL || !env.OPENCLAW_GATEWAY_TOKEN) {
    throw failure('OPENCLAW_UNAVAILABLE', 'OpenClaw is not configured.', 503);
  }
  const url = new URL(env.OPENCLAW_GATEWAY_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw failure('OPENCLAW_CONFIG_INVALID', 'Invalid OpenClaw gateway configuration.', 503);
  }
  return { base: url.toString().replace(/\/$/, ''), token: env.OPENCLAW_GATEWAY_TOKEN };
}

async function readEvents(response, consume) {
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 8_000_000) throw failure('OPENCLAW_OUTPUT_LIMIT', 'OpenClaw response exceeded the output limit.');
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const payload = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!payload || payload === '[DONE]') continue;
      let value;
      try { value = JSON.parse(payload); } catch { throw failure('OPENCLAW_STREAM_INVALID', 'OpenClaw returned an invalid stream event.'); }
      await consume(value);
    }
  }
  if (buffer.trim()) throw failure('OPENCLAW_STREAM_INCOMPLETE', 'OpenClaw ended before its final stream event.');
}

function visibleText(response) {
  return (response?.output || []).filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('\n');
}

function createOpenClawExecutionClient({ env = process.env, fetchImpl = fetch } = {}) {
  async function request(path, { signal, timeoutMs = 600000, ...options } = {}) {
    const { base, token } = connection(env);
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(600000, Number(timeoutMs) || 600000)));
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetchImpl(`${base}${path}`, { ...options, signal: bounded,
      redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers } });
    if (!response.ok) {
      let body; try { body = await response.json(); } catch { /* private upstream body is discarded */ }
      const nativeCode = /^OPENCLAW_[A-Z_]{1,80}$/.test(body?.code || '') ? body.code : null;
      const code = nativeCode || (response.status === 404 ? 'OPENCLAW_MODEL_API_UNAVAILABLE' : 'OPENCLAW_EXECUTION_REJECTED');
      throw failure(code, `OpenClaw refused execution (HTTP ${response.status}).`, response.status === 404 ? 503 : response.status,
        { executionState: ['unknown', 'not-dispatched'].includes(body?.executionState) ? body.executionState : 'unknown',
          ...(body?.schema === 'agentx.openclaw-model-error/v1' ? {
            partialResponse: typeof body.partialResponse === 'string' ? body.partialResponse.slice(0, 2000000) : '',
            partialThinking: typeof body.partialThinking === 'string' ? body.partialThinking.slice(0, 2000000) : '' } : {}) });
    }
    return response;
  }

  async function catalog({ signal } = {}) {
    const body = await (await request(`${MODEL_API}/models`, { method: 'GET', signal, timeoutMs: 10000 })).json();
    if (body.schema !== CATALOG_SCHEMA || !Array.isArray(body.models) || !Array.isArray(body.agents)) {
      throw failure('OPENCLAW_CATALOG_INVALID', 'OpenClaw did not return an execution catalogue.');
    }
    if (!Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()) throw failure('OPENCLAW_CATALOG_STALE', 'OpenClaw execution catalogue has expired.', 503);
    return body;
  }

  async function execute(input, { signal, onToken, onThinking, timeoutMs } = {}) {
    const selection = parseExecutionSource(input);
    if (selection?.source !== 'openclaw') throw failure('EXECUTION_SOURCE_INVALID', 'Choose an OpenClaw execution source.', 400);
    signal?.throwIfAborted();
    const messages = input.messages || [{ role: 'user', content: input.prompt || '' }];
    const id = input.requestId || randomUUID();
    let text = '', thinking = '', result, terminal = false;
    try {
      if (selection.mode === 'model') {
        const response = await request(`${MODEL_API}/model`, { method: 'POST', signal, timeoutMs,
          body: JSON.stringify({ schema: 'agentx.openclaw-model-request/v1', requestId: id, model: selection.model,
            messages, parameters: input.parameters || {}, budget: input.budget || null,
            tools: input.tools || [], expectedFingerprint: input.expectedFingerprint || null, stream: Boolean(onToken || onThinking) }) });
        if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
          await readEvents(response, async event => {
            if (terminal) throw failure('OPENCLAW_STREAM_INVALID', 'OpenClaw returned data after completion.');
            if (event.type === 'text_delta') { if (typeof event.delta !== 'string') throw failure('OPENCLAW_STREAM_INVALID', 'Invalid text event.'); text += event.delta; await onToken?.(event.delta); }
            else if (event.type === 'thinking_delta') { if (typeof event.delta !== 'string') throw failure('OPENCLAW_STREAM_INVALID', 'Invalid thinking event.'); thinking += event.delta; await onThinking?.(event.delta); }
            else if (event.type === 'completed') { result = event.result; terminal = true; }
            else if (event.type === 'error') throw failure(/^OPENCLAW_[A-Z_]{1,80}$/.test(event.code || '') ? event.code : 'OPENCLAW_EXECUTION_FAILED', 'OpenClaw model execution failed.');
          });
        } else { result = await response.json(); terminal = true; }
        if (!terminal || result?.schema !== RESULT_SCHEMA || result.requestId !== id || result.model !== selection.model
            || result.receipt?.source !== 'openclaw' || result.receipt?.mode !== 'model') {
          throw failure('OPENCLAW_RESULT_UNVERIFIED', 'OpenClaw model identity or completion could not be verified.');
        }
        const receipt = result.receipt, observed = receipt.observed, isolation = receipt.isolation, usage = receipt.usage;
        if (receipt.requestId !== id || `${observed?.provider}/${observed?.model}` !== selection.model
            || !isolation?.noMemory || !isolation.noAgentPrompt || !isolation.noRuntimeFallback || isolation.modelCalls !== 1
            || isolation.toolsExecuted !== 0 || (!input.tools?.length && !isolation.noTools)
            || !/^[a-f0-9]{64}$/.test(receipt.targetFingerprint || '')
            || (input.expectedFingerprint && receipt.targetFingerprint !== input.expectedFingerprint)
            || ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].some(key => !Number.isSafeInteger(usage?.[key]) || usage[key] < 0)
            || usage.total !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite) {
          throw failure('OPENCLAW_RESULT_UNVERIFIED', 'OpenClaw returned incomplete model execution evidence.');
        }
        if (text && text !== result.text) throw failure('OPENCLAW_STREAM_DIVERGED', 'OpenClaw final text differs from its streamed text.');
        if (!result.text?.trim() && !result.toolCalls?.length) throw failure('OPENCLAW_EMPTY_RESULT', 'OpenClaw returned no visible model answer.', 502, { executionReceipt: receipt });
        return { ...result, selection, partial: result.finishReason !== 'stop' };
      }
      if (Object.entries(input.parameters || {}).some(([key, value]) => value != null && !(key === 'thinking' && value === false))) {
        throw failure('OPENCLAW_AGENT_PARAMETERS_UNSUPPORTED', 'Configure agent generation parameters in OpenClaw; its Responses API does not attest request overrides.', 422);
      }
      // Agent execution deliberately uses the native agent loop and tools.
      const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
      const response = await request('/v1/responses', { method: 'POST', signal, timeoutMs,
        headers: { 'x-openclaw-session-key': `agent:${selection.agentId}:agentx:${input.sessionId || 'turn'}:${id}`,
          ...(selection.model ? { 'x-openclaw-model': selection.model } : {}) },
        body: JSON.stringify({ model: `openclaw/${selection.agentId}`, stream: true, instructions,
          // The native Responses schema is strict: every input item declares its type.
          input: messages.filter(message => message.role !== 'system').map(({ role, content }) => ({ type: 'message', role, content })) }) });
      await readEvents(response, event => {
        if (event.type === 'response.completed') { result = event.response; terminal = true; }
        if (['response.failed', 'response.error', 'error'].includes(event.type)) throw failure('OPENCLAW_AGENT_FAILED', 'OpenClaw agent execution failed.');
      });
      if (!terminal || result.status !== 'completed') throw failure('OPENCLAW_RESULT_UNVERIFIED', 'OpenClaw agent completion could not be verified.');
      text = visibleText(result);
      if (!text.trim()) throw failure('OPENCLAW_EMPTY_RESULT', 'OpenClaw returned no assistant answer.');
      // Native progress text may be rewritten. Deliver only the completed answer.
      await onToken?.(text);
      return { schema: 'agentx.openclaw-agent-result/v1', requestId: id, selection, text, thinking: null,
        finishReason: null, partial: false, tools: [],
        receipt: { source: 'openclaw', mode: 'agent', requestId: id, runId: result.id,
          requested: selection, observed: null, usage: result.usage || null, cost: null,
          isolation: null, completion: 'completed', finishReason: null } };
    } catch (error) {
      error.partialResponse ??= text;
      error.partialThinking ??= thinking;
      error.executionState ??= terminal ? 'completed' : 'unknown';
      throw error;
    }
  }
  return { catalog, execute };
}

module.exports = { createOpenClawExecutionClient, connection, readEvents, MODEL_API, CATALOG_SCHEMA, RESULT_SCHEMA };
