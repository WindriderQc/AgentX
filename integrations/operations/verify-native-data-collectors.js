#!/usr/bin/env node
'use strict';

const EXPECTED = Object.freeze({
  network: ['network-agent'],
  storage: ['storage-agent'],
  // The GPU collector is opt-in per instance: `--expect-gpu <collector ids>`.
  gpu: []
});

const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:3183',
  expectNetwork: EXPECTED.network,
  expectStorage: EXPECTED.storage,
  expectGpu: EXPECTED.gpu,
  mode: 'current',
  pollMs: 2500,
  recentMs: 60000,
  timeoutMs: 35000
});

function positiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function expectedIds(value, flag) {
  if (value === 'none') return [];
  const ids = [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))) {
    throw new Error(`${flag} must be none or comma-separated scanner identifiers`);
  }
  return ids;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    ...DEFAULTS,
    expectNetwork: [...DEFAULTS.expectNetwork],
    expectStorage: [...DEFAULTS.expectStorage],
    expectGpu: [...DEFAULTS.expectGpu]
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--base-url') options.baseUrl = next();
    else if (arg === '--expect-network') options.expectNetwork = expectedIds(next(), arg);
    else if (arg === '--expect-storage') options.expectStorage = expectedIds(next(), arg);
    else if (arg === '--expect-gpu') options.expectGpu = expectedIds(next(), arg);
    else if (arg === '--mode') options.mode = next();
    else if (arg === '--poll-ms') options.pollMs = positiveInteger(next(), arg);
    else if (arg === '--recent-ms') options.recentMs = positiveInteger(next(), arg);
    else if (arg === '--timeout-ms') options.timeoutMs = positiveInteger(next(), arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['current', 'fresh'].includes(options.mode)) {
    throw new Error('--mode must be current or fresh');
  }
  if (options.expectNetwork.length + options.expectStorage.length + options.expectGpu.length === 0) {
    throw new Error('At least one expected native agent is required');
  }
  const parsedBase = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(parsedBase.protocol)) {
    throw new Error('--base-url must use http or https');
  }
  options.baseUrl = parsedBase.toString().replace(/\/$/, '');
  return options;
}

async function readJson(fetchImpl, baseUrl, route) {
  const response = await fetchImpl(`${baseUrl}${route}`, {
    method: 'GET',
    signal: AbortSignal.timeout(10000)
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${route} returned non-JSON evidence`);
  }
  return { response, body };
}

function validAgent(row, id, threshold, nowMs) {
  const lastSeen = Date.parse(row?.lastSeen);
  return (row?.scannerId ?? row?.collectorId) === id
    && row?.active === true
    && Number.isFinite(lastSeen)
    && lastSeen >= threshold
    && lastSeen <= nowMs + 5000;
}

function completeProjection(networkRows, storageRows, threshold, nowMs, expected = EXPECTED, gpuRows = []) {
  return expected.network.every((id) => networkRows.some((row) => validAgent(row, id, threshold, nowMs)))
    && expected.storage.every((id) => storageRows.some((row) => validAgent(row, id, threshold, nowMs)))
    && (expected.gpu || []).every((id) => gpuRows.some((row) => validAgent(row, id, threshold, nowMs)));
}

async function readGpuProjection(fetchImpl, baseUrl) {
  const gpu = await readJson(fetchImpl, baseUrl, '/api/v1/hardware/collectors');
  if (!gpu.response.ok || !Array.isArray(gpu.body?.data?.collectors)) {
    throw new Error('GPU collector projection is unavailable or malformed');
  }
  return gpu.body.data.collectors;
}

async function readAgentProjection(fetchImpl, baseUrl) {
  const [network, storage] = await Promise.all([
    readJson(fetchImpl, baseUrl, '/api/v1/network/agents'),
    readJson(fetchImpl, baseUrl, '/api/v1/storage/agents')
  ]);
  if (!network.response.ok || !Array.isArray(network.body?.data?.scanners)) {
    throw new Error('Network agent projection is unavailable or malformed');
  }
  if (!storage.response.ok || !Array.isArray(storage.body?.data?.scanners)) {
    throw new Error('Storage agent projection is unavailable or malformed');
  }
  return {
    networkRows: network.body.data.scanners,
    storageRows: storage.body.data.scanners
  };
}

async function verifyNativeDataCollectors(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const expected = {
    network: options.expectNetwork || DEFAULTS.expectNetwork,
    storage: options.expectStorage || DEFAULTS.expectStorage,
    gpu: options.expectGpu || DEFAULTS.expectGpu
  };
  if (expected.network.length + expected.storage.length + expected.gpu.length === 0) {
    throw new Error('At least one expected native agent is required');
  }


  const freshThreshold = now();
  const deadline = freshThreshold + options.timeoutMs;
  let attempts = 0;
  do {
    attempts += 1;
    const projection = await readAgentProjection(fetchImpl, options.baseUrl);
    const gpuRows = expected.gpu.length ? await readGpuProjection(fetchImpl, options.baseUrl) : [];
    const observedAt = now();
    const threshold = options.mode === 'fresh'
      ? freshThreshold
      : observedAt - options.recentMs;
    if (completeProjection(projection.networkRows, projection.storageRows, threshold, observedAt, expected, gpuRows)) {
      return {
        attempts,
        mode: options.mode,
        verifiedAgents: expected.network.length + expected.storage.length + expected.gpu.length
      };
    }
    if (observedAt >= deadline) break;
    await sleep(Math.min(options.pollMs, Math.max(1, deadline - observedAt)));
  } while (now() <= deadline);

  const freshness = options.mode === 'fresh' ? 'post-check' : `${options.recentMs}ms`;
  const expectedIds = [...expected.network, ...expected.storage, ...expected.gpu].join(',');
  throw new Error(`Native agent projection did not contain active ${freshness} heartbeats for expected agents: ${expectedIds}`);
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await verifyNativeDataCollectors(options);
  console.log(`Native Data: ${result.verifiedAgents} ${result.mode} heartbeats verified`);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  EXPECTED,
  completeProjection,
  expectedIds,
  parseArgs,
  readAgentProjection,
  readGpuProjection,
  runCli,
  validAgent,
  verifyNativeDataCollectors
};
