'use strict';

/**
 * GPU occupancy over a window for the Nerve Center (#365), from Data's
 * `/api/v1/hardware/occupancy` (aggregated from the gpu-agent samples).
 *
 * Each collector host is matched to the configured Ollama hosts through the
 * `ollamaUrl` it reports, as the live GPU view does. Each sampled GPU is joined
 * to a physical resource of AGENTX_RUNTIME_RESOURCES_JSON, and so to every
 * endpoint that uses it, when the resource's id is that GPU's UUID or PCI bus
 * id, or when its endpoints include the Ollama URL of a collector host that has
 * a single GPU. Coverage and sample counts pass through unchanged: time no
 * sample covers stays missing.
 */

const { fetchData } = require('./dataServiceClient');
const { resourceTopology } = require('./runtimePhysicalResources');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const { ollamaOrigin } = require('./gpuTelemetryService');

const WINDOWS = Object.freeze({ '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000, '30d': 30 * 24 * 3600_000 });
const DEFAULT_WINDOW = '24h';
const REQUEST_TIMEOUT_MS = 15_000;

function resolveWindow(raw, now = Date.now()) {
  const key = Object.prototype.hasOwnProperty.call(WINDOWS, raw) ? raw : DEFAULT_WINDOW;
  return { key, from: new Date(now - WINDOWS[key]), to: new Date(now) };
}

function readTopology(raw) {
  try {
    const topology = resourceTopology(raw);
    return { status: topology.resources.length ? 'configured' : 'unset', resources: topology.resources };
  } catch {
    return { status: 'invalid', resources: [] };
  }
}

const sameId = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

function resourceFor(gpu, host, resources) {
  const byUuid = resources.find(resource => sameId(resource.id, gpu.uuid));
  if (byUuid) return { ...byUuid, link: 'uuid' };
  const byBus = resources.find(resource => sameId(resource.id, gpu.busId));
  if (byBus) return { ...byBus, link: 'bus_id' };
  const endpoint = hostUrlKey(host.ollamaUrl);
  if (!endpoint || host.gpus.length !== 1) return null;
  const byEndpoint = resources.filter(resource => resource.endpoints.includes(endpoint));
  return byEndpoint.length === 1 ? { ...byEndpoint[0], link: 'single_gpu_host' } : null;
}

/**
 * Joins Data's occupancy to the configured Ollama hosts and the physical
 * resource map. Resources linked to no sampled GPU are listed by id.
 */
function joinOccupancy(data, { configuredHosts = [], topology = readTopology() } = {}) {
  const linked = new Set();
  const hosts = (Array.isArray(data?.hosts) ? data.hosts : []).map(host => {
    const origin = ollamaOrigin(host.ollamaUrl);
    const gpus = Array.isArray(host.gpus) ? host.gpus : [];
    return {
      collectorHostId: host.hostId,
      name: host.name || host.hostId,
      intervalMs: host.intervalMs ?? null,
      ollamaHostIds: origin ? configuredHosts.filter(item => ollamaOrigin(item.url) === origin).map(item => item.id) : [],
      gpus: gpus.map(gpu => {
        const resource = resourceFor(gpu, { ollamaUrl: host.ollamaUrl, gpus }, topology.resources);
        if (resource) linked.add(resource.id);
        return { ...gpu, resource };
      }),
    };
  });
  return {
    from: data?.from ?? null,
    to: data?.to ?? null,
    windowMs: data?.windowMs ?? null,
    busyAtPct: data?.busyAtPct ?? null,
    topology: topology.status,
    hosts,
    unlinkedResources: topology.resources.filter(resource => !linked.has(resource.id)).map(resource => resource.id),
  };
}

/**
 * @param {{ window?: string, busyAtPct?: string|number, configuredHosts?: object[] }} options
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, data?: object }>}
 */
async function getGpuOccupancy({ window, busyAtPct, configuredHosts = [] } = {}, { fetchImpl = fetchData, now = Date.now() } = {}) {
  const range = resolveWindow(window, now);
  const query = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() });
  if (busyAtPct != null && busyAtPct !== '') query.set('busyAtPct', String(busyAtPct));
  try {
    const { response, body } = await fetchImpl('/api/v1/hardware/occupancy', { query: query.toString(), timeoutMs: REQUEST_TIMEOUT_MS });
    if (!response.ok || body.ok === false || !Array.isArray(body.data?.hosts)) {
      return { ok: false, status: response.status === 400 ? 400 : 502, error: body?.message || `Data returned HTTP ${response.status}` };
    }
    return { ok: true, data: { window: range.key, ...joinOccupancy(body.data, { configuredHosts }) } };
  } catch (error) {
    return { ok: false, status: 502, error: error.name === 'TimeoutError' ? 'Data request timed out' : error.message };
  }
}

module.exports = { WINDOWS, getGpuOccupancy, joinOccupancy, readTopology, resolveWindow };
