import { randomUUID } from 'node:crypto';
import { fingerprint } from './native.mjs';

const aliasesForMaxTokens = ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxOutputTokens', 'num_predict'];
const reject = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const metric = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) reject(`OPENCLAW_USAGE_${label}_UNAVAILABLE`, 502);
  return value;
};

function nativeContext(messages, model, tools) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 256) reject('OPENCLAW_MESSAGES_INVALID');
  const system = [], history = [];
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') reject('OPENCLAW_MESSAGES_INVALID');
    if (message.role === 'system') { system.push(message.content); continue; }
    if (message.role === 'user') history.push({ role: 'user', content: message.content, timestamp: Date.now() });
    else history.push({ role: 'assistant', content: [{ type: 'text', text: message.content }],
      provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  if (!Array.isArray(tools) || tools.length > 64) reject('OPENCLAW_TOOLS_INVALID');
  const schemas = tools.map(tool => {
    const value = tool.function || tool;
    if (typeof value.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(value.name) || !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) reject('OPENCLAW_TOOLS_INVALID');
    return { name: value.name, description: value.description || '', parameters: value.parameters };
  });
  return { ...(system.length ? { systemPrompt: system.join('\n\n') } : {}), messages: history, ...(schemas.length ? { tools: schemas } : {}) };
}

function parametersFor(raw = {}, descriptor) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('OPENCLAW_PARAMETERS_INVALID');
  const allowed = new Set(['maxTokens', 'temperature', 'topP', 'seed', 'thinking', 'thinkingLevel', 'reasoningMaxTokens', 'responseFormat', 'timeoutMs']);
  if (Object.keys(raw).some(key => !allowed.has(key))) reject('OPENCLAW_PARAMETER_UNSUPPORTED');
  const maxTokens = raw.maxTokens ?? Math.min(4096, descriptor.maxTokens || 4096);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > descriptor.maxTokens) reject('OPENCLAW_MAX_TOKENS_INVALID');
  if (raw.temperature != null && (!Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2)) reject('OPENCLAW_TEMPERATURE_INVALID');
  if (raw.topP != null && (!Number.isFinite(raw.topP) || raw.topP <= 0 || raw.topP > 1)) reject('OPENCLAW_TOP_P_INVALID');
  if (raw.seed != null && !Number.isSafeInteger(raw.seed)) reject('OPENCLAW_SEED_INVALID');
  if ((raw.thinking === true || raw.reasoningMaxTokens != null) && descriptor.reasoning !== true) reject('OPENCLAW_REASONING_UNSUPPORTED', 422);
  if (raw.thinking != null && typeof raw.thinking !== 'boolean') reject('OPENCLAW_THINKING_INVALID');
  if (raw.thinkingLevel && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(raw.thinkingLevel)) reject('OPENCLAW_THINKING_INVALID');
  if (raw.reasoningMaxTokens != null && (!Number.isSafeInteger(raw.reasoningMaxTokens) || raw.reasoningMaxTokens < 1 || raw.reasoningMaxTokens >= maxTokens)) reject('OPENCLAW_REASONING_BUDGET_INVALID');
  if (raw.responseFormat != null && !['text', 'json'].includes(raw.responseFormat)) reject('OPENCLAW_RESPONSE_FORMAT_UNSUPPORTED');
  return { ...raw, maxTokens };
}

function reserveCost(descriptor, parameters, budget) {
  if (['local', 'free', 'included'].includes(descriptor.billing.kind)) return null;
  if (descriptor.billing.kind !== 'paid') reject('OPENCLAW_BILLING_UNAVAILABLE', 503);
  const rates = descriptor.billing.rates;
  // Conservatively bound the whole native context; never guess a provider's tokenizer.
  const cost = Math.ceil((descriptor.contextWindow * Math.max(rates.input, rates.cacheRead, rates.cacheWrite)
    + parameters.maxTokens * rates.output) * 1000);
  if (!Number.isSafeInteger(cost) || !budget || !Number.isSafeInteger(budget.maxCostNanodollars)
      || budget.maxCostNanodollars < cost || budget.maxCalls !== 1) reject('OPENCLAW_SPEND_LIMIT_REQUIRED', 403);
  return { reservedNanodollars: cost, source: 'native-catalog-context-bound' };
}

