'use strict';

/**
 * Live GPU telemetry for the Nerve Center, read from Data's
 * `/api/v1/hardware/latest` (fed by integrations/data-collectors/gpu-agent.js).
 *
 * A configured Ollama host is matched to a collector host through the
 * `ollamaUrl` the collector reports. Values are returned only while Data calls
 * the sample fresh; a stale or failing host keeps its age and error instead of
 * frozen numbers. The retired Core host-report collection is not read.
 *
 * The host's Ollama service settings, when the collector reads them, travel
 * separately: they carry their own observation time and are shown whatever the
 * GPU sample's freshness.
 */

const { fetchData } = require('./dataServiceClient');
const { normalizeOllamaEnvironment } = require('../../../shared/ollamaServiceEnvironment');

const REQUEST_TIMEOUT_MS = 3000;

function ollamaOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '11434')}`;
  } catch {
    return '';
  }
}

function projectGpu(gpu, position) {
  return {
    index: gpu.index ?? position,
    name: gpu.name || '',
    busId: gpu.busId || '',
    utilization: gpu.utilizationPct ?? null,
    temperature: gpu.temperatureC ?? null,
    vramUsed: gpu.memoryUsedMiB ?? 0,
    vramTotal: gpu.memoryTotalMiB ?? 0,
    powerDraw: gpu.powerDrawW ?? null,
    powerLimit: gpu.powerLimitW ?? null,
    smClock: gpu.smClockMHz ?? null,
    smClockMax: gpu.smClockMaxMHz ?? null,
    pcieGen: gpu.pcieGen ?? null,
    pcieWidth: gpu.pcieWidth ?? null,
    throttleReasons: Array.isArray(gpu.throttleReasons) ? gpu.throttleReasons : []
  };
}

function projectHost(dataHost) {
  const freshness = dataHost?.freshness || 'no_data';
  const telemetry = {
    status: freshness,
    collectorHostId: dataHost.hostId,
    collectorId: dataHost.collectorId || null,
    sampledAt: dataHost.lastSampleAt || null,
    ageMs: dataHost.ageMs ?? null,
    staleAfterMs: dataHost.staleAfterMs ?? null,
    lastError: dataHost.lastError || null,
    consecutiveFailures: dataHost.consecutiveFailures || 0
  };
  // Only a fresh snapshot is shown as current values.
  const gpus = freshness === 'fresh' && Array.isArray(dataHost.gpus) ? dataHost.gpus.map(projectGpu) : [];
  return { telemetry, gpus, ollamaEnvironment: normalizeOllamaEnvironment(dataHost.ollamaEnvironment) };
}

async function readLatest(fetchImpl = fetchData) {
  try {
    const { response, body } = await fetchImpl('/api/v1/hardware/latest', { timeoutMs: REQUEST_TIMEOUT_MS });
    if (!response.ok || body.ok === false || !Array.isArray(body.data?.hosts)) {
      return { ok: false, error: body?.message || `Data returned HTTP ${response.status}`, hosts: [] };
    }
    return { ok: true, hosts: body.data.hosts };
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'Data request timed out' : error.message, hosts: [] };
  }
}

/**
 * @param {Array<{id:string,url:string}>} hosts configured Ollama hosts
 * @returns {Promise<Map<string,{telemetry:object,gpus:object[]}>>} keyed by host id
 */
async function getGpuTelemetryForHosts(hosts, { fetchImpl } = {}) {
  const latest = await readLatest(fetchImpl);
  const byOrigin = new Map(latest.hosts.map(host => [ollamaOrigin(host.ollamaUrl), host]).filter(([origin]) => origin));
  const result = new Map();
  for (const host of hosts || []) {
    if (!latest.ok) {
      result.set(host.id, { telemetry: { status: 'unavailable', lastError: latest.error }, gpus: [] });
      continue;
    }
    const match = byOrigin.get(ollamaOrigin(host.url));
    result.set(host.id, match
      ? projectHost(match)
      : { telemetry: { status: 'no_collector_host', lastError: null }, gpus: [] });
  }
  return result;
}

module.exports = { getGpuTelemetryForHosts, ollamaOrigin, projectGpu, projectHost, readLatest, _internal: { readLatest, projectHost } };
