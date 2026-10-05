'use strict';

const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::', '[::]']);
const RESIDENCIES = new Set(['gpu', 'cpu']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseHostFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase();
  } catch {
    const match = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return match ? match[1].toLowerCase() : null;
  }
}

function normalizeHostUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (WILDCARD_HOSTNAMES.has(parsed.hostname)) parsed.hostname = '127.0.0.1';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return withScheme;
  }
}

function isWildcardHostUrl(raw) {
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return WILDCARD_HOSTNAMES.has(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

function parseHostIp(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    const match = String(urlStr || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return match ? match[1] : null;
  }
}

function hostUrlKey(raw) {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    let hostname = parsed.hostname.toLowerCase();
    if (LOOPBACK_HOSTNAMES.has(hostname)) hostname = 'localhost';
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${hostname}:${port}`;
  } catch {
    return normalized.toLowerCase();
  }
}

// `host=MB` or `host:port=MB`, comma separated. A port-qualified entry wins,
// so a GPU and a CPU Ollama instance on the same machine stay distinct.
function parseHostVramMap(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const entry of String(raw).split(',')) {
    const index = entry.lastIndexOf('=');
    if (index <= 0) continue;
    const host = entry.slice(0, index).trim().toLowerCase();
    const vramMb = Number.parseInt(entry.slice(index + 1).trim(), 10);
    if (host && Number.isFinite(vramMb) && vramMb > 0) map.set(host, vramMb);
  }
  return map;
}

function lookupHostVramMb(map, hostUrl) {
  const host = parseHostFromUrl(hostUrl);
  if (!host) return 0;
  let port = '';
  try { port = new URL(normalizeHostUrl(hostUrl)).port || '11434'; } catch { port = ''; }
  return (port && map.get(`${host}:${port}`)) || map.get(host) || 0;
}

const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function normalizeRegisteredHost(raw) {
  const url = normalizeHostUrl(raw?.url);
  const id = String(raw?.id || raw?.hostId || '').trim().toLowerCase();
  if (!url || !HOST_ID_PATTERN.test(id)) return null;
  const maxInflight = Number(raw.maxInflight);
  return {
    id,
    name: String(raw.name || '').trim(),
    url,
    priority: Number.isSafeInteger(Number(raw.priority)) && Number(raw.priority) > 0 ? Number(raw.priority) : 0,
    vramMb: Number(raw.vramMb) > 0 ? Number(raw.vramMb) : 0,
    residency: RESIDENCIES.has(raw.residency) ? raw.residency : 'gpu',
    maxInflight: Number.isSafeInteger(maxInflight) && maxInflight > 0 ? maxInflight : null,
    pinThreads: normalizePinThreads(raw.pinThreads)
  };
}

// CPU threads per pinned model, as Core's host registry publishes them.
function modelKey(name) {
  const value = String(name || '').trim().toLowerCase();
  return value && !value.includes(':') ? `${value}:latest` : value;
}

function normalizePinThreads(raw) {
  const threads = {};
  for (const [model, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (modelKey(model) && Number.isSafeInteger(value) && value > 0 && value <= 256) threads[modelKey(model)] = value;
  }
  return threads;
}

function createOllamaHostConfig({ readDotenv = () => ({}), readFallbackHosts = () => [] } = {}) {
  function values() {
    return { env: process.env, dotenv: readDotenv() || {} };
  }

  function firstValue(keys, { allowWildcard = true } = {}) {
    const sources = values();
    let wildcardFallback = null;
    for (const source of [sources.env, sources.dotenv]) {
      for (const key of keys) {
        const raw = source[key];
        if (!raw || !String(raw).trim()) continue;
        const trimmed = String(raw).trim();
        if (!isWildcardHostUrl(trimmed)) return trimmed;
        if (allowWildcard && !wildcardFallback) wildcardFallback = trimmed;
      }
    }
    return wildcardFallback;
  }

  function textValue(keys, fallback) {
    const sources = values();
    for (const source of [sources.env, sources.dotenv]) {
      for (const key of keys) {
        const raw = source[key];
        if (raw && String(raw).trim()) return String(raw).trim();
      }
    }
    return fallback;
  }

  function hostVramMap() {
    return parseHostVramMap(firstValue(['OLLAMA_HOST_VRAM_MAP']));
  }

  function resolveHostVramMb(hostUrl, fallback = 0) {
    return lookupHostVramMb(hostVramMap(), hostUrl) || fallback || 0;
  }

  // Hosts the operator registered at runtime (Core's inference host registry).
  // A synchronous snapshot keeps every existing caller synchronous.
  let registeredHosts = [];

  function setRegisteredHosts(list) {
    registeredHosts = (Array.isArray(list) ? list : [])
      .map(normalizeRegisteredHost)
      .filter(Boolean);
    return registeredHosts.length;
  }

  function registeredFor(url) {
    const key = hostUrlKey(url);
    return registeredHosts.find(host => hostUrlKey(host.url) === key) || null;
  }

  function getConfiguredHosts() {
    const definitions = [
      {
        id: 'primary',
        urlKeys: ['OLLAMA_HOST', 'OLLAMA_HOST_1', 'OLLAMA_HOST_PRIMARY'],
        nameKeys: ['OLLAMA_HOST_NAME', 'OLLAMA_HOST_1_NAME', 'OLLAMA_HOST_PRIMARY_NAME'],
        defaultName: 'Local Ollama'
      },
      {
        id: 'secondary',
        urlKeys: ['OLLAMA_HOST_2', 'OLLAMA_HOST_HEAVY', 'OLLAMA_HOST_SECONDARY'],
        nameKeys: ['OLLAMA_HOST_2_NAME', 'OLLAMA_HOST_HEAVY_NAME', 'OLLAMA_HOST_SECONDARY_NAME'],
        defaultName: 'Ollama 2'
      },
      {
        id: 'tertiary',
        urlKeys: ['OLLAMA_HOST_3', 'OLLAMA_HOST_TERTIARY'],
        nameKeys: ['OLLAMA_HOST_3_NAME', 'OLLAMA_HOST_TERTIARY_NAME'],
        defaultName: 'Ollama 3'
      }
    ];

    const hosts = [];
    for (const [index, definition] of definitions.entries()) {
      const url = normalizeHostUrl(firstValue(definition.urlKeys));
      if (!url) continue;
      const registered = registeredFor(url);
      hosts.push({
        id: definition.id,
        name: registered?.name || textValue(definition.nameKeys, definition.defaultName),
        url,
        priority: index + 1,
        vramMb: registered?.vramMb || resolveHostVramMb(url),
        residency: registered?.residency || 'gpu',
        maxInflight: registered?.maxInflight || null,
        source: 'env'
      });
    }
    // Env slots only bootstrap the first hosts; any number may be registered.
    for (const host of registeredHosts) {
      if (hosts.some(existing => hostUrlKey(existing.url) === hostUrlKey(host.url))) continue;
      if (hosts.some(existing => existing.id === host.id)) continue;
      hosts.push({
        ...host,
        name: host.name || host.id,
        priority: host.priority || hosts.length + 1,
        vramMb: host.vramMb || resolveHostVramMb(host.url),
        source: 'registry'
      });
    }

    if (hosts.length === 0) {
      for (const [index, host] of (readFallbackHosts() || []).entries()) {
        const url = normalizeHostUrl(host?.url);
        if (!url) continue;
        hosts.push({
          id: host.id || `config-${index}`,
          name: host.name || `Host ${index + 1}`,
          url,
          priority: host.priority || index + 1,
          vramMb: Number(host.vramMb) > 0 ? Number(host.vramMb) : 0,
          residency: RESIDENCIES.has(host.residency) ? host.residency : 'gpu',
          maxInflight: null,
          source: 'config-file'
        });
      }
    }
    return hosts;
  }

  function getHostUrls() {
    return getConfiguredHosts().map(host => host.url);
  }

  function validateHostUrl(input) {
    const configured = getConfiguredHosts();
    const allowed = configured.map(host => host.url);
    if (input === undefined || input === null || !String(input).trim()) {
      return { valid: true, host: null, allowed, message: null };
    }

    const raw = String(input).trim();
    for (const host of configured) {
      if (raw === host.id || raw.toLowerCase() === String(host.name || '').toLowerCase()) {
        return { valid: true, host: host.url, allowed, message: null };
      }
    }

    const key = hostUrlKey(raw);
    const match = configured.find(host => hostUrlKey(host.url) === key);
    if (match) return { valid: true, host: match.url, allowed, message: null };

    return {
      valid: false,
      host: null,
      allowed,
      message: `Host "${raw}" is not in the configured allowlist; use one of: ${allowed.join(', ') || '(none configured)'}`
    };
  }

  function getHostResidency(hostUrl) {
    const key = hostUrlKey(hostUrl);
    if (!key) return 'gpu';
    return getConfiguredHosts().find(host => hostUrlKey(host.url) === key)?.residency || 'gpu';
  }

  // Thread count pinned for a model on a CPU-resident host, or 0.
  function getHostPinThreads(hostUrl, model) {
    const host = registeredFor(hostUrl);
    return host?.residency === 'cpu' ? host.pinThreads[modelKey(model)] || 0 : 0;
  }

  return {
    normalizeHostUrl,
    getConfiguredHosts,
    getHostResidency,
    getHostPinThreads,
    setRegisteredHosts,
    resolveHostVramMb,
    getHostUrls,
    parseHostIp,
    validateHostUrl,
    hostUrlKey,
    isConfigured: () => getConfiguredHosts().length > 0
  };
}

module.exports = {
  HOST_ID_PATTERN,
  RESIDENCIES,
  createOllamaHostConfig,
  lookupHostVramMb,
  normalizeRegisteredHost,
  parseHostVramMap,
  hostUrlKey,
  normalizeHostUrl,
  parseHostIp
};
