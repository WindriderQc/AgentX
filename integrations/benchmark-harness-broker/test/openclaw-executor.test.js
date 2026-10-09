'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { invocationConfig, parseResult } = require('../executors/openclaw-executor');

const input = {
  target: { provider: 'ollama', model: 'qwen', mode: 'native_agent', fingerprint: 'target', profile: { id: 'native', version: '1' } },
  envelope: { fingerprint: 'envelope', prompt: { fingerprint: 'prompt' } },
  parameters: { maxTokens: 512, temperature: 0, topP: 0.9, seed: 42 }
};
const result = () => ({ ok: true, status: 'ok', final: 'Read back: 42', provider: 'ollama', model: 'qwen', usage: { input: 3012, output: 64 }, assistantTurns: 3, toolSummary: { calls: 2, tools: ['write', 'read'] } });

test('native receipt preserves total multi-turn usage and observed tool calls', () => {
  const receipt = parseResult(result(), input, 3500, { OPENCLAW_RUNTIME_VERSION: '2026.8.2' });
  assert.deepEqual(receipt.usage, { durationMs: 3500, inputTokens: 3012, outputTokens: 64, turns: 3, toolCalls: 2 });
  assert.equal(receipt.actual.modelDigest, null);
  assert.equal(receipt.actual.modelVersion, 'unknown');
  assert.equal(receipt.output, 'Read back: 42');
  assert.equal(parseResult({ ...result(), assistantTurns: 1, toolSummary: undefined }, input, 10).usage.toolCalls, 0);
});

test('empty answers, errors, model drift and absent usage cannot become successful zero-cost results', () => {
  for (const override of [ { final: '  ' }, { ok: false }, { provider: 'cloud' }, { model: 'fallback' }, { usage: null }, { assistantTurns: undefined }, { toolSummary: undefined } ]) {
    assert.throws(() => parseResult({ ...result(), ...override }, input, 10));
  }
  assert.throws(() => parseResult(result(), { ...input, target: { ...input.target, mode: 'isolated_model' } }, 10), /cannot attest an isolated/);
});

test('each invocation applies Benchmark parameters without mutating the pinned profile', () => {
  const profile = { models: { providers: { ollama: { models: [{ id: 'qwen', maxTokens: 32000 }] } } }, agents: { defaults: { model: { primary: 'cloud/fallback' } } } };
  const config = invocationConfig(profile, input);
  assert.deepEqual(config.agents.defaults.model, { primary: 'ollama/qwen', fallbacks: [] });
  assert.deepEqual(config.agents.defaults.models['ollama/qwen'].params, input.parameters);
  assert.equal(config.models.providers.ollama.models[0].maxTokens, 512);
  assert.equal(profile.models.providers.ollama.models[0].maxTokens, 32000);
  assert.throws(() => invocationConfig(profile, { ...input, target: { ...input.target, model: 'unknown' } }), /selected model/);
  const claims = [{ host: 'http://model.test:11434', claimBatchId: 'batch', claimGeneration: 'claim',
    workloadAdmissionId: 'admission', workloadGeneration: 'workload' }];
  const claimed = invocationConfig(profile, { ...input, runtimeClaims: claims });
  assert.deepEqual(JSON.parse(claimed.models.providers.ollama.headers['x-agentx-benchmark-claims']), claims);
  assert.equal(profile.models.providers.ollama.headers, undefined);
  assert.equal(invocationConfig(claimed, input).models.providers.ollama.headers['x-agentx-benchmark-claims'], undefined);
});

test('a named agent keeps its native auth reference but cannot retain personal fallbacks', () => {
  const profile = {
    models: { providers: { openai: { models: [{ id: 'sol', maxTokens: 32000 }] } } },
    agents: { defaults: { systemAgent: { agentId: 'cloudx' } }, entries: {
      cloudx: { agentDir: '/private/cloudx/agent', model: { primary: 'openai/sol', fallbacks: ['ollama/qwen'] } }
    } }
  };
  const selected = { ...input, target: { ...input.target, provider: 'openai', model: 'sol' } };
  const config = invocationConfig(profile, selected);
  assert.equal(config.agents.defaults.systemAgent.agentId, 'cloudx');
  assert.equal(config.agents.entries.cloudx.agentDir, '/private/cloudx/agent');
  assert.deepEqual(config.agents.entries.cloudx.model, { primary: 'openai/sol', fallbacks: [] });
  assert.deepEqual(profile.agents.entries.cloudx.model.fallbacks, ['ollama/qwen']);
  assert.equal(config.models.providers.openai.headers['x-agentx-benchmark-claims'], undefined);
  delete profile.agents.entries.cloudx;
  assert.throws(() => invocationConfig(profile, selected), /selected agent/);
});

test('unqualified native execution refuses a repository fixture before staging or starting it', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execute } = require('../executors/openclaw-executor');
  const task = require('../../../benchmark/src/services/qualification/repoTaskFixtures').loadRepoTasks().find(item => item.id === 'sum-sign');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-native-executor-')), previous = process.cwd();
  const oldVersion = process.env.OPENCLAW_RUNTIME_VERSION;
  try {
    process.chdir(dir); process.env.OPENCLAW_RUNTIME_VERSION = 'fixture-runtime';
    const profile = JSON.stringify({ models: { providers: { ollama: { models: [{ id: 'qwen' }] } } }, agents: { defaults: {} } });
    fs.writeFileSync('profile.json', profile);
    const invocation = { ...input, target: { ...input.target, tier: 'local', harness: { version: 'fixture-runtime' } },
      input: { prompt: task.instructions }, parameters: { ...input.parameters, timeoutMs: 30000 },
      envelope: { ...input.envelope, budgets: { maxTurns: 2, maxToolCalls: 1 },
        selection: { model: { constraints: [`repo-fixture:${task.id}:${task.fixtureFingerprint}`] } } } };
    let starts = 0;
    await assert.rejects(execute(invocation, { config: path.join(dir, 'profile.json'), openclaw: 'unused' },
      () => { starts++; throw new Error('native process must not start'); }), /OPENCLAW_NATIVE_AGENT_BUDGET_UNQUALIFIED/);
    assert.equal(starts, 0);
    assert.equal(fs.existsSync('work'), false);
    assert.equal(fs.existsSync('invocation.json'), false);
    assert.equal(fs.readFileSync('profile.json', 'utf8'), profile);
  } finally {
    process.chdir(previous);
    if (oldVersion === undefined) delete process.env.OPENCLAW_RUNTIME_VERSION; else process.env.OPENCLAW_RUNTIME_VERSION = oldVersion;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent with no tool calls still cannot become an isolated model', () => {
  assert.throws(() => parseResult({ ...result(), assistantTurns: 1, toolSummary: undefined },
    { ...input, target: { ...input.target, mode: 'isolated_model' } }, 10), /cannot attest an isolated/);
});

test('native invocation preserves configured provider routing policy', () => {
  const profile = { models: { providers: { ollama: { models: [{ id: 'qwen' }] } } },
    agents: { defaults: { models: { 'ollama/qwen': { params: { provider: { only: ['fixed'], allow_fallbacks: false } } }, other: { alias: 'kept' } } } } };
  const config = invocationConfig(profile, input);
  assert.deepEqual(config.agents.defaults.models['ollama/qwen'].params.provider, { only: ['fixed'], allow_fallbacks: false });
  assert.equal(config.agents.defaults.models.other.alias, 'kept');
});
