'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExecutionSource } = require('../../../shared/executionSource');
const { createOpenClawExecutionClient } = require('../../../shared/openclawExecutionClient');
const { withExecutionSource, parametersFor } = require('../../../core/src/services/execution/openclawInference');
const env = { OPENCLAW_GATEWAY_URL: 'http://gateway.test:18789', OPENCLAW_GATEWAY_TOKEN: 'gateway-only' };
const selected = { model: 'openclaw:model:fixture/model' };
const result = id => ({ schema: 'agentx.openclaw-model-result/v1', requestId: id, model: 'fixture/model', text: 'answer', finishReason: 'stop',
  receipt: { source: 'openclaw', mode: 'model', requestId: id, targetFingerprint: 'a'.repeat(64), observed: { provider: 'fixture', model: 'model' },
    isolation: { noMemory: true, noAgentPrompt: true, noTools: true, noRuntimeFallback: true, modelCalls: 1, toolsExecuted: 0 }, durationMs: 3, usage: { input: 5, output: 2, cacheRead: 3, cacheWrite: 0, total: 10 }, cost: null } });

test('source selection keeps plain local requests and rejects mixed sources and fallback', () => {
  assert.equal(parseExecutionSource({ model: 'qwen:8b', target: 'host-a' }), null);
  assert.deepEqual(parseExecutionSource(selected), { source: 'openclaw', mode: 'model', model: 'fixture/model' });
  for (const request of [{ ...selected, autoRoute: true }, { ...selected, host: 'host-a' }, { ...selected, target: 'host-a' },
    { ...selected, execution: { source: 'local' } }, { execution: { source: 'openclaw', mode: 'model', model: 'https://provider.test' } }]) {
    assert.throws(() => parseExecutionSource(request), { code: 'EXECUTION_SOURCE_INVALID' });
  }
});

test('local execution is delegated verbatim, without accessing OpenClaw', async () => {
  const request = { model: 'qwen:8b', mode: 'embed', options: { num_ctx: 8192 } }; let count = 0;
  const execute = withExecutionSource((received, options) => { assert.equal(received, request); assert.equal(options.hostUrl, 'local'); return 'local'; },
    { execute: () => { count++; } });
  assert.equal(await execute(request, { hostUrl: 'local' }), 'local'); assert.equal(count, 0);
  await assert.rejects(execute({ ...selected, mode: 'embed' }), { code: 'OPENCLAW_EMBEDDING_UNSUPPORTED' });
  await assert.rejects(execute(selected, { consumerContract: 'openclaw-runtime-v1' }), { code: 'EXECUTION_SOURCE_RECURSION' });
});

