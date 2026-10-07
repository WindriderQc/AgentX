import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeSdk, createNativeBackend } from '../native.mjs';
import { createExecutionService } from '../service.mjs';

let installed = true;
try { import.meta.resolve('openclaw/plugin-sdk/llm'); } catch { installed = false; }

// Synthetic provider streams. No socket is opened: the installed SDK's own
// fetch port is replaced, so its clients, retry policy and parsers are real.
const sse = frames => frames.map(frame => `${frame.event ? `event: ${frame.event}\n` : ''}data: ${JSON.stringify(frame.data ?? frame)}\n\n`).join('');
const streams = {
  'anthropic-messages': sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', content: [], stop_reason: null,
      usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }]),
  'openai-responses': sse([
    { type: 'response.created', response: { id: 'synthetic', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item', role: 'assistant', content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', item_id: 'item', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'item', output_index: 0, content_index: 0, delta: 'answer' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'synthetic', status: 'completed',
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 0 } } } }])
};
const firstDelta = body => body.split('\n\n').slice(0, 4).join('\n\n') + '\n\n';

const apis = [
  { api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-6', usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 2, total: 17 }, maxTokensKey: 'max_tokens',
    wire: payload => [{ role: 'system', content: payload.system }, ...payload.messages],
    thinkingOff: payload => payload.thinking?.type === 'disabled', thinkingOn: payload => payload.thinking?.type === 'adaptive' },
  { api: 'openai-responses', provider: 'xai', baseUrl: 'https://api.x.ai/v1', url: 'https://api.x.ai/v1/responses',
    model: 'grok-fixture', usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 0, total: 12 }, maxTokensKey: 'max_output_tokens',
    wire: payload => payload.input,
    thinkingOff: payload => payload.reasoning?.effort === 'none', thinkingOn: payload => payload.reasoning?.effort === 'low' }
];
const canonical = [{ role: 'system', content: 'Core persona and explicit RAG.' }, { role: 'user', content: 'Earlier Core turn.' },
  { role: 'assistant', content: 'Earlier Core reply.' }, { role: 'user', content: 'Current Core turn.' }];
const textOf = content => typeof content === 'string' ? content : content.map(block => block.text).join('');

async function harness({ api, provider, baseUrl, model, key = 'synthetic', extraModels = [] }) {
  const sdk = await loadNativeSdk(), requests = [], state = { mode: 'ok', abort: null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = options?.body ?? await url.clone().text();
    requests.push({ url: typeof url === 'string' ? url : url.url, payload: JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8')) });
    if (state.mode === 'disconnect') throw new TypeError('fetch failed');
    if (state.mode === 429 || state.mode === 503) return new Response(JSON.stringify({ error: { message: 'synthetic', type: 'synthetic' } }),
      { status: state.mode, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    const headers = { 'content-type': 'text/event-stream', 'request-id': 'synthetic', 'x-request-id': 'synthetic' };
    if (state.mode === 'ok') return new Response(streams[api], { status: 200, headers });
    // 'cut' breaks the stream after the first delta; 'hang' keeps it open until cancelled.
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(firstDelta(streams[api])));
      if (state.mode === 'cut') setTimeout(() => controller.error(new TypeError('terminated')), 10);
      else options?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    } }), { status: 200, headers });
  };
  const entry = id => ({ id, name: id, api, input: ['text'], reasoning: true, contextWindow: 8192, maxTokens: 4096,
    cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1.25 } });
  const cfg = { models: { providers: { [provider]: { api, baseUrl, apiKey: key, models: [model, ...extraModels].map(entry) } } },
    agents: { defaults: { workspace: '/synthetic', model: { primary: `${provider}/${model}` } } } };
  const storage = sdk.AuthStorage.inMemory({ [provider]: { type: 'api_key', key } });
  const backend = createNativeBackend({ config: cfg, pluginConfig: { agentIds: ['main'] } }, { loadSdk: async () => ({ ...sdk,
    AuthStorage: { forAgent: () => storage }, getRuntimeAuthForModel: async () => ({ apiKey: key }),
    ModelRegistry: class extends sdk.ModelRegistry { constructor(auth, path, options) { super(auth, path, { ...options, includePluginCatalogs: false }); } } }) });
  // Initialize OpenClaw's transport host with a pre-dispatch rejection, then replace its fetch port.
  const native = await backend.prepare(`${provider}/${model}`, {});
  for await (const event of await native.stream({ messages: [{ role: 'user', content: 'synthetic' }] },
    { onPayload: () => { throw new Error('TEST_NO_EGRESS'); } })) assert.equal(event.type, 'error');
  const ai = await import(new URL('../../node_modules/@openclaw/ai/dist/index.mjs', import.meta.resolve('openclaw/plugin-sdk/llm')));
  const originalHost = ai.getAiTransportHost();
  ai.configureAiTransportHost({ ...originalHost, buildModelFetch: () => globalThis.fetch });
  assert.equal(requests.length, 0);
  const ref = id => `${provider}/${id}`;
  const request = (parameters = {}, id = model) => ({ schema: 'agentx.openclaw-model-request/v1', model: ref(id), messages: canonical,
    parameters: { maxTokens: 64, ...parameters }, budget: { maxCalls: 1, maxCostNanodollars: 50_000_000 } });
  return { backend, requests, state, request, ref, service: createExecutionService({ backend, maxRequestCostNanodollars: 50_000_000 }),
    restore: () => { ai.configureAiTransportHost(originalHost); globalThis.fetch = originalFetch; } };
}

