/**
 * Policy-gated shared-drive strategy reports.
 *
 * This module reads only indexed AgentX evidence (`nas_files` / `nas_scans`).
 * It never touches shared-drive paths. Reports may contain review proposals,
 * but no proposal is an executable action and every proposal requires the
 * existing, separate profile approval gate.
 */
const janitorPolicyDecisionSupport = require('./janitorPolicyDecisionSupport');
const janitorStrategyInsights = require('./janitorStrategyInsights');
const {
  POLICY_COLLECTION,
  POLICY_ID,
  SHARED_ROOTS,
  POLICY_CHOICES,
  defaultPolicy,
  publicPolicy,
  validatePolicy,
  decisionsRequired,
  getPolicy,
  savePolicy
} = require('./janitorStrategyPolicy');
const {
  missingExtensionContentKnownMatch,
  missingExtensionContentUnknownMatch
} = require('./janitorStrategyRootMetadata');
const {
  candidateEvidencePipeline,
  oversizedUnhashedEvidence,
  publicOversizedUnhashedEvidence,
  metadataFirstEvidence,
  verificationQueueEvidence,
  collectEvidence,
  buildVerificationOutlook
} = require('./janitorStrategyEvidence');
const { fileContext, selectSurvivor, buildDuplicatePlan } = require('./janitorStrategyDuplicates');
const {
  REPORT_COLLECTION,
  REPORT_DETAIL_COLLECTION,
  chunkVerifiedEvidence,
  persistStrategyReport,
  hydrateStrategyReport,
  getLatestStrategy
} = require('./janitorStrategyReportStore');
const janitorReviewDecisions = require('./janitorReviewDecisions');

