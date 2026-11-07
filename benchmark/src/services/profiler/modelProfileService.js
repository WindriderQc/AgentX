const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const { projectionPaths } = require('./gpuDriverPreparationIdentity');
const { effectiveModelProfiles } = require('./publishedGpuDriverProjection');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { normalizeModelTag: normalizeModelName } = require('../../../../shared/modelNames');

async function getAll(filter = {}) {
  const profiles = await effectiveModelProfiles(await ModelProfile.find().lean());
  if (!filter.stage) return profiles;
  return profiles.filter(doc => Object.values(doc.readiness instanceof Map
    ? Object.fromEntries(doc.readiness) : doc.readiness || {}).some(row => row.stage === filter.stage));
}

async function getByName(name) {
  const profile = await ModelProfile.findOne({ name }).lean();
  return profile ? (await effectiveModelProfiles([profile]))[0] : null;
}

async function readCurrentModelProfile(filter, projection, model = ModelProfile) {
  let query = model.findOne(filter);
  if (projection) query = query.select(typeof projection === 'string' ? `${projection} name` : { ...projection, name: 1 });
  const profile = await query.lean();
  return profile ? (await effectiveModelProfiles([profile]))[0] : null;
}

async function readCurrentModelProfiles(filter, projection, model = ModelProfile) {
  let query = model.find(filter);
  if (projection) query = query.select(typeof projection === 'string' ? `${projection} name` : { ...projection, name: 1 });
  return effectiveModelProfiles(await query.lean());
}

async function upsert(data) {
  return ModelProfile.findOneAndUpdate(
    { name: data.name },
    data,
    { upsert: true, new: true, runValidators: true }
  );
}

