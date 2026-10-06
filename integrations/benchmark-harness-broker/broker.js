'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createReadStream } = require('node:fs');
const { appendFile, mkdir, mkdtemp, readFile, rm } = require('node:fs/promises');
const { stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildReceipt, fail, fingerprint, normalizeTarget } = require('./contract');

const MAX_CONFIG_BYTES = 1_000_000;
const DEFAULT_OUTPUT_BYTES = 2_000_000;
const activeByLock = new Map();
const queuesByLock = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function classifyFailure(code) {
  if (code === 'EXECUTION_TIMEOUT') return 'timeout';
  if (code === 'EXECUTION_CANCELLED') return 'cancelled';
  if (['OUTPUT_LIMIT_EXCEEDED', 'SPEND_GRANT_EXHAUSTED', 'EXECUTION_BUDGET_EXCEEDED'].includes(code)) return 'budget_exceeded';
  if (['FALLBACK_USED', 'TARGET_DRIFT', 'PIN_DRIFT', 'PROFILE_DRIFT', 'CATALOG_STALE', 'ISOLATION_CONTRACT_DRIFT', 'PROMPT_FINGERPRINT_MISMATCH'].includes(code)) return 'policy_violation';
  if (['EXECUTOR_INVALID_JSON', 'EXECUTOR_REQUEST_MISMATCH', 'EXECUTOR_RESPONSE_MISMATCH'].includes(code)) return 'invalid_result';
  if (String(code || '').startsWith('SPEND_GRANT_')) return 'policy_violation';
  if (code === 'EXECUTOR_FAILED') return 'adapter_error';
  if (code === 'TARGET_UNAVAILABLE') return 'infrastructure_error';
  return 'harness_error';
}

function validateExecutor(executor) {
  if (!executor || typeof executor !== 'object' || !path.isAbsolute(String(executor.command || ''))) fail('INVALID_CATALOG', 'executor.command must be absolute');
  if (!Array.isArray(executor.args) || executor.args.some((arg) => typeof arg !== 'string' || arg.length > 1000)) fail('INVALID_CATALOG', 'executor.args must be fixed strings');
  const envAllowlist = Array.isArray(executor.envAllowlist) ? executor.envAllowlist : [];
  if (envAllowlist.some((name) => !/^[A-Z][A-Z0-9_]{0,79}$/.test(name))) fail('INVALID_CATALOG', 'executor.envAllowlist contains an invalid name');
  const normalizePins = (value, kind) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail('INVALID_CATALOG', `executor.pins.${kind} must contain 1 to 32 files`);
    const pins = value.map((pin, index) => {
      if (!pin || typeof pin !== 'object' || !path.isAbsolute(String(pin.path || ''))) fail('INVALID_CATALOG', `executor.pins.${kind}[${index}].path must be absolute`);
      const sha256 = String(pin.sha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha256)) fail('INVALID_CATALOG', `executor.pins.${kind}[${index}].sha256 must be SHA-256`);
      const name = String(pin.name || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)) fail('INVALID_CATALOG', `executor.pins.${kind}[${index}].name is invalid`);
      const envName = pin.envName == null ? null : String(pin.envName);
      if (envName && !/^[A-Z][A-Z0-9_]{0,79}$/.test(envName)) fail('INVALID_CATALOG', `executor.pins.${kind}[${index}].envName is invalid`);
      return { name, path: path.resolve(pin.path), sha256, envName };
    });
    if (new Set(pins.map((pin) => pin.name)).size !== pins.length) fail('INVALID_CATALOG', `executor.pins.${kind} names must be unique`);
    return pins;
  };
  const runtimePins = normalizePins(executor.pins?.runtime, 'runtime');
  const profilePins = normalizePins(executor.pins?.profile, 'profile');
  const pinnedPaths = new Set([...runtimePins, ...profilePins].map((pin) => pin.path));
  for (const executablePath of [executor.command, ...executor.args.filter((arg) => path.isAbsolute(arg))].map((entry) => path.resolve(entry))) {
    if (!pinnedPaths.has(executablePath)) fail('INVALID_CATALOG', `executor path is not pinned: ${executablePath}`);
  }
  return {
    command: executor.command, args: [...executor.args], envAllowlist,
    lock: String(executor.lock || executor.command),
    capacity: Math.max(1, Math.min(32, Number(executor.capacity) || 1)),
    timeoutMs: Math.max(1000, Math.min(604800000, Number(executor.timeoutMs) || 600000)),
    maxOutputBytes: Math.max(4096, Math.min(10000000, Number(executor.maxOutputBytes) || DEFAULT_OUTPUT_BYTES)),
    pins: { runtime: runtimePins, profile: profilePins },
  };
}