function buildStrategy(policy, evidence, generatedAt = new Date(), previousReport = null) {
  const duplicatePlan = buildDuplicatePlan(evidence.duplicateGroups, policy);
  const groups = evidence.duplicateGroups || [];
  const provenSavingsBytes = groups.reduce(
    (sum, group) => sum + Number(group.size ?? group.file_size ?? 0) * Math.max(0, Number(group.count || group.files?.length || 0) - 1),
    0
  );
  const verifiedDuplicateFiles = groups.reduce(
    (sum, group) => sum + Number(group.count || group.files?.length || 0),
    0
  );
  const metadata = evidence.roots || [];
  const verifiedDuplicateEvidence = groups.map(group => {
    const size = Number(group.size ?? group.file_size ?? 0);
    const count = Number(group.count || group.files?.length || 0);
    return {
      sha256: group._id || group.hash,
      proof: 'sha256-current-metadata',
      size,
      count,
      provenSavingsBytes: size * Math.max(0, count - 1),
      files: (group.files || []).map(file => ({
        path: file.path,
        mtime: file.mtime ?? null,
        storageRole: file.storageRole || null
      }))
    };
  });

  const report = {
    strategySchemaVersion: 6,
    generatedAt,
    status: duplicatePlan.status,
    mode: 'read-only-strategy',
    scope: {
      canonicalRoots: [...SHARED_ROOTS],
      mediaContainsDatalakePhysically: true,
      mediaIndexExcludesNestedDatalake: true,
      portfolioTotalsDoubleCountDatalake: false
    },
    policy: publicPolicy(policy),
    decisions_required: duplicatePlan.decisions_required,
    policyDecisionSupport: janitorPolicyDecisionSupport.buildPolicyDecisionSupport(groups, {
      fileContext,
      selectSurvivor,
      policyChoices: POLICY_CHOICES
    }),
    evidence: {
      duplicateProof: 'sha256-current-metadata',
      verifiedDuplicatesAreLowerBound: true,
      candidateBytesAreNotSavings: true,
      verifiedDuplicateGroups: groups.length,
      verifiedDuplicateFiles,
      provenSavingsBytes,
      verifiedDuplicateEvidence,
      duplicateCandidates: evidence.duplicateCandidates || {
        evidence: 'same-size-not-fully-hashed',
        candidateBytesAreNotSavings: true,
        groups: 0,
        files: 0,
        candidateBytes: 0,
        filesToHash: 0,
        bytesToHash: 0
      },
      metadataFirst: evidence.metadataFirst || metadataFirstEvidence(metadata),
      verificationQueue: evidence.verificationQueue
        || verificationQueueEvidence(evidence.duplicateCandidates || {}),
      verificationOutlook: evidence.verificationOutlook || {
        status: 'unavailable',
        evidence: 'current-indexed-candidate-backlog-and-latest-successful-hashing-cycle',
        filesToHash: Math.max(0, Number(evidence.duplicateCandidates?.filesToHash || 0)),
        bytesToHash: Math.max(0, Number(evidence.duplicateCandidates?.bytesToHash || 0)),
        latestCompletedCycle: null,
        configuredCapacity: null,
        note: 'Verification pace is unavailable; unavailable does not mean no backlog.'
      },
      oversizedUnhashedCandidates: publicOversizedUnhashedEvidence(
        evidence.oversizedUnhashedCandidates
      ),
      hashingLimits: metadata.map(root => ({
        root: root.root,
        hashMaxBytes: root.latestHashingScan?.hashMaxBytes || null,
        note: root.latestHashingScan?.hashMaxBytes
          ? `An individual unhashed file larger than ${root.latestHashingScan.hashMaxBytes} bytes cannot be proven duplicate by that run.`
          : 'No hashing byte ceiling is recorded; duplicate evidence remains incomplete.'
      })),
      perRoot: metadata
    },
    organizationRecommendations: [
      {
        type: 'backup_semantics',
        disposition: policy.backupRetention || 'decision_required',
        note: 'Backup-like trees are never treated as disposable merely because their paths look old or redundant.'
      },
      {
        type: 'generated_cache',
        disposition: policy.generatedCache || 'decision_required',
        note: 'Generated-cache classification is advisory until its explicit policy is selected.'
      },
      {
        type: 'nested_scope',
        disposition: 'canonical_namespaces',
        note: 'Media excludes its physical Datalake child; /mnt/datalake is counted independently exactly once.'
      }
    ],
    metadataRecommendations: metadata.map(root => ({
      root: root.root,
      unclassifiedFiles: Number(root.unclassifiedFiles || 0),
      missingExtensionUnresolvedFiles: Number(root.missingExtensionUnresolvedFiles || 0),
      missingExtensionUnresolvedBytes: Number(root.missingExtensionUnresolvedBytes || 0),
      missingExtensionContentKnownFiles: Number(root.missingExtensionContentKnownFiles || 0),
      missingExtensionContentKnownBytes: Number(root.missingExtensionContentKnownBytes || 0),
      missingExtensionContentUnknownFiles: Number(root.missingExtensionContentUnknownFiles || 0),
      missingExtensionContentUnknownBytes: Number(root.missingExtensionContentUnknownBytes || 0),
      timestampReviewFiles: Number(root.timestampReviewFiles || 0),
      note: 'Content-known means matched content-signature evidence only. Missing extensions may be intentional; metadata and timestamp signals never authorize renames, moves, or deletion.'
    })),
    organizationStrategy: janitorStrategyInsights.buildOrganizationStrategy(evidence),
    maintenance: {
      authorization: 'explicit_per_action',
      approvalRequired: true,
      executionEndpointCalled: false,
      executableActions: [],
      proposals: duplicatePlan.proposals,
      omittedGroups: duplicatePlan.omitted
    },
    safety: {
      sharedDriveMutations: 0,
      approvalEndpointsCalled: false,
      deleteMoveArchiveExecuted: false
    }
  };
  report.comparison = janitorStrategyInsights.buildComparison(report, previousReport);
  return report;
}

async function generateStrategy(db, { persist = true } = {}) {
  const [policy, evidence, previousReport] = await Promise.all([
    getPolicy(db),
    collectEvidence(db),
    getLatestStrategy(db)
  ]);
  const report = buildStrategy(policy, evidence, new Date(), previousReport);
  // Read-only: counts the owner's stored review decisions against this report's
  // groups. It changes neither the verified groups nor the policy's survivors.
  report.reviewDecisions = await janitorReviewDecisions.reportSummary(db, report);
  if (!persist) return { report };
  const insertedId = await persistStrategyReport(db, report);
  return { report: { ...report, _id: insertedId } };
}

module.exports = {
  POLICY_COLLECTION,
  REPORT_COLLECTION,
  REPORT_DETAIL_COLLECTION,
  POLICY_ID,
  SHARED_ROOTS,
  POLICY_CHOICES,
  defaultPolicy,
  publicPolicy,
  validatePolicy,
  decisionsRequired,
  getPolicy,
  savePolicy,
  candidateEvidencePipeline,
  oversizedUnhashedEvidence,
  publicOversizedUnhashedEvidence,
  metadataFirstEvidence,
  verificationQueueEvidence,
  collectEvidence,
  buildVerificationOutlook,
  fileContext,
  selectSurvivor,
  buildDuplicatePlan,
  missingExtensionContentKnownMatch,
  missingExtensionContentUnknownMatch,
  buildStrategy,
  chunkVerifiedEvidence,
  persistStrategyReport,
  hydrateStrategyReport,
  generateStrategy,
  getLatestStrategy
};
