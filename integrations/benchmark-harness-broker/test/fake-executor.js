'use strict';

const fs = require('node:fs');
const { fingerprint } = require('../contract');

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'success';
  const input = await readInput();
  if (mode === 'check-runtime-claims') {
    const expected = input.target.tier === 'local'
      ? [{ host: 'http://local:11434', claimBatchId: 'batch-1', claimGeneration: 'claim-1', workloadAdmissionId: 'workload-1', workloadGeneration: 'admission-1' }]
      : [];
    require('node:assert/strict').deepEqual(input.runtimeClaims, expected);
  }
  if (process.env.FAKE_HOME_RECORD) fs.appendFileSync(process.env.FAKE_HOME_RECORD, `${process.env.HOME}\n`);
  if (mode === 'tree-sleep') {
    require('node:child_process').spawn(process.execPath, ['-e', "const fs = require('node:fs'); setInterval(() => fs.writeFileSync(process.env.FAKE_CHILD_ACTIVITY, String(Date.now())), 10);"], { stdio: 'inherit' });
    await new Promise(() => {});
  }
  if (mode === 'sleep' || mode === 'locked') await new Promise((resolve) => setTimeout(resolve, 250));
  if (mode === 'overflow') {
    process.stdout.write('x'.repeat(100_000));
    return;
  }
  const output = 'bounded cloud answer';
  const target = input.target;
  process.stdout.write(JSON.stringify({
    requestFingerprint: fingerprint({
      targetFingerprint: target.fingerprint,
      envelopeFingerprint: input.envelope.fingerprint,
      promptFingerprint: input.envelope.prompt.fingerprint,
    }),
    responseFingerprint: fingerprint(output),
    output,
    thinking: mode === 'provider-reported' ? 'bounded reasoning' : null,
    finishReason: 'stop',
    fallbackUsed: mode === 'fallback',
    actual: {
      provider: mode === 'identity-drift' ? 'different-provider' : target.provider,
      providerVersion: 'fixture-v1',
      model: target.model,
      modelVersion: target.modelVersion,
      harnessVersion: target.harness.version,
      adapterVersion: target.adapter.version,
      environmentId: target.profile.id,
      environmentVersion: target.profile.version,
      environmentFingerprint: process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT,
      runtimeFingerprint: process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT,
      modelDigest: null,
    },
    usage: {
      durationMs: 10,
      inputTokens: 4,
      outputTokens: 3,
      cacheReadTokens: mode === 'provider-reported' ? 2 : 0,
      cacheWriteTokens: 0,
      costNanodollars: mode === 'provider-reported' ? 750 : 0,
      costSource: mode === 'provider-reported' ? 'provider-reported' : undefined,
      turns: 1,
      toolCalls: 0,
    },
  }));
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
