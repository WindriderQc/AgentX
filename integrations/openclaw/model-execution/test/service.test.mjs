import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionService } from '../service.mjs';
import { billingFor } from '../native.mjs';

const model = { provider: 'fixture', id: 'model', api: 'openai-completions' };
const descriptor = { model: 'fixture/model', maxTokens: 1024, contextWindow: 8192, fingerprint: 'fixed',
  modelVersion: 'unknown', modelVersionSource: 'not-observed', isolation: { singleCallQualified: true }, billing: { kind: 'free' } };
const request = () => ({ schema: 'agentx.openclaw-model-request/v1', requestId: 'turn', model: descriptor.model,
  messages: [{ role: 'user', content: 'Only this prompt.' }], parameters: { maxTokens: 64, temperature: 0 } });
const answer = () => ({ ...model, model: model.id, content: [{ type: 'text', text: 'answer' }], stopReason: 'stop',
  usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } } });

function fixture({ selected = descriptor, stream } = {}) {
  const calls = [];
  const backend = { catalogue: async () => ({ runtimeVersion: 'fixture', models: [selected], agents: [] }),
    prepare: async () => ({ model, descriptor: selected, runtimeVersion: 'fixture', effectiveParameters: {},
      stream: (context, options) => { calls.push(context); return stream ? stream(context, options) : (async function* () {
        await options.onPayload({ messages: context.messages, max_tokens: options.maxTokens, temperature: options.temperature });
        yield { type: 'text_delta', delta: 'answer' }; yield { type: 'done', message: answer() };
      })(); } }) };
  return { calls, service: createExecutionService({ backend, maxRequestCostNanodollars: 30_000_000 }) };
}

test('one native model call receives only submitted context and attests isolation, cache and unknown revision', async () => {
  const { service, calls } = fixture(); const events = [];
  const result = await service.execute(request(), { emit: event => events.push(event) });
  assert.equal(calls.length, 1); assert.equal(calls[0].systemPrompt, undefined); assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].messages.length, 1); assert.equal(calls[0].messages[0].content, 'Only this prompt.');
  assert.equal(result.receipt.isolation.noMemory, true); assert.equal(result.receipt.isolation.noAgentPrompt, true);
  assert.equal(result.receipt.isolation.modelCalls, 1); assert.equal(result.receipt.usage.cacheRead, 3);
  assert.equal(result.receipt.observed.modelVersion, 'unknown'); assert.equal(result.receipt.observed.upstreamProvider, null);
  assert.equal(result.receipt.cost.source, 'runtime-estimate'); assert.equal(events.at(-1).type, 'completed');
});

test('each turn is independent and never retains preceding messages', async () => {
  const { service, calls } = fixture(); await service.execute(request());
  await service.execute({ ...request(), messages: [{ role: 'user', content: 'Second turn.' }] });
  assert.equal(calls[1].messages.length, 1); assert.equal(calls[1].messages[0].content, 'Second turn.');
});

test('drift, unsupported parameters and paid budgets fail before any model call', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.execute({ ...request(), expectedFingerprint: 'changed' }), { code: 'OPENCLAW_TARGET_DRIFT' });
  await assert.rejects(service.execute({ ...request(), parameters: { arbitrary: true } }), { code: 'OPENCLAW_PARAMETER_UNSUPPORTED' });
  assert.equal(calls.length, 0);
  const unqualified = fixture({ selected: { ...descriptor, isolation: { singleCallQualified: false } } });
  await assert.rejects(unqualified.service.execute(request()), { code: 'OPENCLAW_MODEL_TRANSPORT_UNQUALIFIED' });
  assert.equal(unqualified.calls.length, 0);
  const paid = fixture({ selected: { ...descriptor, billing: { kind: 'paid', rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } } });
  await assert.rejects(paid.service.execute({ ...request(), budget: { maxCalls: 1, maxCostNanodollars: 1 } }), { code: 'OPENCLAW_SPEND_LIMIT_REQUIRED' });
  assert.equal(paid.calls.length, 0);
  const result = await paid.service.execute({ ...request(), budget: { maxCalls: 1, maxCostNanodollars: 20_000_000 } });
  assert.equal(result.receipt.reservation.reservedNanodollars, 8_320_000);
});

test('unexpected tools, ignored parameters, second calls and identity drift fail closed', async () => {
  for (const override of ['tools', 'parameter', 'second', 'identity', 'usage', 'zeroUsage']) {
    const { service } = fixture({ stream: (context, options) => (async function* () {
      await options.onPayload({ messages: context.messages, max_tokens: override === 'parameter' ? 63 : 64, temperature: 0,
        ...(override === 'tools' ? { tools: [{ type: 'web_search' }] } : {}) });
      if (override === 'second') await options.onPayload({ messages: context.messages, max_tokens: 64, temperature: 0 });
      const value = answer(); if (override === 'identity') value.model = 'fallback'; if (override === 'usage') delete value.usage;
      if (override === 'zeroUsage') value.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
      yield { type: 'done', message: value };
    })() });
    await assert.rejects(service.execute(request()), error => error.code.startsWith('OPENCLAW_'));
  }
});

test('cancellation stops the single stream and preserves partial output without retry', async () => {
  const controller = new AbortController();
  const { service, calls } = fixture({ stream: (context, options) => (async function* () {
    await options.onPayload({ messages: context.messages, max_tokens: 64, temperature: 0 }); yield { type: 'text_delta', delta: 'part' };
    controller.abort(); options.signal.throwIfAborted();
  })() });
  await assert.rejects(service.execute(request(), { signal: controller.signal }), error => error.partialResponse === 'part' && error.executionState === 'unknown');
  assert.equal(calls.length, 1);
});

test('protocol tool schemas produce declarations without executing tools or claiming tool-free isolation', async () => {
  const { service, calls } = fixture({ stream: (context, options) => (async function* () {
    await options.onPayload({ messages: context.messages, max_tokens: 64, temperature: 0, tools: [{ type: 'function', function: { name: 'room' } }] });
    const value = answer(); value.content = [{ type: 'toolCall', id: 'call', name: 'room', arguments: { name: 'kitchen' } }];
    value.stopReason = 'toolUse'; yield { type: 'done', message: value };
  })() });
  const result = await service.execute({ ...request(), tools: [{ name: 'room', parameters: { type: 'object' } }] });
  assert.equal(calls[0].tools[0].name, 'room'); assert.equal(result.toolCalls[0].name, 'room');
  assert.equal(result.receipt.isolation.noTools, false); assert.equal(result.receipt.isolation.toolsExecuted, 0);
});


test('native zero rate defaults remain unknown until free or included billing is declared', () => {
  const value = { id: 'fixture/model', api: 'openai-completions', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(billingFor(value).kind, 'unknown');
  assert.equal(billingFor({ ...value, id: 'fixture/model:free' }).kind, 'free');
  assert.equal(billingFor(value, { params: { billingKind: 'free' } }).kind, 'free');
  assert.equal(billingFor(value, { params: { billingKind: 'included' } }).kind, 'included');
  assert.equal(billingFor({ ...value, cost: { ...value.cost, output: 1 } }).kind, 'paid');
});