for (const spec of apis) {
  test(`installed ${spec.api} transport sends one verified request and never retries`, { skip: !installed }, async () => {
    const h = await harness(spec), { service, requests, state, request } = h;
    const sent = async (run, count = 1) => { const before = requests.length; const value = await run(); assert.equal(requests.length - before, count); return value; };
    const refusedBeforeHttp = (parameters, code, id) => sent(async () => {
      const error = await service.execute(request(parameters, id)).catch(value => value);
      assert.equal(error.code, code); return error;
    }, 0);
    try {
      const descriptor = (await service.catalogue()).models.find(entry => entry.model === h.ref(spec.model));
      assert.equal(descriptor.isolation.singleCallQualified, true); assert.equal(descriptor.billing.kind, 'paid');
      assert.deepEqual(descriptor.parameterSupport, { jsonResponseFormat: false, thinking: true, temperature: null, seed: false, topP: false });

      const result = await sent(() => service.execute(request({ thinking: false })));
      const { url, payload } = requests.at(-1);
      assert.equal(url, spec.url);
      assert.deepEqual(spec.wire(payload).map(message => ({ role: message.role === 'developer' ? 'system' : message.role, content: textOf(message.content) })), canonical);
      assert.equal(payload.tools, undefined); assert.equal(payload[spec.maxTokensKey], 64); assert.ok(spec.thinkingOff(payload));
      assert.equal(result.text, 'answer'); assert.deepEqual({ ...result.receipt.usage, reasoning: undefined }, { ...spec.usage, reasoning: undefined });
      assert.equal(result.receipt.isolation.modelCalls, 1); assert.equal(result.receipt.isolation.toolsExecuted, 0);
      assert.equal(result.receipt.observed.provider, spec.provider); assert.equal(result.receipt.observed.model, spec.model);
      assert.equal(result.receipt.observed.responseId, 'synthetic'); assert.equal(result.receipt.observed.upstreamProvider, null);
      assert.equal(result.receipt.cost.source, 'runtime-estimate'); assert.ok(result.receipt.cost.nanodollars > 0);
      assert.ok(result.receipt.cost.nanodollars <= result.receipt.reservation.reservedNanodollars);
      assert.equal(result.receipt.observedParameters.maxTokens, 64);

      await sent(() => service.execute(request({ thinking: true })));
      assert.ok(spec.thinkingOn(requests.at(-1).payload));
      const tempered = await sent(() => service.execute(request({ temperature: .2 })));
      assert.equal(requests.at(-1).payload.temperature, .2); assert.equal(tempered.receipt.observedParameters.temperature, .2);

      // Parameters this transport drops are refused; nothing reaches the provider.
      for (const [parameters, code] of [[{ seed: 42 }, 'OPENCLAW_PARAMETER_UNSUPPORTED'], [{ topP: .9 }, 'OPENCLAW_PARAMETER_UNSUPPORTED'],
        [{ responseFormat: 'json' }, 'OPENCLAW_RESPONSE_FORMAT_UNSUPPORTED'],
        [{ thinking: true, reasoningMaxTokens: 32 }, 'OPENCLAW_REASONING_BUDGET_UNSUPPORTED']]) await refusedBeforeHttp(parameters, code);
      const unfunded = await sent(() => service.execute({ ...request(), budget: { maxCalls: 1, maxCostNanodollars: 1 } }).catch(value => value), 0);
      assert.equal(unfunded.code, 'OPENCLAW_SPEND_LIMIT_REQUIRED');

      for (const mode of [429, 503, 'disconnect']) {
        state.mode = mode;
        const failure = await sent(() => service.execute(request()).catch(value => value));
        assert.equal(failure.code, 'OPENCLAW_NATIVE_MODEL_FAILED'); assert.equal(failure.partialResponse, '');
        assert.ok(!JSON.stringify(failure).includes('synthetic'), 'provider diagnostics stay native');
      }
      state.mode = 'cut';
      const cut = await sent(() => service.execute(request()).catch(value => value));
      assert.equal(cut.code, 'OPENCLAW_NATIVE_MODEL_FAILED'); assert.equal(cut.partialResponse, 'answer'); assert.equal(cut.executionState, 'unknown');

      state.mode = 'hang';
      const controller = new AbortController(), events = [];
      const cancelled = await sent(() => service.execute(request(), { signal: controller.signal,
        emit: event => { events.push(event.type); if (event.type === 'text_delta') controller.abort(); } }).catch(value => value));
      assert.equal(cancelled.partialResponse, 'answer'); assert.ok(!events.includes('completed'));
    } finally { h.restore(); }
  });
}

