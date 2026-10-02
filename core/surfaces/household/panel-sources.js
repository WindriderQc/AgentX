'use strict';

// Data sources for the Household panel: service health probes, JSON
// projections with a short in-process cache, the Hermes crew and the
// inference fleet summary.

const { fetchWithTimeout } = require('./voix-client');

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

const FLEET_LABELS = Object.freeze({
  primary: 'Primary inference',
  secondary: 'Secondary inference',
  tertiary: 'Service host'
});

async function serviceHealth(name, url) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(url, {}, 5000);
    return { id: name.toLowerCase(), name, status: response.ok ? 'ok' : 'down', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { id: name.toLowerCase(), name, status: 'down', latencyMs: Date.now() - startedAt, error: error.message };
  }
}

async function projectedJson(url, projector, fallback, timeoutMs = 8000) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, timeoutMs);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
    return { ...projector(body), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ...fallback, latencyMs: Date.now() - startedAt, error: error.message };
  }
}

const projectionCache = new Map();
const projectionInFlight = new Map();

async function cachedProjectedJson(url, projector, fallback, timeoutMs = 8000, ttlMs = 60_000) {
  const cached = projectionCache.get(url);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...projector(cached.body), latencyMs: 0, cache: 'fresh' };
  }
  let pending = projectionInFlight.get(url);
  if (!pending) pending = (async () => {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, timeoutMs);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
      projectionCache.set(url, { body, expiresAt: Date.now() + ttlMs });
      return { body, latencyMs: Date.now() - startedAt, cache: 'refreshed' };
    } catch (error) {
      if (cached) return { body: cached.body, latencyMs: Date.now() - startedAt, cache: 'stale', error: error.message };
      return { body: null, latencyMs: Date.now() - startedAt, cache: 'unavailable', error: error.message };
    } finally {
      projectionInFlight.delete(url);
    }
  })();
  if (!projectionInFlight.has(url)) projectionInFlight.set(url, pending);
  const result = await pending;
  const metadata = {
    latencyMs: result.latencyMs,
    cache: result.cache,
    ...(result.error ? { error: result.error } : {})
  };
  return result.body === null
    ? { ...fallback, ...metadata }
    : { ...projector(result.body), ...metadata };
}

function hermesCrew(body = {}) {
  const telegram = body.gateway?.platforms?.telegram || {};
  const running = body.ok === true && body.gateway?.running === true;
  const connected = telegram.state === 'connected';
  const freshness = body.gateway?.freshness;
  const stale = freshness?.fresh === false;
  const degraded = running && (stale || (telegram.state && !connected));
  return {
    id: 'hermes',
    name: 'Hermès',
    role: 'External runtime · local memory source',
    status: running ? (degraded ? 'degraded' : 'ok') : 'down',
    detail: !running
      ? 'supervision gateway unavailable'
      : stale
        ? 'supervision online · Telegram evidence stale'
        : `supervision online${connected ? ' · Telegram connected' : ''}`,
    updatedAt: telegram.updated_at || body.gateway?.updatedAt || null,
    href: '/agent-ops'
  };
}

function fleetSummary(body = {}) {
  const data = body.data || body;
  const health = data.health || {};
  const hosts = Array.isArray(data.cluster) ? data.cluster.map((host) => {
    const models = Array.isArray(host?.models) ? host.models : [];
    return {
      id: cleanText(host?.hostKey || 'unknown', 32),
      name: FLEET_LABELS[host?.hostKey] || cleanText(host?.hostKey || 'Unknown host', 64),
      status: host?.status === 'online' ? 'ok' : 'down',
      models: models.length,
      primaryModel: cleanText(models[0] || '', 160),
      latencyMs: Number(host?.latency || 0)
    };
  }) : [];
  const configuredHosts = Math.max(0, Number(health.configuredHosts || hosts.length));
  const onlineHosts = Math.max(0, Number(health.onlineHosts || hosts.filter((host) => host.status === 'ok').length));
  const attention = (data.operationalAttention?.issues || [])
    .filter((issue) => issue.code !== 'active_alerts')
    .map((issue) => cleanText(issue.message, 240));
  for (const alert of (data.alerts || []).filter((entry) => entry.status === 'active').slice(0, 5)) {
    attention.push(cleanText(alert.title || alert.ruleName || 'Alerte active', 240));
  }
  if (data.health?.status !== 'ok' && !attention.length) attention.push('État opérationnel à vérifier');
  return {
    status: configuredHosts > 0 && hosts.length === configuredHosts && hosts.every((host) => host.status === 'ok') ? 'ok' : 'degraded',
    attention: attention.filter(Boolean).slice(0, 5),
    configuredHosts,
    onlineHosts,
    observedModels: Math.max(0, Number(health.observedModels || 0)),
    hosts
  };
}

module.exports = {
  FLEET_LABELS,
  serviceHealth,
  projectedJson,
  projectionCache,
  projectionInFlight,
  cachedProjectedJson,
  hermesCrew,
  fleetSummary
};
