/**
 * Core workload admissions: acquire, heartbeat, release and admitted inference.
 */

const logger = require('../../config/logger');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS } = require('./coreOperations');
const { workloadAdmissionById } = require('./coreProofState');
const { getBenchmarkClaimIdentity } = require('./coreBenchmarkClaims');
const { transitionWorkloadRecovery } = require('./coreWorkloadRecoveries');

/**
 * Core's explicit refusal to admit a workload (HTTP 409, `acquired: false`),
 * as the coded error callers and the batch action recognise; null otherwise.
 */
function coreRefusal(error) {
  if (error?.status !== 409) return null;
  let answer;
  try { answer = JSON.parse(error.body); } catch { return null; }
  if (answer?.data?.acquired !== false) return null;
  return Object.assign(new Error(answer.data.reason || 'Core refused the workload admission'),
    { code: 'WORKLOAD_ADMISSION_REJECTED', statusCode: 409 });
}

async function acquireWorkloadAdmission(workloadId, options = {}) {
  const key = String(workloadId || '');
  if (!key) throw new Error('workloadId is required');
  const expectedKind = options.kind || 'benchmark';
  const expectedBatchId = options.batchId || null;
  const requestId = options.requestId || `benchmark:${key}`;
  const recoveryRequestId = `recovery:${requestId}`;
  // Core stores canonical host identities in coordination receipts. Use the
  // same shared key so IPv4/IPv6 loopback aliases and default ports agree.
  const expectedHosts = [...new Set((Array.isArray(options.hosts) ? options.hosts : [])
    .map(hostUrlKey)
    .filter(Boolean))].sort();
  // Hosts held for the judge only (#396). Core grants a subset; a Core that
  // does not know shared hosts grants none, and the host stays reserved.
  const requestedSharedHosts = [...new Set((Array.isArray(options.sharedHosts) ? options.sharedHosts : [])
    .map(hostUrlKey)
    .filter(host => host && expectedHosts.includes(host)))].sort();
  const existing = workloadAdmissionById.get(key);
  if (existing) {
    if (existing.requestId !== requestId
      || existing.kind !== expectedKind
      || (existing.batchId || null) !== expectedBatchId
      || JSON.stringify(existing.hosts || []) !== JSON.stringify(expectedHosts)) {
      const error = new Error('Local workload id already binds a different admission intent');
      error.code = 'WORKLOAD_ADMISSION_CONFLICT';
      throw error;
    }
    // A local receipt is only an identity hint, never current authority. Core
    // may have expired/reaped it and granted maintenance since our last call.
    // Re-attest the exact generation before allowing another mutation to use
    // this workload id.
    const renewed = await heartbeatWorkloadAdmission(key, options.ttlMs || null);
    if (renewed?.heartbeat === true) {
      return { acquired: true, ...existing, expiresAt: renewed.expiresAt || existing.expiresAt, idempotent: true };
    }
    workloadAdmissionById.delete(key);
  }
  const request = async () => coreRequest('/api/nerve-center/workload-admissions', {
    method: 'POST',
    operationId: CORE_OPERATIONS.WORKLOAD_ACQUIRE,
    body: JSON.stringify({
      requestId,
      workloadId: key,
      kind: expectedKind,
      batchId: expectedBatchId,
      hosts: expectedHosts,
      ...(requestedSharedHosts.length && { sharedHosts: requestedSharedHosts }),
      recoveryRequestId,
      ttlMs: options.ttlMs || null
    })
  });
  let data;
  try {
    data = await request();
  } catch (error) {
    // Core answers 409 when it grants nothing: a refusal, not a lost response.
    const refusal = coreRefusal(error);
    if (refusal) throw refusal;
    // A lost response after Core's atomic acquire is ambiguous. Retry the same
    // idempotency key once; Core returns the same Core-minted proof.
    try {
      data = await request();
    } catch {
      throw error;
    }
  }
  const result = data?.data;
  const grantedSharedHosts = [...(Array.isArray(result?.sharedHosts) ? result.sharedHosts : [])].sort();
  if (!result?.acquired || !result.admissionId || !result.generation
    || !result.principal
    || result.workloadId !== key
    || result.requestId !== requestId
    || result.kind !== expectedKind
    || (result.batchId || null) !== expectedBatchId
    || JSON.stringify([...(result.hosts || [])].sort()) !== JSON.stringify(expectedHosts)
    || grantedSharedHosts.some(host => !expectedHosts.includes(host))) {
    const error = new Error(result?.reason || 'Core workload admission receipt is invalid');
    error.code = 'WORKLOAD_ADMISSION_REJECTED';
    throw error;
  }
  const receipt = {
    admissionId: result.admissionId,
    generation: result.generation,
    principal: result.principal,
    requestId,
    workloadId: key,
    kind: expectedKind,
    batchId: expectedBatchId,
    hosts: expectedHosts,
    sharedHosts: grantedSharedHosts,
    expiresAt: result.expiresAt || null
  };
  const arm = async () => coreRequest(
    `/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}/recovery`,
    {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_RECOVERY_ARM,
      body: JSON.stringify({ generation: receipt.generation, recoveryRequestId })
    }
  );
  let armData;
  try {
    armData = await arm();
  } catch (error) {
    try {
      armData = await arm();
    } catch {
      // The caller never receives an admission before recovery quarantine is
      // durably armed, so no Product mutation can start in this gap.
      try {
        await coreRequest(`/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}`, {
          method: 'DELETE',
          operationId: CORE_OPERATIONS.WORKLOAD_RELEASE,
          body: JSON.stringify({ generation: receipt.generation })
        });
      } catch (cleanupError) {
        logger.error('Unarmed workload admission cleanup was not acknowledged', {
          workloadId: key,
          admissionId: receipt.admissionId,
          error: cleanupError.message
        });
        error.cleanupError = cleanupError;
      }
      throw error;
    }
  }
  const armed = armData?.data;
  const exactArm = armed?.armed === true
    && armed.admissionId === receipt.admissionId
    && armed.generation === receipt.generation
    && armed.principal === receipt.principal
    && armed.requestId === receipt.requestId
    && armed.workloadId === receipt.workloadId
    && armed.kind === receipt.kind
    && (armed.batchId || null) === (receipt.batchId || null)
    && JSON.stringify([...(armed.hosts || [])].sort()) === JSON.stringify(receipt.hosts || [])
    && armed.recoveryRequired === true
    && typeof armed.recoveryId === 'string'
    && typeof armed.recoveryGeneration === 'string'
    && armed.recoveryRequestId === recoveryRequestId;
  if (!exactArm) {
    throw Object.assign(new Error(armed?.reason || 'Core recovery quarantine receipt is invalid'), {
      code: 'WORKLOAD_RECOVERY_ARM_REJECTED',
      retainAdmission: true
    });
  }
  Object.assign(receipt, {
    recoveryRequired: true,
    recoveryId: armed.recoveryId,
    recoveryGeneration: armed.recoveryGeneration,
    recoveryRequestId,
    recoveryOwnerId: armed.recoveryOwnerId || null,
    recoveryState: armed.recoveryState,
    recoveryVersion: armed.recoveryVersion
  });
  workloadAdmissionById.set(key, receipt);
  await transitionWorkloadRecovery(key, 'MUTATING', {
    receipt: { contract: 'agentx.workload-recovery/v1', event: 'mutation-started', workloadId: key }
  });
  return { acquired: true, ...receipt };
}

