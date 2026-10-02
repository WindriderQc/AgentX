/**
 * Core workload recoveries: quarantine transitions, adoption, ownership and
 * host restore after an interrupted workload.
 */

const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS, PIN_RESTORE_TIMEOUT_MS } = require('./coreOperations');
const { workloadAdmissionById } = require('./coreProofState');

const RECOVERY_OWNER_TTL_MS = PIN_RESTORE_TIMEOUT_MS + 60_000;

function getWorkloadRecoveryIdentity(workloadId) {
  const receipt = workloadAdmissionById.get(String(workloadId || ''));
  if (!receipt?.recoveryRequired) return null;
  return { ...receipt };
}

async function transitionWorkloadRecovery(workloadId, state, options = {}) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt?.recoveryRequired) return { transitioned: false, reason: 'local recovery proof missing' };
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/transition`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_TRANSITION,
      signal: options.signal,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId || null,
        expectedVersion: receipt.recoveryVersion,
        state,
        receipt: options.receipt || null
      })
    }
  );
  const result = data?.data;
  const exact = result?.transitioned === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    && (result.recoveryOwnerId || null) === (receipt.recoveryOwnerId || null)
    && result.recoveryState === state
    && result.recoveryVersion === receipt.recoveryVersion + 1;
  if (!exact) {
    const error = new Error(result?.reason || 'Core recovery transition receipt is invalid');
    error.code = 'WORKLOAD_RECOVERY_TRANSITION_REJECTED';
    error.retainAdmission = true;
    throw error;
  }
  receipt.recoveryState = result.recoveryState;
  receipt.recoveryVersion = result.recoveryVersion;
  return result;
}

async function adoptWorkloadRecovery({ workloadId, recoveryId, recoveryRequestId, ownerId, signal }) {
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(recoveryId)}/adopt`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_ADOPT,
      signal,
      body: JSON.stringify({ recoveryRequestId, ownerId, ttlMs: RECOVERY_OWNER_TTL_MS })
    }
  );
  const result = data?.data;
  if (result?.adopted !== true
    || result.workloadId !== String(workloadId)
    || result.recoveryId !== recoveryId
    || result.recoveryRequestId !== recoveryRequestId
    || result.recoveryOwnerId !== ownerId
    || !result.recoveryGeneration) {
    const error = new Error(result?.reason || 'Core recovery adoption receipt is invalid');
    error.code = 'WORKLOAD_RECOVERY_ADOPTION_REJECTED';
    error.retryable = result?.retryable === true;
    throw error;
  }
  workloadAdmissionById.set(String(workloadId), { ...result });
  return result;
}

async function heartbeatWorkloadRecovery(workloadId, ttlMs = RECOVERY_OWNER_TTL_MS, options = {}) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt?.recoveryRequired || !receipt.recoveryOwnerId) {
    return { heartbeat: false, reason: 'adopted local recovery proof missing' };
  }
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/heartbeat`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_HEARTBEAT,
      signal: options.signal,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId,
        ttlMs
      })
    }
  );
  const result = data?.data;
  const exact = result?.heartbeat === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    && result.recoveryOwnerId === receipt.recoveryOwnerId;
  if (!exact) return { heartbeat: false, reason: result?.reason || 'Core recovery heartbeat receipt is invalid' };
  receipt.recoveryHeartbeatAt = result.recoveryHeartbeatAt || receipt.recoveryHeartbeatAt;
  receipt.recoveryExpiresAt = result.recoveryExpiresAt || receipt.recoveryExpiresAt;
  return result;
}

async function assertWorkloadRecovery(workloadId, options = {}) {
  const receipt = workloadAdmissionById.get(String(workloadId || ''));
  if (!receipt?.recoveryRequired) return { owned: false, reason: 'local recovery proof missing' };
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/assert`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_ASSERT,
      signal: options.signal,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId || null
      })
    }
  );
  const result = data?.data;
  return result?.owned === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    ? result
    : { owned: false, reason: result?.reason || 'Core recovery ownership is invalid' };
}

async function recoverWorkloadAdmissionRelease(identity = {}, options = {}) {
  const data = await coreRequest(
    `/api/nerve-center/workload-admissions/${encodeURIComponent(identity.admissionId || '')}/release-receipt`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RELEASE_RECOVERY,
      signal: options.signal,
      body: JSON.stringify({ generation: identity.generation })
    }
  );
  const result = data?.data;
  const exact = result?.recovered === true
    && result.released === true
    && result.admissionId === identity.admissionId
    && result.generation === identity.generation
    && result.principal === identity.principal
    && result.workloadId === identity.workloadId
    && result.recoveryId === identity.recoveryId
    && result.recoveryState === 'RESTORED'
    && result.recoveryReceipt?.contract === 'agentx.workload-recovery/v1';
  return exact ? result : {
    recovered: result?.recovered === true,
    released: false,
    retryable: result?.retryable === true,
    reason: result?.reason || 'Core workload recovery receipt is invalid'
  };
}

async function restoreWorkloadRecoveryHosts(workloadId, excludedModelsByHost = {}, options = {}) {
  const receipt = workloadAdmissionById.get(String(workloadId || ''));
  if (!receipt?.recoveryRequired || !receipt.recoveryOwnerId) {
    return { restored: false, reason: 'adopted local recovery proof missing' };
  }
  const data = await coreRequest(
    `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}/restore-hosts`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_HOST_RESTORE,
      signal: options.signal,
      body: JSON.stringify({
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId,
        excludedModelsByHost
      })
    }
  );
  const result = data?.data;
  return result?.restored === true
    && result.recoveryId === receipt.recoveryId
    && result.recoveryGeneration === receipt.recoveryGeneration
    && result.recoveryOwnerId === receipt.recoveryOwnerId
    ? result
    : { restored: false, reason: result?.reason || 'Core recovery host restore receipt is invalid' };
}

module.exports = {
  getWorkloadRecoveryIdentity,
  transitionWorkloadRecovery,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  recoverWorkloadAdmissionRelease,
  restoreWorkloadRecoveryHosts,
};
