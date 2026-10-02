'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTarget } = require('../contract');
const { execute } = require('../executors/openrouter-isolated-executor');

function targetFixture(overrides = {}) {
  return normalizeTarget({
    id: 'openrouter-qwen38-flash',
    label: 'Qwen 3.8 Flash via OpenRouter',
    mode: 'isolated_model',
    tier: 'paid_cloud',
    provider: 'Alibaba',
    model: 'qwen/qwen3.8-flash',
    modelVersion: 'qwen3.8-flash-20260826',
    harness: { name: 'aiops-benchmark-harness-broker', version: '1.1.0' },
    adapter: { name: 'openrouter-isolated', version: '1.0.0' },
    profile: { id: 'openrouter-isolated-v1', version: '1', fingerprint: '1'.repeat(64) },
    api: { name: 'openrouter-chat-completions', version: 'v1' },
    contextWindow: 1_000_000,
    capabilities: { candidate: true, judge: true },
    pricing: {
      kind: 'manual_per_token', currency: 'USD', source: 'OpenRouter endpoint snapshot',
      effectiveAt: '2026-09-02T00:00:00.000Z', inputNanodollarsPerMillion: 150_000_000,
      outputNanodollarsPerMillion: 470_000_000, cacheReadNanodollarsPerMillion: 16_000_000,
      cacheWriteNanodollarsPerMillion: 200_000_000, callNanodollars: 0,
    },
    available: false,
    observedAt: null,
    catalogFingerprint: '2'.repeat(64),
    ...overrides,
  });
}