test('installed anthropic-messages transport refuses added prompts, dropped parameters and provider fallback before HTTP', { skip: !installed }, async () => {
  const oauth = await harness({ ...apis[0], key: 'sk-ant-oat01-synthetic' });
  try {
    // A subscription token makes the SDK prepend its own agent identity to the system prompt.
    await assert.rejects(oauth.service.execute(oauth.request()), { code: 'OPENCLAW_CONTEXT_DRIFT' });
    assert.equal(oauth.requests.length, 0);
  } finally { oauth.restore(); }
  const h = await harness({ ...apis[0], extraModels: ['claude-opus-4-7', 'claude-opus-5'] });
  try {
    await assert.rejects(h.service.execute(h.request({ temperature: .2 }, 'claude-opus-4-7')), { code: 'OPENCLAW_PARAMETER_UNAPPLIED' });
    // The SDK attaches server-side model fallbacks to this model family.
    await assert.rejects(h.service.execute(h.request({}, 'claude-opus-5')), { code: 'OPENCLAW_NATIVE_STATE_FORBIDDEN' });
    assert.equal(h.requests.length, 0);
  } finally { h.restore(); }
});

test('installed subscription Responses transport stays unavailable: it sends no output limit', { skip: !installed }, async () => {
  const account = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url');
  const h = await harness({ api: 'openai-chatgpt-responses', provider: 'openai', baseUrl: 'https://chatgpt.com/backend-api', model: 'subscription-fixture', key: `x.${account}.y` });
  try {
    const descriptor = (await h.service.catalogue()).models[0];
    assert.equal(descriptor.isolation.singleCallQualified, false); assert.equal(descriptor.parameterSupport.seed, null);
    await assert.rejects(h.service.execute(h.request()), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' });
    let payload;
    const native = await h.backend.prepare(h.ref('subscription-fixture'), { maxTokens: 64 });
    for await (const event of await native.stream({ messages: [{ role: 'user', content: 'synthetic' }] },
      { maxTokens: 64, onPayload: value => { payload = structuredClone(value); throw new Error('TEST_NO_EGRESS'); } })) assert.equal(event.type, 'error');
    assert.ok(!JSON.stringify(payload).includes('64'), 'the requested output bound is absent from the native payload');
    assert.equal(h.requests.length, 0);
  } finally { h.restore(); }
});
