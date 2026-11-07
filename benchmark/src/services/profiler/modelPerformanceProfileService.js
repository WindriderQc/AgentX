'use strict';

const crypto = require('crypto');
const { activatedHosts } = require('./publishedGpuDriverProjection');
const { buildRuntimeFingerprint } = require('../../../../shared/artifactIdentity');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');

async function saveProfile({ modelName, hostId, artifact, profile }, options = {}) {
  const authorityWriteId = options.authorityWriteId || crypto.randomUUID();
  const identity = {
    modelName,
    hostId,
    'artifact.digest': artifact.digest,
    'artifact.runtimeFingerprint': artifact.runtimeFingerprint
  };
  const writableIdentity = {
    ...identity,
    authorityState: { $ne: 'authority_invalidated' }
  };
  let writeStarted = false;
  try {
    options.assertAuthorityActive?.();
    writeStarted = true;
    const saved = await ModelPerformanceProfile.findOneAndUpdate(
      writableIdentity,
      { $set: {
        artifact,
        profile,
        authorityWriteId,
        authorityReconciliationId: options.authorityReconciliationId || null,
        authorityState: options.authorityState || 'authoritative',
        active: !artifact.driverPreparationId,
        stale: false,
        staleReason: null,
        supersededByAuthorityWriteId: null
      } },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        ...(options.signal ? { signal: options.signal } : {})
      }
    );
    options.assertAuthorityActive?.();
    return saved;
  } catch (error) {
    if (writeStarted && options.deferAuthorityCompensation !== true) {
      try {
        await ModelPerformanceProfile.updateOne(
          { ...identity, authorityWriteId },
          { $set: { active: false, stale: true, staleReason: 'profiler_authority_write_failed' } }
        );
      } catch (compensationError) {
        error.compensationError = compensationError;
        error.authorityInvalidationFailed = true;
        error.code = error.code || 'PROFILER_AUTHORITY_INVALIDATION_FAILED';
      }
    }
    throw error;
  }
}

async function retireSupersededProfiles({
  modelName,
  hostId,
  evidenceId,
  authorityWriteId = null,
  assertAuthorityActive,
  signal
}) {
  assertAuthorityActive?.();
  const filter = { _id: { $ne: evidenceId }, modelName, hostId, active: true };
  const update = { $set: {
    active: false,
    stale: true,
    staleReason: 'superseded',
    supersededByAuthorityWriteId: authorityWriteId
  } };
  if (signal) await ModelPerformanceProfile.updateMany(filter, update, { signal });
  else await ModelPerformanceProfile.updateMany(filter, update);
  assertAuthorityActive?.();
}

async function getActiveProfile(modelName, hostId) {
  const [activated] = await activatedHosts(hostId);
  if (activated) {
    const profile = await require('./modelProfileService').getByName(modelName);
    const readiness = profile?.readiness?.[hostId];
    if (!readiness?.evidenceId) return null;
    const selected = await ModelPerformanceProfile.findOne({ _id: readiness.evidenceId, modelName, hostId,
      'artifact.runtimeFingerprint': buildRuntimeFingerprint(activated), stale: { $ne: true },
      authorityState: { $nin: ['pending_reconciliation', 'authority_invalidated'] } }).lean();
    return selected ? { ...selected, active: true, publication: { source: 'gpu_driver_identity_selector',
      requestId: activated.gpuDriverActivation.requestId } } : null;
  }
  return ModelPerformanceProfile.findOne({
    modelName,
    hostId,
    active: true,
    stale: { $ne: true },
    authorityState: { $nin: ['pending_reconciliation', 'authority_invalidated'] }
  })
    .sort({ updatedAt: -1 })
    .lean();
}

async function getRoster(filter = {}) {
  // The roster is a current-view projection, not an audit-history endpoint.
  // A stale active row must never be merged back into the UI after reload.
  const query = {
    active: true,
    stale: { $ne: true },
    authorityState: { $nin: ['pending_reconciliation', 'authority_invalidated'] }
  };
  if (filter.hostId) query.hostId = filter.hostId;
  if (filter.modelName) query.modelName = filter.modelName;
  const rows = await ModelPerformanceProfile.find(query).sort({ updatedAt: -1 }).lean();
  const activated = await activatedHosts(filter.hostId);
  if (!activated.length) return rows;
  const hostIds = new Set(activated.map(host => host.hostId));
  const result = rows.filter(row => !hostIds.has(row.hostId));
  const profiles = await require('./modelProfileService').getAll();
  for (const host of activated) {
    for (const profile of profiles) {
      if (filter.modelName && profile.name !== filter.modelName) continue;
      const selected = await getActiveProfile(profile.name, host.hostId);
      if (selected) result.push(selected);
    }
  }
  return result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function readCurrentPerformance(filter, projection = null, model = ModelPerformanceProfile) {
  const [host] = await activatedHosts(filter.hostId);
  let queryFilter = filter;
  if (host) {
    if (filter['artifact.runtimeFingerprint'] && filter['artifact.runtimeFingerprint'] !== buildRuntimeFingerprint(host)) return null;
    const profile = await require('./modelProfileService').getByName(filter.modelName);
    const readiness = profile?.readiness?.[filter.hostId];
    if (!readiness?.evidenceId || (filter._id && String(filter._id) !== String(readiness.evidenceId))) return null;
    queryFilter = { ...filter, _id: readiness.evidenceId, 'artifact.runtimeFingerprint': buildRuntimeFingerprint(host) };
    delete queryFilter.active;
  }
  let query = model.findOne(queryFilter);
  if (projection) query = query.select(projection);
  const row = await query.lean();
  return row && host ? { ...row, active: true, publication: { source: 'gpu_driver_identity_selector', requestId: host.gpuDriverActivation.requestId } } : row;
}

async function projectPerformanceRows(rows) {
  const hosts = await activatedHosts();
  if (!hosts.length) return rows;
  const profiles = await require('./modelProfileService').getAll();
  const selected = new Set();
  for (const profile of profiles) {
    for (const host of hosts) {
      const readiness = profile.readiness?.[host.hostId];
      if (readiness?.artifact?.runtimeFingerprint === buildRuntimeFingerprint(host) && readiness.evidenceId) selected.add(String(readiness.evidenceId));
    }
  }
  const ids = new Set(hosts.map(host => host.hostId));
  return rows.map(row => ids.has(row.hostId) ? { ...row, active: selected.has(String(row._id)) } : row);
}

async function readCurrentPerformanceProfiles(filter) {
  const [host] = await activatedHosts(filter.hostId);
  // Reuse the current roster when there is a published host selector. The
  // legacy query remains unchanged for callers without one.
  if (host) return getRoster({ hostId: filter.hostId, modelName: filter.modelName });
  return ModelPerformanceProfile.find(filter).lean();
}

async function invalidateProfile(evidenceId, reason = 'authority_write_failed') {
  if (!evidenceId) return { modifiedCount: 0 };
  return ModelPerformanceProfile.updateOne(
    { _id: evidenceId },
    { $set: { active: false, stale: true, staleReason: reason } }
  );
}

module.exports = {
  readCurrentPerformance,
  readCurrentPerformanceProfiles,
  projectPerformanceRows,
  getActiveProfile,
  getRoster,
  invalidateProfile,
  retireSupersededProfiles,
  saveProfile
};
