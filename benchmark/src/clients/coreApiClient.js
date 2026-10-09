/**
 * Core API Client
 *
 * HTTP client for benchmark → core service-to-service calls.
 * Replaces direct MongoDB access to core-owned collections.
 *
 * Facade over the per-capability Core clients in this directory.
 */

const { CORE_OPERATIONS, CORE_OPERATION_SPECS } = require('./coreOperations');
const {
  coreRequest,
  classifyCoreOperation,
  configuredCoreOrigin,
  normalizeCallerHeaders,
} = require('./coreHttp');
const { exactBenchmarkReleaseReceipt, runtimeSnapshotIdentity } = require('./coreRuntimeReceipts');
const {
  getModelRegistries,
  getModelRegistryByName,
  loadCorePublicConfig,
  getDedicationStatuses,
  resolveHostKey,
  restoreDedication,
} = require('./coreModelHostApi');
const {
  claimHostForBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  getBenchmarkClaimIdentity,
  getBenchmarkClaims,
} = require('./coreBenchmarkClaims');
const {
  acquireWorkloadAdmission,
  heartbeatWorkloadAdmission,
  releaseWorkloadAdmission,
  getWorkloadAdmissionIdentity,
  generateWithWorkloadAdmission,
} = require('./coreWorkloadAdmissions');
const {
  getWorkloadRecoveryIdentity,
  transitionWorkloadRecovery,
  lookupWorkloadRecovery,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  recoverWorkloadAdmissionRelease,
  restoreWorkloadRecoveryHosts,
} = require('./coreWorkloadRecoveries');

module.exports = {
  getModelRegistries,
  getModelRegistryByName,
  loadCorePublicConfig,
  coreRequest,
  getDedicationStatuses,
  resolveHostKey,
  restoreDedication,
  claimHostForBenchmark,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  getBenchmarkClaimIdentity,
  getWorkloadAdmissionIdentity,
  generateWithWorkloadAdmission,
  getBenchmarkClaims,
  acquireWorkloadAdmission,
  heartbeatWorkloadAdmission,
  releaseWorkloadAdmission,
  getWorkloadRecoveryIdentity,
  lookupWorkloadRecovery,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  recoverWorkloadAdmissionRelease,
  restoreWorkloadRecoveryHosts,
  CORE_OPERATIONS,
  _internal: {
    classifyCoreOperation,
    configuredCoreOrigin,
    CORE_OPERATION_SPECS,
    normalizeCallerHeaders,
    exactBenchmarkReleaseReceipt,
    runtimeSnapshotIdentity,
  },
};
