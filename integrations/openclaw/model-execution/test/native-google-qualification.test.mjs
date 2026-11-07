import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { loadNativeSdk, createNativeBackend, qualifiedModelApi } from '../native.mjs';
import { createExecutionService } from '../service.mjs';

let installed = true;
try { import.meta.resolve('openclaw/plugin-sdk/llm'); } catch { installed = false; }
const skip = !installed && !process.env.AGENTX_REQUIRE_OPENCLAW_SDK;
const canonical = [{ role: 'system', content: ' Exact Core persona.\nExplicit RAG. ' },
  { role: 'user', content: 'Earlier Core turn.' }, { role: 'assistant', content: 'Earlier Core reply.' },
  { role: 'user', content: ' Current Core turn. ' }];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = frame({ candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }] });
const terminal = frame({ candidates: [{ finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 3 } });
const forbiddenState = ['cachedContent', 'previous_response_id', 'conversation', 'fallbacks', 'context_management', 'mcp_servers'];

async function harness() {
  const requests = [], sockets = [], state = { mode: 'ok' }, restores = [];
  // Replace the network boundary only. Keep the real SDK request construction,
  // client, retry decisions and stream parser. No credentials or provider socket.
  for (const [owner, key] of [[net, 'connect'], [net, 'createConnection'], [tls, 'connect'], [http, 'request'], [https, 'request']]) {
    const original = owner[key];
    owner[key] = () => { sockets.push(key); throw new Error('TEST_PROVIDER_SOCKET_FORBIDDEN'); };
    restores.push(() => { owner[key] = original; });
  }
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch;
  restores.push(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    const target = typeof url === 'string' ? url : url.url;
    const body = options?.body ?? await url.clone().text();
    requests.push({ url: target, payload: JSON.parse(body) });
    assert.equal(target, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-fixture:streamGenerateContent?alt=sse');
    if (state.mode === 'disconnect') throw new TypeError('synthetic disconnect');
    if ([429, 503].includes(state.mode)) return new Response(JSON.stringify({ error: { code: state.mode, message: 'synthetic' } }),
      { status: state.mode, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    const headers = { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic' };
    if (state.mode === 'ok') return new Response(delta + terminal, { headers });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(delta));
      if (state.mode === 'cut') setTimeout(() => controller.error(new TypeError('synthetic terminated')), 10);
      else options.signal.addEventListener('abort', () => controller.error(new DOMException('synthetic abort', 'AbortError')), { once: true });
    } }), { headers });
  };
  const restore = () => { for (const run of restores.reverse()) run(); syncBuiltinESMExports(); };
  try {
    const sdk = await loadNativeSdk();
    const ref = 'google/gemini-2.5-flash-fixture';
    const cfg = { models: { providers: { google: { api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'synthetic', models: ['gemini-2.5-flash-fixture', 'gemini-2.5-pro-fixture'].map(id => ({ id, name: 'Synthetic', input: ['text'], reasoning: true,
        contextWindow: 8192, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 0 } })) } } },
      agents: { defaults: { workspace: '/synthetic', model: { primary: ref } } } };
    const storage = sdk.AuthStorage.inMemory({ google: { type: 'api_key', key: 'synthetic' } });
    const backendWith = (overrides = {}) => createNativeBackend({ config: cfg, pluginConfig: { agentIds: ['main'] } }, { loadSdk: async () => ({ ...sdk, ...overrides,
      AuthStorage: { forAgent: () => storage }, getRuntimeAuthForModel: async () => ({ apiKey: 'synthetic' }),
      ModelRegistry: class extends sdk.ModelRegistry { constructor(auth, path, options) { super(auth, path, { ...options, includePluginCatalogs: false }); } } }) });
    const backend = backendWith();
    const request = (parameters = {}, messages = canonical) => ({ schema: 'agentx.openclaw-model-request/v1', model: ref, messages,
      parameters: { maxTokens: 64, ...parameters }, budget: { maxCalls: 1, maxCostNanodollars: 50_000_000 } });
    return { sdk, cfg, ref, backend, backendWith, requests, sockets, state, request, restore,
      service: createExecutionService({ backend, maxRequestCostNanodollars: 50_000_000 }) };
  } catch (error) { restore(); throw error; }
}

test('native Google qualification requires the exact SDK version, API and executable dependency fingerprint', { skip, timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const catalogue = await h.service.catalogue(), descriptor = catalogue.models.find(value => value.model === h.ref);
    assert.equal(h.sdk.version, '2026.9.4');
    assert.equal(descriptor.nativeTransportFingerprint, h.sdk.googleTransportFingerprint);
    assert.equal(descriptor.isolation.singleCallQualified, true, `unqualified native SDK bytes: ${h.sdk.googleTransportFingerprint}`);
    assert.deepEqual(descriptor.parameterSupport, { jsonResponseFormat: false, thinking: true, temperature: true, seed: false, topP: false });
    assert.equal(qualifiedModelApi('2026.9.4', 'google-generative-ai'), null);
    assert.equal(qualifiedModelApi('2026.9.4', 'google-generative-ai', 'changed'), null);
    assert.equal(qualifiedModelApi('2026.11.1', 'google-generative-ai', h.sdk.googleTransportFingerprint), null);
    assert.equal(qualifiedModelApi('2026.9.4', 'google-vertex', h.sdk.googleTransportFingerprint), null);
    const changed = h.backendWith({ googleTransportFingerprint: 'changed' });
    const changedCatalogue = await changed.catalogue();
    assert.equal(changedCatalogue.models[0].isolation.singleCallQualified, false);
    assert.notEqual(changedCatalogue.models[0].fingerprint, descriptor.fingerprint);
    await assert.rejects(createExecutionService({ backend: changed }).execute(h.request()), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' });
    assert.equal(h.requests.length, 0); assert.deepEqual(h.sockets, []);
  } finally { h.restore(); }
});

