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
  const { recoverJudgeQueue } = require('./benchmark/judgeQueueRecovery');
  recoverJudgeQueue().catch(err => logger.warn('Judge queue recovery error', { error: err.message }));

  // Release leaked claims, mark ghost batches stopped, then re-acquire the
  // claims of batches that are still genuinely active.
  const { recoverLeakedClaims, reacquireActiveBatchClaims } = require('./benchmark/claimRecovery');
  recoverLeakedClaims()
    .then(() => reacquireActiveBatchClaims())
    .catch(err => logger.warn('Claim recovery error', { error: err.message }));

  require('./profiler/profilerProjectionRecovery').startProfilerProjectionRecovery();
  require('./benchmark/benchmarkAuthorityReconciliation').startBenchmarkAuthorityReconciliation();

  if (shouldSyncRegisteredHosts(profile)) {
    // Hosts registered in Core's Nerve Center become profiling and benchmark targets.
    require('./registeredHostSync').startRegisteredHostSync();
  } else {
    logger.info('[RegisteredHostSync] Disabled by the demo product profile');
  }
}

module.exports = { startStartupRecovery };
