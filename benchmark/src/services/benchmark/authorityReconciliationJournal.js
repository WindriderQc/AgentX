'use strict';

/**
 * Writes durable authority reconciliation journal entries: enqueues
 * invalidations and prepares/completes profiler authority writes.
 * Moved out of benchmarkAuthorityReconciliation.js.
 */

const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { getWorkloadRecoveryIdentity } = require('../../clients/coreApiClient');
const logger = require('../../../config/logger');
const { resourceTypeForKind, isProfilerAuthorityKind } = require('./authorityReconciliationShared');
const { publishProfilerResource } = require('./profilerAuthorityPublication');

async function enqueueAuthorityInvalidation({
  kind = 'result_invalidation',
  resultId,
  batchId,
  workloadId,
  phase,
  reason,
  details = null,
  resolutionMode = 'invalidate',
  // The identity Core read back, when this process no longer remembers it.
  recovery: suppliedRecovery = null
}) {
  const identity = String(resultId || '');
  const workloadKey = String(workloadId || batchId || '');
  if (!identity) throw new Error('resultId is required for authority reconciliation');
  const recovery = suppliedRecovery || getWorkloadRecoveryIdentity(workloadKey);
  if (!workloadKey || !recovery?.recoveryId || !recovery?.recoveryRequestId
    || !recovery?.admissionId || !recovery?.generation || !recovery?.principal) {
    throw new Error(`Durable recovery quarantine proof is missing for workload ${workloadKey || 'unknown'}`);
  }
  const resourceType = resourceTypeForKind(kind);
  if (!resourceType) throw new Error(`Unsupported authority reconciliation kind: ${kind}`);
  const pending = {
    kind,
    resultId: identity,
    resourceType,
    batchId: batchId ? String(batchId) : null,
    workloadId: workloadKey,
    admissionId: recovery.admissionId,
    admissionGeneration: recovery.generation,
    admissionPrincipal: recovery.principal,
    recoveryId: recovery.recoveryId,
    recoveryRequestId: recovery.recoveryRequestId,
    phase,
    details,
    resolutionMode,
    state: 'pending_reconciliation',
    reason: reason || null,
    attempts: 0,
    startedAt: new Date()
  };
  // A record an earlier admission of the same resource left resolved is
  // re-armed for this admission; otherwise the upsert below would keep it
  // resolved and the new quarantine would have no record.
  const record = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: identity, state: 'resolved', admissionId: { $ne: recovery.admissionId } },
    {
      $set: { ...pending, lastError: reason || null },
      $unset: {
        compensationReceipt: '', releaseReceipt: '', resolvedAt: '', lastAttemptAt: '',
        ownerId: '', ownerEpoch: '', ownerClaimedAt: ''
      }
    },
    { new: true }
  ).lean() || await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: identity },
    { $setOnInsert: pending, $set: { lastError: reason || null } },
    { upsert: true, new: true }
  ).lean();

  if (batchId) {
    try {
      await BenchmarkBatch.updateOne(
        { _id: batchId, authority_state: { $ne: 'authority_invalidated' } },
        { $set: {
          authority_state: 'pending_reconciliation',
          authority_reconciliation_reason: `${resourceType} ${identity} persistence acknowledgement was ambiguous`
        } }
      );
    } catch (error) {
      logger.error('Benchmark batch pending-authority projection could not be persisted', {
        batchId: String(batchId), reconciliationId: String(record._id), error: error.message
      });
    }
  }
  return record;
}

function enqueueResultInvalidation(input) {
  return enqueueAuthorityInvalidation({ ...input, kind: 'result_invalidation' });
}

async function prepareProfilerAuthorityWrite(input = {}) {
  if (!isProfilerAuthorityKind(input.kind)) {
    throw new Error(`Unsupported profiler authority write kind: ${input.kind || 'unknown'}`);
  }
  return enqueueAuthorityInvalidation({
    ...input,
    reason: input.reason || 'profiler authority write prepared before first projection mutation',
    resolutionMode: 'invalidate'
  });
}

async function completeProfilerAuthorityWrite(recordOrId, input = {}) {
  const recordId = recordOrId?._id || recordOrId;
  input.assertAuthorityActive?.();
  const verified = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    {
      _id: recordId,
      state: 'pending_reconciliation',
      $or: [{ ownerId: null }, { ownerId: { $exists: false } }]
    },
    { $set: {
      state: 'verified',
      resolutionMode: 'publish',
      details: input.details || recordOrId?.details || null,
      compensationReceipt: {
        contract: 'agentx.profiler-authority-write/v1',
        terminal: 'all_projection_writes_acknowledged',
        verifiedAt: new Date().toISOString()
      },
      lastError: null
    } },
    { new: true, ...(input.signal ? { signal: input.signal } : {}) }
  ).lean();
  if (!verified) {
    const error = new Error('Profiler authority journal verification CAS was lost');
    error.code = 'PROFILER_AUTHORITY_RECONCILIATION_PENDING';
    error.retainAdmission = true;
    error.authorityInvalidationFailed = true;
    throw error;
  }
  input.assertAuthorityActive?.();
  const publicationReceipt = await publishProfilerResource(verified, {
    signal: input.signal,
    assertActive: input.assertAuthorityActive
  });
  input.assertAuthorityActive?.();
  const resolvedAt = new Date();
  const resolved = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { _id: recordId, state: 'verified', resolutionMode: 'publish' },
    { $set: {
      state: 'resolved',
      compensationReceipt: publicationReceipt,
      resolvedAt,
      lastError: null,
      ownerId: null,
      ownerEpoch: null,
      ownerClaimedAt: null
    } },
    { new: true, ...(input.signal ? { signal: input.signal } : {}) }
  ).lean();
  if (!resolved) {
    const error = new Error('Profiler authority journal resolution CAS was lost');
    error.code = 'PROFILER_AUTHORITY_RECONCILIATION_PENDING';
    error.retainAdmission = true;
    error.authorityInvalidationFailed = true;
    throw error;
  }
  return { record: resolved, publicationReceipt };
}

module.exports = {
  enqueueAuthorityInvalidation,
  enqueueResultInvalidation,
  prepareProfilerAuthorityWrite,
  completeProfilerAuthorityWrite
};
