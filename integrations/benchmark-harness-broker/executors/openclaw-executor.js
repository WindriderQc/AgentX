'use strict';

const { spawn } = require('node:child_process');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { fingerprint: hash } = require('../contract');
const ADAPTER_VERSION = '2.3.0';
const { fixtureForEnvelope, stageFixture, verifyFixture } = require('../repoFixture');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) result[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  if (!result.openclaw || !result.config) throw new Error('--openclaw and --config are required');
  return result;
}

function invocationConfig(profile, input) {
  const config = structuredClone(profile);
  const target = input.target;
  const key = `${target.provider}/${target.model}`;
  const model = config.models?.providers?.[target.provider]?.models?.find((entry) => entry.id === target.model);
  if (!model) throw new Error('pinned profile does not contain the selected model');
  const parameters = input.parameters;
  const provider = config.models.providers[target.provider];
  provider.headers = { ...provider.headers };
  delete provider.headers['x-agentx-benchmark-claims'];
  if (target.provider === 'ollama' && input.runtimeClaims?.length) {
    provider.headers['x-agentx-benchmark-claims'] = JSON.stringify(input.runtimeClaims);
  }
  model.maxTokens = parameters.maxTokens;
  config.agents.defaults.model = { primary: key, fallbacks: [] };
  const agentId = config.agents.defaults.systemAgent?.agentId;
  if (agentId) {
    const agent = config.agents.entries?.[agentId];
    if (!agent) throw new Error('pinned profile does not contain the selected agent');
    agent.model = { primary: key, fallbacks: [] };
  }
  const modelSettings = config.agents.defaults.models || {};
  config.agents.defaults.models = { ...modelSettings,
    [key]: { ...modelSettings[key], params: { ...modelSettings[key]?.params,
      maxTokens: parameters.maxTokens, temperature: parameters.temperature, topP: parameters.topP, seed: parameters.seed } }
  };
  return config;
}

function parseResult(body, input, durationMs, env = process.env) {
  const target = input.target;
  if (target.mode !== 'native_agent') throw new Error('agent exec cannot attest an isolated model result');
  if (body.ok !== true || body.status !== 'ok') throw new Error(`OpenClaw execution ${body.status || 'failed'}`);
  if (body.provider !== target.provider || body.model !== target.model) throw new Error('OpenClaw returned a different provider or model');
  const output = typeof body.final === 'string' ? body.final : '';
  if (!output.trim()) throw new Error('OpenClaw returned no visible answer');
  const count = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`OpenClaw did not report valid ${label}`);
    return value;
  };
  const cacheRead = body.usage?.cacheRead == null ? null : count(body.usage.cacheRead, 'cached input tokens');
  const cacheWrite = body.usage?.cacheWrite == null ? null : count(body.usage.cacheWrite, 'cache write tokens');
  const inputTokens = count(body.usage?.input, 'input tokens') + (cacheRead || 0) + (cacheWrite || 0);
  const outputTokens = count(body.usage?.output, 'output tokens');
  const turns = count(body.assistantTurns, 'model turns');
  // agent exec omits the summary for a single assistant turn without tool activity.
  const toolCalls = count(body.toolSummary?.calls ?? (turns === 1 ? 0 : undefined), 'tool calls');
  return {
    requestFingerprint: hash({ targetFingerprint: target.fingerprint, envelopeFingerprint: input.envelope.fingerprint, promptFingerprint: input.envelope.prompt.fingerprint }),
    responseFingerprint: hash(output), output, thinking: null, finishReason: null,
    // agent exec uses an explicit model, an empty fallback list and no --fallback flags.
    fallbackUsed: false,
    actual: {
      provider: body.provider, providerVersion: 'openclaw-provider-api',
      model: body.model, modelVersion: 'unknown',
      harnessVersion: env.OPENCLAW_RUNTIME_VERSION, adapterVersion: ADAPTER_VERSION,
      environmentId: target.profile.id, environmentVersion: target.profile.version,
      environmentFingerprint: env.AGENTX_OBSERVED_PROFILE_FINGERPRINT || null,
      runtimeFingerprint: env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT || null, modelDigest: null
    },
    usage: { durationMs, inputTokens, outputTokens, turns, toolCalls,
      ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}), ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}) }
  };
}

async function execute(input, fixed, run = spawn) {
  if (input.target.tier === 'paid_cloud') throw new Error('OPENCLAW_NATIVE_AGENT_BUDGET_UNQUALIFIED');
  const runtimeVersion = String(process.env.OPENCLAW_RUNTIME_VERSION || '');
  if (!runtimeVersion || runtimeVersion !== input.target.harness.version) throw new Error('OPENCLAW_RUNTIME_VERSION does not match the catalog target');
  const config = invocationConfig(JSON.parse(await readFile(fixed.config, 'utf8')), input);
  // The broker owns this temporary home. The agent sees only its work subfolder.
  const configPath = path.resolve('invocation.json');
  const workspace = path.resolve('work');
  await mkdir(workspace);
  const fixture = fixtureForEnvelope(input.envelope);
  if (fixture && input.target.mode !== 'native_agent') throw new Error('Repository fixtures require native_agent');
  const staged = fixture ? stageFixture(fixture, workspace) : null;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const args = ['agent', 'exec', '--config', configPath, '--cwd', workspace,
    '--model', `${input.target.provider}/${input.target.model}`, '--message-file', '-',
    '--thinking', input.parameters.thinking ? 'low' : 'off', '--code-mode', 'direct',
    '--json', '--timeout', String(Math.max(1, Math.ceil(input.parameters.timeoutMs / 1000)))];
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = run(fixed.openclaw, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { child.kill('SIGKILL'); reject(new Error('OpenClaw output exceeded the result limit')); }
      else stdout.push(chunk);
    });
    // Diagnostics can contain prompt text. Do not copy them into persisted errors.
    child.stderr.resume();
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8') }));
    child.stdin.end(String(input.input?.prompt || ''));
  });
  if (result.code !== 0) throw new Error(`OpenClaw exited ${result.code}`);
  const parsed = parseResult(JSON.parse(result.stdout), input, Date.now() - started);
  if (staged) Object.assign(parsed, verifyFixture(staged, { model: input.target.model,
    timeoutMs: Math.min(30_000, input.parameters.timeoutMs) }));
  parsed.usage.durationMs = Date.now() - started;
  return parsed;
}

async function main() {
  const fixed = parseArgs(process.argv.slice(2));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify(await execute(input, fixed)));
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { ADAPTER_VERSION, execute, invocationConfig, parseArgs, parseResult };