async function updateMetadata(name, metadata = {}) {
  const allowed = ['displayName', 'tags', 'categories'];
  const set = {};
  for (const key of allowed) {
    if (metadata[key] !== undefined) set[key] = metadata[key];
  }
  return ModelProfile.findOneAndUpdate(
    { name },
    { $set: set, $setOnInsert: { name } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}

async function updateReadiness(modelName, hostId, stage, extraFields = {}, options = {}) {
  if (!['available', 'profiled', 'benchmarked'].includes(stage)) {
    throw new RangeError(`Unsupported readiness stage: ${stage}`);
  }
  const paths = projectionPaths(options.driverPreparationId);
  const setFields = { [`${paths.readiness}.${hostId}.stage`]: stage };
  if (stage === 'profiled') setFields[`${paths.readiness}.${hostId}.profiledAt`] = new Date();
  if (stage === 'benchmarked') setFields[`${paths.readiness}.${hostId}.benchmarkedAt`] = new Date();
  Object.assign(setFields, extraFields);
  const authorityWriteId = extraFields[`${paths.readiness}.${hostId}.authorityWriteId`] || null;
  return ModelProfile.findOneAndUpdate(
    {
      name: modelName,
      ...(authorityWriteId ? { rejectedAuthorityWriteIds: { $ne: authorityWriteId } } : {})
    },
    { $set: setFields },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true, ...(options.signal ? { signal: options.signal } : {}) }
  );
}

async function updateThinkingCapability(modelName, hostId, thinkingProfile = {}, options = {}) {
  const paths = projectionPaths(options.driverPreparationId);
  const policy = thinkingProfile.recommendedPolicy || 'unknown';
  const supported = !!thinkingProfile.supported;
  const profiledAt = thinkingProfile.profiledAt || new Date();
  const capability = {
    profileVersion: thinkingProfile.profileVersion ?? null,
    profiledAt,
    hostId,
    probeCount: thinkingProfile.probeCount ?? null,
    probeAttempts: thinkingProfile.probeAttempts ?? null,
    retryProbeCount: thinkingProfile.retryProbeCount ?? null,
    maxProbeNumPredict: thinkingProfile.maxProbeNumPredict ?? null,
    defaultProbeNumPredict: thinkingProfile.defaultProbeNumPredict ?? null,
    supported,
    supportSignals: Array.isArray(thinkingProfile.supportSignals) ? thinkingProfile.supportSignals : [],
    channel: thinkingProfile.channel || 'unknown',
    visibleFinalAnswerOk: !!thinkingProfile.visibleFinalAnswerOk,
    finalAnswerContractOk: !!thinkingProfile.finalAnswerContractOk,
    thinkingOnlyResponse: !!thinkingProfile.thinkingOnlyResponse,
    runawayRisk: !!thinkingProfile.runawayRisk,
    contractSensitive: !!thinkingProfile.contractSensitive,
    contractlessVisibleAnswerOk: !!thinkingProfile.contractlessVisibleAnswerOk,
    stressVisibleAnswerOk: !!thinkingProfile.stressVisibleAnswerOk,
    tokenMultiplier: thinkingProfile.tokenMultiplier ?? null,
    latencyMultiplier: thinkingProfile.latencyMultiplier ?? null,
    recommendedPolicy: policy,
    recommendationReason: thinkingProfile.recommendationReason || null
  };
  if (options.authorityWriteId) {
    capability.authorityWriteId = options.authorityWriteId;
    capability.authorityState = options.authorityState || 'pending_reconciliation';
  }

  return ModelProfile.findOneAndUpdate(
    {
      name: modelName,
      ...(options.authorityWriteId
        ? { rejectedAuthorityWriteIds: { $ne: options.authorityWriteId } }
        : {})
    },
    {
      $set: {
        ...(!options.driverPreparationId && { 'capabilities.thinking': supported, 'capabilities.thinkingPolicy': policy }),
        [`${paths.thinking}.${hostId}`]: capability
      }
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true, ...(options.signal ? { signal: options.signal } : {}) }
  );
}

async function updateHostAvailability(modelName, hostId, available) {
  return ModelProfile.findOneAndUpdate(
    { name: modelName },
    {
      $set: {
        [`hosts.${hostId}.available`]: available,
        [`hosts.${hostId}.lastSeen`]: available ? new Date() : undefined
      }
    },
    { new: true }
  );
}

async function invalidateReadinessIfEvidence(modelName, hostId, evidenceId, reason = 'authority_write_failed') {
  if (!evidenceId) return { modifiedCount: 0 };
  return ModelProfile.updateOne(
    {
      name: modelName,
      [`readiness.${hostId}.evidenceId`]: evidenceId
    },
    {
      $set: {
        [`readiness.${hostId}.benchmarkQualified`]: false,
        [`readiness.${hostId}.qualificationReason`]: reason,
        [`readiness.${hostId}.stale`]: true,
        [`readiness.${hostId}.staleReason`]: reason,
        [`readiness.${hostId}.authorityReceipt`]: null
      }
    }
  );
}

async function invalidateThinkingCapability(modelName, hostId, reason = 'authority_write_failed') {
  return ModelProfile.updateOne(
    { name: modelName },
    {
      $set: {
        'capabilities.thinking': false,
        'capabilities.thinkingPolicy': 'unknown',
        [`thinkingProfiles.${hostId}.supported`]: false,
        [`thinkingProfiles.${hostId}.recommendedPolicy`]: 'unknown',
        [`thinkingProfiles.${hostId}.recommendationReason`]: reason
      }
    }
  );
}

async function getStalenessReport() {
  return ModelPerformanceProfile.find({ stale: true }).lean();
}

async function getReadinessFunnel() {
  const profiles = await getAll();
  const counts = { available: 0, profiled: 0, benchmarked: 0 };
  for (const profile of profiles) {
    const readinessMap = profile.readiness instanceof Map
      ? Object.fromEntries(profile.readiness)
      : (profile.readiness || {});
    const stages = Object.values(readinessMap).map(r => r.stage);
    const highest = ['benchmarked', 'profiled', 'available']
      .find(s => stages.includes(s)) || 'available';
    counts[highest]++;
  }
  return counts;
}

async function getBenchmarkedModelNames() {
  const names = await BenchmarkResult.distinct('model', { success: true });
  return [...new Set(names.map(normalizeModelName).filter(Boolean))].sort();
}

module.exports = {
  readCurrentModelProfile,
  readCurrentModelProfiles,
  getAll,
  getByName,
  upsert,
  updateMetadata,
  updateReadiness,
  updateThinkingCapability,
  updateHostAvailability,
  invalidateReadinessIfEvidence,
  invalidateThinkingCapability,
  getStalenessReport,
  getReadinessFunnel,
  getBenchmarkedModelNames
};
