import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { loadNativeSdk, createNativeBackend, qualifiedModelApi } from '../native.mjs';
import { createExecutionService } from '../service.mjs';

let installed = true;
try { import.meta.resolve('openclaw/plugin-sdk/llm'); } catch { installed = false; }
const skip = !installed && !process.env.AGENTX_REQUIRE_OPENCLAW_SDK;
const canonical = [{ role: 'system', content: ' Exact Core persona.\nExplicit RAG. ' }, { role: 'user', content: 'Earlier Core turn.' },
  { role: 'assistant', content: 'Earlier Core reply.' }, { role: 'user', content: ' Current Core turn. ' }];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const responses = [
  { type: 'response.created', response: { id: 'synthetic', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item', role: 'assistant', content: [], status: 'in_progress' } },
  { type: 'response.content_part.added', item_id: 'item', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
  { type: 'response.output_text.delta', item_id: 'item', output_index: 0, content_index: 0, delta: 'answer' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] } },
  { type: 'response.completed', response: { id: 'synthetic', status: 'completed', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12,
    input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 0 } } } }
].map(frame);
const mistral = [
  { id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: null }] },
  { id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
].map(frame);
const specs = [
  { api: 'azure-openai-responses', provider: 'azure', baseUrl: 'https://synthetic.openai.azure.com/openai/v1',
    url: 'https://synthetic.openai.azure.com/openai/v1/responses?api-version=v1', frames: responses, reasoning: true },
  { api: 'azure-openai-responses', provider: 'azure', baseUrl: 'https://synthetic.services.ai.azure.com/openai/v1',
    url: 'https://synthetic.services.ai.azure.com/openai/v1/responses', frames: responses, reasoning: true },
  { api: 'mistral-conversations', provider: 'mistral', baseUrl: 'https://api.mistral.ai',
    url: 'https://api.mistral.ai/v1/chat/completions', frames: mistral, reasoning: false }
];
const azureEnv = ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP'];

