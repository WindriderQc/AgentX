'use strict';

const { readFile } = require('node:fs/promises');
const { createOpenClawExecutionClient } = require('../../../shared/openclawExecutionClient');
const { fingerprint } = require('../contract');
const ADAPTER_VERSION = '1.0.0';

function verifyResult(result, input, profile) {
  const receipt = result.receipt, isolation = receipt?.isolation, observed = receipt?.observed;
  const target = input.target;
  if (receipt?.mode !== 'model' || receipt.runtimeVersion !== target.harness.version
      || receipt.targetFingerprint !== profile.model.fingerprint || observed?.provider !== target.provider
      || observed?.model !== target.model || observed?.modelVersion !== target.modelVersion) throw new Error('OPENCLAW_TARGET_DRIFT');
  if (!isolation?.noMemory || !isolation.noAgentPrompt || !isolation.noTools || !isolation.noRuntimeFallback
      || isolation.toolsExecuted !== 0 || isolation.modelCalls !== 1) throw new Error('OPENCLAW_ISOLATION_UNVERIFIED');
  if (target.provider === 'openrouter' && (isolation.providerRouting?.allow_fallbacks !== false
      || isolation.providerRouting.only?.length !== 1)) throw new Error('OPENCLAW_PROVIDER_ROUTING_UNPINNED');
  if (fingerprint(receipt.billing) !== fingerprint(profile.model.billing)) throw new Error('OPENCLAW_PRICE_DRIFT');
  if (!result.text?.trim()) throw new Error('OPENCLAW_VISIBLE_FINAL_MISSING');
  const usage = receipt.usage;
  if (['input', 'output', 'cacheRead', 'cacheWrite', 'total'].some(key => !Number.isSafeInteger(usage?.[key]) || usage[key] < 0)
      || usage.total !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite) throw new Error('OPENCLAW_USAGE_UNVERIFIED');
  return { requestFingerprint: fingerprint({ targetFingerprint: target.fingerprint, envelopeFingerprint: input.envelope.fingerprint,
    promptFingerprint: input.envelope.prompt.fingerprint }), responseFingerprint: fingerprint(result.text),
    output: result.text, thinking: result.thinking, finishReason: result.finishReason, fallbackUsed: false,
    actual: { provider: observed.provider, providerVersion: 'openclaw-native-sdk', model: observed.model, modelVersion: observed.modelVersion,
      harnessVersion: receipt.runtimeVersion, adapterVersion: ADAPTER_VERSION, environmentId: target.profile.id,
      environmentVersion: target.profile.version, environmentFingerprint: process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT || null,
      runtimeFingerprint: process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT || null, modelDigest: null },
    execution: { source: 'openclaw', mode: 'model', nativeReceiptFingerprint: fingerprint(receipt),
      targetFingerprint: receipt.targetFingerprint, contextFingerprint: receipt.contextFingerprint, payloadFingerprint: receipt.payloadFingerprint,
      noMemory: true, noAgentPrompt: true, noTools: true, noRuntimeFallback: true, modelCalls: 1, toolsExecuted: 0,
      providerRoutingPinned: target.provider !== 'openrouter' || profile.model.isolation.providerRouting === true,
      modelVersionSource: 'not-observed', upstreamProvider: null, costSource: 'runtime-estimate' },
    usage: { durationMs: receipt.durationMs, inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
      turns: 1, toolCalls: 0 } };
}

async function execute(input, profile, client = createOpenClawExecutionClient()) {
  if (input.target.mode !== 'isolated_model' || input.envelope.tools.allowed.length) throw new Error('OPENCLAW_ISOLATED_PROFILE_REQUIRED');
  if (!Number.isFinite(Date.parse(profile.expiresAt)) || Date.parse(profile.expiresAt) <= Date.now()) throw new Error('OPENCLAW_CATALOG_STALE');
  const catalog = await client.catalog();
  const current = catalog.models.find(entry => entry.model === `${input.target.provider}/${input.target.model}`);
  if (catalog.runtimeVersion !== input.target.harness.version || current?.fingerprint !== profile.model.fingerprint
      || !current.isolation?.providerRouting) throw new Error('OPENCLAW_TARGET_DRIFT');
  const parameters = Object.fromEntries(Object.entries(input.parameters).filter(([, value]) => value != null));
  const result = await client.execute({ execution: { source: 'openclaw', mode: 'model', model: current.model },
    requestId: input.envelope.task.id, expectedFingerprint: current.fingerprint,
    messages: [{ role: 'user', content: input.input.prompt }], parameters,
    budget: { maxCalls: 1, maxCostNanodollars: input.envelope.budgets.maxCostNanodollars } }, { timeoutMs: parameters.timeoutMs });
  return verifyResult(result, input, profile);
}

async function main() {
  if (process.argv[2] !== '--profile' || !process.argv[3]) throw new Error('--profile is required');
  const profile = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(JSON.stringify(await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')), profile)));
}
if (require.main === module) main().catch(error => { process.stderr.write(`${/^OPENCLAW_[A-Z_]+$/.test(error.message) ? error.message : 'OPENCLAW_EXECUTION_FAILED'}\n`); process.exitCode = 1; });
module.exports = { ADAPTER_VERSION, execute, verifyResult };
