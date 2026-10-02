'use strict';

/**
 * The durable authority guard of a managed workload (a batch, a judge run, a
 * profiler queue). Before the workload mutates anything it records a
 * pending_reconciliation guard; on success it verifies, then resolves it.
 *
 * The guard is keyed by workload id, and some ids repeat by design: every
 * standalone judge run of a batch is `judge-batch:<batchId>`. A guard that an
 * earlier admission already resolved is therefore re-armed for the new
 * admission. A guard still pending for another admission is left alone: that
 * earlier run was never reconciled, and verifying over it would hide it.
 *
 * Moved out of benchmarkAuthorityReconciliation.js, which re-exports these.
 */

const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const { getWorkloadRecoveryIdentity } = require('../../clients/coreApiClient');

function pendingGuardFields(workloadKey, recovery, { batchId, phase }) {
  return {
    kind: 'workload_invalidation',
    resourceType: 'BenchmarkWorkload',
    batchId: batchId ? String(batchId) : null,
    workloadId: workloadKey,
    admissionId: recovery.admissionId,
    admissionGeneration: recovery.generation,
    admissionPrincipal: recovery.principal,
    recoveryId: recovery.recoveryId,
    recoveryRequestId: recovery.recoveryRequestId,
    phase,
    state: 'pending_reconciliation',
    reason: 'workload owner has not published a terminal authority receipt',
    attempts: 0,
    startedAt: new Date()
  };
}

async function prepareWorkloadAuthority({ workloadId, batchId = null, phase = 'workload' } = {}) {
  const workloadKey = String(workloadId || '');
  if (!workloadKey) throw new Error('workloadId is required for authority guard');
  const recovery = getWorkloadRecoveryIdentity(workloadKey);
  if (!recovery?.recoveryId || !recovery?.recoveryRequestId
    || !recovery?.admissionId || !recovery?.generation || !recovery?.principal) {
    throw new Error(`Durable recovery quarantine proof is missing for workload ${workloadKey}`);
  }
  const resultId = `workload:${workloadKey}`;
  const fields = pendingGuardFields(workloadKey, recovery, { batchId, phase });
  const rearmed = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId, state: 'resolved', admissionId: { $ne: recovery.admissionId } },
    {
      $set: fields,
      $unset: {
        compensationReceipt: '', releaseReceipt: '', resolvedAt: '', lastError: '', lastAttemptAt: '',
        ownerId: '', ownerEpoch: '', ownerClaimedAt: ''
      }
    },
    { new: true }
  ).lean();
  if (rearmed) return rearmed;
  return BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId },
    { $setOnInsert: { resultId, ...fields } },
    { upsert: true, new: true }
  ).lean();
}

async function verifyWorkloadAuthority(workloadId, receipt = {}) {
  const workloadKey = String(workloadId || '');
  const updated = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: `workload:${workloadKey}`, workloadId: workloadKey, state: 'pending_reconciliation' },
    { $set: {
      state: 'verified',
      reason: null,
      compensationReceipt: {
        contract: 'agentx.authority-workload-terminal/v1',
        workloadId: workloadKey,
        ...receipt,
        verifiedAt: new Date().toISOString()
      }
    } },
    { new: true }
  ).lean();
  if (!updated) throw new Error(`Workload authority guard ${workloadKey} could not be verified`);
  return updated;
}

async function resolveWorkloadAuthority(workloadId, releaseReceipt) {
  const workloadKey = String(workloadId || '');
  const updated = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: `workload:${workloadKey}`, workloadId: workloadKey, state: { $in: ['verified', 'releasing'] } },
    { $set: {
      state: 'resolved',
      reason: null,
      releaseReceipt,
      resolvedAt: new Date(),
      ownerId: null,
      ownerEpoch: null,
      ownerClaimedAt: null
    } },
    { new: true }
  ).lean();
  if (!updated) throw new Error(`Workload authority guard ${workloadKey} terminal receipt could not be projected`);
  return updated;
}

module.exports = { prepareWorkloadAuthority, verifyWorkloadAuthority, resolveWorkloadAuthority };
