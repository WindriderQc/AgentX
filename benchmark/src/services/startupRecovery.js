'use strict';

/**
 * Startup recovery after a crash, in both product profiles.
 *
 * A process crash mid-batch or mid-profile skips the normal release path:
 * claims stay held, a batch stays running and blocks new batches, and a
 * profiler workload can stay quarantined. The recovery paths below only call
 * Core coordination routes that the demo profile keeps. Registered-host sync
 * reads the full-profile Nerve Center host list and stays full-only.
 */

const logger = require('../../config/logger');
const { shouldSyncRegisteredHosts } = require('../helpers/benchmarkProfileCapabilities');

function startStartupRecovery(profile) {
  const { interruptOrphanedBatches, currentProcessStartedAt } = require('./benchmark/orphanedBatchRecovery');
  const { recoverJudgeQueue } = require('./benchmark/judgeQueueRecovery');
  const { recoverLeakedClaims, reacquireActiveBatchClaims } = require('./benchmark/claimRecovery');
  const processStartedAt = currentProcessStartedAt();

  // Settle batches a previous process left running before anything else
  // writes to them. Then recover judge tasks, release leaked claims, and
  // re-acquire claims only for batches this process owns.
  interruptOrphanedBatches(processStartedAt)
    .catch(err => logger.warn('Orphaned batch recovery error', { error: err.message }))
    .then(() => {
      recoverJudgeQueue().catch(err => logger.warn('Judge queue recovery error', { error: err.message }));
      return recoverLeakedClaims().then(() => reacquireActiveBatchClaims({ processStartedAt }));
    })
    .catch(err => logger.warn('Claim recovery error', { error: err.message }));

  require('./profiler/profilerProjectionRecovery').startProfilerProjectionRecovery();
  require('./benchmark/benchmarkAuthorityReconciliation').startBenchmarkAuthorityReconciliation();

  if (shouldSyncRegisteredHosts(profile)) {
    // Hosts registered in Core's Nerve Center become profiling and benchmark targets.
    require('./registeredHostSync').startRegisteredHostSync();
    // Coverage reads the Nerve Center too; it stays idle until switched on.
    require('./measurementCoverage/coverageJob').getCoverageJob().start();
  } else {
    logger.info('[RegisteredHostSync] Disabled by the demo product profile');
  }
}

module.exports = { startStartupRecovery };
