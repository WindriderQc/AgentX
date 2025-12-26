const { URL } = require('url');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

class DataApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'DataApiError';
    this.status = status;
    this.body = body;
  }
}

function getBaseUrl() {
  const raw = process.env.DATAAPI_BASE_URL || '';
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function getApiKey() {
  return process.env.DATAAPI_API_KEY || null;
}

function buildUrl(pathname, query) {
  const base = getBaseUrl();
  if (!base) {
    throw new DataApiError('DATAAPI_BASE_URL is not configured');
  }

  const url = new URL(base + pathname);
  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

async function requestJson(method, pathname, { query, body, timeoutMs = 30000 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new DataApiError('DATAAPI_API_KEY is not configured');
  }

  const url = buildUrl(pathname, query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const text = await resp.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (_e) {
      parsed = text;
    }

    if (!resp.ok) {
      const msg = typeof parsed === 'object' && parsed && parsed.message
        ? parsed.message
        : `DataAPI request failed (${resp.status})`;
      throw new DataApiError(msg, { status: resp.status, body: parsed });
    }

    return parsed;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new DataApiError(`DataAPI request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const dataapi = {
  files: {
    search: async ({ q, limit = 50, skip = 0 } = {}) => {
      return requestJson('GET', '/api/v1/files/search', { query: { q, limit, skip } });
    },
    duplicates: async () => {
      return requestJson('GET', '/api/v1/files/duplicates');
    },
    stats: async () => {
      return requestJson('GET', '/api/v1/files/stats');
    },
    tree: async ({ root = '/' } = {}) => {
      return requestJson('GET', '/api/v1/files/tree', { query: { root } });
    },
    cleanupRecommendations: async () => {
      return requestJson('GET', '/api/v1/files/cleanup-recommendations');
    },
    exportOptimized: async ({ type = 'summary' } = {}) => {
      return requestJson('GET', `/api/v1/files/export-optimized/${encodeURIComponent(type)}`);
    },
    export: async ({ type = 'summary', format = 'json' } = {}) => {
      // DataAPI uses query params for type/format
      return requestJson('POST', '/api/v1/files/export', { query: { type, format } });
    },
    exportsList: async () => {
      return requestJson('GET', '/api/v1/files/exports');
    }
  },
  storage: {
    scanStart: async ({ roots, extensions, batch_size } = {}) => {
      return requestJson('POST', '/api/v1/storage/scan', { body: { roots, extensions, batch_size }, timeoutMs: 60000 });
    },
    scanStatus: async ({ scan_id } = {}) => {
      return requestJson('GET', `/api/v1/storage/status/${encodeURIComponent(scan_id)}`);
    },
    scansList: async ({ limit = 10, skip = 0 } = {}) => {
      return requestJson('GET', '/api/v1/storage/scans', { query: { limit, skip } });
    },
    scanStop: async ({ scan_id } = {}) => {
      return requestJson('POST', `/api/v1/storage/stop/${encodeURIComponent(scan_id)}`);
    }
  },
  live: {
    iss: async () => requestJson('GET', '/api/v1/iss'),
    quakes: async () => requestJson('GET', '/api/v1/quakes'),
    pressure: async () => requestJson('GET', '/api/v1/pressure'),
    weather: async () => requestJson('GET', '/api/v1/weather')
  }
};

module.exports = {
  dataapi,
  DataApiError
};