async function heartbeatWorkloadAdmission(workloadId, ttlMs = null) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt) return { heartbeat: false, reason: 'local workload admission proof missing' };
  try {
    const data = await coreRequest(`/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}/heartbeat`, {
      method: 'POST',
      operationId: CORE_OPERATIONS.WORKLOAD_HEARTBEAT,
      body: JSON.stringify({ generation: receipt.generation, ttlMs })
    });
    const result = data?.data;
    const exact = result?.heartbeat === true
      && result.admissionId === receipt.admissionId
      && result.generation === receipt.generation
      && result.principal === receipt.principal
      && result.requestId === receipt.requestId
      && result.workloadId === receipt.workloadId
      && result.kind === receipt.kind
      && (result.batchId || null) === (receipt.batchId || null)
      && JSON.stringify([...(result.hosts || [])].sort()) === JSON.stringify(receipt.hosts || [])
      && result.recoveryRequired === receipt.recoveryRequired
      && result.recoveryId === receipt.recoveryId
      && result.recoveryGeneration === receipt.recoveryGeneration
      && result.recoveryState === receipt.recoveryState
      && result.recoveryVersion === receipt.recoveryVersion;
    if (!exact) {
      return { heartbeat: false, reason: result?.reason || 'Core workload heartbeat receipt is invalid' };
    }
    receipt.expiresAt = result.expiresAt || receipt.expiresAt;
    return result;
  } catch (error) {
    if (error.status === 409) return { heartbeat: false, reason: error.message };
    throw error;
  }
}

