'use strict';

const mongoose = require('mongoose');
const HostProfile = require('../../../models/HostProfile');
const ModelProfile = require('../../../models/ModelProfile');
const { buildRuntimeFingerprint, GPU_DRIVER_IDENTITY_VERSION } = require('../../../../shared/artifactIdentity');
const { projectionDigest } = require('../../../../shared/gpuDriverTransition');

const map = value => value instanceof Map ? Object.fromEntries(value) : value || {};

function publicProfile(profile) {
  const { preparedReadiness: _readiness, preparedThinkingProfiles: _thinking,
    nativePublishedReadiness: _published, ...safe } = profile;
  return safe;
}

async function activatedHosts(hostId = null) {
  // A disconnected owner cannot positively select prepared evidence.
  if (mongoose.connection.readyState !== 1) return [];
  return HostProfile.find({ ...(hostId && { hostId }), gpuDriverIdentityVersion: GPU_DRIVER_IDENTITY_VERSION,
    'gpuDriverPreparation.state': 'active', 'gpuDriverActivation.state': { $in: ['published', 'complete'] }
  }).lean();
}

function selectProfile(profile, hosts) {
  const safe = publicProfile(profile);
  const readiness = { ...map(profile.readiness) };
  const thinking = { ...map(profile.thinkingProfiles) };
  for (const host of hosts) {
    const fingerprint = buildRuntimeFingerprint(host);
    // After native publication under this runtime, its own pending/failure/
    // invalidation rules apply. Never resurrect an earlier prepared candidate.
    if (map(profile.nativePublishedReadiness)[host.hostId]?.runtimeFingerprint === fingerprint) continue;
    const proof = host.gpuDriverActivation.proofs?.find(row => row.modelName === profile.name);
    const prepared = map(profile.preparedReadiness)[host.hostId];
    if (!proof?.performanceEvidenceId || !prepared
      || String(prepared.evidenceId) !== String(proof.performanceEvidenceId)
      || prepared.artifact?.driverPreparationId !== host.gpuDriverPreparation.requestId
      || prepared.artifact.runtimeFingerprint !== fingerprint
      || (prepared.authorityWriteId || null) !== proof.performanceWriteId
      || prepared.authorityReceipt?.digest !== proof.performanceReceiptDigest) continue;
    readiness[host.hostId] = prepared;
    const preparedThinking = map(profile.preparedThinkingProfiles)[host.hostId];
    if (preparedThinking?.authorityWriteId && preparedThinking.authorityWriteId === prepared.authorityWriteId
      && projectionDigest(preparedThinking) === proof.thinkingProjectionDigest) thinking[host.hostId] = preparedThinking;
    else delete thinking[host.hostId];
  }
  return { ...safe, readiness, thinkingProfiles: thinking };
}

async function effectiveModelProfiles(profiles) {
  if (!profiles.length) return profiles;
  const hosts = await activatedHosts();
  if (!hosts.length) return profiles.map(publicProfile);
  const candidates = await ModelProfile.find({ name: { $in: profiles.map(profile => profile.name) } })
    .select('+preparedReadiness +preparedThinkingProfiles +nativePublishedReadiness').lean();
  const byName = new Map(candidates.map(profile => [profile.name, profile]));
  return profiles.map(profile => selectProfile({ ...profile,
    preparedReadiness: byName.get(profile.name)?.preparedReadiness,
    preparedThinkingProfiles: byName.get(profile.name)?.preparedThinkingProfiles,
    nativePublishedReadiness: byName.get(profile.name)?.nativePublishedReadiness
  }, hosts));
}

module.exports = { activatedHosts, effectiveModelProfiles, selectProfile };
