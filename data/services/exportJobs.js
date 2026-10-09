'use strict';

/**
 * Report generation as background jobs.
 *
 * A full report walks every indexed file through an unindexed sort, so its
 * duration grows with the inventory: the HTTP request only starts the job and
 * the report list says what became of it. Job state lives in memory: a restart
 * ends the running generations, and their `.part` files are removed by the
 * next list or generation.
 */

const { log } = require('../utils/logger');
const store = require('./exportStore');

const MAX_RUNNING = 2;
const MAX_FINISHED_KEPT = 20;

function createExportJobs({ maxRunning = MAX_RUNNING, maxFinishedKept = MAX_FINISHED_KEPT, limits } = {}) {
  const jobs = new Map(); // filename -> job
  const pending = new Set();

  function runningNames() {
    return new Set([...jobs.values()].filter(job => job.status === 'running').map(job => job.filename));
  }

  function forgetOldFinished() {
    const finished = [...jobs.values()].filter(job => job.status !== 'running')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (finished.length > maxFinishedKept) jobs.delete(finished.shift().filename);
  }

  /**
   * Start one generation. `produce(partPath, generatedAt)` writes the whole
   * report to `partPath` and resolves with `{ recordCount, skippedCount }`.
   * Returns `{ busy: true }` when `maxRunning` generations are already running.
   */
  function start(type, format, produce, now = new Date()) {
    if (runningNames().size >= maxRunning) return { busy: true };
    const job = {
      filename: store.newReportName(type, format, now),
      type,
      format,
      status: 'running',
      requestedAt: now,
      finishedAt: null,
      size: null,
      recordCount: null,
      skippedCount: null,
      removed: [],
      error: null
    };
    jobs.set(job.filename, job);

    const work = (async () => {
      try {
        await store.ensureDir();
        await store.removeStaleParts(runningNames());
        const result = await produce(store.partPath(job.filename), now.toISOString());
        const report = await store.commitPart(job.filename);
        job.size = report ? report.size : null;
        job.recordCount = result?.recordCount ?? null;
        job.skippedCount = result?.skippedCount ?? 0;
        job.status = 'ready';
        try {
          job.removed = await store.pruneReports(job.filename, limits);
        } catch (error) {
          log(`[exports] Could not prune old reports: ${error.message}`, 'warn');
        }
      } catch (error) {
        await store.discardPart(job.filename);
        job.status = 'failed';
        job.error = String(error?.message || error).split('\n')[0].slice(0, 300);
        log(`[exports] Report ${job.filename} failed: ${job.error}`, 'error');
      } finally {
        job.finishedAt = new Date();
        forgetOldFinished();
      }
    })();
    pending.add(work);
    work.finally(() => pending.delete(work));
    return { job };
  }

  return {
    start,
    get: (filename) => jobs.get(filename) || null,
    forget: (filename) => jobs.delete(filename),
    list: () => [...jobs.values()],
    runningNames,
    /** Resolves when every generation started so far has ended (tests, shutdown). */
    settled: () => Promise.all([...pending]).then(() => undefined)
  };
}

module.exports = { MAX_RUNNING, MAX_FINISHED_KEPT, createExportJobs };
