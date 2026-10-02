/**
 * Host test outbound operations.
 *
 * Registered Ollama/Core operations, the governed executor singleton used by
 * every host-test request, abort/deadline helpers and the host connectivity
 * check. Re-exported by ./hostTestService.
 */

const nodeFetch                = require('node-fetch');
const { getConfiguredHosts }   = require('../helpers/ollamaHostConfig');
const {
  admitOllamaTarget,
  admitOllamaTargetResolved
} = require('../helpers/ollamaTargetAdmission');
const { createNodeFetchPeerTransport } = require('../helpers/outboundHttpTransport');
const {
  OUTBOUND_ERROR_CODES,
  createOutboundHttpExecutor,
  readBoundedJson
} = require('../../../shared/outboundHttpExecutor');

// Host test warm-up routes through core's /api/inference/generate. The
// scoped Benchmark credential authenticates
// `callerDetail: 'benchmark-host-test-<model>'` for the **direct lane**
// (no probe, no gate, no Mongo, async telemetry) —
// keeping warmup low-overhead while preserving telemetry.
// The probe call itself (further down) stays direct — probing needs
// clean timing measurements unaffected by queueing. /api/ps and /api/tags
// metadata also stay direct — they're not inference.
const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const circuitBreaker           = require('../helpers/circuitBreaker');

const HOST_TEST_OPERATIONS = Object.freeze({
  TAGS: 'benchmark.host-test.tags',
  LOADED_PS: 'benchmark.host-test.loaded-ps',
  UNLOAD_PS: 'benchmark.host-test.unload-ps',
  UNLOAD_CURRENT: 'benchmark.host-test.unload-current',
  UNLOAD_ONE: 'benchmark.host-test.unload-one',
  WARMUP: 'benchmark.host-test.warmup',
  PROBE: 'benchmark.host-test.probe'
});

function operation(method, pathPattern, {
  deadlineMs,
  maxRequestBytes = 0,
  maxResponseBytes,
  responseMode
}) {
  return Object.freeze({
    allowSearch: false,
    method,
    pathPattern,
    responseMode,
    policy: Object.freeze({
      authoritySource: 'request-admitted',
      deadlineMs,
      maxRequestBytes,
      maxResponseBytes
    })
  });
}

