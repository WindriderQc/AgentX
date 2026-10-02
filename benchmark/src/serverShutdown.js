'use strict';

/**
 * One shutdown sequence for SIGTERM and SIGINT.
 *
 * Stop accepting connections, stop judging, mark the running batch
 * interrupted, give in-flight requests a short drain, close MongoDB, then let
 * the process end by itself with exit code 0. The deadline is the only forced
 * exit: it, a second signal or a failed step exits nonzero, so a leaked
 * handle is never hidden behind a successful exit.
 */

const mongoose = require('mongoose');
const logger = require('../config/logger');
const BenchmarkBatch = require('../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../models/BenchmarkTimelineEntry');
const { getActiveBatchId, getActiveHeartbeatInterval } = require('./services/benchmark/execution');
const { stopAllJudging } = require('./services/benchmark/judging');
const { buildIdleCurrentTest } = require('./services/benchmark/batchHelpers');

const SHUTDOWN_DEADLINE_MS = 5000;
const REQUEST_DRAIN_MS = 3000;

async function interruptActiveBatch(signal) {
  const batchId = getActiveBatchId();
  if (!batchId) return;
  logger.warn(`${signal} received - marking active batch as interrupted`, { batchId });
  const heartbeat = getActiveHeartbeatInterval();
  if (heartbeat) clearInterval(heartbeat);
  await BenchmarkTimelineEntry.create({
    batchId,
    timestamp: new Date(),
    event: `${signal.toLowerCase()}_interrupted`,
    success: false,
    error: `Process received ${signal} signal`
  }).catch(() => {});
  await BenchmarkBatch.updateOne(
    { _id: batchId, status: 'running' },
    { $set: {
      status: 'interrupted',
      completed_at: new Date(),
      last_activity_at: new Date(),
      current_test: buildIdleCurrentTest(),
      active_slot: null
    } }
  );
  logger.info('Batch marked as interrupted', { batchId });
}

// Resolves once the listener has closed; open requests get REQUEST_DRAIN_MS.
function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cut = setTimeout(() => server.closeAllConnections(), REQUEST_DRAIN_MS);
    server.close(error => {
      clearTimeout(cut);
      if (error) reject(error); else resolve();
    });
    server.closeIdleConnections();
  });
}

function installShutdown(server, processRef = process) {
  let pending = null;

  function run(signal) {
    if (pending) {
      logger.error(`Second ${signal} during Benchmark shutdown; exiting now`);
      processRef.exit(1);
      return pending;
    }
    logger.info('Benchmark shutdown started', { signal });
    const deadline = setTimeout(() => {
      logger.error('Benchmark shutdown exceeded its deadline');
      processRef.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();

    stopAllJudging();
    pending = (async () => {
      const results = await Promise.allSettled([closeServer(server), interruptActiveBatch(signal)]);
      results.push(...await Promise.allSettled([mongoose.disconnect()]));
      const failures = results.filter(result => result.status === 'rejected');
      for (const failure of failures) {
        logger.error('Benchmark shutdown step failed', { error: failure.reason?.message });
      }
      processRef.exitCode = failures.length ? 1 : 0;
      logger.info('Benchmark shutdown drained', { failed: failures.length });
    })();
    return pending;
  }

  for (const signal of ['SIGTERM', 'SIGINT']) processRef.on(signal, () => run(signal));
  return { run };
}

module.exports = { installShutdown, interruptActiveBatch, SHUTDOWN_DEADLINE_MS, REQUEST_DRAIN_MS };
