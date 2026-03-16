const ModelRegistry = require('../../../models/ModelRegistry');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { checkHost } = require('../hostTest/hostTestService');
const { detectOptimalNumCtx } = require('../modelSync/parameterDetection');

const TIER_RANK = { basic: 1, standard: 2, advanced: 3, premium: 4 };

function normalizeModelName(modelName) {
  return String(modelName || '').trim().replace(/:latest$/i, '').toLowerCase();
}

function inferJudgeTierFromName(modelName) {
  const normalized = normalizeModelName(modelName);
  if (/70b|72b|405b|671b/.test(normalized)) return 'premium';
  if (/32b|34b|30b|40b|24b|22b|20b|14b|13b/.test(normalized)) return 'advanced';
  if (/9b|8b|7b/.test(normalized)) return 'standard';
  if (/3b|2b|1\.5b/.test(normalized)) return 'basic';
  return null;
}

function resolveJudgeTier(entry) {
  const caps = entry?.capabilities || {};
  return (
    caps.curatedJudgeTier ||
    caps.recommendedJudgeTier ||
    caps.calibratedJudgeTier ||
    caps.judgeTier ||
    inferJudgeTierFromName(entry?.modelName)
  );
}

function isPotentialJudge(entry, modelName) {
  const normalized = normalizeModelName(modelName || entry?.modelName);
  const categories = Array.isArray(entry?.categories) ? entry.categories : [];
  if (categories.includes('judge')) return true;
  if (!normalized) return false;
  if (/embed|bert|diagnostic/.test(normalized)) return false;
  if (/coder/.test(normalized)) return false;
  return /(instruct|chat|reason|r1|qwen|llama|mistral|gemma|deepseek)/.test(normalized);
}

function resolveRecommendedContext(entry, host) {
  const overrides = entry?.executionOverrides || {};
  const defaults = entry?.executionDefaults || {};
  if (overrides.num_ctx != null) {
    return {
      num_ctx: overrides.num_ctx,
      source: 'override',
      reason: 'Registry override'
    };
  }

  const contextTest = entry?.contextTest || {};
  const testedNumCtx = contextTest.status === 'completed' ? contextTest.testedNumCtx : null;
  const testedHost = contextTest.hostUrl || null;
  const sourceHost = entry?.sourceHost || null;
  const sameHostTest = !!(testedNumCtx != null && testedHost && testedHost === host.url);
  const implicitSourceHostTest = !!(testedNumCtx != null && !testedHost && sourceHost && sourceHost === host.url);
  if (sameHostTest || implicitSourceHostTest) {
    return {
      num_ctx: testedNumCtx,
      source: 'context_test',
      reason: 'Probed on this host'
    };
  }

  const detection = detectOptimalNumCtx({
    parameterSize: entry?.parameterSize,
    quantization: entry?.quantization,
    modelSizeBytes: entry?.modelSizeBytes,
    hostVramMiB: host?.vramMb || null
  });

  if (defaults.num_ctx != null && (!entry?.parameterSize || detection.reason.includes('No model info available'))) {
    return {
      num_ctx: defaults.num_ctx,
      source: 'execution_default',
      reason: defaults._reason || 'Registry default'
    };
  }

  return {
    num_ctx: detection.num_ctx,
    source: host?.vramMb ? 'host_vram_estimate' : 'estimate',
    reason: detection.reason
  };
}

function scoreJudgeCandidate(candidate) {
  let score = 0;
  if (candidate.isJudgeTagged) score += 500;
  score += (TIER_RANK[candidate.tier] || 0) * 140;
  score += Math.round((candidate.reliability ?? (candidate.isJudgeTagged ? 0.45 : 0.15)) * 160);
  score += Math.round(Math.min(candidate.num_ctx || 2048, 16384) / 256);
  if (candidate.contextSource === 'context_test') score += 40;
  if (candidate.contextSource === 'override') score += 20;
  if (!candidate.isJudgeTagged && candidate.reliability == null) score -= 40;
  if (/coder/.test(candidate.normalizedName) && !candidate.isJudgeTagged) score -= 160;
  return score;
}

