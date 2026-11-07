import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionService } from '../service.mjs';

// Service validation units, separate from the real-SDK network qualification.
const model = { provider: 'google', id: 'synthetic', api: 'google-generative-ai' };
const descriptor = { model: 'google/synthetic', maxTokens: 1024, contextWindow: 8192, fingerprint: 'fixed',
  isolation: { singleCallQualified: true }, billing: { kind: 'free' } };

test('Google payload validation rejects provider state, retry overrides, hidden parts and undeclared tools', async () => {
  for (const [patch, code] of [
    [{ cachedContent: 'synthetic-cache' }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
    [{ config: { cachedContent: 'synthetic-cache' } }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
    [{ config: { httpOptions: { retryOptions: { attempts: 5 } } } }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
    [{ fallbacks: ['synthetic-fallback'] }, 'OPENCLAW_NATIVE_STATE_FORBIDDEN'],
    [{ contents: [{ role: 'user', parts: [{ text: 'Added context' }] }] }, 'OPENCLAW_CONTEXT_DRIFT'],
    [{ contents: [{ role: 'user', parts: [{ text: 'Exact context', thoughtSignature: 'hidden-state' }] }] }, 'OPENCLAW_CONTEXT_UNVERIFIED'],
    [{ config: { tools: [{ googleSearch: {} }] } }, 'OPENCLAW_NATIVE_TOOLS_FORBIDDEN']
  ]) {
    let dispatched = 0;
    const backend = { catalogue: async () => ({ models: [descriptor] }), prepare: async () => ({ model, descriptor,
      stream: (context, options) => (async function* () {
        options.onPayload({ contents: [{ role: 'user', parts: [{ text: 'Exact context' }] }],
          config: { maxOutputTokens: 64 }, ...patch });
        dispatched++;
        yield { type: 'error' };
      })()
    }) };
    await assert.rejects(createExecutionService({ backend }).execute({ schema: 'agentx.openclaw-model-request/v1', model: descriptor.model,
      messages: [{ role: 'user', content: 'Exact context' }], parameters: { maxTokens: 64 } }), { code });
    assert.equal(dispatched, 0);
  }
});
