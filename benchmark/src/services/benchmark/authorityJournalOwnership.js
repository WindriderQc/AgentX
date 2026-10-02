'use strict';

/**
 * Ownership of authority reconciliation journal rows: claim, assert,
 * refresh, CAS state persistence and release by recovery workers.
 * Moved out of benchmarkAuthorityReconciliation.js.
 */

const crypto = require('crypto');
const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const logger = require('../../../config/logger');

const OWNER_STALE_MS = 60_000;

async function claimRecoveryRecord(record, ownerId) {
  const ownerEpoch = crypto.randomUUID();
  const claimed = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    {
      _id: record._id,
      state: { $ne: 'resolved' },
      $or: [
        { ownerId: null },
        { ownerId: { $exists: false } },
        { ownerClaimedAt: { $lte: new Date(Date.now() - OWNER_STALE_MS) } }
      ]
    },
    { $set: { ownerId, ownerEpoch, ownerClaimedAt: new Date() } },
    { new: true }
  ).lean();
  return claimed ? { record: claimed, ownerId, ownerEpoch } : null;
}

async function assertJournalOwner(recordId, ownerId, ownerEpoch, states, options = {}) {
  const journal = await BenchmarkAuthorityReconciliation.findOne({
    _id: recordId,
    state: { $in: states },
    ownerId,
    ownerEpoch
  }, null, options.signal ? { signal: options.signal } : undefined).lean();
  if (!journal) {
    const error = new Error('Authority reconciliation journal ownership was lost');
    error.code = 'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST';
    throw error;
  }
  return journal;
}

async function refreshJournalOwner(ownership, { signal } = {}) {
  const { record, ownerId, ownerEpoch } = ownership;
  const result = await BenchmarkAuthorityReconciliation.updateOne(
    { _id: record._id, state: { $ne: 'resolved' }, ownerId, ownerEpoch },
    { $set: { ownerClaimedAt: new Date() } },
    { signal }
  );
  if (Number(result?.matchedCount ?? result?.modifiedCount) !== 1) {
    const error = new Error('Authority reconciliation journal ownership was lost');
    error.code = 'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST';
    throw error;
  }
}

async function persistJournalState(ownership, fromStates, state, fields = {}, options = {}) {
  options.assertActive?.();
  const { record, ownerId, ownerEpoch } = ownership;
  const updated = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { _id: record._id, state: { $in: fromStates }, ownerId, ownerEpoch },
    { $set: { state, ...fields, lastAttemptAt: new Date() }, $inc: { attempts: 1 } },
    { new: true, ...(options.signal ? { signal: options.signal } : {}) }
  ).lean();
  if (!updated) {
    const error = new Error(`Authority reconciliation ${state} receipt CAS was lost`);
    error.code = 'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST';
    throw error;
  }
  options.assertActive?.();
  ownership.record = updated;
  return updated;
}

function isRecoveryOwnershipLoss(error) {
  return new Set([
    'AUTHORITY_RECONCILIATION_OWNERSHIP_LOST',
    'RECOVERY_OWNERSHIP_LOST',
    'WORKLOAD_RECOVERY_OWNERSHIP_LOST'
  ]).has(error?.code);
}

async function releaseJournalOwnership(ownership, error) {
  if (!ownership || isRecoveryOwnershipLoss(error)) return;
  const { record, ownerId, ownerEpoch } = ownership;
  try {
    await BenchmarkAuthorityReconciliation.updateOne(
      { _id: record._id, state: { $ne: 'resolved' }, ownerId, ownerEpoch },
      { $set: {
        ownerId: null,
        ownerEpoch: null,
        ownerClaimedAt: null,
        lastAttemptAt: new Date(),
        lastError: error.message
      }, $inc: { attempts: 1 } }
    );
  } catch (updateError) {
    logger.error('Authority recovery ownership release failed', {
      reconciliationId: String(record._id), error: updateError.message
    });
  }
}

module.exports = {
  OWNER_STALE_MS,
  claimRecoveryRecord,
  assertJournalOwner,
  refreshJournalOwner,
  persistJournalState,
  isRecoveryOwnershipLoss,
  releaseJournalOwnership
};