const HOST_TEST_OPERATION_SPECS = Object.freeze({
  [HOST_TEST_OPERATIONS.TAGS]: operation('GET', '^/api/tags$', {
    deadlineMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.LOADED_PS]: operation('GET', '^/api/ps$', {
    deadlineMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.UNLOAD_PS]: operation('GET', '^/api/ps$', {
    deadlineMs: 5_000,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.UNLOAD_CURRENT]: operation('POST', '^/api/generate$', {
    deadlineMs: 15_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.UNLOAD_ONE]: operation('POST', '^/api/generate$', {
    deadlineMs: 15_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.WARMUP]: operation('POST', '^/api/(?:inference/)?generate$', {
    deadlineMs: 600_000,
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    responseMode: 'json'
  }),
  [HOST_TEST_OPERATIONS.PROBE]: operation('POST', '^/api/generate$', {
    deadlineMs: 600_000,
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    responseMode: 'json'
  })
});

function configuredCoreOrigin(coreUrl = CORE_URL) {
  let parsed;
  try {
    parsed = new URL(coreUrl);
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

function operationMatches(spec, method, target) {
  return spec.method === method
    && new RegExp(spec.pathPattern).test(target.pathname)
    && (spec.allowSearch || !target.search);
}

function assertRegisteredOperation(operationId, method, target) {
  const spec = HOST_TEST_OPERATION_SPECS[operationId];
  if (!spec || !operationMatches(spec, method, target)) {
    throw new Error('Host test outbound operation is not registered');
  }
  return spec;
}

function createHostTestExecutor(options = {}) {
  const admitTarget = options.admitOllamaTargetResolved || admitOllamaTargetResolved;
  const configuredHosts = options.getConfiguredHosts || getConfiguredHosts;
  const coreUrl = options.coreUrl || CORE_URL;

  return createOutboundHttpExecutor({
    operations: Object.fromEntries(Object.entries(HOST_TEST_OPERATION_SPECS)
      .map(([operationId, spec]) => [operationId, spec.policy])),
    authorityAdapter: async ({ sinkId, target }) => {
      const spec = HOST_TEST_OPERATION_SPECS[sinkId];
      const requested = new URL(target);
      if (!spec
        || !new RegExp(spec.pathPattern).test(requested.pathname)
        || (!spec.allowSearch && requested.search)) {
        throw new Error('Host test outbound target is not registered');
      }

      if (sinkId === HOST_TEST_OPERATIONS.WARMUP
        && requested.pathname === '/api/inference/generate') {
        const coreOrigin = configuredCoreOrigin(coreUrl);
        if (requested.origin !== coreOrigin) {
          throw new Error('Host test Core warm-up target is not configured');
        }
        return { expectedOrigin: coreOrigin };
      }

      const expectedOrigin = await admitTarget(requested.origin, {
        configuredHosts: configuredHosts()
      });
      if (requested.origin !== expectedOrigin) {
        throw new Error('Host test Ollama target is not admitted');
      }
      return { expectedOrigin };
    },
    fetchImpl: options.fetchImpl || nodeFetch,
    transportAdapter: options.transportAdapter || createNodeFetchPeerTransport()
  });
}

const { createHostTestRequest } = require('./hostTestRuntimeTransport');
const hostTestExecutor = createHostTestExecutor();
const hostTestRequest = createHostTestRequest({ assertRegisteredOperation, hostTestExecutor });

function createLocalDeadline(timeoutMs, maximumMs) {
  const parsed = Number(timeoutMs);
  const durationMs = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.round(parsed), maximumMs)
    : maximumMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
    get expired() { return controller.signal.aborted; }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function legacyHttpErrorMessage(error) {
  return error?.code === OUTBOUND_ERROR_CODES.REDIRECT_REJECTED
    && Number.isInteger(error.status)
    ? `HTTP ${error.status}`
    : error.message;
}

/**
 * Check host connectivity and return model list.
 * @param {string} hostUrl
 * @returns {Promise<{ available: boolean, models: string[], latency: number, error?: string }>}
 */
async function checkHost(hostUrl, options = {}) {
  const admitTarget = options.admitOllamaTargetResolved || admitOllamaTargetResolved;
  const admitOrigin = options.admitOllamaTarget || admitOllamaTarget;
  const configuredHosts = options.getConfiguredHosts || getConfiguredHosts;
  const executor = options.executor || (
    options.fetchImpl || options.transportAdapter || options.admitOllamaTargetResolved
      ? createHostTestExecutor({
        admitOllamaTargetResolved: admitTarget,
        coreUrl: options.coreUrl,
        fetchImpl: options.fetchImpl,
        getConfiguredHosts: configuredHosts,
        transportAdapter: options.transportAdapter
      })
      : hostTestExecutor
  );
  try {
    hostUrl = admitOrigin(hostUrl, { configuredHosts: configuredHosts() });
  } catch (error) {
    return { available: false, models: [], latency: 0, error: error.message };
  }

  // Circuit breaker gate
  const gate = circuitBreaker.canRequest(hostUrl);
  if (!gate.allowed) {
    return { available: false, models: [], latency: 0, error: gate.reason };
  }

  const start = Date.now();
  try {
    const url = `${hostUrl}/api/tags`;
    const res = await hostTestRequest(HOST_TEST_OPERATIONS.TAGS, url, {
      method: 'GET',
      signal: options.signal
    }, executor);
    if (!res.ok) {
      // Preserve the legacy status-first connectivity result.  Draining an
      // untrusted error body can otherwise turn an immediate HTTP failure into
      // a response-read timeout or byte-limit error.
      await res.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await readBoundedJson(res);
    const models = (data.models || [])
      .filter(m => {
        const name   = m.name.toLowerCase();
        const family = (m.details?.family || '').toLowerCase();
        if (name.includes('embed') || name.includes('nomic') || name.includes('bert')) return false;
        if (family === 'bert' || family === 'nomic-bert') return false;
        if (name.includes('diagnostic')) return false;
        return true;
      })
      .map(m => m.name.replace(/:latest$/, ''));
    circuitBreaker.recordSuccess(hostUrl);
    return { available: true, models, latency: Date.now() - start };
  } catch (err) {
    circuitBreaker.recordFailure(hostUrl);
    return {
      available: false,
      models: [],
      latency: Date.now() - start,
      error: legacyHttpErrorMessage(err)
    };
  }
}

function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean);
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Profiler claim stopped while host request was running');
  error.code = 'BENCHMARK_CLAIM_STOPPED';
  throw error;
}

module.exports = {
  CORE_URL,
  HOST_TEST_OPERATIONS,
  HOST_TEST_OPERATION_SPECS,
  configuredCoreOrigin,
  operationMatches,
  createHostTestExecutor,
  hostTestExecutor,
  hostTestRequest,
  createLocalDeadline,
  legacyHttpErrorMessage,
  checkHost,
  combineAbortSignals,
  throwIfAborted
};
