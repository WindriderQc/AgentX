/**
 * Core model registry, public config and host preference (dedication) calls.
 */

const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS, PIN_RESTORE_TIMEOUT_MS } = require('./coreOperations');

/**
 * GET /api/models/registry — list active models from core's model registry.
 *
 * @param {Object} [query] - Optional filters: category, tag, vendor, status
 * @returns {Promise<Object[]>} Array of model registry entries
 */
async function getModelRegistries(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null) params.set(key, value);
  }
  const qs = params.toString();
  const path = `/api/models/registry${qs ? `?${qs}` : ''}`;

  const data = await coreRequest(path, { operationId: CORE_OPERATIONS.MODEL_REGISTRIES });
  return data.data?.models || [];
}

/**
 * GET /api/models/registry/:name — get a single model by name.
 *
 * @param {string} name - Model name
 * @returns {Promise<Object|null>} Model registry entry or null
 */
async function getModelRegistryByName(name, options = {}) {
  try {
    const params = new URLSearchParams();
    if (options.host) params.set('host', options.host);
    const qs = params.toString();
    const data = await coreRequest(`/api/models/registry/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`, {
      operationId: CORE_OPERATIONS.MODEL_REGISTRY,
      signal: options.signal,
    });
    return data.data?.model || data.data || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * GET /api/config — resolve Core-owned public browser URLs. The shared browser
 * resolver receives this as an injected loader so Benchmark never invokes its
 * generic raw-fetch fallback at runtime.
 */
async function loadCorePublicConfig({ signal } = {}) {
  return coreRequest('/api/config', {
    operationId: CORE_OPERATIONS.PUBLIC_CONFIG,
    signal,
  });
}

// ── GPU Host Preferences (Nerve Center) ─────────────────────────────────────

/**
 * GET /api/nerve-center/host-preferences — all host preferences with live status.
 * Returns array of { hostUrl, defaultModels, live, ... }
 * Normalised to a common shape so callers can use .host and .pinnedModels
 * the same way they did with the old sovereignty endpoint.
 * @returns {Promise<Object[]>} Array of { host, pinnedModels, ... }
 */
async function getDedicationStatuses() {
  const data = await coreRequest('/api/nerve-center/host-preferences', {
    operationId: CORE_OPERATIONS.HOST_PREFERENCES,
  });
  const prefs = Array.isArray(data) ? data : (data.data || []);
  return prefs.map(p => ({
    host: p.hostUrl,
    pinnedModels: p.defaultModels || [],
    state: p.live?.defaultLoaded ? 'ready' : 'unloaded',
    ...p
  }));
}

/**
 * Resolve a host URL to its Nerve Center hostKey.
 * Kept for backward compatibility — callers that already have a hostKey
 * can still use it, but reloadDedication no longer needs it.
 * @param {string} hostUrl - full Ollama base URL
 * @returns {Promise<string|null>} hostKey, or null if not found
 */
async function resolveHostKey(hostUrl) {
  const prefs = await getDedicationStatuses();
  const normalized = hostUrl.replace(/\/+$/, '');
  const match = prefs.find(p => (p.hostUrl || p.host || '').replace(/\/+$/, '') === normalized);
  return match?.hostKey || null;
}

/**
 * POST /api/nerve-center/host-preferences/:hostUrl/reload — reload default models.
 * @param {string} hostUrlOrKey - host URL (preferred) or legacy hostKey (ignored gracefully)
 */
async function restoreDedication(hostUrlOrKey) {
  // The new endpoint takes a hostUrl, not a hostKey.
  // If a bare key like "primary" was passed, resolve it first.
  let hostUrl = hostUrlOrKey;
  if (!hostUrlOrKey.startsWith('http')) {
    const prefs = await getDedicationStatuses();
    const match = prefs.find(p => p.hostKey === hostUrlOrKey);
    hostUrl = match?.hostUrl || hostUrlOrKey;
  }
  return coreRequest(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/reload`, {
    method: 'POST',
    operationId: CORE_OPERATIONS.HOST_RELOAD,
    timeout: PIN_RESTORE_TIMEOUT_MS
  });
}

module.exports = {
  getModelRegistries,
  getModelRegistryByName,
  loadCorePublicConfig,
  getDedicationStatuses,
  resolveHostKey,
  restoreDedication,
};
