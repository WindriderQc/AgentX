import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeSdk, createNativeBackend } from '../native.mjs';
import { createExecutionService } from '../service.mjs';

let installed = true;
try { import.meta.resolve('openclaw/plugin-sdk/llm'); } catch { installed = false; }

test('installed native SDK projects its registry and sends a single isolated request through its own transport', { skip: !installed }, async () => {
  const originalFetch = globalThis.fetch, requests = [];
  let ai, originalHost, failFetch = false;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: typeof url === 'string' ? url : url.url, payload: JSON.parse(options?.body || await url.clone().text()) });
    if (failFetch) return new Response(JSON.stringify({ error: { message: 'synthetic unavailable' } }), { status: 503 });
    // No socket is opened. This fixture terminates the actual native SDK stream.
    const frames = [
      { id: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: null }] },
      { id: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic' } });
  };
  try {
    const sdk = await loadNativeSdk();
    const cfg = { models: { providers: { openrouter: { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'synthetic',
      models: [{ id: 'fixture/model', name: 'Fixture', params: { billingKind: 'free' }, input: ['text'], reasoning: true, contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
      agents: { defaults: { workspace: '/synthetic', model: { primary: 'openrouter/fixture/model' },
        models: { 'openrouter/fixture/model': { params: { provider: { only: ['fixture'], allow_fallbacks: false } } } } } } };
    const storage = sdk.AuthStorage.inMemory({ openrouter: { type: 'api_key', key: 'synthetic' } });
    const backend = createNativeBackend({ config: cfg, pluginConfig: { agentIds: ['main'] } }, { loadSdk: async () => ({ ...sdk,
      AuthStorage: { forAgent: () => storage }, getRuntimeAuthForModel: async () => ({ apiKey: 'synthetic' }),
      ModelRegistry: class extends sdk.ModelRegistry { constructor(auth, path, options) { super(auth, path, { ...options, includePluginCatalogs: false }); } } }) });
    // Initialize OpenClaw's native transport host with an unconditional
    // pre-dispatch rejection, then replace its actual fetch port.
    const native = await backend.prepare('openrouter/fixture/model', {});
    for await (const event of native.stream({ messages: [{ role: 'user', content: 'synthetic' }] },
      { onPayload: () => { throw new Error('TEST_NO_EGRESS'); } })) assert.equal(event.type, 'error');
    ai = await import(new URL('../../node_modules/@openclaw/ai/dist/index.mjs', import.meta.resolve('openclaw/plugin-sdk/llm')));
    originalHost = ai.getAiTransportHost();
    ai.configureAiTransportHost({ ...originalHost, buildModelFetch: () => globalThis.fetch });
    const service = createExecutionService({ backend });
    const catalog = await service.catalogue();
    assert.equal(catalog.models.length, 1); assert.equal(catalog.models[0].origin, 'cloud');
    assert.equal(catalog.models[0].billing.kind, 'free'); assert.equal(catalog.models[0].isolation.providerRouting, true);
    assert.ok(!JSON.stringify(catalog).includes('apiKey'));
    const result = await service.execute({ schema: 'agentx.openclaw-model-request/v1', model: 'openrouter/fixture/model',
      messages: [{ role: 'user', content: 'Only this prompt.' }], parameters: { maxTokens: 64, temperature: 0, thinking: false } });
    assert.equal(requests[0].payload.reasoning.effort, 'none');
    assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.deepEqual(requests[0].payload.messages, [{ role: 'user', content: 'Only this prompt.' }]);
    assert.equal(requests[0].payload.tools, undefined); assert.equal(requests[0].payload.provider.allow_fallbacks, false);
    assert.deepEqual(requests[0].payload.provider.only, ['fixture']);
    assert.equal(result.text, 'answer'); assert.equal(result.receipt.usage.total, 12);
    assert.equal(result.receipt.isolation.modelCalls, 1);
    const reasoning = await service.execute({ schema: 'agentx.openclaw-model-request/v1', model: 'openrouter/fixture/model',
      messages: [{ role: 'user', content: 'Only this prompt.' }], parameters: { maxTokens: 64, thinking: true } });
    assert.equal(requests[1].payload.reasoning.effort, 'low');
    assert.equal(reasoning.receipt.observedParameters.maxTokens, 64);
    const seeded = await service.execute({ schema: 'agentx.openclaw-model-request/v1', model: 'openrouter/fixture/model',
      messages: [{ role: 'user', content: 'Only this prompt.' }], parameters: { maxTokens: 64, seed: 42, topP: .9, responseFormat: 'json' } });
    assert.equal(requests[2].payload.seed, 42); assert.equal(requests[2].payload.top_p, .9);
    assert.deepEqual(requests[2].payload.response_format, { type: 'json_object' });
    assert.equal(seeded.receipt.observedParameters.seed, 42);
    assert.equal(catalog.models[0].parameterSupport.jsonResponseFormat, true);
    assert.equal(requests.length, 3, 'each isolated turn sends exactly one HTTP request');
    cfg.agents.defaults.models['openrouter/fixture/model'].params.extraBody = {
      messages: [{ role: 'system', content: 'Native hidden memory must not enter a model result.' }]
    };
    await assert.rejects(service.execute({ schema: 'agentx.openclaw-model-request/v1', model: 'openrouter/fixture/model',
      messages: [{ role: 'user', content: 'Only this prompt.' }], parameters: { maxTokens: 64 } }), { code: 'OPENCLAW_CONTEXT_DRIFT' });
    assert.equal(requests.length, 3, 'native configuration cannot inject context before HTTP');
    delete cfg.agents.defaults.models['openrouter/fixture/model'].params.extraBody;
    failFetch = true;
    await assert.rejects(service.execute({ schema: 'agentx.openclaw-model-request/v1', model: 'openrouter/fixture/model',
      messages: [{ role: 'user', content: 'Only this prompt.' }], parameters: { maxTokens: 64 } }), { code: 'OPENCLAW_NATIVE_MODEL_FAILED' });
    assert.equal(requests.length, 4, 'the native transport cannot retry a failed HTTP request');
  } finally { if (originalHost) ai.configureAiTransportHost(originalHost); globalThis.fetch = originalFetch; }
});

test('native plugin routes require gateway auth and preserve one SSE completion or bounded private-safe errors', { skip: !installed }, async () => {
  const { registerExecutionRoutes } = await import('../index.mjs');
  const { Readable } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  const routes = [], model = { provider: 'fixture', id: 'model', api: 'openai-completions' };
  const descriptor = { model: 'fixture/model', maxTokens: 128, contextWindow: 8192, fingerprint: 'a'.repeat(64),
    billing: { kind: 'free' }, isolation: { singleCallQualified: true } };
  let fail = false;
  const backend = { catalogue: async () => ({ models: [descriptor], agents: [] }), prepare: async () => ({ model, descriptor,
    stream: (context, options) => (async function* () {
      options.onPayload({ messages: context.messages, max_tokens: options.maxTokens }); yield { type: 'text_delta', delta: 'answer' };
      if (fail) throw new Error('private provider details');
      yield { type: 'done', message: { provider: model.provider, model: model.id, stopReason: 'stop', content: [{ type: 'text', text: 'answer' }],
        usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9 } } };
    })() }) };
  registerExecutionRoutes({ pluginConfig: { maxRequestBytes: 4096 }, registerHttpRoute: value => routes.push(value) }, { backend });
  assert.equal(routes.length, 2); assert.ok(routes.every(route => route.auth === 'gateway' && route.match === 'exact'));
  const invoke = async (body, method = 'POST') => {
    const req = Readable.from([Buffer.from(body)]); req.method = method;
    const res = new EventEmitter(); res.headers = {}; res.chunks = []; res.headersSent = false;
    res.setHeader = (key, value) => { res.headers[key] = value; };
    res.write = value => { res.headersSent = true; res.chunks.push(value); };
    res.end = value => { if (value) res.chunks.push(value); res.writableEnded = true; };
    await routes[1].handler(req, res); return res;
  };
  const request = { schema: 'agentx.openclaw-model-request/v1', model: descriptor.model,
    messages: [{ role: 'user', content: 'synthetic' }], parameters: { maxTokens: 64 }, stream: true };
  const success = await invoke(JSON.stringify(request));
  assert.equal(success.headers['content-type'], 'text/event-stream');
  assert.equal(success.chunks.join('').match(/"type":"completed"/g).length, 1);
  fail = true;
  const partial = await invoke(JSON.stringify({ ...request, stream: false }));
  assert.equal(partial.statusCode, 502); assert.equal(JSON.parse(partial.chunks.join('')).partialResponse, 'answer');
  assert.ok(!partial.chunks.join('').includes('private provider details'));
  const tooLarge = await invoke('x'.repeat(4097)); assert.equal(tooLarge.statusCode, 413);
});