async function sha256File(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > 512 * 1024 * 1024) fail('PIN_DRIFT', 'pinned runtime/profile file is absent, empty, or too large', 409);
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function observeExecutorPins(executor, target) {
  const observe = async (pins, kind) => {
    const observed = [];
    for (const pin of pins) {
      if (pin.envName && path.resolve(String(process.env[pin.envName] || '')) !== pin.path) {
        fail('PIN_DRIFT', `${kind} pin ${pin.name} does not match ${pin.envName}`, 409);
      }
      let digest;
      try { digest = await sha256File(pin.path); } catch (error) {
        if (error.code === 'PIN_DRIFT') throw error;
        fail('PIN_DRIFT', `${kind} pin ${pin.name} is unreadable`, 409);
      }
      if (!safeEqual(digest, pin.sha256)) fail('PIN_DRIFT', `${kind} pin ${pin.name} changed`, 409);
      observed.push({ name: pin.name, sha256: digest });
    }
    return fingerprint(observed.sort((left, right) => left.name.localeCompare(right.name)));
  };
  const runtimeFingerprint = await observe(executor.pins.runtime, 'runtime');
  const profileFingerprint = await observe(executor.pins.profile, 'profile');
  if (!safeEqual(profileFingerprint, target.profile.fingerprint)) fail('PROFILE_DRIFT', `target ${target.id} profile fingerprint differs from observed pinned files`, 409);
  return { runtimeFingerprint, profileFingerprint };
}

async function loadCatalog(configPath) {
  const raw = await readFile(configPath);
  if (raw.length > MAX_CONFIG_BYTES) fail('INVALID_CATALOG', 'catalog exceeds 1000000 bytes');
  const config = JSON.parse(raw.toString('utf8'));
  if (config?.schema !== 'agentx.benchmark-harness-catalog/v1' || !Array.isArray(config.targets)) fail('INVALID_CATALOG', 'catalog schema is invalid');
  const entries = config.targets.map((entry) => {
    const target = normalizeTarget(entry.target);
    const attestations = entry.attestations || {};
    if (target.mode === 'isolated_model') {
      for (const key of ['noMemory', 'noTools', 'noFallback', 'noFanOut', 'noDelivery', 'ephemeralSession']) {
        if (attestations[key] !== true) fail('INVALID_CATALOG', `isolated target ${target.id} lacks ${key} attestation`);
      }
    }
    return { target, attestations, executor: validateExecutor(entry.executor) };
  });
  if (new Set(entries.map((entry) => entry.target.id)).size !== entries.length) fail('INVALID_CATALOG', 'target ids must be unique');
  const hasAvailableTargets = entries.some((entry) => entry.target.available);
  // Local executors and profiles are observed below on every catalog read.
  // Cloud catalog observations also cover external pricing and retain their expiry.
  const allLocal = entries.length > 0 && entries.every((entry) => entry.target.tier === 'local');
  const catalogObservedAt = allLocal ? Date.now() : config.catalog?.observedAt == null ? null : Date.parse(config.catalog.observedAt);
  const catalogExpiresAt = allLocal ? catalogObservedAt + 300_000 : config.catalog?.expiresAt == null ? null : Date.parse(config.catalog.expiresAt);
  if (hasAvailableTargets && (!Number.isFinite(catalogObservedAt) || !Number.isFinite(catalogExpiresAt))) {
    fail('CATALOG_STALE', 'an available catalog requires observedAt and expiresAt', 409);
  }
  if (hasAvailableTargets && (catalogObservedAt > Date.now() + 300_000 || catalogExpiresAt <= Date.now() || catalogExpiresAt <= catalogObservedAt)) {
    fail('CATALOG_STALE', 'catalog observation is future-dated, expired, or has an invalid freshness window', 409);
  }
  for (const entry of entries) entry.observedPins = await observeExecutorPins(entry.executor, entry.target);
  return {
    entries,
    observedAt: Number.isFinite(catalogObservedAt) ? new Date(catalogObservedAt).toISOString() : null,
    expiresAt: Number.isFinite(catalogExpiresAt) ? new Date(catalogExpiresAt).toISOString() : null,
    broker: { name: String(config.broker?.name || 'aiops-benchmark-harness-broker'), version: String(config.broker?.version || '1.0.0') }
  };
}

