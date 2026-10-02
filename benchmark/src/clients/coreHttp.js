/**
 * Core HTTP transport: the allowlisted, authenticated request path every
 * Benchmark call to Core goes through.
 */

const nodeFetch = require('node-fetch');
const { withBenchmarkServiceAuth } = require('../helpers/coreServiceAuth');
const { createNodeFetchPeerTransport } = require('../helpers/outboundHttpTransport');
const {
  createOutboundHttpExecutor,
  readBoundedJson,
  readBoundedText,
} = require('../../../shared/outboundHttpExecutor');
const { CORE_OPERATION_SPECS } = require('./coreOperations');

const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const SERVICE_NAME = 'benchmark';
const PROTECTED_CORE_HEADERS = new Set([
  ':authority',
  'content-type',
  'host',
  'x-agentx-benchmark-token',
  'x-service-caller',
]);

function configuredCoreOrigin() {
  let parsed;
  try {
    parsed = new URL(CORE_URL);
  } catch {
    throw new Error('Core service URL is invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash) {
    throw new Error('Core service URL is invalid');
  }
  return parsed.origin;
}

function parseCorePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Core API path is not registered');
  }
  return new URL(path, `${configuredCoreOrigin()}/`);
}

function operationMatches(spec, method, target) {
  return spec.method === method
    && new RegExp(spec.pathPattern).test(target.pathname)
    && (spec.allowSearch || !target.search);
}

function classifyCoreOperation(path, method) {
  const target = parseCorePath(path);
  const matches = Object.entries(CORE_OPERATION_SPECS)
    .filter(([, spec]) => operationMatches(spec, method, target));
  if (matches.length !== 1) throw new Error('Core API operation is not registered');
  return matches[0][0];
}

function normalizeCallerHeaders(headers) {
  if (headers === undefined || headers === null) return {};
  let entries;
  try {
    if (Array.isArray(headers)) entries = headers;
    else if (typeof headers.entries === 'function') entries = [...headers.entries()];
    else if (typeof headers === 'object') entries = Object.entries(headers);
    else throw new TypeError('invalid headers');
  } catch {
    throw new Error('Core API headers are invalid');
  }

  const normalized = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new Error('Core API headers are invalid');
    }
    const name = String(entry[0]);
    if (PROTECTED_CORE_HEADERS.has(name.toLowerCase())) {
      throw new Error('Core API protected headers cannot be overridden');
    }
    normalized[name] = entry[1];
  }
  return normalized;
}

const coreExecutor = createOutboundHttpExecutor({
  operations: Object.fromEntries(Object.entries(CORE_OPERATION_SPECS)
    .map(([operationId, spec]) => [operationId, spec.policy])),
  authorityAdapter: ({ sinkId, target }) => {
    const spec = CORE_OPERATION_SPECS[sinkId];
    const requested = new URL(target);
    const expectedOrigin = configuredCoreOrigin();
    if (!spec || requested.origin !== expectedOrigin
      || !new RegExp(spec.pathPattern).test(requested.pathname)
      || (!spec.allowSearch && requested.search)) {
      throw new Error('Core API target is not registered');
    }
    return { expectedOrigin };
  },
  fetchImpl: nodeFetch,
  transportAdapter: createNodeFetchPeerTransport(),
});

/**
 * Base fetch wrapper with service-caller header and error handling.
 */
async function coreRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const operationId = options.operationId || classifyCoreOperation(path, method);
  const spec = CORE_OPERATION_SPECS[operationId];
  const target = parseCorePath(path);
  if (!spec || !operationMatches(spec, method, target)) {
    throw new Error('Core API operation is not registered');
  }

  const {
    operationId: _operationId,
    timeout: _legacyTimeout,
    ...requestOptions
  } = options;
  const headers = withBenchmarkServiceAuth({
    ...normalizeCallerHeaders(options.headers),
    'x-service-caller': SERVICE_NAME,
    'Content-Type': 'application/json',
  });
  const receipt = await coreExecutor.admitTarget(operationId, target.href, {
    signal: requestOptions.signal,
  });
  const res = await coreExecutor.request(receipt, {
    ...requestOptions,
    method,
    headers,
  });

  if (!res.ok) {
    const body = await readBoundedText(res);
    const err = new Error(`Core API ${res.status}: ${path} — ${body.slice(0, 200)}`);
    Object.assign(err, { status: res.status, body });
    throw err;
  }

  return readBoundedJson(res);
}

module.exports = {
  coreRequest,
  classifyCoreOperation,
  configuredCoreOrigin,
  normalizeCallerHeaders,
};
