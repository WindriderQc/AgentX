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
  assert.equal(receipt.actual.modelVersion, 'qwen');
  assert.equal(receipt.output, 'Read back: 42');
  assert.equal(parseResult({ ...result(), assistantTurns: 1, toolSummary: undefined }, input, 10).usage.toolCalls, 0);
});

test('empty answers, errors, model drift and absent usage cannot become successful zero-cost results', () => {
  for (const override of [ { final: '  ' }, { ok: false }, { provider: 'cloud' }, { model: 'fallback' }, { usage: null }, { assistantTurns: undefined }, { toolSummary: undefined } ]) {
    assert.throws(() => parseResult({ ...result(), ...override }, input, 10));
  }
  assert.throws(() => parseResult(result(), { ...input, target: { ...input.target, mode: 'isolated_model' } }, 10), /tool activity/);
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

test('native execution stages a pinned fixture and verifies the resulting edit', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { PassThrough } = require('node:stream'), { EventEmitter } = require('node:events');
  const { execute } = require('../executors/openclaw-executor');
  const task = require('../../../benchmark/src/services/qualification/repoTaskFixtures').loadRepoTasks().find(item => item.id === 'sum-sign');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-native-executor-')), previous = process.cwd();
  const oldVersion = process.env.OPENCLAW_RUNTIME_VERSION;
  try {
    process.chdir(dir); process.env.OPENCLAW_RUNTIME_VERSION = 'fixture-runtime';
    fs.writeFileSync('profile.json', JSON.stringify({ models: { providers: { ollama: { models: [{ id: 'qwen' }] } } }, agents: { defaults: {} } }));
    const invocation = { ...input, target: { ...input.target, harness: { version: 'fixture-runtime' } },
      input: { prompt: task.instructions }, parameters: { ...input.parameters, timeoutMs: 30000 },
      envelope: { ...input.envelope, selection: { model: { constraints: [`repo-fixture:${task.id}:${task.fixtureFingerprint}`] } } } };
    const spawn = (_command, argv) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.stdin.on('finish', () => {
        const work = argv[argv.indexOf('--cwd') + 1];
        assert.equal(fs.existsSync(path.join(work, 'test/hidden.js')), false);
        assert.match(fs.readFileSync(path.join(work, 'src/sum.js'), 'utf8'), /a - b/);
        fs.writeFileSync(path.join(work, 'src/sum.js'), 'module.exports = (a, b) => a + b;\n');
        child.stdout.write(JSON.stringify(result())); child.stdout.end(); child.emit('close', 0);
      });
      return child;
    };
    const receipt = await execute(invocation, { config: path.join(dir, 'profile.json'), openclaw: 'synthetic' }, spawn);
    assert.equal(receipt.contractSatisfied, true); assert.equal(receipt.evidence.tests[0].status, 'passed');
    assert.equal(receipt.evidence.artifacts[0].digest, task.fixtureFingerprint); assert.equal(receipt.usage.toolCalls, 2);
  } finally {
    process.chdir(previous);
    if (oldVersion === undefined) delete process.env.OPENCLAW_RUNTIME_VERSION; else process.env.OPENCLAW_RUNTIME_VERSION = oldVersion;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