async function harness(spec) {
  // Fail before loading a native SDK unless the process has no external network
  // interface. Run under `unshare -Urn` (loopback may be enabled for other tests).
  assert.ok(Object.values(networkInterfaces()).flat().every(value => value.internal), 'Native SDK qualification requires an isolated network namespace');
  const directory = await mkdtemp(join(tmpdir(), 'agentx-native-key-')), restores = [], requests = [], sockets = [], state = { mode: 'ok' };
  for (const key of ['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_AD_TOKEN',
    'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'MISTRAL_API_KEY', ...azureEnv]) {
    const previous = process.env[key]; restores.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    if (key === 'OPENCLAW_STATE_DIR') process.env[key] = directory;
    else if (key === 'OPENCLAW_CONFIG_PATH') process.env[key] = join(directory, 'config.json');
    else delete process.env[key];
  }
  for (const [owner, key] of [[net, 'connect'], [net, 'createConnection'], [tls, 'connect'], [http, 'request'], [https, 'request']]) {
    const original = owner[key]; owner[key] = () => { sockets.push(key); throw new Error('TEST_PROVIDER_SOCKET_FORBIDDEN'); };
    restores.push(() => { owner[key] = original; });
  }
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch; restores.push(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    const target = typeof url === 'string' ? url : url.url;
    const body = options?.body ?? await url.clone().text();
    const signal = options?.signal ?? url.signal;
    const headers = new Headers(options?.headers ?? url.headers);
    assert.ok(['synthetic', 'Bearer synthetic'].includes(headers.get('api-key') ?? headers.get('authorization')), 'only synthetic native credentials reach the intercepted port');
    requests.push({ url: target, payload: JSON.parse(body) });
    assert.equal(target, spec.url);
    if (state.mode === 'disconnect') throw new TypeError('synthetic disconnect');
    if ([429, 503].includes(state.mode)) return new Response(JSON.stringify({ error: { message: 'synthetic', type: 'synthetic' } }),
      { status: state.mode, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    const responseHeaders = { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic' };
    if (state.mode === 'ok') return new Response(spec.frames.join(''), { headers: responseHeaders });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(spec.frames.slice(0, spec.reasoning ? 4 : 1).join('')));
      if (state.mode === 'cut') state.breakStream = () => controller.error(new TypeError('synthetic terminated'));
      else signal.addEventListener('abort', () => controller.error(new DOMException('synthetic aborted', 'AbortError')), { once: true });
    } }), { headers: responseHeaders });
  };
  const restore = async () => { for (const run of restores.reverse()) run(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }); };
  try {
    const sdk = await loadNativeSdk();
    const entry = (id, reasoning = spec.reasoning) => ({ id, name: 'Synthetic', input: ['text'], reasoning, contextWindow: 8192, maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 0 } });
    const ref = `${spec.provider}/fixture-model`;
    const cfg = { models: { providers: { [spec.provider]: { api: spec.api, baseUrl: spec.baseUrl, auth: 'api-key', apiKey: 'synthetic',
      models: [entry('fixture-model'), ...(spec.reasoning ? [] : [entry('reasoning-fixture', true)])] } } },
      agents: { defaults: { workspace: directory, model: { primary: ref } } } };
    const storage = sdk.AuthStorage.inMemory({ [spec.provider]: { type: 'api_key', key: 'synthetic' } });
    const backendWith = (overrides = {}) => createNativeBackend({ config: cfg, pluginConfig: { agentIds: ['main'] } }, { loadSdk: async () => ({ ...sdk,
      AuthStorage: { forAgent: () => storage },
      ModelRegistry: class extends sdk.ModelRegistry { constructor(auth, path, options) { super(auth, path, { ...options, includePluginCatalogs: false }); } }, ...overrides }) });
    const backend = backendWith();
    const native = await backend.prepare(ref, {});
    for await (const event of native.stream({ messages: [{ role: 'user', content: 'synthetic' }] }, { onPayload: () => { throw new Error('TEST_NO_EGRESS'); } })) assert.equal(event.type, 'error');
    // Intercept the actual native port. Replacing global fetch alone does not
    // intercept SDK-managed model fetchers.
    const ai = await import(new URL('../../node_modules/@openclaw/ai/dist/index.mjs', import.meta.resolve('openclaw/plugin-sdk/llm')));
    const host = ai.getAiTransportHost(); ai.configureAiTransportHost({ ...host, buildModelFetch: () => globalThis.fetch });
    restores.push(() => ai.configureAiTransportHost(host));
    assert.equal(requests.length, 0); assert.deepEqual(sockets, []);
    const request = (parameters = {}, messages = canonical) => ({ schema: 'agentx.openclaw-model-request/v1', model: ref, messages,
      parameters: { maxTokens: 64, ...parameters }, budget: { maxCalls: 1, maxCostNanodollars: 50_000_000 } });
    return { sdk, cfg, ref, backend, backendWith, state, requests, sockets, restore, request,
      service: createExecutionService({ backend, maxRequestCostNanodollars: 50_000_000 }) };
  } catch (error) { await restore(); throw error; }
}
const textOf = content => typeof content === 'string' ? content : content.map(part => part.text).join('');