async function releaseWorkloadAdmission(workloadId, options = {}) {
  const key = String(workloadId || '');
  const receipt = workloadAdmissionById.get(key);
  if (!receipt) return { released: false, reason: 'local workload admission proof missing' };
  if (receipt.recoveryRequired && receipt.recoveryState !== 'RESTORED') {
    if (!new Set(['VERIFIED', 'RESTORED']).has(receipt.recoveryState)) {
      await transitionWorkloadRecovery(key, 'VERIFIED', {
        signal: options.signal,
        receipt: { contract: 'agentx.workload-recovery/v1', event: 'workload-terminal', workloadId: key }
      });
    }
    if (receipt.recoveryState !== 'RESTORED') {
      await transitionWorkloadRecovery(key, 'RESTORED', {
        signal: options.signal,
        receipt: { contract: 'agentx.workload-recovery/v1', event: 'authority-restored', workloadId: key }
      });
    }
  }
  const exactIdentity = result => result?.admissionId === receipt.admissionId
    && result.generation === receipt.generation
    && result.principal === receipt.principal
    && result.requestId === receipt.requestId
    && result.workloadId === receipt.workloadId
    && result.kind === receipt.kind
    && (result.batchId || null) === (receipt.batchId || null)
    && JSON.stringify([...(result.hosts || [])].sort()) === JSON.stringify(receipt.hosts || [])
    && (!receipt.recoveryRequired || (
      result.recoveryId === receipt.recoveryId
      && result.recoveryGeneration === receipt.recoveryGeneration
      && result.recoveryState === 'RESTORED'
      && result.recoveryReceipt?.contract === 'agentx.workload-recovery/v1'
    ));
  const exactRelease = result => result?.released === true
    && exactIdentity(result)
    && Number.isFinite(Date.parse(result.releasedAt));
  const requestRelease = () => coreRequest(
    receipt.recoveryRequired
      ? `/api/nerve-center/workload-recoveries/${encodeURIComponent(receipt.recoveryId)}`
      : `/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}`,
    {
      method: 'DELETE',
      operationId: receipt.recoveryRequired
        ? CORE_OPERATIONS.WORKLOAD_RECOVERY_RELEASE
        : CORE_OPERATIONS.WORKLOAD_RELEASE,
      signal: options.signal,
      body: JSON.stringify(receipt.recoveryRequired ? {
        recoveryGeneration: receipt.recoveryGeneration,
        ownerId: receipt.recoveryOwnerId || null
      } : { generation: receipt.generation })
    }
  );
  let data;
  try {
    data = await requestRelease();
  } catch (originalError) {
    try {
      const recovery = await coreRequest(
        `/api/nerve-center/workload-admissions/${encodeURIComponent(receipt.admissionId)}/release-receipt`,
        {
          method: 'POST',
          operationId: CORE_OPERATIONS.WORKLOAD_RELEASE_RECOVERY,
          signal: options.signal,
          body: JSON.stringify({ generation: receipt.generation })
        }
      );
      const recovered = recovery?.data;
      if (recovered?.recovered === true && exactRelease(recovered)) {
        data = recovery;
      } else if (recovered?.recovered === true
        && recovered?.released === false
        && recovered?.retryable === true
        && exactIdentity(recovered)) {
        data = await requestRelease();
      } else {
        throw originalError;
      }
    } catch {
      throw originalError;
    }
  }
  const result = data?.data;
  const exact = exactRelease(result);
  if (!exact) return { released: false, reason: result?.reason || 'Core workload release receipt is invalid' };
  workloadAdmissionById.delete(key);
  return result;
}

function getWorkloadAdmissionIdentity(workloadId) {
  const admission = workloadAdmissionById.get(String(workloadId || ''));
  if (!admission?.admissionId || !admission?.generation) return null;
  return {
    workloadAdmissionId: admission.admissionId,
    workloadGeneration: admission.generation
  };
}

async function generateWithWorkloadAdmission(workloadId, request, { signal } = {}) {
  const proof = getWorkloadAdmissionIdentity(workloadId);
  if (!proof) {
    const error = new Error(`Exact workload admission proof is unavailable for ${workloadId || 'unknown'}`);
    error.code = 'WORKLOAD_ADMISSION_REQUIRED';
    throw error;
  }
  const requestedHost = typeof request?.host === 'string' ? request.host.trim() : '';
  const claimProof = requestedHost ? getBenchmarkClaimIdentity(requestedHost, workloadId) : null;
  if (requestedHost && !claimProof) {
    const error = new Error(`Exact benchmark host claim proof is unavailable for ${requestedHost}`);
    error.code = 'BENCHMARK_HOST_CLAIM_REQUIRED';
    throw error;
  }
  const data = await coreRequest('/api/inference/generate', {
    method: 'POST',
    operationId: CORE_OPERATIONS.INFERENCE_GENERATE,
    signal,
    body: JSON.stringify({ ...request, ...proof, ...(claimProof || {}) })
  });
  return data;
}

module.exports = {
  acquireWorkloadAdmission,
  heartbeatWorkloadAdmission,
  releaseWorkloadAdmission,
  getWorkloadAdmissionIdentity,
  generateWithWorkloadAdmission,
};
