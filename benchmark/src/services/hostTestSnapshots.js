/**
 * Host test snapshot persistence (HostPerformanceSnapshot through the
 * profiler authority journal). Re-exported by ./hostTestService.
 */

const mongoose = require('mongoose');
const HostPerformanceSnapshot = require('../../models/HostPerformanceSnapshot');
const authorityReconciliation = require('./benchmark/benchmarkAuthorityReconciliation');

async function persistHostSnapshot(modelName, snapshot, { signal, checkpoint, workloadId } = {}) {
  const snapshotId = new mongoose.Types.ObjectId();
  const authorityWriteId = new mongoose.Types.ObjectId().toString();
  if (!workloadId) {
    const error = new Error('Host snapshot publication requires an exact durable workload identity');
    error.code = 'PROFILER_AUTHORITY_JOURNAL_REQUIRED';
    throw error;
  }
  let journal = null;
  checkpoint?.();
  try {
    const basePayload = { _id: snapshotId, modelName, ...snapshot };
    journal = await authorityReconciliation.prepareProfilerAuthorityWrite({
      kind: 'profiler_snapshot_write',
      resultId: `profiler-snapshot:${workloadId}:${snapshotId}`,
      workloadId,
      phase: 'profiler host performance snapshot publication',
      details: {
        snapshotId: String(snapshotId),
        authorityWriteId,
        payload: basePayload
      }
    });
    checkpoint?.();
    const payload = {
      ...basePayload,
      authorityState: 'pending_reconciliation',
      authorityWriteId,
      authorityReconciliationId: String(journal._id)
    };
    const created = await HostPerformanceSnapshot.create(
      [payload],
      signal ? { signal } : undefined
    );
    const saved = Array.isArray(created) ? created[0] : created;
    checkpoint?.();
    await authorityReconciliation.completeProfilerAuthorityWrite(journal, {
      details: journal.details,
      signal,
      assertAuthorityActive: checkpoint
    });
    return saved;
  } catch (error) {
    if (journal) {
      error.retainAdmission = true;
      error.authorityInvalidationFailed = true;
      error.code = error.code || 'HOST_SNAPSHOT_RECONCILIATION_PENDING';
      error.reconciliationId = String(journal._id);
    }
    throw error;
  }
}

async function persistFailureSnapshot(modelName, snapshot, options = {}) {
  return persistHostSnapshot(modelName, {
    modelName,
    hostId:      null,
    tokensPerSec: 0,
    latencyMs:    0,
    numCtx:       null,
    testedAt:     new Date(),
    status:       'error',
    error:        null,
    ...snapshot
  }, options);
}

module.exports = { persistHostSnapshot, persistFailureSnapshot };
