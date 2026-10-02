'use strict';

const { readFile, writeFile, readdir, realpath, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { fingerprint, normalizeTarget } = require('./contract');
const { ADAPTER_VERSION } = require('./executors/openclaw-executor');

async function materialize({ openclaw, output, profilePath, additionalProfilePaths = [] }) {
  if (![openclaw, output, profilePath, ...additionalProfilePaths].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('Explicit absolute OpenClaw, output and instance profile paths are required');
  }
  const entryPath = await realpath(openclaw);
  const packageRoot = path.dirname(entryPath);
  const packagePath = path.join(packageRoot, 'package.json');
  const runtimeVersion = JSON.parse(await readFile(packagePath, 'utf8')).version;
  const dist = path.join(packageRoot, 'dist');
  const files = await readdir(dist);
  const modulePath = (prefix) => {
    const matches = files.filter((name) => name.startsWith(prefix) && /\.m?js$/.test(name));
    if (matches.length !== 1) throw new Error(`OpenClaw installation must contain exactly one ${prefix} module`);
    return path.join(dist, matches[0]);
  };
  const codingPath = modulePath('core-coding-tools-');
  const execPath = modulePath('agent-exec-');
  const coding = await import(pathToFileURL(codingPath));
  const entries = [];
  for (const selectedProfilePath of [profilePath, ...additionalProfilePaths]) {
    const profile = JSON.parse(await readFile(selectedProfilePath, 'utf8'));
    const agentId = profile.agents?.defaults?.systemAgent?.agentId;
    const selection = (agentId ? profile.agents.entries?.[agentId]?.model : profile.agents?.defaults?.model)?.primary;
    const slash = selection?.indexOf('/');
    if (!(slash > 0)) throw new Error('OpenClaw profile must select an explicit primary model');
    const provider = selection.slice(0, slash);
    const modelId = selection.slice(slash + 1);
    const providerConfig = profile.models?.providers?.[provider];
    const model = providerConfig?.models?.find(entry => entry.id === modelId);
    if (!model) throw new Error('OpenClaw profile does not declare its selected model');
    const subscription = provider === 'openai' && (model.api || providerConfig.api) === 'openai-chatgpt-responses';
    if (provider !== 'ollama' && !subscription) throw new Error('OpenClaw cloud profile needs an explicit supported billing policy');
    if (subscription && !agentId) throw new Error('ChatGPT subscription profile must select its auth-owning agent');
    const targetId = agentId ? `openclaw-${agentId}` : 'openclaw-local';
    // Read actual schemas from the installed version; no synthetic tool definitions.
    const tools = coding.t({ includeBaseCodingTools: true, includeShellTools: false,
      codingRoot: path.dirname(output), containmentRoot: path.dirname(output), workspaceOnly: true,
      modelContextWindowTokens: model.contextWindow });
    const allowed = profile.tools.allow;
    if (allowed.some((name) => !tools.some((tool) => tool.name === name))) throw new Error('OpenClaw tool schemas differ from the pinned profile');
    const pin = async (name, file) => ({ name, path: await realpath(file), sha256: crypto.createHash('sha256').update(await readFile(file)).digest('hex') });
    const profilePins = [await pin('openclaw-native-profile', selectedProfilePath)];
    const runtimePins = await Promise.all([
      pin('node', process.execPath), pin('openclaw-entry', entryPath), pin('openclaw-package', packagePath),
      pin('openclaw-agent-exec', execPath), pin('openclaw-coding-tools', codingPath),
      pin('openclaw-executor', path.join(__dirname, 'executors/openclaw-executor.js')),
      pin('broker-contract', path.join(__dirname, 'contract.js'))
    ]);
    const target = normalizeTarget({
      id: targetId, label: `OpenClaw${agentId ? ` / ${agentId}` : ''} · ${model.name}`, mode: 'native_agent', tier: subscription ? 'free_cloud' : 'local',
      provider, model: model.id, modelVersion: model.id,
      harness: { name: 'openclaw', version: runtimeVersion }, adapter: { name: 'openclaw-benchmark', version: ADAPTER_VERSION },
      profile: { id: agentId ? targetId : 'openclaw-native', version: '1', fingerprint: fingerprint(profilePins.map(({ name, sha256 }) => ({ name, sha256 }))) },
      api: { name: 'openclaw-agent-exec', version: runtimeVersion }, contextWindow: model.contextWindow,
      capabilities: { candidate: true, judge: false },
      pricing: subscription ? { kind: 'free', currency: 'USD', source: 'chatgpt-subscription-included-usage-not-total-subscription-cost' } : null,
      available: true, observedAt: null,
      catalogFingerprint: fingerprint({ runtimeVersion, model, profile }),
      nativePolicy: {
        tools: tools.filter((tool) => allowed.includes(tool.name)).map((tool) => ({ name: tool.name, version: runtimeVersion, schemaFingerprint: fingerprint(tool.parameters) })),
        filesystemMode: 'workspace_write', allowedOperations: ['read', 'create', 'update'],
        networkDestinations: [provider], maxTurns: 20, maxToolCalls: 40
      }
    });
    entries.push({ target, attestations: { ephemeralSession: true }, executor: {
      command: process.execPath,
      args: [path.join(__dirname, 'executors/openclaw-executor.js'), '--openclaw', entryPath, '--config', await realpath(selectedProfilePath)],
      envAllowlist: ['OPENCLAW_RUNTIME_VERSION'], lock: targetId, capacity: 1, timeoutMs: 600000, maxOutputBytes: 2000000,
      pins: { runtime: runtimePins, profile: profilePins }
    } });
  }
  const cloud = entries.some(entry => entry.target.tier !== 'local');
  const catalog = {
    schema: 'agentx.benchmark-harness-catalog/v1', broker: { name: 'aiops-benchmark-harness-broker', version: '1.1.0' },
    catalog: { observedAt: cloud ? new Date().toISOString() : null, expiresAt: cloud ? new Date(Date.now() + 48 * 3600000).toISOString() : null }, targets: entries
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 });
  return { runtimeVersion, targetId: entries[0].target.id, targetIds: entries.map(entry => entry.target.id), output };
}

if (require.main === module) {
  const [openclaw, output, profilePath, ...additionalProfilePaths] = process.argv.slice(2);
  if (!openclaw || !output || !profilePath) throw new Error('usage: node materialize-openclaw-catalog.js /absolute/openclaw /absolute/targets.json /absolute/profile.json [additional profiles...]');
  materialize({ openclaw, output, profilePath, additionalProfilePaths }).then((result) => process.stdout.write(JSON.stringify(result) + '\n')).catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
module.exports = { materialize };
