'use strict';

const { executeWithTelemetry } = require('./openclawTelemetry');
const { PassThrough } = require('node:stream');
const { createOpenClawExecutionClient } = require('../../../../shared/openclawExecutionClient');
const { parseExecutionSource, executionModelId } = require('../../../../shared/executionSource');

function parametersFor(request) {
  const options = request.options || {};
  const aliases = { maxTokens: [request.max_tokens, options.num_predict, options.max_tokens],
    temperature: [request.temperature, options.temperature], topP: [request.top_p, options.top_p],
    seed: [request.seed, options.seed == null || options.seed === '' ? undefined : Number(options.seed)], thinking: [request.think],
    thinkingLevel: [request.thinkingMode === 'on' ? 'low' : ['auto', 'off', undefined].includes(request.thinkingMode) ? undefined : request.thinkingMode],
    reasoningMaxTokens: [request.reasoningMaxTokens], responseFormat: [request.responseFormat] };
  return { ...Object.fromEntries(Object.entries(aliases).map(([key, values]) => [key, values.find(value => value != null)])
    .filter(([, value]) => value != null)), ...(request.parameters || {}) };
}

function responseFor(result, model) {
  const usage = result.receipt?.usage;
  const input = usage?.input != null ? usage.input + (usage.cacheRead || 0) + (usage.cacheWrite || 0) : usage?.input_tokens;
  const output = usage?.output ?? usage?.output_tokens;
  const total = usage?.total ?? usage?.total_tokens;
  const stats = input != null && output != null ? { usage: { promptTokens: input, completionTokens: output, totalTokens: total ?? input + output },
    meta: { executionReceipt: result.receipt }, performance: { totalDuration: (result.receipt.durationMs || 0) * 1e6 } } : null;
  return { status: 'success', model, response: result.text, message: { role: 'assistant', content: result.text, ...(result.thinking ? { thinking: result.thinking } : {}) },
    done: true, done_reason: result.finishReason, partial: result.partial, stats, executionReceipt: result.receipt,
    ...(input != null ? { prompt_eval_count: input } : {}), ...(output != null ? { eval_count: output } : {}) };
}

async function executeOpenClawInference(request, options = {}, client = createOpenClawExecutionClient()) {
  const selection = parseExecutionSource(request);
  if (selection?.source !== 'openclaw') throw new Error('OpenClaw selection required');
  if (request.mode === 'embed') throw Object.assign(new Error('OpenClaw execution does not replace local embeddings.'), { code: 'OPENCLAW_EMBEDDING_UNSUPPORTED', statusCode: 400 });
  if (options.hostUrl || options.benchmarkClaims || String(options.consumerContract || '').startsWith('openclaw-') || options.sourcePolicy === 'local-only') {
    throw Object.assign(new Error('This local runtime bridge cannot delegate back to OpenClaw.'), { code: 'EXECUTION_SOURCE_RECURSION', statusCode: 403 });
  }
  const messages = request.messages || [{ role: 'user', content: request.prompt || '' }];
  const input = { execution: selection, model: executionModelId(selection), messages: request.system ? [{ role: 'system', content: request.system }, ...messages] : messages,
    requestId: request.requestId, sessionId: request.conversationId || request.sessionId,
    parameters: parametersFor(request), budget: request.budget, tools: request.tools };
  if (request.stream !== true) {
    const result = await executeWithTelemetry(client, input, { signal: options.signal, timeoutMs: options.timeoutMs || request.timeoutMs },
      { callerDetail: request.callerDetail, consumerContract: options.consumerContract, taskType: request.taskType });
    return { ok: true, status: 200, body: responseFor(result, input.model), headers: { 'x-agentx-execution-source': 'openclaw' },
      metadata: { execution: selection, receipt: result.receipt } };
  }
  const stream = new PassThrough();
  const write = value => { if (!stream.destroyed) stream.write(`${JSON.stringify(value)}\n`); };
  const completion = executeWithTelemetry(client, input, { signal: options.signal, timeoutMs: options.timeoutMs || request.timeoutMs,
    onToken: text => write({ message: { role: 'assistant', content: text }, done: false }),
    onThinking: thinking => write({ message: { thinking }, done: false }) },
    { callerDetail: request.callerDetail, consumerContract: options.consumerContract, taskType: request.taskType }).then(result => {
      write({ ...responseFor(result, input.model), message: { content: '' }, response: '', done: true });
      stream.end();
      return { completed: true, terminalComplete: true, metadata: { executionReceipt: result.receipt },
        result: responseFor(result, input.model) };
    }, error => {
      write({ error: 'OpenClaw execution failed.', code: error.code, partial: true }); stream.end();
      throw error;
    });
  void completion.catch(() => {});
  return { ok: true, status: 200, stream, completion, body: {}, headers: { 'x-agentx-execution-source': 'openclaw' }, metadata: { execution: selection } };
}

async function settleNativeInference(execution) {
  try {
    const result = await execution;
    if (!result.stream) return result;
    for await (const chunk of result.stream) { /* existing HTTP inference returns aggregated JSON */ }
    const completion = await result.completion;
    return { ok: true, status: 200, headers: result.headers, body: completion.result, metadata: completion.metadata };
  } catch (error) {
    return { ok: false, status: error.statusCode || 502, headers: { 'x-agentx-execution-source': 'openclaw' },
      body: { status: 'error', code: error.code || 'OPENCLAW_EXECUTION_FAILED', message: error.message,
        partialResponse: error.partialResponse || '', partialThinking: error.partialThinking || '', executionState: error.executionState || 'unknown' } };
  }
}

function withExecutionSource(localExecute, client, { aggregateStreams = false } = {}) {
  return (request, options) => {
    let selection;
    try { selection = parseExecutionSource(request); }
    catch (error) { if (aggregateStreams) return settleNativeInference(Promise.reject(error)); throw error; }
    if (selection?.source !== 'openclaw') return localExecute(selection?.model ? { ...request, model: selection.model } : request, options);
    const execution = executeOpenClawInference(request, options, client);
    return aggregateStreams ? settleNativeInference(execution) : execution;
  };
}

module.exports = { parametersFor, responseFor, executeOpenClawInference, withExecutionSource };
