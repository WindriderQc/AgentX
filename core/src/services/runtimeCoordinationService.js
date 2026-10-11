'use strict';

// Public facade for runtime coordination. Each capability lives in its own
// module; consumers keep importing this file.
const { createMaintenanceAcquisition } = require('./runtimeMaintenanceAcquire');
const {
  clean, ttlMs, secret, canonicalHost, reapExpired
} = require('./runtimeCoordinationState');
const {
  classifyKeepAlive, buildInferenceResidencySpec, buildInferenceResidencyKey
} = require('./runtimeInferenceResidency');
const {
  acquireInference,
  heartbeatInference,
  releaseInference,
  markInferenceUnknown,
  recoverInferenceAfterRuntimeRestart,
  hostHasActiveInferences
} = require('./runtimeInferenceCoordination');
const {
  markMaintenanceUnknown,
  recoverMaintenanceAfterOperatorReconciliation
} = require('./runtimeMaintenanceRecovery');
const {
  acquireWorkload,
  recoverWorkloadAcquisition,
  isWorkloadRecoveryRequired,
  assertWorkloadAdmission
} = require('./runtimeWorkloadAdmission');
const {
  armWorkloadRecovery,
  lookupWorkloadRecovery,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  resolveWorkloadRecovery
} = require('./runtimeWorkloadRecovery');
const { heartbeat, release, recoverRelease, listActive } = require('./runtimeLeaseLifecycle');

const { acquireMaintenance, listDeployBlockers } = createMaintenanceAcquisition({ clean, ttlMs, secret, reapExpired });

module.exports = {
  acquireMaintenance,
  acquireWorkload,
  recoverWorkloadAcquisition,
  acquireInference,
  heartbeatInference,
  releaseInference,
  markInferenceUnknown,
  recoverInferenceAfterRuntimeRestart,
  markMaintenanceUnknown,
  recoverMaintenanceAfterOperatorReconciliation,
  hostHasActiveInferences,
  armWorkloadRecovery,
  lookupWorkloadRecovery,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  resolveWorkloadRecovery,
  isWorkloadRecoveryRequired,
  assertWorkloadAdmission,
  heartbeat,
  release,
  recoverRelease,
  listActive,
  listDeployBlockers,
  reapExpired,
  _internal: {
    ttlMs,
    canonicalHost,
    classifyKeepAlive,
    buildInferenceResidencySpec,
    buildInferenceResidencyKey
  }
};
