'use strict';

/**
 * Journals the batch quarantines Core still holds and Benchmark has no record
 * of. The process that owned the batch died, or could not write, before its
 * journal entry existed; the recovery identity it kept in memory is gone, so
 * the reconciliation worker has nothing to adopt and the hosts stay fenced.
 *
 * Only a quarantine whose batch is terminal here, whose original owner is no
 * longer live in Core, and that no unresolved record covers is journaled, from
 * the identity Core reads back. The reconciliation worker then lifts it the
 * ordinary way. Everything else is left untouched.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const { lookupWorkloadRecovery } = require('../../clients/coreApiClient');
const { getRuntimeActive } = require('../../clients/coreCoverageReads');
const { enqueueAuthorityInvalidation } = require('./authorityReconciliationJournal');

const TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
let interval = null;

async function journalIfRecordless(workload) {
  const workloadId = String(workload.workloadId);
  const covered = await BenchmarkAuthorityReconciliation.exists({ workloadId, state: { $ne: 'resolved' } });
  if (covered) return false;
  const batch = await BenchmarkBatch.findById(workloadId).select('status').lean();
  if (!batch || !TERMINAL_BATCH_STATUSES.has(batch.status)) return false;
  // Batch admissions are requested as `benchmark:<batchId>`.
  const recovery = await lookupWorkloadRecovery({ workloadId, recoveryRequestId: `recovery:benchmark:${workloadId}` });
  if (!recovery) return false;
  await enqueueAuthorityInvalidation({
    kind: 'batch_invalidation',
    resultId: workloadId,
    batchId: workloadId,
    workloadId,
    phase: 'record-less quarantine found after restart',
    reason: `batch ended ${batch.status} while Core kept its admission quarantined with no journal record`,
    recovery
  });
  logger.warn('Journaled a record-less batch quarantine from Core proof', { workloadId, batchStatus: batch.status });
  return true;
}

async function recoverRecordlessQuarantines() {
  const journaled = [];
  let active;
  try {
    active = await getRuntimeActive();
  } catch (error) {
    logger.warn('Record-less quarantine recovery could not read Core coordination', { error: error.message });
    return { fetched: false, journaled };
  }
  const expired = (active.workloads || []).filter(workload => workload.recoveryRequired === true
    && workload.kind === 'benchmark'
    && OBJECT_ID_PATTERN.test(String(workload.workloadId || ''))
    && new Date(workload.expiresAt).getTime() <= Date.now());
  for (const workload of expired) {
    try {
      if (await journalIfRecordless(workload)) journaled.push(String(workload.workloadId));
    } catch (error) {
      logger.warn('Record-less quarantine could not be journaled; it stays fenced', {
        workloadId: workload.workloadId, error: error.message
      });
    }
  }
  return { fetched: true, journaled };
}

/** Once at startup, then at a slow pace: an owner killed outright expires later. */
function startRecordlessQuarantineRecovery(options = {}) {
  if (interval) return interval;
  const run = () => recoverRecordlessQuarantines()
    .catch(error => logger.warn('Record-less quarantine recovery failed', { error: error.message }));
  run();
  interval = setInterval(run, Math.max(1_000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS));
  interval.unref?.();
  return interval;
}

function stopRecordlessQuarantineRecovery() {
  if (interval) clearInterval(interval);
  interval = null;
}

module.exports = {
  recoverRecordlessQuarantines,
  startRecordlessQuarantineRecovery,
  stopRecordlessQuarantineRecovery
};