test('cloud requests contact only the gateway and stream the exact completion without retry', async () => {
  const requests = [];
  const client = createOpenClawExecutionClient({ env, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).hostname, 'gateway.test'); assert.equal(options.headers.authorization, 'Bearer gateway-only');
    const body = JSON.parse(options.body); requests.push(body);
    return new Response(`data: ${JSON.stringify({ type: 'text_delta', delta: 'answer' })}\r\n\r\n` +
      `data: ${JSON.stringify({ type: 'completed', result: result(body.requestId) })}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const tokens = []; const value = await client.execute({ ...selected, prompt: 'prompt' }, { onToken: token => tokens.push(token) });
  assert.deepEqual(tokens, ['answer']); assert.equal(value.partial, false); assert.equal(requests.length, 1);
  const execution = await withExecutionSource(() => assert.fail('local fallback'), client)({ ...selected, prompt: 'prompt' });
  assert.equal(execution.body.stats.usage.promptTokens, 8); assert.equal(execution.body.executionReceipt.cost, null);
});

test('truncated streaming preserves partial text, unknown usage and never retries locally', async () => {
  let calls = 0;
  const client = createOpenClawExecutionClient({ env, fetchImpl: async () => { calls++;
    return new Response('data: {"type":"text_delta","delta":"part"}\n\n', { headers: { 'content-type': 'text/event-stream' } }); } });
  await assert.rejects(client.execute(selected, { onToken: () => {} }), error => error.partialResponse === 'part' && error.code === 'OPENCLAW_RESULT_UNVERIFIED');
  assert.equal(calls, 1);
});

test('agent requests use separate sessions, expose unknown model/cost and refuse unsupported overrides', async () => {
  const sessions = [];
  const client = createOpenClawExecutionClient({ env, fetchImpl: async (_url, options) => {
    sessions.push(options.headers['x-openclaw-session-key']);
    return new Response('data: {"type":"response.completed","response":{"id":"agent-run","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"final"}]}]}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const agent = { model: 'openclaw:agent:main', sessionId: 'core-conversation' };
  const first = await client.execute(agent), second = await client.execute(agent);
  assert.notEqual(sessions[0], sessions[1]); assert.equal(first.receipt.observed, null); assert.equal(second.receipt.cost, null);
  await assert.rejects(client.execute({ ...agent, parameters: { seed: 42 } }), { code: 'OPENCLAW_AGENT_PARAMETERS_UNSUPPORTED' });
  assert.equal(sessions.length, 2);
});


test('omitted seed stays absent for native agents and explicit model parameters are preserved', () => {
  assert.deepEqual(parametersFor({ options: {} }), {});
  assert.deepEqual(parametersFor({ options: { seed: '', num_predict: 64 } }), { maxTokens: 64 });
  assert.deepEqual(parametersFor({ options: { seed: '42' } }), { seed: 42 });
});

test('expired or malformed catalogues cannot become executable source evidence', async () => {
  for (const expiresAt of ['invalid', '2000-01-01T00:00:00Z']) {
    const client = createOpenClawExecutionClient({ env, fetchImpl: async () => new Response(JSON.stringify({
      schema: 'agentx.openclaw-execution-catalog/v1', models: [], agents: [], expiresAt })) });
    await assert.rejects(client.catalog(), { code: 'OPENCLAW_CATALOG_STALE' });
  }
});


test('a failed nonstream native response retains partial output and never exposes the provider error', async () => {
  const client = createOpenClawExecutionClient({ env, fetchImpl: async () => new Response(JSON.stringify({
    schema: 'agentx.openclaw-model-error/v1', code: 'OPENCLAW_NATIVE_MODEL_FAILED', partialResponse: 'part',
    partialThinking: 'thought', executionState: 'unknown', message: 'private provider detail'
  }), { status: 502 }) });
  await assert.rejects(client.execute(selected), error => error.partialResponse === 'part'
    && error.partialThinking === 'thought' && error.executionState === 'unknown' && !error.message.includes('private'));
});

test('the HTTP inference contract aggregates native streams and projects errors while raw extensions retain streaming', async () => {
  const client = { execute: async (_input, options) => {
    await options.onToken?.('answer');
    return { text: 'answer', finishReason: 'stop', partial: false, receipt: result('turn').receipt };
  } };
  const infer = withExecutionSource(() => assert.fail('local fallback'), client, { aggregateStreams: true });
  const response = await infer({ ...selected, stream: true });
  assert.equal(response.body.response, 'answer'); assert.equal(response.status, 200); assert.equal(response.stream, undefined);
  const raw = await withExecutionSource(() => assert.fail('local fallback'), client)({ ...selected, stream: true });
  for await (const chunk of raw.stream) assert.ok(chunk.length);
  assert.equal((await raw.completion).terminalComplete, true);
  const rejected = await infer({ ...selected, autoRoute: true });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'EXECUTION_SOURCE_INVALID');
  const failed = await withExecutionSource(() => assert.fail('local fallback'), { execute: async () => {
    throw Object.assign(new Error('Native failed'), { code: 'OPENCLAW_NATIVE_MODEL_FAILED', partialResponse: 'part' });
  } }, { aggregateStreams: true })({ ...selected, stream: true });
  assert.equal(failed.status, 502); assert.equal(failed.body.partialResponse, 'part');
});
