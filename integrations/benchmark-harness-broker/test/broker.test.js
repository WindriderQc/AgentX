'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBroker, loadCatalog, sanitizeOpenRouterExecutorFailure, verifySpendGrant } = require('../broker');
const { fingerprint, normalizeTarget } = require('../contract');
const { createServer } = require('../server');

const HEX = (character) => character.repeat(64);
const BATCH_FINGERPRINT = HEX('b');
const fixtureExecutor = path.resolve(__dirname, 'fake-executor.js');

function rawTarget(overrides = {}) {
  return {
    id: 'openclaw-free-fixture', label: 'Fixture cloud model', mode: 'isolated_model', tier: 'free_cloud',
    provider: 'openrouter', model: 'vendor/model', modelVersion: 'provider-version-1',
    harness: { name: 'openclaw', version: '2026.8.1' },
    adapter: { name: 'openclaw-benchmark', version: '1.0.0' },
    profile: { id: 'benchmark-isolated', version: '1', fingerprint: HEX('1') },
    api: { name: 'openclaw-agent-cli', version: '2026.8.1' }, contextWindow: 131072,
    capabilities: { candidate: true, judge: true },
    pricing: { kind: 'free', currency: 'USD', source: 'fixture-free', effectiveAt: null, inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 0 },
    available: true, observedAt: '2026-08-31T00:00:00.000Z', catalogFingerprint: HEX('a'),
    ...overrides,
  };
}

function envelope(target, prompt = 'TOP-SECRET-PROMPT') {
  const policies = {
    filesystem: { mode: 'none', workspaceOnly: true, allowedOperations: [] },
    network: { mode: 'allowlist', allowedDestinations: [target.provider] },
    output: { mode: 'result_only', maxBytes: 2_000_000, publicProjection: 'allowlist_only' },
  };
  const value = {
    schema: 'agentx.worker-envelope/v1', schemaVersion: 1,
    task: { id: 'benchmark-cell-1', correlationId: 'batch-batch-1' },
    work: { description: null, reference: 'benchmark.candidate.cell' },
    workspace: { id: 'ephemeral-cell-1', kind: 'ephemeral' },
    dataClassification: 'internal', executionProfile: 'portable',
    selection: {
      harness: { id: target.harness.name, version: target.harness.version, constraints: [] },
      model: { provider: target.provider, id: target.model, version: target.modelVersion, digest: null, constraints: ['isolated-model', 'no-fallback'] },
    },
    prompt: { reference: 'benchmark.candidate.prompt', fingerprint: fingerprint(prompt) },
    tools: { allowed: [], schemaFingerprint: fingerprint([]) },
    budgets: { maxDurationMs: 5000, maxTokens: 100, maxCostNanodollars: 0, maxTurns: 1, maxToolCalls: 0 },
    policies: { ...policies, fingerprint: fingerprint(policies) },
    resultContract: { format: 'text', schemaFingerprint: null, requiredEvidence: [] },
  };
  return { ...value, fingerprint: fingerprint(value) };
}

function request(target, overrides = {}) {
  const prompt = overrides.prompt || 'TOP-SECRET-PROMPT';
  const workerEnvelope = envelope(target, prompt);
  if (overrides.spendGrant) {
    workerEnvelope.budgets.maxCostNanodollars = overrides.spendGrant.maxCostNanodollars;
    delete workerEnvelope.fingerprint;
    workerEnvelope.fingerprint = fingerprint(workerEnvelope);
  }
  return {
    schema: 'agentx.harness-execution/v1', schemaVersion: 1, requestId: 'benchmark-cell-1', batchId: 'batch-1', batchFingerprint: BATCH_FINGERPRINT, role: 'candidate',
    target, envelope: workerEnvelope, input: { prompt }, parameters: { maxTokens: 10, timeoutMs: 5000 }, spendGrant: null,
    ...overrides,
  };
}