function findParameter(payload, keys) {
  if (!payload || typeof payload !== 'object') return undefined;
  for (const key of keys) if (Object.hasOwn(payload, key)) return payload[key];
  for (const key of ['generationConfig', 'generation_config', 'options', 'text', 'config']) {
    const value = findParameter(payload[key], keys);
    if (value !== undefined) return value;
  }
}

function verifyWireContext(payload, context, model) {
  if (model.api !== 'openai-completions') reject('OPENCLAW_CONTEXT_TRANSPORT_UNQUALIFIED', 502);
  const textOf = content => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content) || content.some(block => block.type !== 'text' || typeof block.text !== 'string')) reject('OPENCLAW_CONTEXT_UNVERIFIED', 502);
    return content.map(block => block.text).join('');
  };
  const expected = [
    ...(context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : []),
    ...context.messages.map(message => ({ role: message.role, content: textOf(message.content) }))
  ];
  if (!Array.isArray(payload.messages)) reject('OPENCLAW_CONTEXT_UNVERIFIED', 502);
  const observed = payload.messages.map(message => ({
    role: message.role === 'developer' ? 'system' : message.role, content: textOf(message.content)
  }));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) reject('OPENCLAW_CONTEXT_DRIFT', 502);
}

function verifyPayload(payload, parameters, context, model) {
  if (!payload || typeof payload !== 'object') reject('OPENCLAW_PAYLOAD_UNOBSERVED', 502);
  verifyWireContext(payload, context, model);
  const allowedTools = new Set((context.tools || []).map(tool => tool.name));
  for (const tool of payload.tools || payload.config?.tools || []) {
    const declarations = tool.functionDeclarations || [tool];
    for (const declaration of declarations) {
      const name = declaration.function?.name || declaration.name;
      if (!allowedTools.has(name) || (declaration.type && declaration.type !== 'function')) reject('OPENCLAW_NATIVE_TOOLS_FORBIDDEN', 502);
    }
  }
  if (payload.model && payload.model !== model.id) reject('OPENCLAW_MODEL_PARAMETER_DRIFT', 502);
  const aliases = { maxTokens: ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxOutputTokens', 'num_predict'],
    temperature: ['temperature'], topP: ['top_p', 'topP'], seed: ['seed'] };
  for (const [key, names] of Object.entries(aliases)) {
    if (parameters[key] != null && findParameter(payload, names) !== parameters[key]) reject('OPENCLAW_PARAMETER_UNAPPLIED', 422);
  }
  const reasoning = payload.reasoning || payload.reasoning_effort || payload.thinking || payload.generationConfig?.thinkingConfig || payload.config?.thinkingConfig;
  if (model.reasoning && parameters.thinking === false && !(reasoning?.enabled === false || reasoning?.effort === 'none' || reasoning === 'none' || reasoning?.type === 'disabled' || reasoning?.thinkingBudget === 0 || payload.think === false)) reject('OPENCLAW_THINKING_UNAPPLIED', 422);
  if (parameters.thinking === true && !(reasoning?.enabled === true || (reasoning?.effort && reasoning.effort !== 'none') || (typeof reasoning === 'string' && reasoning !== 'none') || ['enabled', 'adaptive'].includes(reasoning?.type) || reasoning?.thinkingBudget > 0 || reasoning?.thinkingBudget === -1 || payload.think === true)) reject('OPENCLAW_THINKING_UNAPPLIED', 422);
  if (parameters.reasoningMaxTokens != null) {
    const observed = payload.reasoning?.max_tokens ?? payload.thinking?.budget_tokens ?? payload.generationConfig?.thinkingConfig?.thinkingBudget ?? payload.config?.thinkingConfig?.thinkingBudget;
    if (observed !== parameters.reasoningMaxTokens) reject('OPENCLAW_REASONING_BUDGET_UNSUPPORTED', 422);
  }
  const format = payload.response_format || payload.text?.format;
  if (parameters.responseFormat === 'json' && !['json_object', 'json_schema'].includes(format?.type) && payload.generationConfig?.responseMimeType !== 'application/json' && payload.config?.responseMimeType !== 'application/json') reject('OPENCLAW_RESPONSE_FORMAT_UNAPPLIED', 422);
}

