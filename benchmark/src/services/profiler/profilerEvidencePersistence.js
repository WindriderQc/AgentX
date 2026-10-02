'use strict';

const crypto = require('crypto');
const {
  canonicalValue,
  createProfilerAuthorityReceipt,
  qualifiesForBenchmark
} = require('./profilerAuthorityReceipt');
const modelProfileService = require('./modelProfileService');
const modelPerformanceProfileService = require('./modelPerformanceProfileService');
const { identitiesMatch, resolveArtifactIdentity } = require('./artifactIdentityService');
const { profileQualificationFailures } = require('./profilerQualification');
const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const authorityReconciliation = require('../benchmark/benchmarkAuthorityReconciliation');

async function persistProfileEvidence({
  modelName,
  hostId,
  hostUrl,
  artifact,
  profileData,
  claimIdentity,
  assertClaimActive,
  signal
}) {
  const checkpoint = () => {
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : new Error('Profiler authority write aborted');
      error.code = error.code || 'BENCHMARK_CLAIM_STOPPED';
      throw error;
    }
    assertClaimActive?.();
  };
  let evidence = null;
  let authorityJournal = null;
  try {
    checkpoint();
    const currentArtifact = await resolveArtifactIdentity(modelName, hostId, hostUrl, { refresh: true });
    checkpoint();
    if (!identitiesMatch(artifact, currentArtifact)) {
      throw new Error(`Artifact or runtime changed while profiling ${modelName} on ${hostUrl}; discard this run and retry`);
    }
    const required = Number(profileData.requiredRetainedSamples) || 0;
    const quality = profileData.measurementQuality || {};
    const qualificationFailures = profileQualificationFailures(profileData);
    const benchmarkQualified = qualifiesForBenchmark(qualificationFailures);
    profileData.benchmarkQualified = benchmarkQualified;
    profileData.qualificationFailures = qualificationFailures;
    const workloadId = String(claimIdentity?.claimBatchId || '');
    if (!workloadId) {
      const error = new Error('Profiler evidence publication requires an exact durable workload identity');
      error.code = 'PROFILER_AUTHORITY_JOURNAL_REQUIRED';
      throw error;
    }
    const authorityWriteId = crypto.randomUUID();
    const [priorProfile, priorEvidence] = await Promise.all([
      ModelProfile.findOne({ name: modelName })
        .select('readiness thinkingProfiles')
        .lean(),
      ModelPerformanceProfile.findOne({
        modelName,
        hostId,
        'artifact.digest': currentArtifact.digest,
        'artifact.runtimeFingerprint': currentArtifact.runtimeFingerprint,
        authorityState: { $ne: 'authority_invalidated' }
      }).lean()
    ]);
    checkpoint();
    const priorReadinessMap = priorProfile?.readiness instanceof Map
      ? Object.fromEntries(priorProfile.readiness)
      : (priorProfile?.readiness || {});
    const priorThinkingMap = priorProfile?.thinkingProfiles instanceof Map
      ? Object.fromEntries(priorProfile.thinkingProfiles)
      : (priorProfile?.thinkingProfiles || {});
    // BSON turns undefined object fields into null. Normalize once so the
    // journal, saved evidence and receipt bind the same persisted payload.
    const evidenceProfile = canonicalValue({ ...profileData, artifact: currentArtifact });
    const journalDetails = {
      modelName,
      hostId,
      artifactDigest: currentArtifact.digest,
      runtimeFingerprint: currentArtifact.runtimeFingerprint,
      artifact: currentArtifact,
      profile: evidenceProfile,
      authorityWriteId,
      evidenceId: null,
      thinking: Boolean(profileData.thinking),
      priorReadiness: priorReadinessMap[hostId] || null,
      priorThinking: priorThinkingMap[hostId] || null,
      // saveProfile updates the exact artifact row in place. Preserve the
      // complete previous authority projection so restart compensation can
      // restore it instead of tombstoning the only valid evidence row.
      priorEvidence: priorEvidence || null
    };
    authorityJournal = await authorityReconciliation.prepareProfilerAuthorityWrite({
      kind: 'profiler_evidence_write',
      resultId: `profiler-evidence:${workloadId}:${authorityWriteId}`,
      workloadId,
      phase: 'profiler evidence/readiness/thinking publication',
      details: journalDetails
    });
    checkpoint();
    evidence = await modelPerformanceProfileService.saveProfile({
      modelName,
      hostId,
      artifact: currentArtifact,
      profile: evidenceProfile
    }, {
      signal,
      assertAuthorityActive: checkpoint,
      authorityWriteId,
      authorityReconciliationId: String(authorityJournal._id),
      authorityState: 'pending_reconciliation',
      deferAuthorityCompensation: true
    });
    journalDetails.evidenceId = evidence?._id || null;
    checkpoint();
    const authorityReceipt = createProfilerAuthorityReceipt({
      modelName,
      hostId,
      artifact: currentArtifact,
      profile: evidenceProfile,
      evidenceId: evidence?._id
    });
    checkpoint();
    await modelProfileService.updateReadiness(modelName, hostId, 'profiled', {
      [`readiness.${hostId}.artifact`]: currentArtifact,
      [`readiness.${hostId}.evidenceId`]: evidence?._id || null,
      [`readiness.${hostId}.profileDepth`]: profileData.profileDepth,
      [`readiness.${hostId}.benchmarkQualified`]: benchmarkQualified,
      [`readiness.${hostId}.qualificationReason`]: benchmarkQualified ? null : qualificationFailures.join(','),
      [`readiness.${hostId}.measurementReliability`]: quality.reliability || 'unknown',
      [`readiness.${hostId}.authorityReceipt`]: authorityReceipt,
      [`readiness.${hostId}.authorityState`]: 'pending_reconciliation',
      [`readiness.${hostId}.authorityWriteId`]: authorityWriteId,
      [`readiness.${hostId}.stale`]: false,
      [`readiness.${hostId}.staleReason`]: null
    }, { signal });
    checkpoint();
    if (profileData.thinking) {
      await modelProfileService.updateThinkingCapability(modelName, hostId, profileData.thinking, {
        signal,
        authorityWriteId,
        authorityState: 'pending_reconciliation'
      });
      checkpoint();
    }
    await modelPerformanceProfileService.retireSupersededProfiles({
      modelName,
      hostId,
      evidenceId: evidence?._id,
      authorityWriteId,
      assertAuthorityActive: checkpoint,
      signal
    });
    checkpoint();
    await authorityReconciliation.completeProfilerAuthorityWrite(authorityJournal, {
      details: journalDetails,
      signal,
      assertAuthorityActive: checkpoint
    });
    return evidence;
  } catch (error) {
    if (authorityJournal) {
      error.retainAdmission = true;
      error.authorityInvalidationFailed = true;
      error.code = error.code || 'PROFILER_AUTHORITY_RECONCILIATION_PENDING';
      error.reconciliationId = String(authorityJournal._id);
      throw error;
    }
    if (evidence?._id) {
      const reason = error.code === 'BENCHMARK_CLAIM_LOST' || error.code === 'BENCHMARK_CLAIM_STOPPED'
        ? 'claim_lost_during_profiler_authority_write'
        : 'profiler_authority_write_failed';
      const invalidations = await Promise.allSettled([
        modelPerformanceProfileService.invalidateProfile(evidence._id, reason),
        modelProfileService.invalidateReadinessIfEvidence(modelName, hostId, evidence._id, reason),
        ...(profileData.thinking
          ? [modelProfileService.invalidateThinkingCapability(modelName, hostId, reason)]
          : [])
      ]);
      const invalidationFailures = invalidations
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (invalidationFailures.length > 0) {
        error.authorityInvalidationFailed = true;
        error.invalidationErrors = invalidationFailures;
        error.code = error.code || 'PROFILER_AUTHORITY_INVALIDATION_FAILED';
      }
    }
    throw error;
  }
}

module.exports = { persistProfileEvidence };