for (const spec of specs) {
  test(`native ${spec.api} ${new URL(spec.baseUrl).hostname} proves one isolated attempt, exact wire context, parameters, usage and cancellation`, { skip, timeout: 60000 }, async () => {
    const h = await harness(spec);
    const sent = async (run, count = 1) => { const before = h.requests.length; const value = await run(); assert.equal(h.requests.length - before, count); assert.deepEqual(h.sockets, []); return value; };
    try {
      const target = (await h.backend.catalogue()).models.find(value => value.model === h.ref);
      assert.equal(target.isolation.singleCallQualified, true, `unqualified SDK bytes: ${target.nativeTransportFingerprint}`);
      assert.equal(qualifiedModelApi('2026.9.4', spec.api, 'changed'), null);
      assert.equal(qualifiedModelApi('2026.11.1', spec.api, target.nativeTransportFingerprint), null);
      const field = spec.reasoning ? 'azureTransportFingerprint' : 'mistralTransportFingerprint';
      const changed = h.backendWith({ [field]: 'changed' });
      assert.equal((await changed.catalogue()).models.find(value => value.model === h.ref).isolation.singleCallQualified, false);
      await sent(() => assert.rejects(createExecutionService({ backend: changed }).execute(h.request()), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' }), 0);
      const result = await sent(() => h.service.execute(h.request({ temperature: .2, ...(spec.reasoning ? {} : { thinking: false }) })));
      const payload = h.requests.at(-1).payload;
      assert.deepEqual((payload.input || payload.messages).map(value => ({ role: value.role === 'developer' ? 'system' : value.role, content: textOf(value.content) })), canonical);
      assert.equal(payload.tools, undefined); assert.equal(payload.max_output_tokens ?? payload.max_tokens, 64); assert.equal(payload.temperature, .2);
      assert.equal(result.text, 'answer'); assert.equal(result.receipt.isolation.noMemory, true); assert.equal(result.receipt.isolation.noAgentPrompt, true);
      assert.equal(result.receipt.isolation.toolsExecuted, 0); assert.equal(result.receipt.isolation.modelCalls, 1); assert.equal(result.receipt.isolation.noRuntimeFallback, true);
      assert.deepEqual([result.receipt.usage.input, result.receipt.usage.output, result.receipt.usage.cacheRead, result.receipt.usage.total], spec.reasoning ? [7, 2, 3, 12] : [10, 2, 0, 12]);
      assert.equal(result.receipt.observedParameters.maxTokens, 64); assert.equal(result.receipt.cost.source, 'runtime-estimate'); assert.ok(result.receipt.cost.nanodollars > 0);
      assert.equal(result.receipt.observed.modelVersion, 'unknown');
      if (spec.reasoning) {
        await sent(() => assert.rejects(h.service.execute(h.request({ thinking: false })), { code: 'OPENCLAW_THINKING_UNAPPLIED' }), 0);
        await sent(() => h.service.execute(h.request({ thinking: true, thinkingLevel: 'low' })));
        assert.equal(h.requests.at(-1).payload.reasoning.effort, 'low');
      } else {
        await sent(() => assert.rejects(h.service.execute(h.request({ thinking: true })), { code: 'OPENCLAW_REASONING_UNSUPPORTED' }), 0);
        await sent(() => assert.rejects(h.service.execute(h.request({ thinkingLevel: 'high' })), { code: 'OPENCLAW_REASONING_UNSUPPORTED' }), 0);
        await sent(() => assert.rejects(h.service.execute({ ...h.request(), model: `${spec.provider}/reasoning-fixture` }), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' }), 0);
      }
      for (const parameters of [{ seed: 42 }, { topP: .9 }, { responseFormat: 'json' }, { reasoningMaxTokens: 32 }]) {
        await sent(() => assert.rejects(h.service.execute(h.request(parameters)), error => error.code?.startsWith('OPENCLAW_')), 0);
      }
      await sent(() => h.service.execute(h.request({}, [{ role: 'user', content: 'Independent turn.' }])));
      assert.deepEqual(h.requests.at(-1).payload.input?.map(value => textOf(value.content)) || h.requests.at(-1).payload.messages.map(value => textOf(value.content)), ['Independent turn.']);
      for (const mode of [429, 503, 'disconnect', 'cut', 'hang']) {
        h.state.mode = mode;
        const controller = new AbortController(), events = [];
        const failure = await sent(() => h.service.execute(h.request(), { signal: controller.signal,
          emit: event => { events.push(event.type); if (event.type === 'text_delta') {
            if (mode === 'hang') controller.abort();
            if (mode === 'cut') h.state.breakStream();
          } } }).catch(error => error));
        assert.equal(failure.code, 'OPENCLAW_NATIVE_MODEL_FAILED');
        assert.equal(failure.partialResponse, ['cut', 'hang'].includes(mode) ? 'answer' : '', `partial output on ${mode}`); assert.ok(!events.includes('completed'));
      }
      if (spec.reasoning) {
        h.state.mode = 'ok';
        const before = h.requests.length, prepared = await h.backend.prepare(h.ref, {});
        for (const key of azureEnv) {
          for (const value of ['synthetic-override', '   ']) {
            process.env[key] = value;
            const changedTarget = (await h.backend.catalogue()).models.find(value => value.model === h.ref);
            assert.equal(changedTarget.isolation.singleCallQualified, false); assert.notEqual(changedTarget.fingerprint, target.fingerprint);
            await assert.rejects(h.service.execute(h.request()), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' });
            assert.throws(() => prepared.stream({ messages: [] }, {}), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' });
          }
          delete process.env[key];
        }
        assert.equal(h.requests.length, before);
      }
    } finally { await h.restore(); }
  });
}

test('native Bedrock remains closed: this SDK stream registry has no provider', { skip, timeout: 60000 }, async () => {
  const h = await harness(specs[0]);
  try {
    const model = { api: 'bedrock-converse-stream', provider: 'amazon-bedrock', id: 'synthetic', baseUrl: 'https://synthetic.invalid',
      reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    for await (const event of h.sdk.streamSimple(model, { messages: [{ role: 'user', content: 'synthetic' }] }, { apiKey: 'synthetic' })) {
      assert.equal(event.type, 'error'); assert.match(event.error.errorMessage, /No API provider registered for api: bedrock-converse-stream/);
    }
    assert.equal(h.requests.length, 0); assert.deepEqual(h.sockets, []);
  } finally { await h.restore(); }
});
