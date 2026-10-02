'use strict';

/**
 * agentx.profiler-hardware-collector/v1 backed by Data's GPU telemetry
 * (`GET /api/v1/hardware/latest`, fed by integrations/data-collectors/gpu-agent.js).
 *
 * A profiled Ollama host is matched to a collector host through the `ollamaUrl`
 * the collector reports for it. Data decides freshness from the collector
 * interval; only a fresh snapshot counts as observed evidence.
 */

const CONTRACT = 'agentx.profiler-hardware-collector/v1';
const REQUEST_TIMEOUT_MS = 2500;

function dataBaseUrl(env = process.env) {
  const raw = String(env.DATAAPI_BASE_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

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

function matchHost(hosts, hostUrl) {
  const target = ollamaOrigin(hostUrl);
  if (!target) return null;
  return (hosts || []).find(host => ollamaOrigin(host?.ollamaUrl) === target) || null;
}

/**
 * Latest collector evidence for one Ollama host URL. Never throws.
 * status: not_configured | unavailable | no_host | no_data | stale | observed
 */
async function readHostHardware(hostUrl, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const baseUrl = dataBaseUrl(env);
  const base = { contract: CONTRACT, source: 'agentx-data' };
  if (!baseUrl) return { ...base, status: 'not_configured', reason: 'DATAAPI_BASE_URL is not set' };
  let body;
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/hardware/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    body = await response.json().catch(() => null);
    if (!response.ok || !body || body.ok === false || !Array.isArray(body.data?.hosts)) {
      return { ...base, status: 'unavailable', reason: body?.message || `Data returned HTTP ${response.status}` };
    }
  } catch (error) {
    return { ...base, status: 'unavailable', reason: error.name === 'TimeoutError' ? 'Data request timed out' : error.message };
  }

  const host = matchHost(body.data.hosts, hostUrl);
  if (!host) return { ...base, status: 'no_host', reason: 'no collector host reports this Ollama URL' };
  const common = {
    ...base,
    collectorId: host.collectorId || null,
    hostId: host.hostId,
    sampledAt: host.lastSampleAt || null,
    ageMs: host.ageMs ?? null,
    staleAfterMs: host.staleAfterMs ?? null,
    lastError: host.lastError || null
  };
  if (host.freshness === 'fresh' && Array.isArray(host.gpus) && host.gpus.length > 0) {
    return { ...common, status: 'observed', gpus: host.gpus };
  }
  return {
    ...common,
    status: host.freshness === 'stale' ? 'stale' : 'no_data',
    reason: host.lastError || (host.freshness === 'stale' ? 'latest GPU sample is stale' : 'no GPU sample yet')
  };
}

module.exports = { CONTRACT, dataBaseUrl, ollamaOrigin, matchHost, readHostHardware };
