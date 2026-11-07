#!/usr/bin/env node
'use strict';

// Thin transport for native preparation and activation owner actions.
async function main(argv = process.argv.slice(2), fetchImpl = globalThis.fetch) {
  const [action, ...rest] = argv;
  if (action === '--help' || !action) {
    process.stdout.write('Usage: gpu-driver-preparation status|prepare|evidence|activate|abandon --url URL --host-id ID [--request-id ID --preparation-id ID --expected-fingerprint HASH]\n');
    return;
  }
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--url', '--host-id', '--request-id', '--preparation-id', '--expected-fingerprint'].includes(rest[i])
      || !rest[i + 1] || rest[i + 1].startsWith('--') || Object.hasOwn(flags, rest[i])) throw new Error('Unknown, duplicate or incomplete option');
    flags[rest[i]] = rest[i + 1];
  }
  if (!['status', 'prepare', 'evidence', 'activate', 'abandon'].includes(action) || !flags['--url'] || !flags['--host-id']) throw new Error('Explicit action, URL and host identity required');
  if (['prepare', 'evidence', 'activate', 'abandon'].includes(action) && !flags['--request-id']) throw new Error('An exact requestId is required');
  if (['activate', 'abandon'].includes(action) && !flags['--preparation-id']) throw new Error('An exact preparationId is required');
  if (action === 'prepare' && !flags['--expected-fingerprint']) throw new Error('An expected active fingerprint is required');
  const base = new URL(flags['--url']);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid service URL');
  let suffix = '';
  if (action === 'prepare') suffix = '/prepare';
  if (['activate', 'abandon'].includes(action)) suffix = `/${action}`;
  if (action === 'evidence') {
    if (!flags['--request-id']) throw new Error('The exact preparation requestId is required');
    suffix = `/prepared/${encodeURIComponent(flags['--request-id'])}`;
  }
  const url = `${base.toString().replace(/\/+$/, '')}/api/profiler/hosts/gpu-driver/${encodeURIComponent(flags['--host-id'])}${suffix}`;
  const mutation = ['prepare', 'activate', 'abandon'].includes(action);
  const response = await fetchImpl(url, { method: mutation ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-agentx-caller': 'operator' }, signal: AbortSignal.timeout(60_000),
    ...(mutation && { body: JSON.stringify({ requestId: flags['--request-id'],
      ...(action === 'prepare' ? { expectedFingerprint: flags['--expected-fingerprint'] } : { preparationId: flags['--preparation-id'] }) }) }) });
  const body = await response.json();
  if (!response.ok || body.status !== 'success') throw new Error(body.error || `HTTP ${response.status}`);
  process.stdout.write(`${JSON.stringify(body.data, null, 2)}\n`);
  return body.data;
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
