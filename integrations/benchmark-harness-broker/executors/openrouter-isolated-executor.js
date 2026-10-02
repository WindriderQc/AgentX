'use strict';

const crypto = require('node:crypto');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const REQUIRED_PARAMETERS = Object.freeze(['max_tokens', 'reasoning']);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

async function readInput(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function scaledInteger(value, scale, name, mode = 'round') {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} is missing or invalid`);
  const scaled = number * scale;
  const integer = mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled);
  if (!Number.isSafeInteger(integer)) throw new Error(`${name} exceeds the safe integer range`);
  return integer;
}

function endpointPricing(endpoint) {
  return {
    inputNanodollarsPerMillion: scaledInteger(endpoint?.pricing?.prompt, 1_000_000_000_000_000, 'endpoint prompt price'),
    outputNanodollarsPerMillion: scaledInteger(endpoint?.pricing?.completion, 1_000_000_000_000_000, 'endpoint completion price'),
    cacheReadNanodollarsPerMillion: scaledInteger(endpoint?.pricing?.input_cache_read ?? 0, 1_000_000_000_000_000, 'endpoint cache-read price'),
    cacheWriteNanodollarsPerMillion: scaledInteger(endpoint?.pricing?.input_cache_write ?? 0, 1_000_000_000_000_000, 'endpoint cache-write price'),
  };
}

function assertExactPricing(target, endpoint) {
  const observed = endpointPricing(endpoint);
  for (const [name, value] of Object.entries(observed)) {
    if (Number(target.pricing?.[name] || 0) !== value) {
      throw new Error(`OpenRouter endpoint pricing drifted for ${name}`);
    }
  }
  return observed;
}

function exactModel(modelsBody, target) {
  const matches = (Array.isArray(modelsBody?.data) ? modelsBody.data : [])
    .filter(model => model?.id === target.model);
  if (matches.length !== 1) throw new Error('OpenRouter catalog does not contain exactly one requested model');
  const model = matches[0];
  const namespace = target.model.includes('/') ? target.model.slice(0, target.model.lastIndexOf('/')) : '';
  const canonicalVersion = namespace ? `${namespace}/${target.modelVersion}` : target.modelVersion;
  if (model.canonical_slug !== canonicalVersion) {
    throw new Error('OpenRouter canonical model version differs from the pinned target');
  }
  if (Number(model.context_length) !== Number(target.contextWindow)) {
    throw new Error('OpenRouter model context window differs from the pinned target');
  }
  return model;
}

function reasoningConfig(parameters, modelRecord) {
  if (!parameters.thinking) return { enabled: false, exclude: false };
  if (parameters.reasoningMaxTokens == null) return { enabled: true, exclude: false };
  const budget = Number(parameters.reasoningMaxTokens);
  const completionLimit = Number(parameters.maxTokens);
  if (!Number.isSafeInteger(budget) || budget < 1 || budget >= completionLimit) {
    throw new Error('reasoning token budget must be a positive integer below maxTokens');
  }
  if (modelRecord?.reasoning?.supports_max_tokens !== true) {
    throw new Error('OpenRouter model does not attest reasoning max-token support');
  }
  return { max_tokens: budget, exclude: false };
}

function exactEndpoint(endpointsBody, target, parameters) {
  if (endpointsBody?.data?.id !== target.model) throw new Error('OpenRouter endpoint catalog model differs from the target');
  const matches = (Array.isArray(endpointsBody?.data?.endpoints) ? endpointsBody.data.endpoints : [])
    .filter(endpoint => endpoint?.provider_name === target.provider && Number(endpoint?.status) === 0);
  if (matches.length !== 1) throw new Error('OpenRouter does not expose exactly one healthy requested provider endpoint');
  const endpoint = matches[0];
  if (Number(endpoint.context_length) !== Number(target.contextWindow)) {
    throw new Error('OpenRouter provider context window differs from the pinned target');
  }
  if (Number(parameters.maxTokens) > Number(endpoint.max_completion_tokens)) {
    throw new Error('requested completion budget exceeds the exact provider endpoint limit');
  }
  const required = [...REQUIRED_PARAMETERS];
  if (parameters.temperature != null) required.push('temperature');
  if (parameters.topP != null) required.push('top_p');
  if (parameters.seed != null) required.push('seed');
  if (parameters.responseFormat === 'json') required.push('response_format');
  const supported = new Set(Array.isArray(endpoint.supported_parameters) ? endpoint.supported_parameters : []);
  if (required.some(parameter => !supported.has(parameter))) {
    throw new Error('OpenRouter provider endpoint lacks a required request parameter');
  }
  assertExactPricing(target, endpoint);
  return endpoint;
}

async function fetchJson(url, init, fetchImplementation, label) {
  const response = await fetchImplementation(url, init);
  if (!response?.ok) throw new Error(`${label} HTTP ${response?.status || 'unavailable'}`);
  return response.json();
}

function responseModelMatches(value, target) {
  const namespace = target.model.includes('/') ? target.model.slice(0, target.model.lastIndexOf('/')) : '';
  const canonicalVersion = namespace ? `${namespace}/${target.modelVersion}` : target.modelVersion;
  return value === target.model || value === canonicalVersion;
}

async function generationMetadata({ baseUrl, requestId, headers, signal, fetchImplementation, attempts, wait }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetchImplementation(
      `${baseUrl}/generation?id=${encodeURIComponent(requestId)}`,
      { method: 'GET', headers, signal }
    );
    if (response?.ok) return response.json();
    if (![202, 404].includes(Number(response?.status)) || attempt === attempts - 1) {
      throw new Error(`OpenRouter generation metadata HTTP ${response?.status || 'unavailable'}`);
    }
    await wait(250 * (attempt + 1));
  }
  throw new Error('OpenRouter generation metadata unavailable');
}

async function execute(input, options = {}) {
  const target = input?.target;
  if (target?.executionKind !== 'harness'
      || target.mode !== 'isolated_model'
      || target.tier !== 'paid_cloud'
      || target.pricing?.kind !== 'manual_per_token') {
    throw new Error('OpenRouter isolated executor accepts only priced cloud isolated harness targets');
  }
  if (typeof input.parameters?.thinking !== 'boolean') {
    throw new Error('OpenRouter isolated executor requires an explicit thinking boolean');
  }
  const token = String(options.apiKey || process.env.OPENROUTER_API_KEY || '').trim();
  if (!token) throw new Error('OPENROUTER_API_KEY is required');
  const baseUrl = String(options.baseUrl || OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const fetchImplementation = options.fetch || globalThis.fetch;
  if (typeof fetchImplementation !== 'function') throw new Error('fetch implementation is unavailable');
  const timeoutMs = Math.min(900_000, Math.max(30_000, Number(input.parameters.timeoutMs) || 600_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const started = Date.now();
  try {
    const modelRecord = exactModel(
      await fetchJson(`${baseUrl}/models`, { method: 'GET', headers, signal: controller.signal }, fetchImplementation, 'OpenRouter model catalog'),
      target
    );
    const requestReasoning = reasoningConfig(input.parameters, modelRecord);
    exactEndpoint(
      await fetchJson(`${baseUrl}/models/${target.model}/endpoints`, { method: 'GET', headers, signal: controller.signal }, fetchImplementation, 'OpenRouter endpoint catalog'),
      target,
      input.parameters
    );
    const requestBody = {
      model: target.model,
      messages: [{ role: 'user', content: String(input.input?.prompt || '') }],
      stream: false,
      max_tokens: Number(input.parameters.maxTokens),
      temperature: input.parameters.temperature ?? undefined,
      top_p: input.parameters.topP ?? undefined,
      seed: input.parameters.seed ?? undefined,
      reasoning: requestReasoning,
      response_format: input.parameters.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      provider: {
        only: [target.provider],
        allow_fallbacks: false,
        require_parameters: true,
      },
      usage: { include: true },
    };
    const body = await fetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST', headers, signal: controller.signal, body: JSON.stringify(requestBody),
    }, fetchImplementation, 'OpenRouter chat completion');
    if (!body?.id || !responseModelMatches(body.model, target)) {
      throw new Error('OpenRouter response lacks the exact request or model identity');
    }
    const metadataBody = await generationMetadata({
      baseUrl,
      requestId: body.id,
      headers,
      signal: controller.signal,
      fetchImplementation,
      // OpenRouter can publish generation accounting several seconds after a
      // successful completion. Keep the identity/cost check fail-closed, but
      // give that eventually-consistent endpoint a bounded ~48 second window.
      attempts: Math.max(1, Number(options.metadataAttempts) || 20),
      wait: options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    });
    const generation = metadataBody?.data;
    if (generation?.provider_name !== target.provider || !responseModelMatches(generation?.model, target)) {
      throw new Error('OpenRouter generation metadata differs from the exact provider or model target');
    }
    const choice = body?.choices?.[0];
    if (!choice || typeof choice.message?.content !== 'string') {
      throw new Error('OpenRouter response does not contain one textual result');
    }
    const output = choice.message.content;
    const reasoning = choice.message.reasoning ?? choice.message.reasoning_content
      ?? (choice.message.reasoning_details == null ? null : JSON.stringify(choice.message.reasoning_details));
    const usage = body.usage || {};
    const inputTokens = Number(usage.prompt_tokens ?? generation.native_tokens_prompt ?? 0);
    const outputTokens = Number(usage.completion_tokens ?? generation.native_tokens_completion ?? 0);
    const cacheReadTokens = Number(usage.prompt_tokens_details?.cached_tokens || 0);
    const cacheWriteTokens = Number(usage.prompt_tokens_details?.cache_write_tokens || 0);
    return {
      requestFingerprint: fingerprint({
        targetFingerprint: target.fingerprint,
        envelopeFingerprint: input.envelope.fingerprint,
        promptFingerprint: input.envelope.prompt.fingerprint,
      }),
      responseFingerprint: fingerprint(output),
      output,
      thinking: reasoning == null ? null : String(reasoning),
      finishReason: choice.finish_reason || null,
      fallbackUsed: false,
      actual: {
        provider: target.provider,
        providerVersion: 'openrouter-generation-v1',
        model: target.model,
        modelVersion: target.modelVersion,
        harnessVersion: target.harness.version,
        adapterVersion: target.adapter.version,
        environmentId: target.profile.id,
        environmentVersion: target.profile.version,
        environmentFingerprint: process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT || null,
        runtimeFingerprint: process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT || null,
        modelDigest: null,
      },
      usage: {
        durationMs: Date.now() - started,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costNanodollars: scaledInteger(generation.total_cost, 1_000_000_000, 'generation total cost', 'ceil'),
        costSource: 'provider-reported',
        turns: 1,
        toolCalls: 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (process.argv.length > 2) throw new Error('OpenRouter isolated executor does not accept runtime arguments');
  process.stdout.write(JSON.stringify(await execute(await readInput())));
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  OPENROUTER_BASE_URL,
  assertExactPricing,
  endpointPricing,
  exactEndpoint,
  exactModel,
  execute,
  fingerprint,
  generationMetadata,
  readInput,
  reasoningConfig,
  scaledInteger,
};
