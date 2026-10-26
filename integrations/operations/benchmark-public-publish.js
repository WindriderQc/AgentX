#!/usr/bin/env node
'use strict';

/**
 * Publish Benchmark's scoreboard as public files.
 *
 *   node benchmark-public-publish.js --outbox DIR            preview: write the public tree locally
 *   node benchmark-public-publish.js --outbox DIR --send     also deliver it to the configured target
 *
 * Reads Benchmark over its private loopback API, keeps only allow-listed public
 * fields, replaces host URLs with registry machine names and refuses to write
 * anything that still carries an address, URL or port. Push only: the public
 * side is never read.
 */

const path = require('path');
const { buildPublication } = require('./benchmark-public/projection');
const { DEFAULT_KEEP_SNAPSHOTS, readIndex, writeOutbox } = require('./benchmark-public/outbox');
const { deliverRsync } = require('./benchmark-public/delivery');

const DEFAULT_BENCHMARK_URL = 'http://127.0.0.1:3181';
const FETCH_TIMEOUT_MS = 30_000;
const ROUTES = Object.freeze({
  summary: '/api/benchmark/summary',
  leaderboard: '/api/benchmark/generalist-leaderboard',
  efficiency: '/api/benchmark/efficiency-map',
  hostNames: '/api/benchmark/host-names',
});

function usage() {
  return [
    'Usage: benchmark-public-publish.js --outbox DIR [--send] [options]',
    '',
    '  --outbox DIR          local public tree (required); without --send nothing leaves this machine',
    '  --benchmark-url URL   Benchmark origin (default BENCHMARK_SERVICE_URL or http://127.0.0.1:3181)',
    '  --time-zone ZONE      zone of the dated snapshot names (default: this machine\'s zone)',
    `  --keep-snapshots N    dated snapshots kept (default ${DEFAULT_KEEP_SNAPSHOTS})`,
    '  --exclude-model GLOB  keep matching models off the public side (repeatable, * wildcard)',
    '  --force               write a new snapshot even when the content is unchanged',
    '  --send                push the outbox with rsync over SSH to the public target',
    '  --target T            user@host:/absolute/folder (default AGENTX_PUBLIC_SCOREBOARD_TARGET)',
    '  --ssh-key FILE        dedicated SSH key (default AGENTX_PUBLIC_SCOREBOARD_SSH_KEY)',
    '  --known-hosts FILE    known-hosts file (default AGENTX_PUBLIC_SCOREBOARD_KNOWN_HOSTS)',
    '',
    'AGENTX_PUBLIC_SCOREBOARD_EXCLUDE holds comma-separated globs added to --exclude-model.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    benchmarkUrl: process.env.BENCHMARK_SERVICE_URL || DEFAULT_BENCHMARK_URL,
    keepSnapshots: DEFAULT_KEEP_SNAPSHOTS,
    excludeModels: String(process.env.AGENTX_PUBLIC_SCOREBOARD_EXCLUDE || '').split(',').map((p) => p.trim()).filter(Boolean),
    target: process.env.AGENTX_PUBLIC_SCOREBOARD_TARGET || '',
    sshKey: process.env.AGENTX_PUBLIC_SCOREBOARD_SSH_KEY || '',
    knownHosts: process.env.AGENTX_PUBLIC_SCOREBOARD_KNOWN_HOSTS || '',
    send: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--outbox') options.outbox = path.resolve(next());
    else if (arg === '--benchmark-url') options.benchmarkUrl = next();
    else if (arg === '--time-zone') options.timeZone = next();
    else if (arg === '--keep-snapshots') options.keepSnapshots = Number(next());
    else if (arg === '--exclude-model') options.excludeModels.push(next());
    else if (arg === '--target') options.target = next();
    else if (arg === '--ssh-key') options.sshKey = path.resolve(next());
    else if (arg === '--known-hosts') options.knownHosts = path.resolve(next());
    else if (arg === '--send') options.send = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.outbox) throw new Error('--outbox is required');
  if (!Number.isSafeInteger(options.keepSnapshots) || options.keepSnapshots < 1) throw new Error('--keep-snapshots must be a positive integer');
  if (options.send && !options.target) throw new Error('--send needs --target or AGENTX_PUBLIC_SCOREBOARD_TARGET');
  if (options.timeZone) new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }); // throws on an unknown zone
  options.benchmarkUrl = String(options.benchmarkUrl).replace(/\/+$/, '');
  return options;
}

async function fetchData(baseUrl, route, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${baseUrl}${route}`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Benchmark ${route} answered ${response.status}`);
  const body = await response.json();
  if (body?.status !== 'success' || !body.data || typeof body.data !== 'object') {
    throw new Error(`Benchmark ${route} returned no data`);
  }
  return body.data;
}

async function readBenchmark(baseUrl, options = {}) {
  const entries = await Promise.all(Object.entries(ROUTES).map(async ([key, route]) => [key, await fetchData(baseUrl, route, options)]));
  return Object.fromEntries(entries);
}

async function publish(options, { fetchImpl, deliver = deliverRsync, now = () => new Date() } = {}) {
  const source = await readBenchmark(options.benchmarkUrl, { fetchImpl });
  const publication = buildPublication(source, {
    generatedAt: now().toISOString(),
    snapshotCount: readIndex(options.outbox).length,
    excludeModels: options.excludeModels,
  });
  const outbox = writeOutbox(options.outbox, publication, {
    timeZone: options.timeZone,
    keepSnapshots: options.keepSnapshots,
    force: options.force,
  });
  const report = {
    ok: true,
    dryRun: !options.send,
    outbox: options.outbox,
    status: outbox.status,
    snapshotId: outbox.snapshotId,
    written: outbox.written,
    removed: outbox.removed,
    contentHash: publication.hash,
    counts: {
      leaderboard: publication.files['leaderboard.json'].leaderboard.length,
      efficiency: publication.files['efficiency.json'].entries.length,
      modelCards: publication.files['model-cards.json'].models.length,
    },
    dropped: publication.dropped,
  };
  if (options.send) {
    // Unchanged content is still pushed: rsync sends nothing new, and a missed
    // earlier delivery catches up.
    report.delivery = await deliver(options.outbox, {
      target: options.target,
      sshKey: options.sshKey,
      knownHosts: options.knownHosts,
    });
  }
  return report;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const report = await publish(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'PUBLISH_FAILED', error: error.message })}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { ROUTES, fetchData, main, parseArgs, publish, readBenchmark };
