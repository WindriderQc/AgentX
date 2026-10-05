const logger = require('../../config/logger');
const clusterScheduleService = require('../services/clusterScheduleService');
const { getConfiguredHosts } = require('./ollamaHostConfig');

function getConfiguredHostById(hostId) {
  return getConfiguredHosts().find((host) => host.id === hostId) || null;
}

function getConfiguredHostByUrl(hostUrl) {
  return getConfiguredHosts().find((host) => host.url === hostUrl) || null;
}

function buildFallbackResolution({ fallbackHostId, fallbackHostUrl, fallbackReason = 'Static fallback' } = {}) {
  const hostById = fallbackHostId ? getConfiguredHostById(fallbackHostId) : null;
  const hostByUrl = fallbackHostUrl ? getConfiguredHostByUrl(fallbackHostUrl) : null;
  const host = hostById || hostByUrl || null;

  return {
    source: 'fallback',
    hostId: host?.id || fallbackHostId || null,
    hostUrl: host?.url || fallbackHostUrl || null,
    reason: fallbackReason,
    claimId: null,
    claimExpiresAt: null,
    recommendation: null
  };
}

function modelInstalledOn(hostUrl, model) {
  return require('../services/routing/inferenceAttemptExecutor').modelExistsOnHost(hostUrl, model);
}

async function resolveAdvisoryHost(options = {}) {
  const {
    model,
    caller = 'unknown',
    durationMs = 30000,
    priority = 'normal',
    createSoftClaim = false,
    claimTtlMs = 30000,
    fallbackHostId = null,
    fallbackHostUrl = null,
    fallbackReason
  } = options;

  const fallback = buildFallbackResolution({ fallbackHostId, fallbackHostUrl, fallbackReason });

  if (!model) {
    return fallback;
  }

  try {
    const recommendation = await clusterScheduleService.recommendHost(model, durationMs, priority);
    if (!recommendation?.hostUrl) {
      if (recommendation?.blockedByBenchmarkClaim) {
        return {
          source: 'scheduler-blocked',
          hostId: null,
          hostUrl: null,
          reason: recommendation.reason || 'All online Ollama hosts are held by active benchmark claims',
          claimId: null,
          claimExpiresAt: null,
          recommendation
        };
      }
      return {
        ...fallback,
        reason: recommendation?.reason || fallback.reason,
        recommendation: recommendation || null
      };
    }

    // The scheduler scores residency and VRAM, not installation. A placement
    // away from the configured host is kept only when that host has the model;
    // otherwise its Ollama would answer "model not found" for a busy primary.
    if (fallback.hostUrl && recommendation.hostUrl !== fallback.hostUrl
      && !(await modelInstalledOn(recommendation.hostUrl, model))) {
      const configuredHostClaimed = (recommendation._scored || []).some((entry) => entry.host === fallback.hostId
        && (entry.reasons || []).includes('benchmarking in progress'));
      logger.info('Scheduler placement lacks the model; keeping the configured host', {
        caller, model, placement: recommendation.host, configuredHost: fallback.hostId, configuredHostClaimed
      });
      if (configuredHostClaimed) {
        return {
          source: 'scheduler-blocked',
          hostId: null,
          hostUrl: null,
          reason: `${model} is only installed on ${fallback.hostId}, which is held by an active benchmark claim`,
          claimId: null,
          claimExpiresAt: null,
          recommendation: { ...recommendation, blockedByBenchmarkClaim: true }
        };
      }
      return {
        ...fallback,
        reason: `${model} is not installed on ${recommendation.host}; using the configured host`,
        recommendation
      };
    }

    let claimId = null;
    let claimExpiresAt = null;
    if (createSoftClaim && recommendation.host) {
      const claim = await clusterScheduleService.createClaim(recommendation.host, model, caller, claimTtlMs);
      claimId = claim.claimId;
      claimExpiresAt = claim.expiresAt;
    }

    return {
      source: 'scheduler',
      hostId: recommendation.host,
      hostUrl: recommendation.hostUrl,
      reason: recommendation.reason,
      claimId,
      claimExpiresAt,
      recommendation
    };
  } catch (error) {
    logger.warn('Scheduler advisory lookup failed, using fallback host', {
      caller,
      model,
      error: error.message
    });
    return fallback;
  }
}

module.exports = {
  buildFallbackResolution,
  getConfiguredHostById,
  getConfiguredHostByUrl,
  resolveAdvisoryHost
};