async function withCapacity(executor, operation) {
  const key = executor.lock;
  if ((activeByLock.get(key) || 0) >= executor.capacity) {
    await new Promise((resolve) => {
      const queue = queuesByLock.get(key) || [];
      queue.push(resolve);
      queuesByLock.set(key, queue);
    });
  }
  activeByLock.set(key, (activeByLock.get(key) || 0) + 1);
  try { return await operation(); } finally {
    activeByLock.set(key, Math.max(0, (activeByLock.get(key) || 1) - 1));
    const next = queuesByLock.get(key)?.shift();
    if (next) next();
  }
}

function verifySpendGrant(grant, target, request, signingKey) {
  if (target.tier !== 'paid_cloud') return null;
  if (!grant || !signingKey) fail('SPEND_GRANT_REQUIRED', 'paid target requires a signed SpendGrant', 402);
  if (grant.schema !== 'agentx.spend-grant/v1' || Number(grant.schemaVersion) !== 1 || !String(grant.grantId || '').trim()) {
    fail('SPEND_GRANT_INVALID', 'SpendGrant schema or identity is invalid', 403);
  }
  const { signature, ...unsigned } = grant;
  const expected = crypto.createHmac('sha256', signingKey).update(JSON.stringify(unsigned)).digest('hex');
  if (!safeEqual(signature, expected)) fail('SPEND_GRANT_INVALID', 'SpendGrant signature is invalid', 403);
  if (unsigned.batchId !== String(request.batchId || '')) fail('SPEND_GRANT_BATCH_MISMATCH', 'SpendGrant is bound to another batch', 403);
  if (!safeEqual(unsigned.batchFingerprint, request.batchFingerprint)) fail('SPEND_GRANT_BATCH_MISMATCH', 'SpendGrant is bound to another batch contract', 403);
  if (!Array.isArray(unsigned.targetFingerprints)
    || unsigned.targetFingerprints.some((value) => !/^[a-f0-9]{64}$/.test(String(value || '').toLowerCase()))
    || !unsigned.targetFingerprints.includes(target.fingerprint)) fail('SPEND_GRANT_TARGET_MISMATCH', 'SpendGrant does not authorize this target', 403);
  for (const name of ['maxCalls', 'maxTokens', 'maxCostNanodollars']) spendPlanInteger(unsigned[name], `SpendGrant.${name}`);
  const expectedPlan = fingerprint({ batchId: unsigned.batchId, batchFingerprint: unsigned.batchFingerprint, targets: [...unsigned.targetFingerprints].sort(), maxCalls: unsigned.maxCalls, maxTokens: unsigned.maxTokens, maxCostNanodollars: unsigned.maxCostNanodollars });
  if (!safeEqual(unsigned.planFingerprint, expectedPlan)) fail('SPEND_GRANT_PLAN_MISMATCH', 'SpendGrant plan fingerprint is invalid', 403);
  const expiry = Date.parse(unsigned.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) fail('SPEND_GRANT_EXPIRED', 'SpendGrant expired', 403);
  return unsigned;
}

