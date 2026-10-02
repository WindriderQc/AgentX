'use strict';

/**
 * Drives one owned authority reconciliation record through Core recovery:
 * compensation or publication, verification, host restore and release.
 * Moved out of benchmarkAuthorityReconciliation.js.
 */

const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const {
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  restoreWorkloadRecoveryHosts,
  releaseWorkloadAdmission,
  recoverWorkloadAdmissionRelease
} = require('../../clients/coreApiClient');
const { startRecoveryOwnershipHeartbeat } = require('../recoveryOwnershipHeartbeat');
const { isProfilerAuthorityKind } = require('./authorityReconciliationShared');
const { publishProfilerResource } = require('./profilerAuthorityPublication');
const { invalidateResource } = require('./authorityResourceInvalidation');
const {
  assertJournalOwner,
  refreshJournalOwner,
  persistJournalState
} = require('./authorityJournalOwnership');

async function adoptAndAssert(record, ownerId, options = {}) {
  await adoptWorkloadRecovery({
    workloadId: record.workloadId,
    recoveryId: record.recoveryId,
    recoveryRequestId: record.recoveryRequestId,
    ownerId,
    signal: options.signal
  });
  const heartbeat = await heartbeatWorkloadRecovery(record.workloadId, undefined, options);
  if (heartbeat?.heartbeat !== true) {
    const error = new Error(heartbeat?.reason || 'Core recovery owner heartbeat was rejected');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  const core = await assertWorkloadRecovery(record.workloadId, options);
  if (core?.owned !== true || core.recoveryOwnerId !== ownerId) {
    const error = new Error(core?.reason || 'Core recovery quarantine ownership was lost');
    error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
    throw error;
  }
  return core;
}

async function reconcileOwnedRecord(ownership) {
  let { record } = ownership;
  const { ownerId, ownerEpoch } = ownership;
  const ownershipHeartbeat = startRecoveryOwnershipHeartbeat({
    refreshOwner: options => refreshJournalOwner(ownership, options)
  });

  try {
  await ownershipHeartbeat.ready;

  if (record.state === 'verified' || record.state === 'releasing') {
    if (record.state === 'verified' && record.resolutionMode === 'publish' && isProfilerAuthorityKind(record.kind)) {
      const publicationReceipt = await publishProfilerResource(record, {
        signal: ownershipHeartbeat.signal,
        assertActive: ownershipHeartbeat.assertActive
      });
      record = await persistJournalState(ownership, ['verified'], 'verified', {
        compensationReceipt: publicationReceipt,
        lastError: null
      }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
    }
    ownershipHeartbeat.assertActive();
    const recovered = await recoverWorkloadAdmissionRelease({
      admissionId: record.admissionId,
      generation: record.admissionGeneration,
      principal: record.admissionPrincipal,
      workloadId: record.workloadId,
      recoveryId: record.recoveryId
    }, { signal: ownershipHeartbeat.signal });
    ownershipHeartbeat.assertActive();
    if (recovered?.released === true) {
      const resolvedAt = new Date();
      await persistJournalState(ownership, ['verified', 'releasing'], 'resolved', {
        releaseReceipt: recovered,
        resolvedAt,
        lastError: null,
        ownerId: null,
        ownerEpoch: null,
        ownerClaimedAt: null
      }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
      return { resolved: true, resultId: record.resultId, resolvedAt, recovered: true };
    }
  }

  await adoptAndAssert(record, ownerId, { signal: ownershipHeartbeat.signal });
  ownershipHeartbeat.setCoreHeartbeat(({ signal }) => heartbeatWorkloadRecovery(
    record.workloadId,
    undefined,
    { signal }
  ));
  await ownershipHeartbeat.heartbeatOnce();
  ownershipHeartbeat.assertActive();
  await assertJournalOwner(
    record._id,
    ownerId,
    ownerEpoch,
    ['pending_reconciliation', 'verified', 'releasing'],
    { signal: ownershipHeartbeat.signal }
  );

  if (record.state === 'pending_reconciliation') {
    await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
      if (result?.heartbeat !== true) {
        const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
        error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
        throw error;
      }
    });
    const core = await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal });
    if (new Set(['PREPARED', 'MUTATING']).has(core.recoveryState)) {
      await transitionWorkloadRecovery(record.workloadId, 'UNKNOWN', {
        signal: ownershipHeartbeat.signal,
        receipt: { contract: 'agentx.workload-recovery/v1', event: 'ambiguous-authority-write' }
      });
    }
    ownershipHeartbeat.assertActive();
    const compensationReceipt = await invalidateResource(record, {
      signal: ownershipHeartbeat.signal,
      assertActive: ownershipHeartbeat.assertActive
    });
    ownershipHeartbeat.assertActive();
    await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
      if (result?.heartbeat !== true) {
        const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
        error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
        throw error;
      }
    });
    await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal }).then(result => {
      if (result?.owned !== true || result.recoveryOwnerId !== ownerId) {
        const error = new Error(result?.reason || 'Core recovery ownership was lost after compensation');
        error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
        throw error;
      }
    });
    record = await persistJournalState(ownership, ['pending_reconciliation'], 'verified', {
      compensationReceipt,
      lastError: null
    }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
  }

  if (record.state === 'verified') {
    if (record.resolutionMode === 'publish' && isProfilerAuthorityKind(record.kind)) {
      const publicationReceipt = await publishProfilerResource(record, {
        signal: ownershipHeartbeat.signal,
        assertActive: ownershipHeartbeat.assertActive
      });
      record = await persistJournalState(ownership, ['verified'], 'verified', {
        compensationReceipt: publicationReceipt,
        lastError: null
      }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
    }
    const core = await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal });
    if (core.recoveryState !== 'VERIFIED' && core.recoveryState !== 'RESTORED') {
      await transitionWorkloadRecovery(record.workloadId, 'VERIFIED', {
        signal: ownershipHeartbeat.signal,
        receipt: record.compensationReceipt
      });
    }
    const afterVerified = await assertWorkloadRecovery(record.workloadId, { signal: ownershipHeartbeat.signal });
    if (afterVerified.recoveryState !== 'RESTORED') {
      await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
        if (result?.heartbeat !== true) {
          const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
          error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
          throw error;
        }
      });
      ownershipHeartbeat.assertActive();
      const hostRestore = await restoreWorkloadRecoveryHosts(
        record.workloadId,
        {},
        { signal: ownershipHeartbeat.signal }
      );
      ownershipHeartbeat.assertActive();
      if (hostRestore?.restored !== true) {
        throw new Error(hostRestore?.reason || 'Core host restoration under recovery quarantine failed');
      }
      await transitionWorkloadRecovery(record.workloadId, 'RESTORED', {
        signal: ownershipHeartbeat.signal,
        receipt: {
          contract: 'agentx.workload-recovery/v1',
          event: 'authority-restored',
          compensation: record.compensationReceipt
        }
      });
    }
    record = await persistJournalState(
      ownership,
      ['verified'],
      'releasing',
      { lastError: null },
      { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive }
    );
  }

  ownershipHeartbeat.assertActive();
  const remaining = await BenchmarkAuthorityReconciliation.countDocuments({
    workloadId: record.workloadId,
    state: { $in: ['pending_reconciliation', 'verified'] },
    _id: { $ne: record._id }
  }, { signal: ownershipHeartbeat.signal });
  ownershipHeartbeat.assertActive();
  if (remaining > 0) {
    return { resolved: false, resultId: record.resultId, reason: 'other authority reconciliations remain pending' };
  }
  await assertJournalOwner(
    record._id,
    ownerId,
    ownerEpoch,
    ['releasing'],
    { signal: ownershipHeartbeat.signal }
  );
  await heartbeatWorkloadRecovery(record.workloadId, undefined, { signal: ownershipHeartbeat.signal }).then(result => {
    if (result?.heartbeat !== true) {
      const error = new Error(result?.reason || 'Core recovery owner heartbeat was rejected');
      error.code = 'WORKLOAD_RECOVERY_OWNERSHIP_LOST';
      throw error;
    }
  });
  ownershipHeartbeat.assertActive();
  const released = await releaseWorkloadAdmission(record.workloadId, { signal: ownershipHeartbeat.signal });
  ownershipHeartbeat.setCoreHeartbeat(null);
  ownershipHeartbeat.assertActive();
  if (released?.released !== true) throw new Error(released?.reason || 'Recovery quarantine release was not acknowledged');
  const resolvedAt = new Date();
  await persistJournalState(ownership, ['releasing'], 'resolved', {
    releaseReceipt: released,
    resolvedAt,
    lastError: null,
    ownerId: null,
    ownerEpoch: null,
    ownerClaimedAt: null
  }, { signal: ownershipHeartbeat.signal, assertActive: ownershipHeartbeat.assertActive });
  return { resolved: true, resultId: record.resultId, resolvedAt, recovery: released };
  } finally {
    await ownershipHeartbeat.stop();
  }
}

module.exports = { adoptAndAssert, reconcileOwnedRecord };
