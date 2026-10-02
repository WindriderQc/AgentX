'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeTarget } = require('../contract');
const { execute, parseRuntimeArgs } = require('../executors/ollama-isolated-executor');

const digest = '6'.repeat(64);

function targetFixture(overrides = {}) {
  return normalizeTarget({
    id: 'host-a-qwen35-9b',
    label: 'Qwen 3.5 9B on host-a',
    mode: 'isolated_model',
    tier: 'local',
    provider: 'ollama',
    model: 'qwen3.5:9b',
    modelVersion: `manifest-${digest}`,
    harness: { name: 'aiops-benchmark-harness-broker', version: '1.1.0' },
    adapter: { name: 'ollama-isolated', version: '1.0.0' },
    profile: { id: 'host-a-8192', version: '1', fingerprint: '1'.repeat(64) },
    api: { name: 'ollama-chat', version: 'v1' },
    contextWindow: 8192,
    capabilities: { candidate: true, judge: true },
    pricing: null,
    available: false,
    observedAt: null,
    catalogFingerprint: '2'.repeat(64),
    ...overrides,
  });
}

function inputFixture(target = targetFixture()) {
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
    },
  };
}

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('normalizes a local isolated Ollama target with no pricing', () => {
  const target = targetFixture();
  assert.equal(target.tier, 'local');
  assert.equal(target.pricing, null);
  assert.throws(() => targetFixture({ pricing: {
    kind: 'free', currency: 'USD', source: 'incorrect-cloud-shape',
  } }), /must not declare cloud pricing/);
  assert.throws(() => targetFixture({ provider: 'openrouter' }), /must use Ollama/);
});

test('requires fixed allowlisted environment names for each target host', () => {
  assert.deepEqual(parseRuntimeArgs([
    '--base-url-env', 'OLLAMA_HOST_A_BENCHMARK_BASE_URL',
    '--version-env', 'OLLAMA_HOST_A_BENCHMARK_VERSION',
  ]), {
    baseUrlEnvironment: 'OLLAMA_HOST_A_BENCHMARK_BASE_URL',
    versionEnvironment: 'OLLAMA_HOST_A_BENCHMARK_VERSION',
  });
  assert.throws(
    () => parseRuntimeArgs(['--base-url-env', 'unsafe-name', '--version-env', 'VERSION']),
    /allowlisted environment variable/
  );
});

test('executes exact no-thinking Ollama request and binds stable model digest', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/tags')) {
      return response({ models: [{ name: 'qwen3.5:9b', digest }] });
    }
    return response({
      model: 'qwen3.5:9b',
      message: { content: 'bounded answer' },
      done_reason: 'stop',
      prompt_eval_count: 4,
      eval_count: 3,
    });
  };
  const priorProfile = process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT;
  const priorRuntime = process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT;
  process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT = '1'.repeat(64);
  process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT = '5'.repeat(64);
  try {
    const result = await execute(inputFixture(), {
      baseUrl: 'http://127.0.0.1:11434', fetch, verifyClaim: async () => {}
    });
    assert.equal(result.output, 'bounded answer');
    assert.equal(result.actual.modelDigest, `sha256:${digest}`);
    assert.equal(result.actual.model, 'qwen3.5:9b');
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.usage.costNanodollars, 0);
    assert.equal(calls.filter(call => call.url.endsWith('/api/tags')).length, 2);
    const request = JSON.parse(calls.find(call => call.url.endsWith('/api/chat')).options.body);
    assert.equal(request.think, false);
    assert.equal(request.options.num_ctx, 8192);
    assert.equal(request.model, 'qwen3.5:9b');
  } finally {
    if (priorProfile === undefined) delete process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT;
    else process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT = priorProfile;
    if (priorRuntime === undefined) delete process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT;
    else process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT = priorRuntime;
  }
});

test('fails closed on digest drift or response model drift', async () => {
  let tags = 0;
  const driftFetch = async (url) => {
    if (url.endsWith('/api/tags')) {
      tags += 1;
      return response({ models: [{ name: 'qwen3.5:9b', digest: tags === 1 ? digest : '7'.repeat(64) }] });
    }
    return response({ model: 'qwen3.5:9b', message: { content: 'answer' } });
  };
  await assert.rejects(
    execute(inputFixture(), { baseUrl: 'http://127.0.0.1:11434', fetch: driftFetch, verifyClaim: async () => {} }),
    /digest|modelVersion/
  );

  const modelFetch = async (url) => url.endsWith('/api/tags')
    ? response({ models: [{ name: 'qwen3.5:9b', digest }] })
    : response({ model: 'gemma4:12b-it-qat', message: { content: 'answer' } });
  await assert.rejects(
    execute(inputFixture(), { baseUrl: 'http://127.0.0.1:11434', fetch: modelFetch, verifyClaim: async () => {} }),
    /response model differs/
  );
});

test('refuses inference when the live generation-fenced claim is unavailable', async () => {
  let chatCalls = 0;
  const fetch = async (url) => {
    if (url.endsWith('/api/chat')) chatCalls += 1;
    return response({ models: [{ name: 'qwen3.5:9b', digest }] });
  };
  await assert.rejects(execute(inputFixture(), {
    baseUrl: 'http://127.0.0.1:11434',
    fetch,
    verifyClaim: async () => { throw new Error('claim generation lost'); }
  }), /claim generation lost/);
  assert.equal(chatCalls, 0);
});
