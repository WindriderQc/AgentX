#!/usr/bin/env node
'use strict';

const { createReadStream } = require('node:fs');
const { readFile, readdir } = require('node:fs/promises');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { instanceIdFor, hermesUsageReceipt, openclawUsageReceipt } = require('../../shared/runtimeUsageReceipts.cjs');

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--core-url', '--sessions-dir', '--instance-id', '--direct-providers', '--hermes-state', '--hermes-origin', '--lookback-days'].includes(key)
      || !args[index + 1] || Object.hasOwn(result, key)) throw new Error('RUNTIME_USAGE_ARGUMENTS_INVALID');
    result[key] = args[index + 1];
  }
  if (!result['--core-url'] || Boolean(result['--sessions-dir']) === Boolean(result['--hermes-state'])) throw new Error('RUNTIME_USAGE_ARGUMENTS_REQUIRED');
  if (result['--sessions-dir'] && (!result['--instance-id'] || !result['--direct-providers'])) throw new Error('RUNTIME_USAGE_DIRECT_PROVIDERS_REQUIRED');
  if (result['--hermes-state'] && !result['--hermes-origin']) throw new Error('RUNTIME_USAGE_HERMES_ORIGIN_REQUIRED');
  if (result['--lookback-days'] && (!/^\d+$/.test(result['--lookback-days']) || Number(result['--lookback-days']) < 1 || Number(result['--lookback-days']) > 365)) throw new Error('RUNTIME_USAGE_LOOKBACK_INVALID');
  return result;
}

async function submit(receipt, coreUrl, fetchImpl) {
  const origin = new URL(coreUrl);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('RUNTIME_USAGE_CORE_URL_INVALID');
  const response = await fetchImpl(new URL('/api/analytics/runtime-usage', origin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'x-service-caller': 'runtime-usage-sync' }, body: JSON.stringify(receipt)
  });
  // A lost response is retried only with this same native identity and fields.
  // No provider call is made by this collector.
  if (!response.ok) {
    await response.body?.cancel?.();
    throw new Error(`RUNTIME_USAGE_HTTP_${response.status}`);
  }
  const body = await response.json();
  if (body.status !== 'success' || !body.result?.receiptId) throw new Error('RUNTIME_USAGE_UNCONFIRMED');
}

async function sync(config, fetchImpl = fetch) {
  const result = { submitted: 0, skipped: 0 };
  if (config['--hermes-state']) {
    const state = JSON.parse(await readFile(config['--hermes-state'], 'utf8'));
    const receipt = hermesUsageReceipt(state, config['--hermes-origin']);
    if (!receipt) throw new Error('RUNTIME_USAGE_HERMES_USAGE_UNAVAILABLE');
    await submit(receipt, config['--core-url'], fetchImpl);
    result.submitted++;
    return result;
  }
  const directory = config['--sessions-dir'];
  const directProviders = config['--direct-providers'].split(',').filter(Boolean);
  const files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && /^[a-zA-Z0-9_-]+\.jsonl$/.test(file.name));
  const cutoff = Date.now() - Number(config['--lookback-days'] || 30) * 86400000;
  for (const file of files) {
    let sessionId;
    const input = createReadStream(path.join(directory, file.name));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { throw new Error('RUNTIME_USAGE_NATIVE_JSON_INVALID'); }
        if (row.type === 'session') { sessionId = row.id; continue; }
        const receipt = sessionId ? openclawUsageReceipt(row, { instanceId: config['--instance-id'], sessionId, directProviders }) : null;
        if (!receipt || !Number.isFinite(Date.parse(receipt.completedAt)) || Date.parse(receipt.completedAt) < cutoff) { result.skipped++; continue; }
        await submit(receipt, config['--core-url'], fetchImpl);
        result.submitted++;
      }
    } finally { lines.close(); input.destroy(); }
  }
  return result;
}

if (require.main === module) {
  sync(options(process.argv.slice(2))).then(result => process.stdout.write(JSON.stringify(result) + '\n'), error => {
    // Native paths, transcript bytes, provider responses and credentials never
    // enter collector diagnostics. Preserve the file for identity-safe replay.
    const code = /^RUNTIME_USAGE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'RUNTIME_USAGE_SYNC_FAILED';
    process.stderr.write(code + '\n'); process.exitCode = 1;
  });
}
module.exports = { options, sync, instanceIdFor };