function verifyEnvelope(envelope, target, role, input) {
  if (!envelope || envelope.schema !== 'agentx.worker-envelope/v1' || Number(envelope.schemaVersion) !== 1) fail('INVALID_ENVELOPE', 'WorkerEnvelope v1 is required', 400);
  const unsigned = { ...envelope };
  delete unsigned.fingerprint;
  if (!safeEqual(envelope.fingerprint, fingerprint(unsigned))) fail('INVALID_ENVELOPE', 'WorkerEnvelope fingerprint mismatch', 409);
  if (!safeEqual(envelope.prompt?.fingerprint, fingerprint(String(input?.prompt || '')))) fail('PROMPT_FINGERPRINT_MISMATCH', 'input prompt does not match the WorkerEnvelope', 409);
  if (envelope.selection?.harness?.id !== target.harness.name || envelope.selection?.harness?.version !== target.harness.version || envelope.selection?.model?.provider !== target.provider || envelope.selection?.model?.id !== target.model || envelope.selection?.model?.version !== target.modelVersion) fail('TARGET_DRIFT', 'WorkerEnvelope selection differs from the catalog target', 409);
  if (envelope.workspace?.kind !== 'ephemeral' || envelope.policies?.output?.mode !== 'result_only' || Number(envelope.policies?.output?.maxBytes) > 2_000_000) {
    fail('ISOLATION_CONTRACT_DRIFT', 'benchmark execution requires an ephemeral workspace and bounded result-only output', 409);
  }
  if (target.mode === 'isolated_model') {
    const exactNetwork = [target.provider];
    if (envelope.executionProfile !== 'portable'
      || envelope.tools?.allowed?.length !== 0
      || envelope.budgets?.maxTurns !== 1
      || envelope.budgets?.maxToolCalls !== 0
      || envelope.policies?.filesystem?.mode !== 'none'
      || envelope.policies?.filesystem?.allowedOperations?.length !== 0
      || envelope.policies?.network?.mode !== 'allowlist'
      || fingerprint(envelope.policies?.network?.allowedDestinations || []) !== fingerprint(exactNetwork)) {
      fail('ISOLATION_CONTRACT_DRIFT', 'isolated target envelope enables state, tools, network expansion, or multiple turns', 409);
    }
  } else {
    const policy = target.nativePolicy;
    const exactNetwork = [...new Set([target.provider, ...policy.networkDestinations])].sort();
    if (envelope.executionProfile !== 'native-ceiling'
      || fingerprint(envelope.tools?.allowed || []) !== fingerprint([...policy.tools].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      || envelope.policies?.filesystem?.mode !== policy.filesystemMode
      || fingerprint(envelope.policies?.filesystem?.allowedOperations || []) !== fingerprint(policy.allowedOperations)
      || envelope.policies?.network?.mode !== 'allowlist'
      || fingerprint([...(envelope.policies?.network?.allowedDestinations || [])].sort()) !== fingerprint(exactNetwork)
      || Number(envelope.budgets?.maxTurns) > policy.maxTurns
      || Number(envelope.budgets?.maxToolCalls) > policy.maxToolCalls) {
      fail('NATIVE_POLICY_DRIFT', 'native-agent envelope differs from its catalog capability policy', 409);
    }
  }
  if (role === 'judge' && (target.mode !== 'isolated_model' || target.capabilities.judge !== true)) fail('JUDGE_NOT_ALLOWED', 'judge must be an isolated target', 422);
}

function estimateReservation(target, request) {
  const turns = target.mode === 'native_agent' ? target.nativePolicy.maxTurns : 1;
  const maxTokens = Math.max(1, Number(request.parameters?.maxTokens) || 1) * turns;
  const promptTokens = target.mode === 'native_agent' ? target.contextWindow * turns
    : Math.max(1, Math.ceil(Buffer.byteLength(String(request.input?.prompt || ''), 'utf8') / 3));
  const pricing = target.pricing || {};
  const conservativeInputRate = Math.max(
    Number(pricing.inputNanodollarsPerMillion || 0),
    Number(pricing.cacheReadNanodollarsPerMillion || 0),
    Number(pricing.cacheWriteNanodollarsPerMillion || 0)
  );
  const costNanodollars = Number(pricing.callNanodollars || 0)
    + Math.ceil(promptTokens * conservativeInputRate / 1000000)
    + Math.ceil(maxTokens * Number(pricing.outputNanodollarsPerMillion || 0) / 1000000);
  return { calls: 1, tokens: promptTokens + maxTokens, costNanodollars };
}

function estimateActualCost(target, usage) {
  const pricing = target.pricing || {};
  const inputTokens = Math.max(0, Number(usage.inputTokens || 0));
  const cacheReadTokens = Math.min(inputTokens, Math.max(0, Number(usage.cacheReadTokens || 0)));
  const cacheWriteTokens = Math.min(inputTokens - cacheReadTokens, Math.max(0, Number(usage.cacheWriteTokens || 0)));
  const uncachedInputTokens = inputTokens - cacheReadTokens - cacheWriteTokens;
  return Number(pricing.callNanodollars || 0)
    + Math.ceil(uncachedInputTokens * Number(pricing.inputNanodollarsPerMillion || 0) / 1000000)
    + Math.ceil(cacheReadTokens * Number(pricing.cacheReadNanodollarsPerMillion || pricing.inputNanodollarsPerMillion || 0) / 1000000)
    + Math.ceil(cacheWriteTokens * Number(pricing.cacheWriteNanodollarsPerMillion || pricing.inputNanodollarsPerMillion || 0) / 1000000)
    + Math.ceil(Number(usage.outputTokens || 0) * Number(pricing.outputNanodollarsPerMillion || 0) / 1000000);
}

function spendPlanInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    fail('SPEND_GRANT_REQUEST_INVALID', `${name} must be an integer between ${min} and ${max}`, 422);
  }
  return normalized;
}

