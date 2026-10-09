'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { materialize } = require('../materialize-openclaw-model-catalog');
const { execute } = require('../executors/openclaw-model-executor');
const { normalizeBenchmarkTarget } = require('../../../shared/benchmarkTargetContract');
const { fingerprint } = require('../contract');
const descriptor = { model: 'openrouter/fixture/model', name: 'Fixture', contextWindow: 8192, fingerprint: 'a'.repeat(64), maxTokens: 1024,
  origin: 'cloud', billing: { kind: 'free', source: 'native', rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  modelVersion: 'unknown', isolation: { singleCallQualified: true, providerRouting: true } };
const catalogue = () => ({ runtimeVersion: '2026.9.4', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), models: [descriptor], agents: [] });

test('catalog projection consumes native models, keeps billing distinct and never reads provider credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true })); const output = path.join(directory, 'catalog.json');
  const data = catalogue(); data.models.push({ ...descriptor, model: 'openai/included', billing: { kind: 'included' } });
  const summary = await materialize({ output, client: { catalog: async () => data } });
  assert.equal(summary.targets.length, 2);
  const catalog = JSON.parse(await readFile(output));
  for (const entry of catalog.targets) {
    assert.equal(normalizeBenchmarkTarget(entry.target).fingerprint, entry.target.fingerprint);
    assert.deepEqual(entry.executor.envAllowlist, ['OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN']);
    assert.equal(entry.target.mode, 'isolated_model'); assert.equal(entry.target.modelVersion, 'unknown');
    assert.equal(entry.target.capabilities.judge, false);
  }
  assert.equal(catalog.targets[1].target.billing, 'included');
});

test('raw executor submits one user prompt, preserves cache evidence and rejects an agent result', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-executor-'));
  t.after(() => rm(directory, { recursive: true, force: true })); const output = path.join(directory, 'catalog.json');
  await materialize({ output, client: { catalog: async () => catalogue() } });
  const entry = JSON.parse(await readFile(output)).targets[0], profile = JSON.parse(await readFile(entry.executor.args[2]));
  const input = { target: entry.target, envelope: { task: { id: 'turn' }, fingerprint: 'e'.repeat(64), prompt: { fingerprint: fingerprint('prompt') },
    tools: { allowed: [] }, budgets: { maxCostNanodollars: 0 } }, parameters: { maxTokens: 64, thinking: false }, input: { prompt: 'prompt' } };
  let mode = 'model', calls = 0;
  const client = { catalog: async () => catalogue(), execute: async request => {
    calls++; assert.deepEqual(request.messages, [{ role: 'user', content: 'prompt' }]);
    return { text: 'answer', finishReason: 'stop', receipt: { mode, runtimeVersion: '2026.9.4', targetFingerprint: descriptor.fingerprint,
      observed: { provider: 'openrouter', model: 'fixture/model', modelVersion: 'unknown' }, durationMs: 4, billing: descriptor.billing,
      contextFingerprint: 'b'.repeat(64), payloadFingerprint: 'c'.repeat(64), usage: { input: 5, output: 2, cacheRead: 3, cacheWrite: 0, total: 10 },
      isolation: { noMemory: true, noAgentPrompt: true, noTools: true, noRuntimeFallback: true, modelCalls: 1, toolsExecuted: 0,
        providerRouting: { only: ['fixture'], allow_fallbacks: false } } } };
  } };
  const result = await execute(input, profile, client); assert.equal(result.usage.inputTokens, 8);
  assert.equal(result.execution.upstreamProvider, null); assert.equal(result.usage.cacheReadTokens, 3);
  mode = 'agent'; await assert.rejects(execute(input, profile, client), /TARGET_DRIFT/); assert.equal(calls, 2);
});


test('catalog refresh retains immutable prior profiles and gates paid targets with the native ceiling', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-refresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'catalog.json'), data = catalogue();
  data.models[0] = { ...descriptor, parameterSupport: { seed: true, jsonResponseFormat: true } };
  data.models.push({ ...descriptor, model: 'fixture/paid', billing: { kind: 'paid', rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });
  await materialize({ output, client: { catalog: async () => data } });
  const prior = JSON.parse(await readFile(output));
  const priorPath = prior.targets[0].executor.args[2], priorBytes = await readFile(priorPath);
  assert.equal(prior.targets[0].target.capabilities.judge, true);
  assert.equal(prior.targets[1].target.available, false);
  data.observedAt = new Date(Date.parse(data.observedAt) + 1).toISOString();
  data.policy = { maxRequestCostNanodollars: 1000000 };
  await materialize({ output, existingCatalogPath: output, client: { catalog: async () => data } });
  const next = JSON.parse(await readFile(output));
  assert.equal(next.targets.length, 2);
  assert.notEqual(next.targets[0].executor.args[2], priorPath);
  assert.deepEqual(await readFile(priorPath), priorBytes);
  assert.equal(next.targets[1].target.available, true);
});
