'use strict';

const crypto = require('node:crypto');

const HEX64 = /^[a-f0-9]{64}$/;

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function required(value, name, max = 240) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) fail('INVALID_CATALOG', `${name} is required and must be at most ${max} characters`);
  return text;
}

function id(value, name, max = 180, model = false) {
  const text = required(value, name, max);
  const pattern = model ? /^[a-zA-Z0-9][a-zA-Z0-9._:@/+\-]*$/ : /^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/;
  if (!pattern.test(text) || text.includes('://') || text.includes('\\') || text.includes('/../')) fail('INVALID_CATALOG', `${name} must be a logical identifier`);
  return text;
}

function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail('INVALID_CATALOG', `${name} must be an integer from ${min} to ${max}`);
  return number;
}

function timestamp(value, name) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('INVALID_CATALOG', `${name} must be an ISO-compatible timestamp`);
  return parsed.toISOString();
}

function versioned(value, name) {
  if (!value || typeof value !== 'object') fail('INVALID_CATALOG', `${name} is required`);
  return { name: id(value.name, `${name}.name`), version: id(value.version, `${name}.version`, 160) };
}

function normalizePricing(value, tier) {
  if (tier === 'local') {
    if (value != null) fail('INVALID_CATALOG', 'local targets must not declare cloud pricing');
    return null;
  }
  if (!value || typeof value !== 'object') fail('INVALID_CATALOG', 'cloud targets require a declared price or declared-free record');
  const kind = required(value.kind, 'pricing.kind').toLowerCase();
  if (!['free', 'manual_per_token', 'manual_per_call'].includes(kind)) fail('INVALID_CATALOG', 'pricing.kind is invalid');
  const pricing = {
    kind,
    currency: required(value.currency || 'USD', 'pricing.currency').toUpperCase(),
    estimated: kind !== 'free',
    source: required(value.source || (kind === 'free' ? 'declared-free' : ''), 'pricing.source'),
    effectiveAt: value.effectiveAt == null ? null : timestamp(value.effectiveAt, 'pricing.effectiveAt'),
    inputNanodollarsPerMillion: integer(value.inputNanodollarsPerMillion ?? 0, 'pricing.inputNanodollarsPerMillion'),
    outputNanodollarsPerMillion: integer(value.outputNanodollarsPerMillion ?? 0, 'pricing.outputNanodollarsPerMillion'),
    cacheReadNanodollarsPerMillion: integer(value.cacheReadNanodollarsPerMillion ?? 0, 'pricing.cacheReadNanodollarsPerMillion'),
    cacheWriteNanodollarsPerMillion: integer(value.cacheWriteNanodollarsPerMillion ?? 0, 'pricing.cacheWriteNanodollarsPerMillion'),
    callNanodollars: integer(value.callNanodollars ?? 0, 'pricing.callNanodollars')
  };
  if (pricing.currency !== 'USD') fail('INVALID_CATALOG', 'pricing.currency must be USD');
  if (tier === 'free_cloud' && kind !== 'free') fail('INVALID_CATALOG', 'free_cloud pricing must be free');
  if (tier === 'paid_cloud' && kind === 'free') fail('INVALID_CATALOG', 'paid_cloud pricing cannot be free');
  if (kind === 'free' && (
    pricing.inputNanodollarsPerMillion
    || pricing.outputNanodollarsPerMillion
    || pricing.cacheReadNanodollarsPerMillion
    || pricing.cacheWriteNanodollarsPerMillion
    || pricing.callNanodollars
  )) fail('INVALID_CATALOG', 'free pricing cannot contain a positive price');
  if (kind === 'manual_per_token' && !pricing.inputNanodollarsPerMillion && !pricing.outputNanodollarsPerMillion) fail('INVALID_CATALOG', 'manual token price is empty');
  if (kind === 'manual_per_call' && !pricing.callNanodollars) fail('INVALID_CATALOG', 'manual call price is empty');
  if (kind !== 'free' && !pricing.effectiveAt) fail('INVALID_CATALOG', 'manual pricing requires pricing.effectiveAt');
  return pricing;
}

