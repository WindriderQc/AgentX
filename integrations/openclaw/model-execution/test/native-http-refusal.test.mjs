import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadNativeSdk, createNativeBackend } from '../native.mjs';
import { createExecutionService } from '../service.mjs';
let installed = true;
try { import.meta.resolve('openclaw/plugin-sdk/llm'); } catch { installed = false; }

test('installed native SDK negative HTTP acknowledgement is observed without patching its fetch or retry path', { skip: !installed, timeout: 15000 }, async t => {
  let status = 400, calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain the synthetic request */ }
    calls++;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'SENSITIVE diagnostic', code: 'unsupported_parameter', param: 'reasoning' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const sdk = await loadNativeSdk(), apiKey = 'synthetic', amounts = [], receipts = [];
  const cfg = { models: { providers: { xai: { api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey,
    models: [{ id: 'grok-fixture', name: 'Synthetic', api: 'openai-responses', input: ['text'], reasoning: true,
      contextWindow: 8192, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1 } }] } } },
    agents: { defaults: { workspace: '/synthetic', model: { primary: 'xai/grok-fixture' } } } };
  const auth = sdk.AuthStorage.inMemory({ xai: { type: 'api_key', key: apiKey } });
  const backend = createNativeBackend({ config: cfg, pluginConfig: { agentIds: ['main'] } }, { loadSdk: async () => ({ ...sdk,
    AuthStorage: { forAgent: () => auth }, getRuntimeAuthForModel: async () => ({ apiKey }),
    ModelRegistry: class extends sdk.ModelRegistry { constructor(auth, path, options) { super(auth, path, { ...options, includePluginCatalogs: false }); } }
  }) });
  const native = await backend.prepare('xai/grok-fixture', {});
  for await (const _ of await native.stream({ messages: [{ role: 'user', content: 'synthetic' }] },
    { onPayload: () => { throw new Error('TEST_NO_EGRESS'); } })) { /* initialize native host before its real loopback transport */ }
  assert.equal(calls, 0);
  const ai = await import(new URL('../../node_modules/@openclaw/ai/dist/index.mjs', import.meta.resolve('openclaw/plugin-sdk/llm')));
  const host = ai.getAiTransportHost();
  // Only the provider endpoint is a fixture; the native SDK/parser/retry policy
  // and real Node HTTP diagnostics run unchanged against loopback, never a model.
  ai.configureAiTransportHost({ ...host, buildModelFetch: () => globalThis.fetch });
  try {
    const service = createExecutionService({ backend, maxRequestCostNanodollars: 30000000,
      ledger: { read: async () => ({}), record: async value => amounts.push(value) }, recordRefusal: value => receipts.push(value) });
    const request = { schema: 'agentx.openclaw-model-request/v1', requestId: 'original-fixture', model: 'xai/grok-fixture',
      messages: [{ role: 'system', content: 'Synthetic context.' }, { role: 'user', content: 'Synthetic source.' }],
      parameters: { maxTokens: 64 }, budget: { maxCalls: 1, maxCostNanodollars: 30000000 } };
    const refused = await service.execute(request).catch(error => error);
    assert.equal(refused.executionState, 'not-dispatched'); assert.equal(refused.code, 'OPENCLAW_PROVIDER_REQUEST_REFUSED');
    assert.equal(refused.refusalReceipt.httpStatus, 400); assert.equal(refused.refusalReceipt.diagnostic.parameter, 'reasoning');
    assert.equal(refused.refusalReceipt.modelHttpRequests, 1); assert.equal(calls, 1);
    assert.deepEqual(amounts, [0]); assert.equal(receipts.length, 1); assert.ok(!JSON.stringify(refused).includes('SENSITIVE'));
    status = 503;
    const unknown = await service.execute({ ...request, requestId: 'unverified-fixture' }).catch(error => error);
    assert.equal(unknown.executionState, 'unknown'); assert.equal(unknown.refusalReceipt, undefined); assert.equal(calls, 2);
    assert.deepEqual(amounts, [0, null]);
  } finally { ai.configureAiTransportHost(host); await new Promise(resolve => server.close(resolve)); }
});
