'use strict';

const { buildAgentOpsProjection, fetchJson } = require('./agent-ops/projection');
const { getHermesStatusEvidence } = require('./operations');
const {
  collectOpenClawCronEvidence,
  getOpenClawRuntimeEvidence
} = require('./openclaw/runtimeEvidence');

function cachedProvider(provider, ttlMs) {
  let cache = null;
  let expiresAt = 0;
  let inFlight = null;
  let generation = 0;
  return async function read(options = {}) {
    if (!options.refresh && cache && Date.now() < expiresAt) return cache;
    if (!options.refresh && inFlight) return inFlight;
    const currentGeneration = ++generation;
    let pending;
    pending = provider(options)
      .then((value) => {
        if (currentGeneration === generation) {
          cache = value;
          expiresAt = Date.now() + ttlMs;
        }
        return value;
      })
      .finally(() => { if (inFlight === pending) inFlight = null; });
    inFlight = pending;
    return pending;
  };
}

function openClawStatusProjection(evidence = {}) {
  const status = evidence.status || {};
  return {
    status: status.online ? 'online' : 'offline',
    authority: evidence.authority,
    source: evidence.source,
    runtimeVersion: status.runtimeVersion,
    gateway: status.gateway,
    gatewayService: status.gatewayService,
    agents: status.agents,
    sessions: status.sessions?.count || 0,
    timestamp: evidence.generatedAt,
    controlUi: null
  };
}

function openClawCronProjection(evidence = {}) {
  return {
    data: Array.isArray(evidence.cron?.jobs) ? evidence.cron.jobs : [],
    count: Math.max(0, Number(evidence.cron?.count) || 0),
    authority: evidence.authority || 'official-openclaw-cli'
  };
}

function createAioOpsEvidenceService(options = {}) {
  const agentOpsBuilder = options.agentOpsBuilder || buildAgentOpsProjection;
  const openClawProvider = options.openClawProvider || getOpenClawRuntimeEvidence;
  const cronProvider = options.cronProvider || collectOpenClawCronEvidence;
  const hermesProvider = cachedProvider(options.hermesProvider || getHermesStatusEvidence, options.hermesTtlMs || 15_000);
  const cronTtlMs = options.cronTtlMs || 15_000;
  const activeCronProvider = cachedProvider(
    (readOptions) => cronProvider({ ...readOptions, includeDisabledCron: false }),
    cronTtlMs
  );
  const disabledCronProvider = cachedProvider(
    (readOptions) => cronProvider({ ...readOptions, includeDisabledCron: true }),
    cronTtlMs
  );
  const productBaseUrl = String(options.productBaseUrl || `http://127.0.0.1:${process.env.PORT || 3080}`).replace(/\/+$/, '');
  const productFetch = options.productFetch || ((route) => fetchJson(productBaseUrl, route, options));

  async function projectionFetch(route) {
    if (route !== '/api/hermes/status') return productFetch(route);
    const startedAt = Date.now();
    try {
      return {
        ok: true,
        statusCode: 200,
        body: await hermesProvider(),
        durationMs: Date.now() - startedAt,
        error: null
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: error.status || 502,
        body: { ok: false, error: error.message },
        durationMs: Date.now() - startedAt,
        error: error.message
      };
    }
  }

  const agentOpsProvider = cachedProvider(
    () => agentOpsBuilder({
      fetchJson: projectionFetch,
      getOpenClawRuntimeEvidence: openClawProvider
    }),
    options.agentOpsTtlMs || 15_000
  );

  return Object.freeze({
    contractVersion: 1,
    getAgentOpsProjection: agentOpsProvider,
    getHermesStatusEvidence: hermesProvider,
    getOpenClawRuntimeEvidence: openClawProvider,
    async getOpenClawCronEvidence({ includeDisabled = false, refresh = false } = {}) {
      return (includeDisabled ? disabledCronProvider : activeCronProvider)({ refresh });
    },
    async getOpenClawStatusProjection(options = {}) {
      return openClawStatusProjection(await openClawProvider(options));
    },
    async getOpenClawCronProjection(options = {}) {
      const provider = options.includeDisabled === true ? disabledCronProvider : activeCronProvider;
      return openClawCronProjection(await provider({ refresh: options.refresh === true }));
    }
  });
}

module.exports = {
  cachedProvider,
  createAioOpsEvidenceService,
  openClawCronProjection,
  openClawStatusProjection
};