function buildSignedSpendGrant(request, catalog, signingKey) {
  if (!signingKey) fail('SPEND_GRANT_ISSUER_DISABLED', 'SpendGrant signing is not configured', 503);
  if (request?.schema !== 'agentx.spend-grant-request/v1' || Number(request.schemaVersion) !== 1) {
    fail('SPEND_GRANT_REQUEST_INVALID', 'agentx.spend-grant-request/v1 is required', 400);
  }
  const batchId = String(request.batchId || '').trim();
  if (!batchId || batchId.length > 240) fail('SPEND_GRANT_REQUEST_INVALID', 'batchId is required', 422);
  const batchFingerprint = String(request.batchFingerprint || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(batchFingerprint)) fail('SPEND_GRANT_REQUEST_INVALID', 'batchFingerprint must be SHA-256', 422);
  if (request.approval?.confirmed !== true) fail('PAID_APPROVAL_REQUIRED', 'explicit paid approval is required', 422);
  if (!Array.isArray(request.units) || request.units.length < 1 || request.units.length > 256) {
    fail('SPEND_GRANT_REQUEST_INVALID', 'spend units must contain 1 to 256 entries', 422);
  }

  let maxCalls = 0n;
  let maxTokens = 0n;
  let maxCostNanodollars = 0n;
  const targetFingerprints = new Set();
  for (const [index, unit] of request.units.entries()) {
    const entry = catalog.entries.find((candidate) => candidate.target.id === String(unit?.targetId || ''));
    if (!entry || !entry.target.available || entry.target.tier !== 'paid_cloud') {
      fail('SPEND_GRANT_TARGET_INVALID', `spend unit ${index} is not an available paid target`, 409);
    }
    if (!safeEqual(unit.targetFingerprint, entry.target.fingerprint)) {
      fail('TARGET_DRIFT', `spend unit ${index} target changed since approval`, 409);
    }
    const calls = BigInt(spendPlanInteger(unit.calls, `units[${index}].calls`, { min: 1, max: 1_000_000 }));
    const inputTokens = BigInt(spendPlanInteger(unit.inputTokensPerCall, `units[${index}].inputTokensPerCall`, { min: 1, max: 1_000_000_000 }));
    const outputTokens = BigInt(spendPlanInteger(unit.outputTokensPerCall, `units[${index}].outputTokensPerCall`, { min: 1, max: 1_000_000_000 }));
    const pricing = entry.target.pricing;
    const conservativeInputRate = Math.max(
      pricing.inputNanodollarsPerMillion || 0,
      pricing.cacheReadNanodollarsPerMillion || 0,
      pricing.cacheWriteNanodollarsPerMillion || 0
    );
    const perCall = BigInt(pricing.callNanodollars || 0)
      + ((inputTokens * BigInt(conservativeInputRate) + 999_999n) / 1_000_000n)
      + ((outputTokens * BigInt(pricing.outputNanodollarsPerMillion || 0) + 999_999n) / 1_000_000n);
    maxCalls += calls;
    maxTokens += calls * (inputTokens + outputTokens);
    maxCostNanodollars += calls * perCall;
    targetFingerprints.add(entry.target.fingerprint);
  }
  for (const [value, name] of [[maxCalls, 'maxCalls'], [maxTokens, 'maxTokens'], [maxCostNanodollars, 'maxCostNanodollars']]) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('SPEND_GRANT_REQUEST_INVALID', `${name} exceeds the safe integer range`, 422);
  }
  const computed = {
    maxCalls: Number(maxCalls),
    maxTokens: Number(maxTokens),
    maxCostNanodollars: Number(maxCostNanodollars),
  };
  for (const name of Object.keys(computed)) {
    const approved = spendPlanInteger(request.approval?.[name], `approval.${name}`);
    if (approved < computed[name]) fail('PAID_APPROVAL_TOO_LOW', `approval.${name} is below the frozen worst-case plan`, 422);
  }
  const fingerprints = [...targetFingerprints].sort();
  const unsigned = {
    schema: 'agentx.spend-grant/v1', schemaVersion: 1, grantId: crypto.randomUUID(), batchId, batchFingerprint,
    targetFingerprints: fingerprints,
    planFingerprint: fingerprint({ batchId, batchFingerprint, targets: fingerprints, ...computed }),
    ...computed,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  return { ...unsigned, signature: crypto.createHmac('sha256', signingKey).update(JSON.stringify(unsigned)).digest('hex') };
}

