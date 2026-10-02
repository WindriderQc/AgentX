'use strict';

/**
 * Orphaned batch recovery at startup.
 *
 * Batch execution lives only in the process that runs it, and a deployment
 * runs one Benchmark process (active_slot 'benchmark_singleton'). A batch
 * still `running` or `judging` that no write has touched since this process
 * started belongs to a previous process that died without its `finally`
 * (SIGKILL, OOM, host reboot). Every batch this process creates, resumes,
 * locks or heartbeats is written after it started, so it is never matched.
 *
 * Such a batch is reconciled to `interrupted` (or `completed` when every test
 * and judgment already finished) whatever its last activity, so a restart
 * within the inactivity thresholds no longer re-acquires its host claims.
 * An interrupted batch stays resumable from its checkpoint by the operator.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');

function currentProcessStartedAt() {
  return new Date(Date.now() - (process.uptime() * 1000));
}

async function interruptOrphanedBatches(processStartedAt = currentProcessStartedAt()) {
  const count = await BenchmarkBatch.reconcileAbandoned({
    status: { $in: ['running', 'judging'] },
    $or: [{ updated_at: { $lt: processStartedAt } }, { updated_at: null }]
  }, 'orphaned_on_startup', 'Batch was running in a previous Benchmark process');
  if (count > 0) {
    logger.warn('[OrphanedBatchRecovery] Reconciled batches left running by a previous process', { count });
  }
  return count;
}

module.exports = { interruptOrphanedBatches, currentProcessStartedAt };
