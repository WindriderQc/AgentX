'use strict';

const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const contextProfiles = require('../modelContextProfileService');
const toolQualifications = require('../qualification/toolCapabilityQualificationService');
const hostProfiles = require('./hostProfileService');
const { syncHostRuntimeSettings } = require('./hostRuntimeSettingsService');
const { resolveArtifactIdentity, identitiesMatch } = require('./artifactIdentityService');
const { hasQualifiedProfilerAuthority } = require('./profilerAuthorityReceipt');
const { projectReadinessEntry } = require('./profilerReadinessProjectionService');
const { assertScopeUnchanged } = require('./gpuDriverPreparationService');
const { buildLaneCapability } = require('./laneCapability');
const { preparedTarget, refusal } = require('./gpuDriverPreparationIdentity');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { atHost } = require('./gpuDriverPreparationScope');

function dependencies(overrides = {}) {
  return { ModelProfile, ModelPerformanceProfile, getHost: hostProfiles.getById,
    sync: syncHostRuntimeSettings, resolveIdentity: resolveArtifactIdentity,
    findContext: contextProfiles.findContextProfile, resolveTools: toolQualifications.resolveQualification,
    assertScope: assertScopeUnchanged, now: () => new Date(), ...overrides };
}

async function readModel(host, entry, requestId, d) {
  const artifact = await d.resolveIdentity(entry.modelName, host.hostId, host.hostUrl,
    { refresh: true, driverPreparationId: requestId });
  const profile = await d.ModelProfile.findOne({ name: entry.modelName })
    .select('+preparedReadiness +preparedThinkingProfiles').lean();
  const readiness = atHost(profile?.preparedReadiness, host.hostId);
  const thinking = atHost(profile?.preparedThinkingProfiles, host.hostId);
  const evidence = readiness?.evidenceId
    ? await d.ModelPerformanceProfile.findOne({ _id: readiness.evidenceId }).lean() : null;
  const [context, tools] = await Promise.all([
    d.findContext(entry.modelName, host.hostUrl, artifact),
    d.resolveTools({ modelName: entry.modelName, hostId: host.hostId, hostUrl: host.hostUrl,
      artifactDigest: artifact.digest, runtimeFingerprint: artifact.runtimeFingerprint })
  ]);
  const since = new Date(host.gpuDriverPreparation.preparedAt).getTime();
  const driver = artifact.runtime?.gpuDriver;
  const performanceValid = evidence?.active === false && evidence.stale !== true
    && evidence.artifact?.driverPreparationId === requestId
    && readiness?.artifact?.driverPreparationId === requestId
    && new Date(readiness?.authorityReceipt?.issuedAt).getTime() >= since
    && driver && evidence.artifact.runtime?.gpuDriver === driver
    && hasQualifiedProfilerAuthority(readiness, evidence, { modelName: entry.modelName, hostId: host.hostId })
    && identitiesMatch(evidence.artifact, artifact) && identitiesMatch(readiness.artifact, artifact);
  const reasons = [];
  if (artifact.digest !== entry.digest) reasons.push('artifact_digest_changed');
  if (entry.performance && !performanceValid) reasons.push('performance_required');
  const sealedThinking = evidence?.profile?.thinking;
  const thinkingValid = performanceValid && evidence.authorityWriteId
    && thinking?.authorityWriteId === evidence.authorityWriteId
    && readiness.authorityWriteId === evidence.authorityWriteId
    && !['pending_reconciliation', 'authority_invalidated'].includes(thinking.authorityState)
    && ['supported', 'visibleFinalAnswerOk', 'finalAnswerContractOk', 'thinkingOnlyResponse']
      .every(key => Boolean(thinking[key]) === Boolean(sealedThinking?.[key]))
    && thinking.recommendedPolicy === sealedThinking?.recommendedPolicy;
  const requiredThinking = entry.performance?.thinking;
  if (requiredThinking && (!thinkingValid || thinking?.supported !== true
    || (requiredThinking.modeOn && thinking.recommendedPolicy === 'disallowed')
    || (requiredThinking.visibleFinalAnswer && !(thinking.visibleFinalAnswerOk === true
      && thinking.finalAnswerContractOk === true && thinking.thinkingOnlyResponse !== true)))) reasons.push('thinking_required');
  const contextValid = context?.driverPreparationId === requestId
    && new Date(context.lastValidatedAt).getTime() >= since
    && driver && context.measuredRuntime?.gpuDriver === driver
    && context.maxVerifiedContext >= entry.servingContext;
  if ((entry.context || entry.tools || entry.performance) && !contextValid) reasons.push('context_required');
  if (entry.context && contextValid) {
    if (context.maxVerifiedContext < entry.context.maxVerifiedContext) reasons.push('context_capacity_required');
    if (entry.context.recommendationStatus === 'verified'
      && (context.recommendationStatus !== 'verified'
        || context.recommendedInteractiveContext < entry.context.recommendedInteractiveContext
        || context.recommendedDocumentContext < entry.context.recommendedDocumentContext)) reasons.push('context_recommendations_required');

  }
  const lane = buildLaneCapability({ model: entry.modelName, hostUrl: host.hostUrl, hostId: host.hostId, artifact,
    contextProfile: contextValid ? context : null, performanceProfile: performanceValid ? evidence : null, now: d.now() });
  if (entry.qualityContext > 0 && !(lane.quality.context >= entry.qualityContext)) reasons.push('quality_context_required');
  for (const [capability, state] of Object.entries(entry.nativeReadiness || {})) {
    if (state === 'ready' && lane.readiness[capability] !== 'ready') reasons.push(`native_${capability}_required`);
  }
  if (entry.tools && !(tools.qualified && tools.evidence?.driverPreparationId === requestId
    && tools.evidence.measuredContext === entry.servingContext
    && new Date(tools.evidence.completedAt).getTime() >= since
    && tools.evidence.measuredRuntime?.gpuDriver === driver && driver
    && (entry.tools.state !== 'supported' || tools.state === 'supported'))) reasons.push('tools_required');
  const projected = performanceValid
    ? await projectReadinessEntry(entry.modelName, host.hostId, readiness,
      new Map([[String(evidence._id), evidence]]), { resolveIdentity: async () => artifact }) : null;
  return { modelName: entry.modelName, artifact, reasons, ready: reasons.length === 0,
    hostProfile: { ...host, gpus: preparedTarget(host, requestId, entry.modelName, d.now()).target.gpus },
    modelProfile: { name: entry.modelName, capabilities: profile?.capabilities || {},
      readiness: projected ? { [host.hostId]: projected } : {},
      thinkingProfiles: thinkingValid && projected ? { [host.hostId]: thinking } : {} },
    contextProfile: contextValid ? context : null, toolQualification: tools,
    performanceEvidence: performanceValid ? evidence : null };
}

