'use strict';

const { mkdir, readFile, writeFile, realpath, rename } = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createOpenClawExecutionClient } = require('../../shared/openclawExecutionClient');
const { fingerprint, normalizeTarget } = require('./contract');
const { ADAPTER_VERSION } = require('./executors/openclaw-model-executor');

async function materialize({ output, existingCatalogPath, client = createOpenClawExecutionClient() }) {
  if (!path.isAbsolute(output || '')) throw new Error('An absolute private output path is required');
  const catalog = await client.catalog(), entries = [], skipped = [];
  const directory = `${output}.profiles`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pin = async (name, file) => ({ name, path: await realpath(file), sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  const runtime = await Promise.all([
    pin('node', process.execPath), pin('openclaw-model-executor', path.join(__dirname, 'executors/openclaw-model-executor.js')),
    pin('execution-source', path.join(__dirname, '../../shared/executionSource.js')),
    pin('openclaw-client', path.join(__dirname, '../../shared/openclawExecutionClient.js')), pin('broker-contract', path.join(__dirname, 'contract.js')),
    pin('execution-evidence', path.join(__dirname, '../../shared/executionEvidence.js'))
  ]);
  for (const model of catalog.models) {
    // Existing claimed Ollama executors remain authoritative for local benchmarks.
    if (model.origin === 'local' || !['free', 'included', 'paid'].includes(model.billing?.kind) || !model.isolation?.providerRouting || !model.isolation?.singleCallQualified) {
      skipped.push({ model: model.model, reason: model.origin === 'local' ? 'local-claim-qualification-required' : 'billing-routing-or-transport-unverified' }); continue;
    }
    const slash = model.model.indexOf('/'), provider = model.model.slice(0, slash), id = model.model.slice(slash + 1);
    const profilePath = path.join(directory, `${fingerprint({ model, observedAt: catalog.observedAt, expiresAt: catalog.expiresAt }).slice(0, 32)}.json`);
    await writeFile(profilePath, JSON.stringify({ schema: 'agentx.openclaw-model-profile/v1', model, runtimeVersion: catalog.runtimeVersion, observedAt: catalog.observedAt, expiresAt: catalog.expiresAt }), { mode: 0o600 });
    const profilePins = [await pin('openclaw-model-profile', profilePath)];
    const paid = model.billing.kind === 'paid', rates = model.billing.rates;
    const pricing = paid ? { kind: 'manual_per_token', currency: 'USD', source: 'openclaw-native-catalog-estimate', effectiveAt: catalog.observedAt,
      ...Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [`${key}NanodollarsPerMillion`, Math.ceil(rates[key] * 1e9)])) }
      : { kind: 'free', currency: 'USD', source: model.billing.kind === 'included' ? 'native-subscription-included-marginal-cost' : model.billing.source };
    const target = normalizeTarget({ id: `openclaw-model-${fingerprint(model.model).slice(0, 20)}`, label: `OpenClaw · ${model.name} · model`,
      mode: 'isolated_model', tier: paid ? 'paid_cloud' : 'free_cloud', provider, model: id, modelVersion: 'unknown',
      harness: { name: 'openclaw', version: catalog.runtimeVersion }, adapter: { name: 'openclaw-model', version: ADAPTER_VERSION },
      profile: { id: 'openclaw-model-v1', version: '1', fingerprint: fingerprint(profilePins.map(({ name, sha256 }) => ({ name, sha256 }))) },
      api: { name: 'openclaw-model-sdk', version: catalog.runtimeVersion }, contextWindow: model.contextWindow,
      capabilities: { candidate: true, judge: model.parameterSupport?.jsonResponseFormat === true && model.parameterSupport?.seed === true }, pricing, billing: model.billing.kind,
      observedAt: catalog.observedAt, catalogFingerprint: model.fingerprint, available: !paid || catalog.policy?.maxRequestCostNanodollars > 0 });
    entries.push({ target, attestations: { noMemory: true, noTools: true, noFallback: true, noFanOut: true, noDelivery: true, ephemeralSession: true },
      executor: { command: process.execPath, args: [path.join(__dirname, 'executors/openclaw-model-executor.js'), '--profile', profilePath],
        envAllowlist: ['OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN'], lock: 'openclaw-model-execution', capacity: 1,
        timeoutMs: 600000, maxOutputBytes: 2000000, pins: { runtime, profile: profilePins } } });
  }
  if (existingCatalogPath) {
    const existing = JSON.parse(await readFile(existingCatalogPath, 'utf8'));
    if (existing.schema !== 'agentx.benchmark-harness-catalog/v1' || !Array.isArray(existing.targets)) throw new Error('Invalid existing catalog');
    // Keep local targets and native agent profiles; retire prior raw cloud executors.
    for (const entry of existing.targets) if (entry.target.tier === 'local' || entry.target.mode === 'native_agent') entries.push(entry);
  }
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ schema: 'agentx.benchmark-harness-catalog/v1',
    broker: { name: 'aiops-benchmark-harness-broker', version: '1.1.0' },
    catalog: { observedAt: catalog.observedAt, expiresAt: catalog.expiresAt }, targets: entries }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, output);
  return { output, targets: entries.map(entry => entry.target.id), skipped };
}
if (require.main === module) materialize({ output: process.argv[2], existingCatalogPath: process.argv[3] }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch(() => { process.stderr.write('OPENCLAW_CATALOG_MATERIALIZATION_FAILED\n'); process.exitCode = 1; });
module.exports = { materialize };
