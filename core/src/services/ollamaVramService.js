'use strict';

const HostPreference = require('../../models/HostPreference');
const { hostUrlKey, normalizeHostUrl, parseHostVramMap: sharedParseHostVramMap, lookupHostVramMb } = require('../../../shared/ollamaHostConfig');

function parseHostFromUrl(hostUrl) {
  try {
    return new URL(hostUrl).hostname.toLowerCase();
  } catch {
    const match = String(hostUrl || '').match(/^(?:https?:\/\/)?([^/:]+)(?::\d+)?/i);
    return match ? match[1].toLowerCase() : null;
  }
}

function parseHostVramMap() {
  return sharedParseHostVramMap(process.env.OLLAMA_HOST_VRAM_MAP);
}

async function getStaticVram(host) {
  const hostKey = parseHostFromUrl(host);
  if (!hostKey) return null;

  try {
    // Exact endpoint: two Ollama instances of one machine are two hosts.
    const preference = await HostPreference.findOne({ hostUrl: normalizeHostUrl(host) }).lean();
    if (Number(preference?.vramTotalMiB) > 0) {
      return {
        ok: true,
        _source: 'configured-profile',
        host: hostKey,
        memoryTotalMiBTotal: Number(preference.vramTotalMiB),
        memoryUsedMiBTotal: 0,
        gpus: [],
        collectedAt: preference.updatedAt?.toISOString?.() || new Date().toISOString()
      };
    }
  } catch {
    // An unavailable product database must not trigger an infrastructure probe.
  }

  const configured = lookupHostVramMb(parseHostVramMap(), host);
  if (configured) {
    return {
      ok: true,
      _source: 'configured-environment',
      host: hostKey,
      memoryTotalMiBTotal: configured,
      memoryUsedMiBTotal: 0,
      gpus: [],
      collectedAt: new Date().toISOString()
    };
  }

  return null;
}

class OllamaVramService {
  constructor() {
    this.cache = new Map();
  }

  async getHostVram(hostUrl) {
    const host = parseHostFromUrl(hostUrl);
    const cacheKey = hostUrlKey(hostUrl);
    const cached = cacheKey ? this.cache.get(cacheKey) : null;
    if (cached) return cached;

    const configured = await getStaticVram(hostUrl);
    const value = configured || {
      ok: false,
      _source: 'none',
      host,
      gpus: [],
      memoryUsedMiBTotal: 0,
      memoryTotalMiBTotal: 0,
      collectedAt: null,
      error: 'VRAM total is not configured for this Ollama endpoint',
      actionRequired: false
    };
    if (cacheKey) this.cache.set(cacheKey, value);
    return value;
  }

  async getVramForHosts(hosts) {
    return Promise.all((hosts || []).map(async (host) => {
      const result = await this.getHostVram(host.url);
      return {
        ...host,
        host: result.host || parseHostFromUrl(host.url),
        ok: Boolean(result.ok),
        _source: result._source || 'none',
        gpus: result.gpus || [],
        memoryUsedMiBTotal: result.memoryUsedMiBTotal || 0,
        memoryTotalMiBTotal: result.memoryTotalMiBTotal || 0,
        collectedAt: result.collectedAt || null,
        error: result.error || null,
        actionRequired: false
      };
    }));
  }
}

module.exports = new OllamaVramService();
module.exports._internal = { parseHostFromUrl, parseHostVramMap, getStaticVram };