test('installed Google SDK preserves exact wire context, applies parameters, reports usage and never retries', { skip, timeout: 30000 }, async () => {
  const h = await harness();
  const sent = async (run, count = 1) => {
    const before = h.requests.length;
    const value = await run();
    assert.equal(h.requests.length - before, count);
    assert.deepEqual(h.sockets, []);
    return value;
  };
  try {
    const first = await sent(() => h.service.execute(h.request({ temperature: .2, thinking: false })));
    const wire = h.requests.at(-1).payload;
    assert.deepEqual([{ role: 'system', content: wire.systemInstruction.parts.map(part => part.text).join('') },
      ...wire.contents.map(message => ({ role: message.role === 'model' ? 'assistant' : message.role,
        content: message.parts.map(part => part.text).join('') }))], canonical);
    assert.deepEqual(Object.keys(wire).sort(), ['contents', 'generationConfig', 'systemInstruction']);
    assert.equal(wire.generationConfig.maxOutputTokens, 64); assert.equal(wire.generationConfig.temperature, .2);
    assert.equal(wire.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.equal(wire.tools, undefined); assert.ok(forbiddenState.every(key => wire[key] == null));
    assert.equal(first.text, 'answer');
    assert.deepEqual(first.receipt.usage, { input: 7, output: 2, cacheRead: 3, cacheWrite: 0, total: 12, reasoning: null });
    assert.deepEqual(first.receipt.isolation, { noAgentPrompt: true, noMemory: true, noTools: true, toolsExecuted: 0,
      noRuntimeFallback: true, modelCalls: 1, providerRouting: null });
    assert.equal(first.receipt.observed.provider, 'google'); assert.equal(first.receipt.observed.model, 'gemini-2.5-flash-fixture');
    assert.equal(first.receipt.observed.modelVersion, 'unknown'); assert.equal(first.receipt.observed.upstreamProvider, null);
    assert.equal(first.receipt.observedParameters.maxTokens, 64); assert.equal(first.receipt.observedParameters.temperature, .2);
    assert.equal(first.receipt.cost.source, 'runtime-estimate'); assert.ok(first.receipt.cost.nanodollars > 0);
    assert.ok(first.receipt.cost.nanodollars <= first.receipt.reservation.reservedNanodollars);
    await sent(() => h.service.execute(h.request({ thinking: true })));
    assert.equal(h.requests.at(-1).payload.generationConfig.thinkingConfig.thinkingBudget, 2048);
    await sent(() => h.service.execute(h.request({ thinking: true, thinkingLevel: 'high' })));
    assert.equal(h.requests.at(-1).payload.generationConfig.thinkingConfig.thinkingBudget, 24576);
    await sent(() => h.service.execute(h.request({ thinking: true, reasoningMaxTokens: 32 })));
    assert.equal(h.requests.at(-1).payload.generationConfig.thinkingConfig.thinkingBudget, 32);
    await sent(() => h.service.execute(h.request({ thinking: false }, [{ role: 'user', content: 'Independent turn.' }])));
    assert.deepEqual(h.requests.at(-1).payload.contents, [{ role: 'user', parts: [{ text: 'Independent turn.' }] }]);
    assert.equal(h.requests.at(-1).payload.systemInstruction, undefined);

    for (const [parameters, code] of [[{ seed: 42 }, 'OPENCLAW_PARAMETER_UNSUPPORTED'], [{ topP: .9 }, 'OPENCLAW_PARAMETER_UNSUPPORTED'],
      [{ responseFormat: 'json' }, 'OPENCLAW_RESPONSE_FORMAT_UNSUPPORTED']]) {
      await sent(() => assert.rejects(h.service.execute(h.request(parameters)), { code }), 0);
    }
    await sent(() => assert.rejects(h.service.execute({ ...h.request(), budget: { maxCalls: 1, maxCostNanodollars: 1 } }),
      { code: 'OPENCLAW_SPEND_LIMIT_REQUIRED' }), 0);
    for (const mode of [429, 503, 'disconnect', 'cut', 'hang']) {
      h.state.mode = mode;
      const controller = new AbortController(), events = [];
      const failure = await sent(() => h.service.execute(h.request(), { signal: controller.signal,
        emit: event => { events.push(event.type); if (mode === 'hang' && event.type === 'text_delta') controller.abort(); } }).catch(error => error));
      assert.equal(failure.code, 'OPENCLAW_NATIVE_MODEL_FAILED');
      assert.equal(failure.partialResponse, ['cut', 'hang'].includes(mode) ? 'answer' : '');
      assert.equal(failure.executionState, 'unknown');
      assert.ok(!events.includes('completed'));
      assert.ok(!JSON.stringify(failure).includes('synthetic'));
    }
  } finally { h.restore(); }
});

test('installed Google SDK refuses native context loss and thinking that cannot be disabled before HTTP', { skip, timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const messages = [...canonical, { role: 'assistant', content: '   ' }, { role: 'user', content: 'Next turn.' }];
    await assert.rejects(h.service.execute(h.request({}, messages)), { code: 'OPENCLAW_CONTEXT_DRIFT' });
    await assert.rejects(h.service.execute({ ...h.request({ thinking: false }), model: 'google/gemini-2.5-pro-fixture' }),
      { code: 'OPENCLAW_THINKING_UNAPPLIED' });
    assert.equal(h.requests.length, 0); assert.deepEqual(h.sockets, []);
  } finally { h.restore(); }
});
