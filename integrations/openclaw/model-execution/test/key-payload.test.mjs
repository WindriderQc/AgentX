import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionService } from '../service.mjs';
import { qualifiedModelApi } from '../native.mjs';

test('unknown native version/API identifiers never inherit an object property as qualification', () => {
  for (const api of ['__proto__', 'constructor', 'toString']) assert.equal(qualifiedModelApi('2026.9.4', api), null);
  for (const version of ['__proto__', 'constructor', 'toString']) assert.equal(qualifiedModelApi(version, 'openai-completions'), null);
});

for (const api of ['azure-openai-responses', 'mistral-conversations']) {
  test(`${api} refuses provider state, undeclared tools and a wrong output-bound shape`, async () => {
    const model = { api, provider: 'fixture', id: 'model', baseUrl: 'https://synthetic.invalid' };
    const descriptor = { model: 'fixture/model', maxTokens: 1024, fingerprint: 'fixed', isolation: { singleCallQualified: true }, billing: { kind: 'free' } };
    const normal = api === 'mistral-conversations' ? { messages: [{ role: 'user', content: 'Exact context' }], maxTokens: 64 }
      : { input: [{ role: 'user', content: 'Exact context' }], max_output_tokens: 64 };
    const wrongBound = api === 'mistral-conversations' ? { ...normal, maxTokens: undefined, max_tokens: 64 }
      : { ...normal, max_output_tokens: undefined, maxTokens: 64 };
    for (const [payload, code] of [
      [{ ...normal, previous_response_id: 'synthetic' }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
      [{ ...normal, conversation: 'synthetic' }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
      [{ ...normal, fallbacks: ['synthetic'] }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
      [{ ...normal, store: true }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
      [{ ...normal, tools: [{ type: 'web_search' }] }, 'OPENCLAW_NATIVE_TOOLS_FORBIDDEN'],
      [wrongBound, 'OPENCLAW_PARAMETER_UNAPPLIED']
    ]) {
      let dispatched = 0;
      const backend = { catalogue: async () => ({ models: [descriptor] }), prepare: async () => ({ model, descriptor,
        stream: (_context, options) => (async function* () { options.onPayload(payload, model); dispatched++; yield { type: 'error' }; })()
      }) };
      await assert.rejects(createExecutionService({ backend }).execute({ schema: 'agentx.openclaw-model-request/v1', model: descriptor.model,
        messages: [{ role: 'user', content: 'Exact context' }], parameters: { maxTokens: 64 } }), { code });
      assert.equal(dispatched, 0);
    }
  });
}

test('Azure refuses native route identity changes before dispatch', async () => {
  const model = { api: 'azure-openai-responses', provider: 'fixture', id: 'model', baseUrl: 'https://synthetic.invalid' };
  const descriptor = { model: 'fixture/model', maxTokens: 1024, fingerprint: 'fixed', isolation: { singleCallQualified: true }, billing: { kind: 'free' } };
  for (const key of ['api', 'provider', 'id', 'baseUrl']) {
    let dispatched = 0;
    const backend = { catalogue: async () => ({ models: [descriptor] }), prepare: async () => ({ model, descriptor,
      stream: (_context, options) => (async function* () { options.onPayload({ input: [{ role: 'user', content: 'Exact context' }], max_output_tokens: 64 },
        { ...model, [key]: 'changed' }); dispatched++; yield { type: 'error' }; })()
    }) };
    await assert.rejects(createExecutionService({ backend }).execute({ schema: 'agentx.openclaw-model-request/v1', model: descriptor.model,
      messages: [{ role: 'user', content: 'Exact context' }], parameters: { maxTokens: 64 } }), { code: 'OPENCLAW_NATIVE_ROUTE_DRIFT' });
    assert.equal(dispatched, 0);
  }
});