function spendGrant(target, overrides = {}) {
  const unsigned = {
    schema: 'agentx.spend-grant/v1', schemaVersion: 1, grantId: 'grant-paid-1', batchId: 'batch-1', batchFingerprint: BATCH_FINGERPRINT,
    targetFingerprints: [target.fingerprint], planFingerprint: null,
    maxCalls: 1, maxTokens: 16, maxCostNanodollars: 1000,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
  unsigned.targetFingerprints = [...unsigned.targetFingerprints].sort();
  unsigned.planFingerprint = fingerprint({
    batchId: unsigned.batchId, batchFingerprint: unsigned.batchFingerprint, targets: unsigned.targetFingerprints,
    maxCalls: unsigned.maxCalls, maxTokens: unsigned.maxTokens,
    maxCostNanodollars: unsigned.maxCostNanodollars,
  });
  return {
    ...unsigned,
    signature: crypto.createHmac('sha256', 'fixture-signing-key').update(JSON.stringify(unsigned)).digest('hex'),
  };
}

async function fixture(mode = 'success', targetOverrides = {}, executorOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-broker-test-'));
  const configPath = path.join(root, 'targets.json');
  const auditPath = path.join(root, 'audit.jsonl');
  const ledgerPath = path.join(root, 'ledger.jsonl');
  const homeRecord = path.join(root, 'homes.txt');
  const profilePath = path.join(root, 'profile.json');
  await fs.writeFile(profilePath, JSON.stringify({ mode: 'fixture-isolated', tools: false, memory: false }));
  const digest = async (filePath) => crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  const nodeDigest = await digest(process.execPath);
  const executorDigest = await digest(fixtureExecutor);
  const profileDigest = await digest(profilePath);
  const profileFingerprint = fingerprint([{ name: 'fixture-profile', sha256: profileDigest }]);
  const config = {
    schema: 'agentx.benchmark-harness-catalog/v1', broker: { name: 'fixture-broker', version: '1.0.0' },
    catalog: { observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    targets: [{
      target: rawTarget({
        ...targetOverrides,
        profile: { id: 'benchmark-isolated', version: '1', fingerprint: profileFingerprint, ...(targetOverrides.profile || {}) },
      }),
      attestations: { noMemory: true, noTools: true, noFallback: true, noFanOut: true, noDelivery: true, ephemeralSession: true },
      executor: {
        command: process.execPath, args: [fixtureExecutor, '--mode', mode], envAllowlist: ['FAKE_HOME_RECORD'],
        lock: `fixture-${mode}-${crypto.randomUUID()}`, capacity: 1, timeoutMs: 5000, maxOutputBytes: 4096,
        pins: {
          runtime: [
            { name: 'node', path: process.execPath, sha256: nodeDigest },
            { name: 'fixture-executor', path: fixtureExecutor, sha256: executorDigest },
          ],
          profile: [{ name: 'fixture-profile', path: profilePath, sha256: profileDigest }],
        },
        ...executorOverrides,
      },
    }],
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  process.env.FAKE_HOME_RECORD = homeRecord;
  const broker = createBroker({ configPath, auditPath, ledgerPath, signingKey: 'fixture-signing-key' });
  const catalog = await broker.catalog();
  return { root, configPath, auditPath, ledgerPath, homeRecord, broker, target: catalog.targets[0] };
}

async function cleanup(item) {
  delete process.env.FAKE_HOME_RECORD;
  if (item?.root) await fs.rm(item.root, { recursive: true, force: true });
}

test('catalog requires all isolated-model attestations', async () => {
  const item = await fixture();
  try {
    const config = JSON.parse(await fs.readFile(item.configPath, 'utf8'));
    config.targets[0].attestations.noTools = false;
    await fs.writeFile(item.configPath, JSON.stringify(config));
    await assert.rejects(loadCatalog(item.configPath), { code: 'INVALID_CATALOG' });
  } finally { await cleanup(item); }
});

for (const tier of ['local', 'free_cloud']) {
  test(`passes owned host claims to the local executor only (${tier})`, async () => {
    const item = await fixture('check-runtime-claims', tier === 'local' ? { tier, provider: 'ollama', pricing: null } : {});
    try {
      const result = await item.broker.execute(request(item.target, {
        runtimeClaims: [{ host: 'http://local:11434', claimBatchId: 'batch-1', claimGeneration: 'claim-1', workloadAdmissionId: 'workload-1', workloadGeneration: 'admission-1' }]
      }));
      assert.equal(result.output, 'bounded cloud answer');
    } finally { await cleanup(item); }
  });
}

test('catalog and execution fail closed when a pinned runtime or profile file drifts', async () => {
  const item = await fixture();
  try {
    const config = JSON.parse(await fs.readFile(item.configPath, 'utf8'));
    const profilePath = config.targets[0].executor.pins.profile[0].path;
    await fs.writeFile(profilePath, '{"changed":true}');
    await assert.rejects(item.broker.catalog(), { code: 'PIN_DRIFT' });
    await assert.rejects(item.broker.execute(request(item.target)), { code: 'PIN_DRIFT' });
    await assert.rejects(fs.access(item.homeRecord));
  } finally { await cleanup(item); }
});

test('available catalog fails closed after its declared freshness window', async () => {
  const item = await fixture();
  try {
    const config = JSON.parse(await fs.readFile(item.configPath, 'utf8'));
    config.catalog.observedAt = new Date(Date.now() - 120_000).toISOString();
    config.catalog.expiresAt = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(item.configPath, JSON.stringify(config));
    await assert.rejects(item.broker.catalog(), { code: 'CATALOG_STALE' });
    await assert.rejects(item.broker.execute(request(item.target)), { code: 'CATALOG_STALE' });
  } finally { await cleanup(item); }
});

test('local catalog reobserves pinned files without expiring its model selection', async () => {
  const item = await fixture('success', { tier: 'local', provider: 'ollama', pricing: null });
  try {
    const config = JSON.parse(await fs.readFile(item.configPath, 'utf8'));
    config.catalog = { observedAt: null, expiresAt: null };
    config.targets[0].executor.args.push('--config', config.targets[0].executor.pins.profile[0].path);
    await fs.writeFile(item.configPath, JSON.stringify(config));
    const catalog = await item.broker.catalog();
    assert.equal(catalog.targets[0].fingerprint, item.target.fingerprint);
    assert.ok(Date.parse(catalog.expiresAt) > Date.now());
    await fs.appendFile(config.targets[0].executor.pins.profile[0].path, ' ');
    await assert.rejects(item.broker.catalog(), { code: 'PIN_DRIFT' });
  } finally { await cleanup(item); }
});

test('executes exact target, emits a receipt, cleans the cell home, and audits metadata only', async () => {
  const item = await fixture();
  try {
    const result = await item.broker.execute(request(item.target));
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.output, 'bounded cloud answer');
    assert.equal(result.receipt.finalState, 'succeeded');
    assert.equal(result.receipt.identity.model.name, item.target.model);
    const homes = (await fs.readFile(item.homeRecord, 'utf8')).trim().split(/\r?\n/);
    assert.equal(homes.length, 1);
    await assert.rejects(fs.access(homes[0]));
    const audit = await fs.readFile(item.auditPath, 'utf8');
    assert.doesNotMatch(audit, /TOP-SECRET-PROMPT|fixture-signing-key|Authorization|OPENROUTER_API_KEY/);
    assert.match(audit, /receiptFingerprint/);
  } finally { await cleanup(item); }
});

test('preserves bounded thinking plus provider-reported cost and cache evidence', async () => {
  const item = await fixture('provider-reported', {
    id: 'paid-provider-receipt', tier: 'paid_cloud',
    pricing: {
      kind: 'manual_per_call', currency: 'USD', source: 'fixture',
      effectiveAt: '2026-09-02T00:00:00.000Z', inputNanodollarsPerMillion: 0,
      outputNanodollarsPerMillion: 0, cacheReadNanodollarsPerMillion: 0,
      cacheWriteNanodollarsPerMillion: 0, callNanodollars: 1000,
    },
  });
  try {
    const grant = spendGrant(item.target);
    const result = await item.broker.execute(request(item.target, { spendGrant: grant }));
    assert.equal(result.thinking, 'bounded reasoning');
    assert.equal(result.receipt.usage.costNanodollars, 750);
    assert.equal(result.receipt.usage.costSource, 'provider-reported');
    assert.equal(result.receipt.usage.cacheReadTokens, 2);
  } finally { await cleanup(item); }
});

for (const [mode, code] of [['fallback', 'FALLBACK_USED'], ['identity-drift', 'TARGET_DRIFT'], ['overflow', 'OUTPUT_LIMIT_EXCEEDED']]) {
  test(`fails closed on ${mode}`, async () => {
    const item = await fixture(mode);
    try { await assert.rejects(item.broker.execute(request(item.target)), { code }); }
    finally { await cleanup(item); }
  });
}

test('propagates hard timeout and cancellation', async () => {
  const timed = await fixture('sleep', {}, { timeoutMs: 50 });
  try { await assert.rejects(timed.broker.execute(request(timed.target, { parameters: { maxTokens: 10, timeoutMs: 50 } })), { code: 'EXECUTION_TIMEOUT' }); }
  finally { await cleanup(timed); }
  const cancelled = await fixture('sleep');
  try {
    const controller = new AbortController();
    const promise = cancelled.broker.execute(request(cancelled.target), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(promise, { code: 'EXECUTION_CANCELLED' });
  } finally { await cleanup(cancelled); }
});

test('cancellation stops the native executor descendants before removing the workspace', { skip: process.platform === 'win32' }, async () => {
  const item = await fixture('tree-sleep', {}, { envAllowlist: ['FAKE_HOME_RECORD', 'FAKE_CHILD_ACTIVITY'] });
  const activity = path.join(item.root, 'child-activity');
  process.env.FAKE_CHILD_ACTIVITY = activity;
  const controller = new AbortController();
  const execution = item.broker.execute(request(item.target), { signal: controller.signal });
  const rejected = assert.rejects(execution, { code: 'EXECUTION_CANCELLED' });
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try { await fs.access(activity); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await fs.access(activity);
    controller.abort();
    await rejected;
    const stoppedAt = await fs.readFile(activity, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await fs.readFile(activity, 'utf8'), stoppedAt);
  } finally { controller.abort(); await rejected; delete process.env.FAKE_CHILD_ACTIVITY; await cleanup(item); }
});

test('enforces capacity lock across concurrent cells', async () => {
  const item = await fixture('locked');
  try {
    const started = Date.now();
    await Promise.all([item.broker.execute(request(item.target)), item.broker.execute(request(item.target))]);
    assert.ok(Date.now() - started >= 450, 'capacity=1 must serialize the two 250ms executors');
  } finally { await cleanup(item); }
});

test('SpendGrant is signed, batch-bound, plan-bound, and target-bound', () => {
  const target = normalizeTarget(rawTarget({
    id: 'paid-target', tier: 'paid_cloud',
    pricing: { kind: 'manual_per_call', currency: 'USD', source: 'fixture', effectiveAt: '2026-08-31T00:00:00.000Z', inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 1000 },
  }));
  const unsigned = {
    schema: 'agentx.spend-grant/v1', schemaVersion: 1, grantId: 'grant-1', batchId: 'batch-1', batchFingerprint: BATCH_FINGERPRINT, targetFingerprints: [target.fingerprint],
    planFingerprint: null, maxCalls: 1, maxTokens: 20, maxCostNanodollars: 1000,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  unsigned.planFingerprint = fingerprint({ batchId: unsigned.batchId, batchFingerprint: unsigned.batchFingerprint, targets: unsigned.targetFingerprints, maxCalls: 1, maxTokens: 20, maxCostNanodollars: 1000 });
  const grant = { ...unsigned, signature: crypto.createHmac('sha256', 'key').update(JSON.stringify(unsigned)).digest('hex') };
  assert.equal(verifySpendGrant(grant, target, { batchId: 'batch-1', batchFingerprint: BATCH_FINGERPRINT }, 'key').grantId, 'grant-1');
  assert.throws(() => verifySpendGrant(grant, target, { batchId: 'different', batchFingerprint: BATCH_FINGERPRINT }, 'key'), { code: 'SPEND_GRANT_BATCH_MISMATCH' });
  assert.throws(() => verifySpendGrant({ ...grant, planFingerprint: HEX('f') }, target, { batchId: 'batch-1' }, 'key'), { code: 'SPEND_GRANT_INVALID' });
});

test('OpenRouter executor failures expose only a bounded safe category', () => {
  assert.equal(
    sanitizeOpenRouterExecutorFailure('OpenRouter chat completion HTTP 400\n'),
    'OPENROUTER_CHAT_COMPLETION_HTTP_400'
  );
  assert.equal(
    sanitizeOpenRouterExecutorFailure('sensitive provider body that must never escape\n'),
    'OPENROUTER_EXECUTOR_REJECTED'
  );
});

test('broker alone issues the exact approved SpendGrant without exposing its signing key', async () => {
  const item = await fixture('success', {
    id: 'paid-target', tier: 'paid_cloud',
    pricing: { kind: 'manual_per_call', currency: 'USD', source: 'fixture', effectiveAt: '2026-08-31T00:00:00.000Z', inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 1000 },
  });
  try {
    const grant = await item.broker.issueSpendGrant({
      schema: 'agentx.spend-grant-request/v1', schemaVersion: 1, batchId: 'batch-1', batchFingerprint: BATCH_FINGERPRINT,
      units: [{ targetId: item.target.id, targetFingerprint: item.target.fingerprint, calls: 2, inputTokensPerCall: 10, outputTokensPerCall: 20 }],
      approval: { confirmed: true, maxCalls: 2, maxTokens: 60, maxCostNanodollars: 2000 },
    });
    assert.equal(grant.maxCalls, 2);
    assert.equal(grant.maxTokens, 60);
    assert.equal(grant.maxCostNanodollars, 2000);
    assert.equal(verifySpendGrant(grant, item.target, { batchId: 'batch-1', batchFingerprint: BATCH_FINGERPRINT }, 'fixture-signing-key').grantId, grant.grantId);
    const audit = await fs.readFile(item.auditPath, 'utf8');
    assert.doesNotMatch(audit, /fixture-signing-key/);
    assert.match(audit, /spend_grant_issued/);
    await assert.rejects(item.broker.issueSpendGrant({
      schema: 'agentx.spend-grant-request/v1', schemaVersion: 1, batchId: 'batch-1', batchFingerprint: BATCH_FINGERPRINT,
      units: [{ targetId: item.target.id, targetFingerprint: item.target.fingerprint, calls: 2, inputTokensPerCall: 10, outputTokensPerCall: 20 }],
      approval: { confirmed: true, maxCalls: 1, maxTokens: 60, maxCostNanodollars: 2000 },
    }), { code: 'PAID_APPROVAL_TOO_LOW' });
  } finally { await cleanup(item); }
});

test('paid execution is refused before spawn and concurrent replay cannot exceed a one-call grant', async () => {
  const item = await fixture('success', {
    id: 'paid-target', tier: 'paid_cloud',
    pricing: { kind: 'manual_per_call', currency: 'USD', source: 'fixture', effectiveAt: '2026-08-31T00:00:00.000Z', inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 1000 },
  });
  try {
    await assert.rejects(item.broker.execute(request(item.target)), { code: 'SPEND_GRANT_REQUIRED' });
    await assert.rejects(fs.access(item.homeRecord));

    const grant = spendGrant(item.target);
    const outcomes = await Promise.allSettled([
      item.broker.execute(request(item.target, { spendGrant: grant })),
      item.broker.execute(request(item.target, { spendGrant: grant })),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.equal(rejection.reason.code, 'SPEND_GRANT_EXHAUSTED');
    const homes = (await fs.readFile(item.homeRecord, 'utf8')).trim().split(/\r?\n/);
    assert.equal(homes.length, 1);
  } finally { await cleanup(item); }
});

test('HTTP surface serves the trusted LAN without an internal service token', async () => {
  const server = createServer({ broker: {
    catalog: async () => ({ targets: [], observedAt: new Date().toISOString(), broker: {} }),
    issueSpendGrant: async (request) => ({ schema: 'agentx.spend-grant/v1', batchId: request.batchId }),
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/benchmark/targets`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.targets, []);
    const issued = await fetch(`http://127.0.0.1:${address.port}/v1/benchmark/spend-grants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: 'batch-http' }),
    });
    assert.equal(issued.status, 201);
    assert.equal((await issued.json()).data.batchId, 'batch-http');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});


test('a failed repository verifier produces a failed receipt with its measured usage and test evidence', () => {
  const { buildReceipt } = require('../contract');
  const target = normalizeTarget(rawTarget(), fingerprint('catalog'));
  const workerEnvelope = envelope(target);
  const receipt = buildReceipt({ envelope: workerEnvelope, target,
    actual: { providerVersion: 'api', environmentId: target.profile.id, environmentVersion: target.profile.version,
      environmentFingerprint: target.profile.fingerprint, runtimeFingerprint: 'a'.repeat(64) },
    usage: { durationMs: 20, inputTokens: 12, outputTokens: 7, turns: 1, toolCalls: 0 }, output: 'patch failed',
    contractSatisfied: false, evidence: { patches: [], artifacts: [], tests: [{ id: 'repo-fixture.test', status: 'failed', digest: 'b'.repeat(64) }] } });
  assert.equal(receipt.finalState, 'failed');
  assert.equal(receipt.result.contractSatisfied, false);
  assert.equal(receipt.failure.code, 'REPO_FIXTURE_VERIFICATION_FAILED');
  assert.equal(receipt.usage.totalTokens, 19);
  assert.equal(receipt.evidence.tests[0].status, 'failed');
});

test('expired cloud entries do not disable freshly pinned local targets in a mixed catalog', async () => {
  const item = await fixture();
  try {
    const config = JSON.parse(await fs.readFile(item.configPath, 'utf8'));
    const localTarget = require('../contract').normalizeTarget({ ...config.targets[0].target, id: 'local-preserved', tier: 'local', provider: 'ollama', pricing: null });
    config.targets.push({ ...config.targets[0], target: localTarget });
    config.catalog.observedAt = new Date(Date.now() - 120000).toISOString();
    config.catalog.expiresAt = new Date(Date.now() - 60000).toISOString();
    await fs.writeFile(item.configPath, JSON.stringify(config));
    const result = await item.broker.catalog();
    assert.equal(result.targets.find(target => target.id === 'local-preserved').fingerprint, localTarget.fingerprint);
    assert.equal(result.targets.find(target => target.id === item.target.id).available, false);
    assert.ok(Date.parse(result.expiresAt) > Date.now());
  } finally { await cleanup(item); }
});
