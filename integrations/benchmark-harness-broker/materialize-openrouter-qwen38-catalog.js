'use strict';

const crypto = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { fingerprint, normalizeTarget } = require('./contract');
const { endpointPricing, exactEndpoint, exactModel, OPENROUTER_BASE_URL } = require('./executors/openrouter-isolated-executor');

const TARGET_MODEL = 'qwen/qwen3.8-flash';
const TARGET_PROVIDER = 'Alibaba';
const EXECUTOR_PATH = path.resolve(__dirname, 'executors/openrouter-isolated-executor.js');
const PROFILE_PATH = path.resolve(__dirname, 'profiles/openrouter-isolated-v1.json');

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`catalog observation failed with HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (process.argv.length > 2) throw new Error('catalog materializer does not accept arguments');
  const observedAt = new Date();
  const modelBody = await fetchJson(`${OPENROUTER_BASE_URL}/models`);
  const modelRecord = (modelBody.data || []).find(model => model?.id === TARGET_MODEL);
  if (!modelRecord?.canonical_slug || !String(modelRecord.canonical_slug).startsWith('qwen/')) {
    throw new Error('Qwen 3.8 Flash canonical slug is unavailable');
  }
  const modelVersion = String(modelRecord.canonical_slug).slice('qwen/'.length);
  const targetShape = {
    model: TARGET_MODEL,
    modelVersion,
    contextWindow: Number(modelRecord.context_length),
    provider: TARGET_PROVIDER,
    pricing: {},
  };
  exactModel(modelBody, targetShape);
  const endpointsBody = await fetchJson(`${OPENROUTER_BASE_URL}/models/${TARGET_MODEL}/endpoints`);
  const endpoint = (endpointsBody?.data?.endpoints || [])
    .find(candidate => candidate?.provider_name === TARGET_PROVIDER && Number(candidate.status) === 0);
  if (!endpoint) throw new Error('healthy Alibaba endpoint for Qwen 3.8 Flash is unavailable');
  const pricing = endpointPricing(endpoint);
  targetShape.pricing = pricing;
  exactEndpoint(endpointsBody, targetShape, {
    maxTokens: Math.min(131_072, Number(endpoint.max_completion_tokens)),
    thinking: true,
    responseFormat: 'text',
  });

  const runtimePins = [
    { name: 'node', path: process.execPath, sha256: await sha256(process.execPath) },
    { name: 'openrouter-isolated-executor', path: EXECUTOR_PATH, sha256: await sha256(EXECUTOR_PATH) },
  ];
  const profilePins = [
    { name: 'openrouter-isolated-v1-profile', path: PROFILE_PATH, sha256: await sha256(PROFILE_PATH) },
  ];
  const profileFingerprint = fingerprint(profilePins.map(({ name, sha256: digest }) => ({ name, sha256: digest })));
  const catalogFingerprint = fingerprint({
    schema: 'agentx.benchmark-harness-catalog-observation/v1',
    model: {
      id: modelRecord.id,
      canonicalSlug: modelRecord.canonical_slug,
      contextLength: modelRecord.context_length,
    },
    endpoint: {
      providerName: endpoint.provider_name,
      contextLength: endpoint.context_length,
      maxCompletionTokens: endpoint.max_completion_tokens,
      supportedParameters: [...(endpoint.supported_parameters || [])].sort(),
      pricing,
    },
    runtimePins: runtimePins.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    profilePins: profilePins.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
  });
  const target = normalizeTarget({
    id: 'openrouter-qwen38-flash-alibaba',
    label: 'Qwen 3.8 Flash via OpenRouter (Alibaba)',
    mode: 'isolated_model',
    tier: 'paid_cloud',
    provider: TARGET_PROVIDER,
    model: TARGET_MODEL,
    modelVersion,
    harness: { name: 'aiops-benchmark-harness-broker', version: '1.1.0' },
    adapter: { name: 'openrouter-isolated', version: '1.0.0' },
    profile: { id: 'openrouter-isolated-v1', version: '1', fingerprint: profileFingerprint },
    api: { name: 'openrouter-chat-completions', version: 'v1' },
    contextWindow: Number(modelRecord.context_length),
    capabilities: { candidate: true, judge: true },
    pricing: {
      kind: 'manual_per_token',
      currency: 'USD',
      source: 'OpenRouter endpoint API live snapshot',
      effectiveAt: observedAt.toISOString(),
      ...pricing,
      callNanodollars: 0,
    },
    available: true,
    observedAt: observedAt.toISOString(),
    catalogFingerprint,
  });
  const catalog = {
    schema: 'agentx.benchmark-harness-catalog/v1',
    broker: { name: 'aiops-benchmark-harness-broker', version: '1.1.0' },
    catalog: {
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(observedAt.getTime() + 48 * 60 * 60 * 1000).toISOString(),
    },
    targets: [{
      target,
      attestations: {
        noMemory: true,
        noTools: true,
        noFallback: true,
        noFanOut: true,
        noDelivery: true,
        ephemeralSession: true,
      },
      executor: {
        command: process.execPath,
        args: [EXECUTOR_PATH],
        envAllowlist: ['OPENROUTER_API_KEY'],
        lock: 'openrouter-qwen38-flash-alibaba-isolated',
        capacity: 1,
        timeoutMs: 900_000,
        maxOutputBytes: 2_000_000,
        pins: { runtime: runtimePins, profile: profilePins },
      },
    }],
  };
  process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
