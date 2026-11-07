'use strict';

const crypto = require('crypto');
const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelContextProfile = require('../../../models/ModelContextProfile');
const ToolCapabilityQualification = require('../../../models/ToolCapabilityQualification');
const contextProfiles = require('../modelContextProfileService');
const tools = require('../qualification/toolCapabilityQualificationService');
const { resolveArtifactIdentity, identitiesMatch } = require('./artifactIdentityService');
const { hasQualifiedProfilerAuthority, canonicalValue } = require('./profilerAuthorityReceipt');
const { resolveContractNumCtx } = require('../benchmark/inferenceContractSnapshot');
const { loadHostPreference } = require('./contextProposalService');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { buildRuntimeFingerprint, stableSerialize } = require('../../../../shared/artifactIdentity');
const { buildLaneCapability } = require('./laneCapability');
const { refusal } = require('./gpuDriverPreparationIdentity');

const hash = value => crypto.createHash('sha256').update(stableSerialize(canonicalValue(value))).digest('hex');
const atHost = (value, hostId) => value instanceof Map ? value.get(hostId) : value?.[hostId];
const authorityLive = row => !['pending_reconciliation', 'authority_invalidated'].includes(row?.authorityState);

function pinSnapshot(preference) {
  if (!preference || !Array.isArray(preference.pinnedModels)) {
    throw refusal('Core host pins must be readable before preparing the driver transition', 'GPU_DRIVER_PINS_REQUIRED');
  }
  return canonicalValue({
    residencyMode: preference.residencyMode || null,
    pinnedModels: preference.pinnedModels.map(pin => ({
      model: normalizeModelTag(pin.model), contextSize: pin.contextSize ?? null,
      numThread: pin.numThread ?? null, keepAlive: pin.keepAlive ?? null,
      autoRestore: pin.autoRestore ?? null
    })).sort((a, b) => a.model.localeCompare(b.model))
  });
}

function dependencies(overrides = {}) {
  return { ModelProfile, ModelPerformanceProfile, ModelContextProfile, ToolCapabilityQualification,
    resolveIdentity: resolveArtifactIdentity, resolveTools: tools.resolveQualification,
    findContext: contextProfiles.findContextProfile, resolveWindow: resolveContractNumCtx, readPins: loadHostPreference, ...overrides };
}

// Enumerate the union first; a failed native read aborts the whole capture.
// Eligibility is decided by the existing owners and their current contracts.
async function captureScope(host, overrides = {}) {
  const d = dependencies(overrides);
  const fingerprint = buildRuntimeFingerprint(host);
  const [profiles, contexts, toolRows, preference] = await Promise.all([
    d.ModelProfile.find({ [`readiness.${host.hostId}`]: { $exists: true } }).lean(),
    d.ModelContextProfile.find({ hostUrl: host.hostUrl, runtimeFingerprint: fingerprint,
      stale: { $ne: true }, authorityState: { $nin: ['pending_reconciliation', 'authority_invalidated'] } }).lean(),
    d.ToolCapabilityQualification.find({ hostUrl: host.hostUrl, runtimeFingerprint: fingerprint, runState: 'finalized' }).lean(),
    d.readPins(host.hostUrl)
  ]);
  const pins = pinSnapshot(preference);
  const names = [...new Set([...profiles.map(row => row.name), ...contexts.map(row => row.modelName),
    ...toolRows.map(row => row.modelName)].map(normalizeModelTag))].sort();
  const manifest = [];
  for (const modelName of names) {
    const artifact = await d.resolveIdentity(modelName, host.hostId, host.hostUrl, { refresh: true });
    if (artifact.runtimeFingerprint !== fingerprint) throw refusal('Host identity changed during scope capture');
    const source = profiles.find(row => row.name === modelName);
    const readiness = atHost(source?.readiness, host.hostId);
    const evidence = readiness?.evidenceId
      ? await d.ModelPerformanceProfile.findOne({ _id: readiness.evidenceId }).lean() : null;
    const performance = evidence?.active === true && evidence.stale !== true
      && hasQualifiedProfilerAuthority(readiness, evidence, { modelName, hostId: host.hostId })
      && identitiesMatch(readiness.artifact, artifact) && identitiesMatch(evidence.artifact, artifact);
    const context = await d.findContext(modelName, host.hostUrl, artifact);
    const tool = await d.resolveTools({ modelName, hostId: host.hostId, hostUrl: host.hostUrl,
      artifactDigest: artifact.digest, runtimeFingerprint: fingerprint });
    const hasContext = context && context.maxVerifiedContext > 0 && context.stale !== true;
    if (!performance && !hasContext && !tool.qualified) continue;
    const window = await d.resolveWindow(modelName, host.hostUrl);
    if (!(Number.isSafeInteger(window.num_ctx) && window.num_ctx > 0)) {
      throw refusal('Core serving context is unavailable', 'GPU_DRIVER_CONTEXT_REQUIRED');
    }
    const thinking = atHost(source?.thinkingProfiles, host.hostId);
    const lane = buildLaneCapability({ model: modelName, hostUrl: host.hostUrl, hostId: host.hostId, artifact,
      contextProfile: hasContext ? context : null, performanceProfile: performance ? evidence : null });
    manifest.push(canonicalValue({
      modelName, digest: artifact.digest, servingContext: window.num_ctx,
      qualityContext: lane.quality.context, nativeReadiness: lane.readiness,
      performance: performance ? { evidenceId: String(evidence._id), receiptDigest: readiness.authorityReceipt.digest,
        sourceProfileDepth: readiness.profileDepth,
        thinking: authorityLive(thinking) && thinking?.supported === true ? {
          supported: true, modeOn: thinking.recommendedPolicy !== 'disallowed',
          visibleFinalAnswer: thinking.visibleFinalAnswerOk === true && thinking.finalAnswerContractOk === true
            && thinking.thinkingOnlyResponse !== true
        } : null } : null,
      context: hasContext ? { evidenceId: String(context._id), maxVerifiedContext: context.maxVerifiedContext,
        recommendationStatus: context.recommendationStatus,
        recommendedInteractiveContext: context.recommendedInteractiveContext,
        recommendedDocumentContext: context.recommendedDocumentContext,
        evidenceFingerprint: hash(context) } : null,
      tools: tool.qualified ? { state: tool.state, campaignId: tool.evidence.campaignId,
        evidenceDigest: tool.evidence.evidenceDigest } : null
    }));
  }
  return { pins, manifest, scopeFingerprint: hash({ pins, manifest }) };
}

module.exports = { captureScope, pinSnapshot, hash, atHost };