async function inspectPrepared(hostId, requestId, overrides = {}) {
  const d = dependencies(overrides);
  let host = await d.getHost(hostId);
  if (!host) throw refusal('Host not found', 'GPU_DRIVER_HOST_REQUIRED');
  await d.sync({ hostId, hostUrl: host.hostUrl }, { force: true });
  host = await d.getHost(hostId);
  await d.assertScope(host, requestId);
  const models = [];
  for (const entry of host.gpuDriverPreparation.manifest) models.push(await readModel(host, entry, requestId, d));
  return { hostId, requestId, ready: models.every(model => model.ready), models };
}

// The caller must already own Core's exact workload and host claim. The route
// re-attests that proof; this read never publishes a candidate to normal traffic.
async function qualificationEvidence(hostId, requestId, modelName, overrides = {}) {
  const d = dependencies(overrides);
  let host = await d.getHost(hostId);
  if (!host) throw refusal('Host not found', 'GPU_DRIVER_HOST_REQUIRED');
  await d.sync({ hostId, hostUrl: host.hostUrl }, { force: true });
  host = await d.getHost(hostId);
  const { entry } = preparedTarget(host, requestId, normalizeModelTag(modelName), d.now());
  await d.assertScope(host, requestId);
  const result = await readModel(host, entry, requestId, d);
  // Tools are measured last. Their own absence must not prevent the native
  // context/performance-qualified contract needed to measure them.
  if (!result.performanceEvidence || !result.contextProfile
    || result.reasons.some(reason => reason !== 'tools_required')) {
    throw refusal('New native context and performance proof is required before the prepared tool campaign', 'GPU_DRIVER_PREPARED_EVIDENCE_REQUIRED');
  }
  return { ...result, servingContext: entry.servingContext, driverPreparationId: requestId };
}

module.exports = { inspectPrepared, qualificationEvidence, readModel };
