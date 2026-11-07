#!/usr/bin/env node
'use strict';

// Thin operator transport. Preparation reads existing owners and writes only a
// frozen host manifest; it launches no collector, profiler or tool campaign.
async function main(argv = process.argv.slice(2), fetchImpl = globalThis.fetch) {
  const [action, ...rest] = argv;
  if (action === '--help' || !action) {
    process.stdout.write('Usage: gpu-driver-preparation status|prepare|evidence --url URL --host-id ID [--request-id ID --expected-fingerprint HASH]\n');
    return;
  }
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--url', '--host-id', '--request-id', '--expected-fingerprint'].includes(rest[i]) || !rest[i + 1]) throw new Error('Unknown or incomplete option');
    flags[rest[i]] = rest[i + 1];
  }
  if (!['status', 'prepare', 'evidence'].includes(action) || !flags['--url'] || !flags['--host-id']) throw new Error('Explicit action, URL and host identity required');
  const base = new URL(flags['--url']);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid service URL');
  let suffix = '';
  if (action === 'prepare') suffix = '/prepare';
  if (action === 'evidence') {
    if (!flags['--request-id']) throw new Error('The exact preparation requestId is required');
    suffix = `/prepared/${encodeURIComponent(flags['--request-id'])}`;
  }
  const url = `${base.toString().replace(/\/+$/, '')}/api/profiler/hosts/gpu-driver/${encodeURIComponent(flags['--host-id'])}${suffix}`;
  const response = await fetchImpl(url, { method: action === 'prepare' ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-agentx-caller': 'operator' }, signal: AbortSignal.timeout(60_000),
    ...(action === 'prepare' && { body: JSON.stringify({ requestId: flags['--request-id'], expectedFingerprint: flags['--expected-fingerprint'] }) }) });
  const body = await response.json();
  if (!response.ok || body.status !== 'success') throw new Error(body.error || `HTTP ${response.status}`);
  process.stdout.write(`${JSON.stringify(body.data, null, 2)}\n`);
  return body.data;
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