function normalizeNativePolicy(value, mode) {
  if (mode !== 'native_agent') return null;
  if (!value || typeof value !== 'object') fail('INVALID_CATALOG', 'native_agent target requires nativePolicy');
  const allowedOperations = [...new Set(Array.isArray(value.allowedOperations) ? value.allowedOperations : [])].sort();
  if (allowedOperations.some((operation) => !['read', 'list', 'create', 'update', 'delete', 'execute'].includes(operation))) {
    fail('INVALID_CATALOG', 'nativePolicy.allowedOperations contains an invalid operation');
  }
  if (value.filesystemMode === 'none' && allowedOperations.length > 0) fail('INVALID_CATALOG', 'filesystem mode none cannot allow operations');
  if (value.filesystemMode === 'read_only' && allowedOperations.some((operation) => !['read', 'list'].includes(operation))) {
    fail('INVALID_CATALOG', 'read_only filesystem may allow only read and list');
  }
  return {
    tools: (Array.isArray(value.tools) ? value.tools : []).map((tool) => ({
      name: id(tool.name, 'nativePolicy.tools.name'),
      version: tool.version == null ? null : id(tool.version, 'nativePolicy.tools.version', 120),
      schemaFingerprint: HEX64.test(String(tool.schemaFingerprint || '').toLowerCase()) ? String(tool.schemaFingerprint).toLowerCase() : fail('INVALID_CATALOG', 'native tool schema fingerprint is invalid')
    })),
    filesystemMode: ['none', 'read_only', 'workspace_write'].includes(value.filesystemMode) ? value.filesystemMode : fail('INVALID_CATALOG', 'native filesystem mode is invalid'),
    allowedOperations,
    networkDestinations: [...new Set((Array.isArray(value.networkDestinations) ? value.networkDestinations : []).map((entry) => id(entry, 'nativePolicy.networkDestinations')))].sort(),
    maxTurns: integer(value.maxTurns ?? 100, 'nativePolicy.maxTurns', 1, 100000),
    maxToolCalls: integer(value.maxToolCalls ?? 1000, 'nativePolicy.maxToolCalls', 0, 1000000)
  };
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object') fail('INVALID_CATALOG', 'target is required');
  const mode = required(value.mode, 'target.mode').toLowerCase();
  const tier = required(value.tier, 'target.tier').toLowerCase();
  if (!['isolated_model', 'native_agent'].includes(mode) || !['local', 'free_cloud', 'paid_cloud'].includes(tier)) fail('INVALID_CATALOG', 'target mode or tier is invalid');
  if (tier === 'local' && value.provider !== 'ollama') fail('INVALID_CATALOG', 'local harness targets must use Ollama');
  const catalogFingerprint = String(value.catalogFingerprint || '').toLowerCase();
  if (!HEX64.test(catalogFingerprint)) fail('INVALID_CATALOG', 'target.catalogFingerprint must be SHA-256');
  const target = {
    schema: 'agentx.benchmark-target/v1', schemaVersion: 1,
    id: id(value.id, 'target.id'), label: required(value.label || value.model, 'target.label'),
    executionKind: 'harness', mode, tier,
    provider: id(value.provider, 'target.provider', 120),
    model: id(value.model, 'target.model', 240, true),
    modelVersion: id(value.modelVersion || 'unknown', 'target.modelVersion', 160),
    host: null,
    harness: versioned(value.harness, 'target.harness'),
    adapter: versioned(value.adapter, 'target.adapter'),
    profile: {
      id: id(value.profile?.id, 'target.profile.id'),
      version: id(value.profile?.version, 'target.profile.version', 160),
      fingerprint: HEX64.test(String(value.profile?.fingerprint || '').toLowerCase()) ? String(value.profile.fingerprint).toLowerCase() : fail('INVALID_CATALOG', 'target.profile.fingerprint is invalid')
    },
    nativePolicy: normalizeNativePolicy(value.nativePolicy, mode),
    api: versioned(value.api, 'target.api'),
    contextWindow: value.contextWindow == null ? null : integer(value.contextWindow, 'target.contextWindow', 1, 100000000),
    capabilities: { candidate: value.capabilities?.candidate !== false, judge: mode === 'isolated_model' && value.capabilities?.judge !== false, nativeAgent: mode === 'native_agent' },
    pricing: normalizePricing(value.pricing, tier),
    available: value.available !== false,
    observedAt: value.observedAt == null ? null : timestamp(value.observedAt, 'target.observedAt'),
    catalogFingerprint
  };
  if (value.billing != null) {
    if (!['local', 'free', 'included', 'paid', 'unknown'].includes(value.billing)) fail('INVALID_CATALOG', 'target.billing is invalid');
    target.billing = value.billing;
  }
  return { ...target, fingerprint: fingerprint(target) };
}

