'use strict';

/**
 * Facade for benchmark authority reconciliation. Owns the sweep scheduler
 * state (interval, running) and re-exports the API implemented in:
 *   authorityReconciliationShared.js   - kind mapping and pure helpers
 *   profilerAuthorityPublication.js    - profiler write publication
 *   authorityResourceInvalidation.js   - projection compensation
 *   authorityReconciliationJournal.js  - journal enqueue/prepare/complete
 *   authorityJournalOwnership.js       - journal row ownership
 *   authorityRecordReconciler.js       - per-record recovery state machine
 */

const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const logger = require('../../../config/logger');
const { prepareWorkloadAuthority, verifyWorkloadAuthority, resolveWorkloadAuthority } = require('./workloadAuthorityGuard');
const {
  enqueueAuthorityInvalidation,
  enqueueResultInvalidation,
  prepareProfilerAuthorityWrite,
  completeProfilerAuthorityWrite
} = require('./authorityReconciliationJournal');
const {
  OWNER_STALE_MS,
  claimRecoveryRecord,
  releaseJournalOwnership
} = require('./authorityJournalOwnership');
const { reconcileOwnedRecord } = require('./authorityRecordReconciler');
const { invalidateResource } = require('./authorityResourceInvalidation');
const { publishProfilerResource } = require('./profilerAuthorityPublication');

const DEFAULT_INTERVAL_MS = 5_000;
let interval = null;
let running = false;

async function reconcilePendingResultInvalidations(options = {}) {
  if (running) return { skipped: true, reason: 'authority reconciliation already running' };
  running = true;
  try {
    const profilerKinds = [
      'profiler_evidence_write',
      'profiler_baseline_write',
      'profiler_snapshot_write',
      'profiler_context_write'
    ];
    const rows = await BenchmarkAuthorityReconciliation.find({
      state: { $ne: 'resolved' },
      $or: [
        { kind: { $nin: profilerKinds } },
        {
          kind: { $in: profilerKinds },
          startedAt: { $lte: new Date(Date.now() - OWNER_STALE_MS) }
        }
      ]
    })
      .sort({ startedAt: 1 }).limit(Number(options.limit) || 50).lean();
    const results = [];
    const workerId = String(options.workerId || `benchmark-recovery:${process.pid}`);
    for (const row of rows) {
      let ownership = null;
      try {
        ownership = await claimRecoveryRecord(row, workerId);
        if (!ownership) {
          results.push({ resolved: false, resultId: row.resultId, reason: 'journal owned by another recovery worker' });
          continue;
        }
        results.push(await reconcileOwnedRecord(ownership));
      } catch (error) {
        await releaseJournalOwnership(ownership, error);
        logger.warn('Benchmark authority reconciliation remains quarantined', {
          reconciliationId: String(row._id), resultId: row.resultId, error: error.message
        });
        results.push({ resolved: false, resultId: row.resultId, error: error.message });
      }
    }
    return {
      inspected: rows.length,
      resolved: results.filter(result => result.resolved).length,
      pending: results.filter(result => !result.resolved).length,
      results
    };
  } finally {
    running = false;
  }
}

async function waitForResultInvalidation(reconciliationId, options = {}) {
  const retryMs = Math.max(10, Number(options.retryMs) || 1_000);
  const workerId = String(options.workerId || `benchmark-recovery:${process.pid}:${reconciliationId}`);
  while (true) {
    const row = await BenchmarkAuthorityReconciliation.findById(reconciliationId).lean();
    if (!row) throw new Error(`Authority reconciliation ${reconciliationId} disappeared`);
    if (row.state === 'resolved') return { resolved: true, reconciliationId: String(row._id) };
    let ownership = null;
    try {
      ownership = await claimRecoveryRecord(row, workerId);
      if (ownership) await reconcileOwnedRecord(ownership);
    } catch (error) {
      await releaseJournalOwnership(ownership, error);
    }
    await new Promise(resolve => setTimeout(resolve, retryMs));
  }
}

function startBenchmarkAuthorityReconciliation(options = {}) {
  if (interval) return interval;
  const intervalMs = Math.max(100, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const run = () => reconcilePendingResultInvalidations(options)
    .catch(error => logger.warn('Benchmark authority reconciliation sweep failed', { error: error.message }));
  run();
  interval = setInterval(run, intervalMs);
  interval.unref?.();
  return interval;
}

function stopBenchmarkAuthorityReconciliation() {
  if (interval) clearInterval(interval);
  interval = null;
}

module.exports = {
  prepareWorkloadAuthority,
  verifyWorkloadAuthority,
  resolveWorkloadAuthority,
  enqueueAuthorityInvalidation,
  enqueueResultInvalidation,
  prepareProfilerAuthorityWrite,
  completeProfilerAuthorityWrite,
  reconcilePendingResultInvalidations,
  waitForResultInvalidation,
  startBenchmarkAuthorityReconciliation,
  stopBenchmarkAuthorityReconciliation,
  _claimRecoveryRecord: claimRecoveryRecord,
  _reconcileOwnedRecord: reconcileOwnedRecord,
  _invalidateResource: invalidateResource,
  _publishProfilerResource: publishProfilerResource
};