function inputFixture(target = targetFixture(), overrides = {}) {
  return {
    target,
    envelope: { fingerprint: '3'.repeat(64), prompt: { fingerprint: '4'.repeat(64) } },
    input: { prompt: 'Bounded prompt' },
    parameters: {
      timeoutMs: 30_000,
      temperature: 0,
      topP: 1,
      seed: 7,
      maxTokens: 256,
      responseFormat: 'text',
      thinking: true,
      ...overrides,
    },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function modelCatalog() {
  return { data: [{
    id: 'qwen/qwen3.8-flash', canonical_slug: 'qwen/qwen3.8-flash-20260826', context_length: 1_000_000,
    reasoning: { mandatory: false, default_enabled: true, supports_max_tokens: true },
  }] };
}

function endpointCatalog(pricing = {}) {
  return { data: {
    id: 'qwen/qwen3.8-flash',
    endpoints: [{
      provider_name: 'Alibaba', status: 0, context_length: 1_000_000, max_completion_tokens: 131_072,
      supported_parameters: ['max_tokens', 'reasoning', 'temperature', 'top_p', 'seed', 'response_format'],
      pricing: {
        prompt: '0.00000015', completion: '0.00000047',
        input_cache_read: '0.000000016', input_cache_write: '0.0000002', ...pricing,
      },
    }],
  } };
}

function withObservedFingerprints(operation) {
  const priorProfile = process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT;
  const priorRuntime = process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT;
  process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT = '1'.repeat(64);
  process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT = '5'.repeat(64);
  return operation().finally(() => {
    if (priorProfile === undefined) delete process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT;
    else process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT = priorProfile;
    if (priorRuntime === undefined) delete process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT;
    else process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT = priorRuntime;
  });
}

test('executes one exact provider request with thinking, no tools, and no fallback', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return response(modelCatalog());
    if (url.endsWith('/endpoints')) return response(endpointCatalog());
    if (url.endsWith('/chat/completions')) return response({
      id: 'gen-1', model: 'qwen/qwen3.8-flash-20260826',
      choices: [{ message: { content: 'bounded answer', reasoning: 'bounded reasoning' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
    });
    if (url.includes('/generation?id=gen-1')) return response({ data: {
      provider_name: 'Alibaba', model: 'qwen/qwen3.8-flash-20260826', total_cost: 0.000001234,
    } });
    return response({}, 404);
  };
  const result = await withObservedFingerprints(() => execute(inputFixture(targetFixture(), { reasoningMaxTokens: 128 }), {
    apiKey: 'test-key', baseUrl: 'https://openrouter.test/api/v1', fetch, metadataAttempts: 1,
  }));
  assert.equal(result.output, 'bounded answer');
  assert.equal(result.thinking, 'bounded reasoning');
  assert.equal(result.actual.provider, 'Alibaba');
  assert.equal(result.actual.modelVersion, 'qwen3.8-flash-20260826');
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(result.usage, {
    durationMs: result.usage.durationMs,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    costNanodollars: 1_234,
    costSource: 'provider-reported',
    turns: 1,
    toolCalls: 0,
  });
  const request = JSON.parse(calls.find(call => call.url.endsWith('/chat/completions')).options.body);
  assert.deepEqual(request.provider, { only: ['Alibaba'], allow_fallbacks: false, require_parameters: true });
  assert.deepEqual(request.reasoning, { max_tokens: 128, exclude: false });
  assert.deepEqual(request.usage, { include: true });
  assert.equal(request.tools, undefined);
  assert.equal(calls.filter(call => call.url.endsWith('/chat/completions')).length, 1);
});

test('rejects a reasoning budget that leaves no visible-final allowance', async () => {
  let paidCalls = 0;
  const fetch = async (url) => {
    if (url.endsWith('/models')) return response(modelCatalog());
    if (url.endsWith('/endpoints')) return response(endpointCatalog());
    paidCalls += Number(url.endsWith('/chat/completions'));
    return response({});
  };
  await assert.rejects(
    execute(inputFixture(targetFixture(), { reasoningMaxTokens: 256 }), {
      apiKey: 'test-key', baseUrl: 'https://openrouter.test/api/v1', fetch,
    }),
    /below maxTokens/
  );
  assert.equal(paidCalls, 0);
});

test('waits through delayed generation metadata without repeating the paid completion', async () => {
  let paidCalls = 0;
  let metadataCalls = 0;
  const fetch = async (url) => {
    if (url.endsWith('/models')) return response(modelCatalog());
    if (url.endsWith('/endpoints')) return response(endpointCatalog());
    if (url.endsWith('/chat/completions')) {
      paidCalls += 1;
      return response({
        id: 'gen-delayed', model: 'qwen/qwen3.8-flash-20260826',
        choices: [{ message: { content: 'bounded answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }
    metadataCalls += 1;
    if (metadataCalls < 8) return response({}, 404);
    return response({ data: {
      provider_name: 'Alibaba', model: 'qwen/qwen3.8-flash-20260826', total_cost: 0.000001,
    } });
  };
  const result = await withObservedFingerprints(() => execute(inputFixture(), {
    apiKey: 'test-key', baseUrl: 'https://openrouter.test/api/v1', fetch, wait: async () => {},
  }));
  assert.equal(result.output, 'bounded answer');
  assert.equal(paidCalls, 1);
  assert.equal(metadataCalls, 8);
});

test('fails before paid execution when the canonical version or provider pricing drifts', async () => {
  let paidCalls = 0;
  const versionFetch = async (url) => {
    if (url.endsWith('/models')) return response({ data: [{
      id: 'qwen/qwen3.8-flash', canonical_slug: 'qwen/qwen3.8-flash-NEW', context_length: 1_000_000,
    }] });
    paidCalls += Number(url.endsWith('/chat/completions'));
    return response(endpointCatalog());
  };
  await assert.rejects(
    execute(inputFixture(), { apiKey: 'test-key', baseUrl: 'https://openrouter.test/api/v1', fetch: versionFetch }),
    /canonical model version/
  );
  assert.equal(paidCalls, 0);

  const pricingFetch = async (url) => {
    if (url.endsWith('/models')) return response(modelCatalog());
    if (url.endsWith('/endpoints')) return response(endpointCatalog({ completion: '0.00000048' }));
    paidCalls += Number(url.endsWith('/chat/completions'));
    return response({});
  };
  await assert.rejects(
    execute(inputFixture(), { apiKey: 'test-key', baseUrl: 'https://openrouter.test/api/v1', fetch: pricingFetch }),
    /pricing drifted/
  );
  assert.equal(paidCalls, 0);
});

test('fails closed when generation metadata reports a different provider', async () => {
  const fetch = async (url) => {
    if (url.endsWith('/models')) return response(modelCatalog());
    if (url.endsWith('/endpoints')) return response(endpointCatalog());
    if (url.endsWith('/chat/completions')) return response({
      id: 'gen-drift', model: 'qwen/qwen3.8-flash',
      choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    return response({ data: {
      provider_name: 'Fallback Provider', model: 'qwen/qwen3.8-flash', total_cost: 0.000001,
    } });
  };
  await assert.rejects(
    execute(inputFixture(), {
      apiKey: 'test-key', baseUrl: 'https://openrouter.test/api/v1', fetch, metadataAttempts: 1,
    }),
    /exact provider or model target/
  );
});
