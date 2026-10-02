'use strict';

/**
 * Keeps Benchmark's host list in step with Core's inference host registry.
 *
 * Core owns the registry. Benchmark reads it periodically and hands the
 * snapshot to its host config, so a host registered in the Nerve Center
 * (for example a CPU Ollama instance) becomes a profiling and benchmark
 * target with its declared residency. When Core is unreachable the last
 * snapshot stays in force.
 */

const logger = require('../../config/logger');
const hostConfig = require('../helpers/ollamaHostConfig');
const { withBenchmarkServiceAuth } = require('../helpers/coreServiceAuth');

const DEFAULT_INTERVAL_MS = 30_000;
let timer = null;

async function syncRegisteredHosts({ coreUrl = process.env.CORE_URL || 'http://localhost:3080', fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${coreUrl}/api/nerve-center/inference-hosts`, {
      headers: withBenchmarkServiceAuth({ Accept: 'application/json' }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return { synced: false, reason: `HTTP ${response.status}` };
    const body = await response.json();
    const hosts = Array.isArray(body?.data?.hosts) ? body.data.hosts : null;
    if (!hosts) return { synced: false, reason: 'malformed' };
    return { synced: true, count: hostConfig.setRegisteredHosts(hosts) };
  } catch (error) {
    return { synced: false, reason: error.message };
  }
}

function startRegisteredHostSync({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (timer) return timer;
  const run = () => syncRegisteredHosts().then(result => {
    if (!result.synced) logger.debug('[HostSync] Core host registry not read', { reason: result.reason });
  });
  run();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}

function stopRegisteredHostSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { syncRegisteredHosts, startRegisteredHostSync, stopRegisteredHostSync };