async function reserveSpend({ ledgerPath, grant, target, request }) {
  if (!grant) return;
  await mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  let prior = [];
  try { prior = (await readFile(ledgerPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const used = prior.filter((row) => row.grantId === grant.grantId).reduce((sum, row) => ({ calls: sum.calls + row.calls, tokens: sum.tokens + row.tokens, costNanodollars: sum.costNanodollars + row.costNanodollars }), { calls: 0, tokens: 0, costNanodollars: 0 });
  const reservation = estimateReservation(target, request);
  if (used.calls + reservation.calls > grant.maxCalls || used.tokens + reservation.tokens > grant.maxTokens || used.costNanodollars + reservation.costNanodollars > grant.maxCostNanodollars) fail('SPEND_GRANT_EXHAUSTED', 'SpendGrant remaining ceilings are insufficient', 402);
  await appendFile(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), grantId: grant.grantId, targetFingerprint: target.fingerprint, ...reservation })}\n`, { mode: 0o600 });
}

async function runExecutor({ entry, request, signal }) {
  if (signal?.aborted) throw publicError('EXECUTION_CANCELLED', 'execution cancelled', 499);
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'agentx-benchmark-cell-'));
  const started = Date.now();
  try {
    const env = { HOME: sessionRoot, USERPROFILE: sessionRoot, TMPDIR: sessionRoot, TEMP: sessionRoot, TMP: sessionRoot, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1' };
    for (const name of entry.executor.envAllowlist) if (process.env[name] != null) env[name] = process.env[name];
    env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT = entry.observedPins.runtimeFingerprint;
    env.AGENTX_OBSERVED_PROFILE_FINGERPRINT = entry.observedPins.profileFingerprint;
    const input = JSON.stringify({
      schema: 'agentx.benchmark-executor-input/v1', requestId: request.requestId,
      target: entry.target, envelope: request.envelope, input: request.input, parameters: request.parameters,
      runtimeClaims: entry.target.tier === 'local' ? request.runtimeClaims || [] : []
    });
    const outcome = await new Promise((resolve, reject) => {
      const processGroup = process.platform !== 'win32';
      const child = spawn(entry.executor.command, entry.executor.args, { cwd: sessionRoot, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: processGroup });
      const kill = () => {
        try {
          if (processGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      const stdout = []; const stderr = []; let bytes = 0; let overflow = false; let timedOut = false;
      const collect = (bucket) => (chunk) => { bytes += chunk.length; if (bytes > entry.executor.maxOutputBytes) { overflow = true; kill(); } else bucket.push(chunk); };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr)); child.on('error', reject);
      const abort = kill;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timeoutMs = Math.min(entry.executor.timeoutMs, Number(request.parameters?.timeoutMs) || entry.executor.timeoutMs);
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      child.on('close', (code, childSignal) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (overflow) return reject(publicError('OUTPUT_LIMIT_EXCEEDED', 'executor output exceeded its bound', 502));
        if (timedOut) return reject(publicError('EXECUTION_TIMEOUT', 'executor exceeded its hard deadline', 504));
        if (signal?.aborted) return reject(publicError('EXECUTION_CANCELLED', 'execution cancelled', 499));
        resolve({
          code,
          signal: childSignal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.end(input);
    });
    if (outcome.code !== 0) {
      const openRouterFailure = entry.target.adapter?.name === 'openrouter-isolated'
        ? sanitizeOpenRouterExecutorFailure(outcome.stderr)
        : null;
      throw publicError(
        'EXECUTOR_FAILED',
        openRouterFailure ? `executor failed: ${openRouterFailure}` : `executor exited ${outcome.code}`,
        502
      );
    }
    let result;
    try { result = JSON.parse(outcome.stdout); } catch { throw publicError('EXECUTOR_INVALID_JSON', 'executor returned invalid JSON', 502); }
    const requestFingerprint = fingerprint({ targetFingerprint: entry.target.fingerprint, envelopeFingerprint: request.envelope.fingerprint, promptFingerprint: request.envelope.prompt.fingerprint });
    if (!safeEqual(result.requestFingerprint, requestFingerprint)) fail('EXECUTOR_REQUEST_MISMATCH', 'executor receipt does not match the request', 409);
    if (result.fallbackUsed !== false) fail('FALLBACK_USED', 'executor used or did not disprove fallback', 409);
    const actual = result.actual || {};
    if (actual.provider !== entry.target.provider
      || actual.model !== entry.target.model
      || actual.modelVersion !== entry.target.modelVersion
      || actual.harnessVersion !== entry.target.harness.version
      || actual.adapterVersion !== entry.target.adapter.version
      || actual.environmentId !== entry.target.profile.id
      || actual.environmentVersion !== entry.target.profile.version
      || actual.environmentFingerprint !== entry.target.profile.fingerprint) {
      fail('TARGET_DRIFT', 'executor actual identity or profile differs from catalog selection', 409);
    }
    if (!/^[a-f0-9]{64}$/.test(String(actual.runtimeFingerprint || '').toLowerCase())) {
      fail('RUNTIME_FINGERPRINT_MISSING', 'executor did not prove its pinned runtime fingerprint', 409);
    }
    if (!safeEqual(actual.runtimeFingerprint, entry.observedPins.runtimeFingerprint)
      || !safeEqual(actual.environmentFingerprint, entry.observedPins.profileFingerprint)) {
      fail('PIN_DRIFT', 'executor receipt does not match the broker-observed runtime/profile pins', 409);
    }
    const output = String(result.output ?? '');
    if (Buffer.byteLength(output, 'utf8') > Number(request.envelope.policies.output.maxBytes)) {
      fail('OUTPUT_LIMIT_EXCEEDED', 'executor result exceeded the WorkerEnvelope output bound', 502);
    }
    if (!safeEqual(result.responseFingerprint, fingerprint(output))) fail('EXECUTOR_RESPONSE_MISMATCH', 'executor response fingerprint mismatch', 409);
    const rawUsage = result.usage || {};
    const providerReportedCost = rawUsage.costSource === 'provider-reported'
      ? Number(rawUsage.costNanodollars)
      : null;
    if (providerReportedCost != null && (!Number.isSafeInteger(providerReportedCost) || providerReportedCost < 0)) {
      fail('EXECUTOR_RESPONSE_MISMATCH', 'executor provider-reported cost is invalid', 409);
    }
    const usage = {
      ...rawUsage,
      durationMs: Number(rawUsage.durationMs) || (Date.now() - started),
      costNanodollars: providerReportedCost ?? estimateActualCost(entry.target, rawUsage),
      costSource: providerReportedCost == null ? 'declared-pricing' : 'provider-reported'
    };
    const totalTokens = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
    const exceeded = Number(usage.durationMs) > Number(request.envelope.budgets.maxDurationMs)
      || totalTokens > Number(request.envelope.budgets.maxTokens)
      || Number(usage.costNanodollars) > Number(request.envelope.budgets.maxCostNanodollars)
      || Number(usage.turns || 0) > Number(request.envelope.budgets.maxTurns)
      || Number(usage.toolCalls || 0) > Number(request.envelope.budgets.maxToolCalls);
    if (exceeded) fail('EXECUTION_BUDGET_EXCEEDED', 'executor usage exceeded the WorkerEnvelope budget', 409);
    const thinking = result.thinking == null ? null : String(result.thinking);
    return { output, thinking, finishReason: result.finishReason || null, actual, usage,
      evidence: result.evidence || null, contractSatisfied: result.contractSatisfied !== false };
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
}

function sanitizeOpenRouterExecutorFailure(stderr) {
  const message = String(stderr || '').trim().split(/\r?\n/, 1)[0];
  const rules = [
    [/^OpenRouter model catalog HTTP (\d{3})$/, 'OPENROUTER_MODEL_CATALOG_HTTP_$1'],
    [/^OpenRouter endpoint catalog HTTP (\d{3})$/, 'OPENROUTER_ENDPOINT_CATALOG_HTTP_$1'],
    [/^OpenRouter chat completion HTTP (\d{3})$/, 'OPENROUTER_CHAT_COMPLETION_HTTP_$1'],
    [/^OpenRouter generation metadata HTTP (\d{3})$/, 'OPENROUTER_GENERATION_METADATA_HTTP_$1'],
    [/^OpenRouter response lacks the exact request or model identity$/, 'OPENROUTER_RESPONSE_IDENTITY_MISSING'],
    [/^OpenRouter generation metadata differs from the exact provider or model target$/, 'OPENROUTER_GENERATION_IDENTITY_DRIFT'],
    [/^OpenRouter response does not contain one textual result$/, 'OPENROUTER_VISIBLE_FINAL_MISSING'],
    [/^generation total cost is missing or invalid$/, 'OPENROUTER_REPORTED_COST_MISSING'],
    [/^OpenRouter .* pricing drifted for /, 'OPENROUTER_PRICE_DRIFT'],
    [/^OpenRouter .* context window differs /, 'OPENROUTER_CONTEXT_DRIFT'],
    [/^OpenRouter .* lacks a required request parameter$/, 'OPENROUTER_PARAMETER_UNSUPPORTED'],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return 'OPENROUTER_EXECUTOR_REJECTED';
}

async function appendAudit(auditPath, row) {
  await mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  await appendFile(auditPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function createBroker(options) {
  const configPath = options.configPath;
  const auditPath = options.auditPath;
  const ledgerPath = options.ledgerPath;
  const signingKey = options.signingKey;
  return {
    async catalog() {
      const catalog = await loadCatalog(configPath);
      return { targets: catalog.entries.map((entry) => entry.target), observedAt: catalog.observedAt, expiresAt: catalog.expiresAt, broker: catalog.broker };
    },
    async issueSpendGrant(request) {
      const catalog = await loadCatalog(configPath);
      const grant = buildSignedSpendGrant(request, catalog, signingKey);
      await appendAudit(auditPath, {
        at: new Date().toISOString(), status: 'spend_grant_issued', grantId: grant.grantId,
        batchId: grant.batchId, batchFingerprint: grant.batchFingerprint, targetFingerprints: grant.targetFingerprints,
        planFingerprint: grant.planFingerprint, maxCalls: grant.maxCalls,
        maxTokens: grant.maxTokens, maxCostNanodollars: grant.maxCostNanodollars,
      });
      return grant;
    },
    async execute(request, { signal } = {}) {
      const started = Date.now();
      let entry = null;
      try {
        if (request?.schema !== 'agentx.harness-execution/v1' || Number(request.schemaVersion) !== 1) fail('INVALID_REQUEST_SCHEMA', 'agentx.harness-execution/v1 request is required', 400);
        if (!request.requestId || request.requestId !== request.envelope?.task?.id) fail('REQUEST_ID_MISMATCH', 'requestId must match WorkerEnvelope task.id', 409);
        if (!request.batchId || !/^[a-f0-9]{64}$/.test(String(request.batchFingerprint || '').toLowerCase()) || !['candidate', 'judge'].includes(request.role)) fail('INVALID_REQUEST', 'batchId, batchFingerprint, and a valid execution role are required', 400);
        const catalog = await loadCatalog(configPath);
        entry = catalog.entries.find((candidate) => candidate.target.id === request?.target?.id);
        if (!entry || !entry.target.available) fail('TARGET_UNAVAILABLE', 'target is unavailable', 409);
        if (!safeEqual(request.target?.fingerprint, entry.target.fingerprint) || !safeEqual(request.target?.catalogFingerprint, entry.target.catalogFingerprint)) fail('TARGET_DRIFT', 'target changed since selection', 409);
        verifyEnvelope(request.envelope, entry.target, request.role, request.input);
        const grant = verifySpendGrant(request.spendGrant, entry.target, request, signingKey);
        const result = await withCapacity(entry.executor, async () => {
          if (signal?.aborted) throw publicError('EXECUTION_CANCELLED', 'execution cancelled', 499);
          await withCapacity(
            { lock: `spend-ledger:${path.resolve(ledgerPath)}`, capacity: 1 },
            () => reserveSpend({ ledgerPath, grant, target: entry.target, request })
          );
          return runExecutor({ entry, request, signal });
        });
        const receipt = buildReceipt({ envelope: request.envelope, target: entry.target, actual: result.actual, usage: result.usage, output: result.output, evidence: result.evidence, contractSatisfied: result.contractSatisfied });
        await appendAudit(auditPath, { at: new Date().toISOString(), requestId: request.requestId, batchFingerprint: request.batchFingerprint, targetId: entry.target.id, targetFingerprint: entry.target.fingerprint, envelopeFingerprint: request.envelope.fingerprint, receiptFingerprint: receipt.fingerprint, durationMs: Date.now() - started, status: receipt.finalState, failureCode: receipt.failure.code });
        return { schema: 'agentx.harness-execution/v1', schemaVersion: 1, output: result.output, thinking: result.thinking, finishReason: result.finishReason, fallbackUsed: false, receipt };
      } catch (error) {
        error.failureClassification ||= classifyFailure(error.code);
        await appendAudit(auditPath, { at: new Date().toISOString(), requestId: request?.requestId || null, batchFingerprint: request?.batchFingerprint || null, targetId: entry?.target?.id || request?.target?.id || null, targetFingerprint: entry?.target?.fingerprint || request?.target?.fingerprint || null, envelopeFingerprint: request?.envelope?.fingerprint || null, durationMs: Date.now() - started, status: 'failed', failureCode: error.code || 'EXECUTION_FAILED', failureClassification: error.failureClassification }).catch(() => {});
        throw error;
      }
    }
  };
}

module.exports = { buildSignedSpendGrant, classifyFailure, createBroker, loadCatalog, observeExecutorPins, reserveSpend, runExecutor, safeEqual, sanitizeOpenRouterExecutorFailure, verifyEnvelope, verifySpendGrant };