function buildReceipt({ envelope, target, actual, usage, output, evidence = null, contractSatisfied = true }) {
  const identity = {
    harness: target.harness,
    adapter: target.adapter,
    provider: { name: target.provider, version: actual.providerVersion || 'unknown' },
    model: { name: target.model, version: target.modelVersion, digest: actual.modelDigest || null, runtimeFingerprint: actual.runtimeFingerprint || null },
    api: target.api,
    environment: { id: actual.environmentId, version: actual.environmentVersion, fingerprint: actual.environmentFingerprint }
  };
  const fingerprints = { prompt: envelope.prompt.fingerprint, tools: envelope.tools.schemaFingerprint, policies: envelope.policies.fingerprint, envelope: envelope.fingerprint };
  const normalized = {
    schema: 'agentx.worker-receipt/v1', schemaVersion: 1,
    executionProfile: envelope.executionProfile,
    identity,
    fingerprints,
    executionTupleFingerprint: fingerprint({ identity, fingerprints: { prompt: fingerprints.prompt, tools: fingerprints.tools, policies: fingerprints.policies } }),
    finalState: contractSatisfied === true ? 'succeeded' : 'failed',
    failure: contractSatisfied === true ? { classification: null, code: null }
      : { classification: 'invalid_result', code: 'REPO_FIXTURE_VERIFICATION_FAILED' },
    usage: {
      durationMs: integer(usage.durationMs, 'usage.durationMs'),
      inputTokens: integer(usage.inputTokens ?? 0, 'usage.inputTokens'),
      outputTokens: integer(usage.outputTokens ?? 0, 'usage.outputTokens'),
      totalTokens: integer((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), 'usage.totalTokens'),
      costNanodollars: integer(usage.costNanodollars ?? 0, 'usage.costNanodollars'),
      turns: integer(usage.turns ?? 1, 'usage.turns'),
      toolCalls: integer(usage.toolCalls ?? 0, 'usage.toolCalls')
    },
    toolErrors: [], humanInterventions: [], evidence: evidence || { patches: [], artifacts: [], tests: [] }, violations: [],
    result: { contractSatisfied: contractSatisfied === true, fingerprint: fingerprint(String(output)) }
  };
  if (actual.execution) normalized.execution = require('../../shared/executionEvidence').normalizeExecutionEvidence(actual.execution);
  if (usage.cacheReadTokens != null) normalized.usage.cacheReadTokens = integer(usage.cacheReadTokens, 'usage.cacheReadTokens');
  if (usage.cacheWriteTokens != null) normalized.usage.cacheWriteTokens = integer(usage.cacheWriteTokens, 'usage.cacheWriteTokens');
  if (usage.costSource != null) {
    const costSource = String(usage.costSource).toLowerCase();
    if (!['declared-pricing', 'provider-reported'].includes(costSource)) fail('INVALID_CATALOG', 'usage.costSource is invalid');
    normalized.usage.costSource = costSource;
  }
  return { ...normalized, fingerprint: fingerprint(normalized) };
}

module.exports = { buildReceipt, fail, fingerprint, normalizeTarget, stableSerialize };