export function createExecutionService({ backend, now = () => Date.now(), catalogTtlSeconds = 300, maxRequestCostNanodollars = 0 } = {}) {
  async function catalogue() {
    const value = await backend.catalogue();
    return { schema: 'agentx.openclaw-execution-catalog/v1', ...value, policy: { maxRequestCostNanodollars },
      observedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + catalogTtlSeconds * 1000).toISOString() };
  }

  async function execute(request, { signal, emit = () => {} } = {}) {
    if (request?.schema !== 'agentx.openclaw-model-request/v1' || typeof request.model !== 'string') reject('OPENCLAW_REQUEST_INVALID');
    const snapshot = await catalogue();
    const descriptor = snapshot.models.find(entry => entry.model === request.model);
    if (!descriptor) reject('OPENCLAW_MODEL_UNAVAILABLE', 404);
    if (descriptor.isolation?.singleCallQualified !== true) reject('OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED', 503);
    if (request.expectedFingerprint && request.expectedFingerprint !== descriptor.fingerprint) reject('OPENCLAW_TARGET_DRIFT', 409);
    const parameters = parametersFor(request.parameters, descriptor);
    const budget = request.budget ? { ...request.budget,
      maxCostNanodollars: Math.min(request.budget.maxCostNanodollars, maxRequestCostNanodollars) }
      : { maxCalls: 1, maxCostNanodollars: maxRequestCostNanodollars };
    const reservation = reserveCost(descriptor, parameters, budget);
    const native = await backend.prepare(request.model, parameters);
    if (native.descriptor.fingerprint !== descriptor.fingerprint) reject('OPENCLAW_TARGET_DRIFT', 409);
    const context = nativeContext(request.messages, native.model, request.tools || []);
    const id = request.requestId || randomUUID(), startedAt = now();
    let payload, payloadError, calls = 0, responseId = null, result, partialText = '', partialThinking = '';
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(600000, parameters.timeoutMs || 600000)));
    const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    boundedSignal.throwIfAborted();
    try {
      const stream = native.stream(context, { signal: boundedSignal, requestId: id, maxTokens: parameters.maxTokens,
        ...(parameters.temperature != null ? { temperature: parameters.temperature } : {}),
        ...(parameters.reasoningMaxTokens != null ? { thinkingBudgets: { low: parameters.reasoningMaxTokens } } : {}),
        onPayload: value => {
          if (++calls !== 1) reject('OPENCLAW_SECOND_MODEL_CALL_FORBIDDEN', 502);
          try { verifyPayload(value, parameters, context, native.model); } catch (error) { payloadError = error; throw error; }
          payload = structuredClone(value);
        },
        onResponse: response => { responseId = response.headers?.get?.('x-request-id') || response.headers?.['x-request-id'] || null; }
      });
      for await (const event of stream) {
        if (event.type === 'text_delta') { partialText += event.delta; await emit({ type: 'text_delta', delta: event.delta }); }
        else if (event.type === 'thinking_delta') { partialThinking += event.delta; await emit({ type: 'thinking_delta', delta: event.delta }); }
        else if (event.type === 'done') result = event.message;
        else if (event.type === 'error') throw payloadError || Object.assign(new Error('OPENCLAW_NATIVE_MODEL_FAILED'), { code: 'OPENCLAW_NATIVE_MODEL_FAILED' });
      }
      boundedSignal.throwIfAborted();
      if (!result || calls !== 1 || !payload || result.provider !== native.model.provider || result.model !== native.model.id) reject('OPENCLAW_RESULT_UNVERIFIED', 502);
      const content = result.content || [];
      const text = content.filter(block => block.type === 'text').map(block => block.text).join('');
      const thinking = content.filter(block => block.type === 'thinking').map(block => block.thinking).join('') || null;
      if (partialText && partialText !== text) reject('OPENCLAW_STREAM_DIVERGED', 502);
      const usage = { input: metric(result.usage?.input, 'INPUT'), output: metric(result.usage?.output, 'OUTPUT'),
        cacheRead: metric(result.usage?.cacheRead, 'CACHE_READ'), cacheWrite: metric(result.usage?.cacheWrite, 'CACHE_WRITE'),
        total: metric(result.usage?.totalTokens, 'TOTAL'), reasoning: result.usage?.reasoningTokens ?? null };
      const toolCalls = content.filter(block => block.type === 'toolCall').map(block => ({ id: block.id, name: block.name, arguments: block.arguments }));
      if (toolCalls.some(call => !context.tools?.some(tool => tool.name === call.name))) reject('OPENCLAW_UNDECLARED_TOOL_CALL', 502);
      if (usage.total !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite
          || ((text || thinking || toolCalls.length) && usage.output === 0)
          || usage.input + usage.cacheRead + usage.cacheWrite === 0) reject('OPENCLAW_USAGE_UNOBSERVED', 502);
      const estimated = result.usage?.cost?.total;
      const cost = Number.isFinite(estimated) && estimated >= 0 ? { nanodollars: Math.ceil(estimated * 1e9), source: 'runtime-estimate', currency: 'USD' } : null;
      const finishReason = result.stopReason === 'length' ? 'length' : result.stopReason === 'stop' ? 'stop' : result.stopReason;
      const receipt = { schema: 'agentx.openclaw-execution-receipt/v1', source: 'openclaw', mode: 'model', requestId: id,
        runtimeVersion: native.runtimeVersion, pluginFingerprint: native.pluginFingerprint, targetFingerprint: descriptor.fingerprint, durationMs: now() - startedAt,
        requested: { model: request.model, parameters }, observed: { provider: result.provider, model: result.model,
          identitySource: 'native-selected-route', modelVersion: descriptor.modelVersion, modelVersionSource: descriptor.modelVersionSource, upstreamProvider: null, responseId },
        usage, cost, billing: descriptor.billing, reservation, finishReason,
        isolation: { noAgentPrompt: true, noMemory: true, noTools: !context.tools?.length, toolsExecuted: 0,
          noRuntimeFallback: true, modelCalls: calls, providerRouting: payload.provider || null },
        contextFingerprint: fingerprint(context), payloadFingerprint: fingerprint(payload), configuredParameters: native.effectiveParameters,
        observedParameters: { maxTokens: findParameter(payload, aliasesForMaxTokens), temperature: findParameter(payload, ['temperature']) ?? null,
          topP: findParameter(payload, ['top_p', 'topP']) ?? null, seed: findParameter(payload, ['seed']) ?? null } };
      const value = { schema: 'agentx.openclaw-model-result/v1', requestId: id, model: request.model, text, thinking, toolCalls, finishReason, receipt };
      await emit({ type: 'completed', result: value });
      return value;
    } catch (error) {
      // Provider diagnostics are deliberately not returned to AgentX.
      const code = /^OPENCLAW_[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'OPENCLAW_NATIVE_MODEL_FAILED';
      throw Object.assign(new Error(code), { code,
        statusCode: error.statusCode || 502, partialResponse: partialText, partialThinking,
        reservation, executionState: calls ? 'unknown' : 'not-dispatched' });
    }
  }
  return { catalogue, execute };
}