function describeCandidate(candidate) {
  const hostLabel = candidate.host?.name || candidate.host?.url || 'host';
  const tierText = candidate.tier || 'unrated';
  const reliabilityText = typeof candidate.reliability === 'number'
    ? `${Math.round(candidate.reliability * 100)}% reliable`
    : 'uncalibrated';
  return `${tierText} judge, ${candidate.num_ctx.toLocaleString()} ctx on ${hostLabel}, ${reliabilityText}`;
}

function buildJudgeHostRecommendations({ hosts = [], registryEntries = [], hostInventoryByUrl = {}, judgeDefaults = {} } = {}) {
  const registryMap = new Map();
  registryEntries.forEach((entry) => {
    registryMap.set(normalizeModelName(entry.modelName), entry);
  });

  const recommendations = {};

  hosts.forEach((host) => {
    const hostInventory = hostInventoryByUrl[host.url] || { available: false, models: [] };
    const availableModels = Array.isArray(hostInventory.models) ? hostInventory.models : [];
    const configuredDefault = judgeDefaults[host.url] || null;

    const candidates = availableModels
      .map((modelName) => {
        const entry = registryMap.get(normalizeModelName(modelName)) || { modelName };
        if (!isPotentialJudge(entry, modelName)) return null;

        const categories = Array.isArray(entry.categories) ? entry.categories : [];
        const ctx = resolveRecommendedContext(entry, host);
        const candidate = {
          model: modelName,
          normalizedName: normalizeModelName(modelName),
          host,
          tier: resolveJudgeTier(entry),
          reliability: typeof entry?.capabilities?.judgeReliability === 'number'
            ? entry.capabilities.judgeReliability
            : null,
          categories,
          isJudgeTagged: categories.includes('judge'),
          num_ctx: ctx.num_ctx,
          contextSource: ctx.source,
          contextReason: ctx.reason
        };
        candidate.score = scoreJudgeCandidate(candidate);
        candidate.summary = describeCandidate(candidate);
        return candidate;
      })
      .filter(Boolean);

    const judgeTagged = candidates.filter((candidate) => candidate.isJudgeTagged);
    const rankingPool = judgeTagged.length > 0 ? judgeTagged : candidates;
    rankingPool.sort((a, b) => b.score - a.score);

    const recommended = rankingPool[0] || null;
    recommendations[host.url] = {
      hostId: host.id,
      hostName: host.name,
      hostUrl: host.url,
      hostVramMb: host.vramMb || null,
      available: !!hostInventory.available,
      configuredDefault,
      inventoryCount: availableModels.length,
      recommended: recommended ? {
        model: recommended.model,
        num_ctx: recommended.num_ctx,
        tier: recommended.tier,
        reliability: recommended.reliability,
        contextSource: recommended.contextSource,
        contextReason: recommended.contextReason,
        summary: recommended.summary,
        differsFromConfiguredDefault: !!(configuredDefault && normalizeModelName(configuredDefault) !== recommended.normalizedName)
      } : null,
      topCandidates: rankingPool.slice(0, 3).map((candidate) => ({
        model: candidate.model,
        num_ctx: candidate.num_ctx,
        tier: candidate.tier,
        reliability: candidate.reliability,
        contextSource: candidate.contextSource,
        summary: candidate.summary
      }))
    };
  });

  return recommendations;
}

async function loadJudgeHostRecommendations({ judgeDefaults = {} } = {}) {
  const hosts = getConfiguredHosts();
  const [registryEntries, hostChecks] = await Promise.all([
    ModelRegistry.find({
      retiredAt: null
    })
      .select('modelName categories capabilities parameterSize quantization modelSizeBytes sourceHost executionDefaults executionOverrides contextTest')
      .lean(),
    Promise.all(hosts.map(async (host) => ({ hostUrl: host.url, ...(await checkHost(host.url)) })))
  ]);

  const hostInventoryByUrl = {};
  hostChecks.forEach((check) => {
    hostInventoryByUrl[check.hostUrl] = {
      available: check.available,
      models: check.models || []
    };
  });

  return buildJudgeHostRecommendations({
    hosts,
    registryEntries,
    hostInventoryByUrl,
    judgeDefaults
  });
}

module.exports = {
  buildJudgeHostRecommendations,
  loadJudgeHostRecommendations,
  inferJudgeTierFromName,
  resolveJudgeTier
};
