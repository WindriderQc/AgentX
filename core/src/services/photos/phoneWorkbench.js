'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fail } = require('./importFiles');
const { id, optional, hash } = require('./phoneLibrary');

// Durable native transport jobs reference the canonical Core import/cleanup
// identities. They never replace Media's manifests, reviews or receipts.
function createPhoneWorkbench({
  config,
  source,
  remote,
  importer,
  cleanup,
  launch,
  alive,
  checkpoint,
  lock,
}) {
  const jobs = path.join(config.cacheRoot, 'phone-jobs');
  async function status() {
    await fs.mkdir(jobs, { recursive: true, mode: 0o700 });
    const files = (await fs.readdir(jobs)).filter((x) => /^[a-f0-9-]{36}\.json$/.test(x));
    if (files.length > 2000)
      throw fail('JOB_HISTORY_LIMIT', 'Archive completed transport jobs before continuing');
    const rows = [];
    for (const name of files) {
      const job = await optional(path.join(jobs, name));
      if (!job) continue;
      const launchError = await optional(path.join(jobs, job.requestId + '.launch-error.json'));
      if (launchError && job.state === 'accepted') {
        job.state = 'unknown';
        job.error = launchError;
      }
      const recordedPid = job.pid || (await optional(path.join(jobs, job.requestId + '.pid.json')))?.pid;
      if (['accepted', 'running'].includes(job.state) && recordedPid && !(await alive(recordedPid)))
        job.state = 'unknown';
      // The full checkpoint stays local; only bounded progress crosses HTTP.
      const state =
        job.input.kind === 'import'
          ? await optional(path.join(config.cacheRoot, (job.input.resume || job.requestId) + '.json'))
          : null;
      rows.push({
        requestId: job.requestId,
        kind: job.input.kind,
        state: job.state,
        runId: job.input.resume || job.requestId,
        planId: job.input.planId,
        at: job.updatedAt || job.at,
        error: job.error,
        result: job.result
          ? {
              state: job.result.state,
              counts: job.result.counts,
              deleted: job.result.deleted,
              confirmedBytes: job.result.confirmedBytes,
            }
          : null,
        progress: state
          ? { selected: state.items.length, verified: state.items.filter((x) => x.receipt).length }
          : null,
      });
    }
    return {
      available: true,
      cleanupEnabled: config.phoneCleanupEnabled === true,
      jobs: rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
    };
  }
  async function start(input) {
    id(input.requestId);
    if (!['import', 'cleanup'].includes(input.kind)) throw fail('INVALID_ACTION', 'Invalid phone job');
    if (input.kind === 'cleanup') {
      if (config.phoneCleanupEnabled !== true) throw fail('CLEANUP_DISABLED', 'Phone cleanup is not enabled');
      id(input.planId);
      const plan = await remote({ action: 'library' }, { json: { op: 'plan', planId: input.planId } });
      if (input.confirmation !== plan.confirmation || input.digest !== plan.digest)
        throw fail('CONFIRMATION_REQUIRED', 'Confirm the exact selection');
    } else if (input.resume) id(input.resume);
    await fs.mkdir(jobs, { recursive: true, mode: 0o700 });
    const file = path.join(jobs, input.requestId + '.json');
    const previous = await optional(file);
    if (previous) {
      if (hash(previous.input) !== hash(input))
        throw fail('REQUEST_CONFLICT', 'This operation already has another intent');
      return { requestId: previous.requestId, state: previous.state };
    }
    const job = { requestId: input.requestId, input, state: 'accepted', at: new Date().toISOString() };
    // Exclusive creation fences concurrent HTTP retries before process launch.
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(job));
      await handle.sync();
    } finally {
      await handle.close();
    }
    let pid;
    try {
      pid = await launch(job.requestId);
      await checkpoint(path.join(jobs, job.requestId + '.pid.json'), { pid });
    } catch (e) {
      await checkpoint(path.join(jobs, job.requestId + '.launch-error.json'), {
        code: 'COLLECTOR_LAUNCH_UNCERTAIN',
        message: e.message,
      });
      throw e;
    }
    // Only the worker changes this document after launch; do not race it by
    // replacing its running/completed state from the HTTP process.
    return { requestId: job.requestId, state: 'accepted', pid };
  }
  async function run(requestId) {
    const file = path.join(jobs, id(requestId) + '.json');
    let release;
    try {
      release = await lock(path.join(config.cacheRoot, 'phone-workbench.lock'));
    } catch (e) {
      const job = await optional(file);
      if (job?.state === 'accepted') {
        job.state = 'failed';
        job.error = { code: 'PHONE_BUSY', message: 'Another phone operation is active' };
        await checkpoint(file, job);
      }
      throw e;
    }
    try {
      const job = await optional(file);
      if (!job) throw fail('JOB_NOT_FOUND', 'Unknown job');
      if (job.state === 'completed') return job;
      if (job.state !== 'accepted')
        throw fail('JOB_RECONCILIATION_REQUIRED', 'Reconcile the existing job instead of starting another');
      job.pid = process.pid;
      job.state = 'running';
      job.updatedAt = new Date().toISOString();
      await checkpoint(file, job);
      try {
        if (job.input.kind === 'import') {
          const resume =
            job.input.resume ||
            ((await optional(path.join(config.cacheRoot, job.requestId + '.json')))
              ? job.requestId
              : undefined);
          job.result = await importer(config, {
            source,
            remote,
            resume,
            initialRunId: job.requestId,
            deviceId: job.input.deviceId,
            log: () => {},
          });
          job.state = job.result.state === 'complete' ? 'completed' : 'incomplete';
        } else {
          job.result = await cleanup({
            input: { ...job.input, operationId: job.requestId },
            source,
            remote,
            enabled: config.phoneCleanupEnabled === true,
          });
          job.state = 'completed';
        }
      } catch (e) {
        job.state = e.code === 'CLEANUP_UNCERTAIN' ? 'unknown' : 'failed';
        job.error = { code: e.code || 'PHONE_JOB_FAILED', message: e.message };
        if (job.input.kind === 'cleanup') {
          try {
            job.result = await remote(
              { action: 'library' },
              { json: { op: 'cleanupStatus', planId: job.input.planId } },
            );
          } catch {
            /* Unavailable receipts stay unknown, never zero successes. */
          }
        }
      }
      job.updatedAt = new Date().toISOString();
      await checkpoint(file, job);
      return job;
    } finally {
      await release();
    }
  }
  async function reconcile(requestId) {
    const file = path.join(jobs, id(requestId) + '.json');
    const release = await lock(file + '.reconcile.lock');
    try {
      const job = await optional(file);
      if (!job) throw fail('JOB_NOT_FOUND', 'Unknown operation');
      if (job.state === 'completed') return { requestId, state: 'completed' };
      const pid = job.pid || (await optional(path.join(jobs, requestId + '.pid.json')))?.pid;
      if (!pid)
        throw fail(
          'JOB_RECONCILIATION_REQUIRED',
          'The original worker launch has no process receipt; inspect it before restarting',
        );
      if (await alive(pid)) throw fail('PHONE_BUSY', 'The original worker is still active');
      // Reuse the complete original input. Native dispatch fences refuse any
      // uncertain WPD Delete; durable local successes only repair Core receipts.
      job.state = 'accepted';
      job.updatedAt = new Date().toISOString();
      delete job.pid;
      delete job.error;
      await checkpoint(file, job);
      await fs.rm(path.join(jobs, requestId + '.launch-error.json'), { force: true });
      const nextPid = await launch(requestId);
      await checkpoint(path.join(jobs, requestId + '.pid.json'), { pid: nextPid });
      return { requestId, state: 'accepted' };
    } finally {
      await release();
    }
  }
  async function command(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw fail('INVALID_ACTION', 'Invalid command');
    if (input.op === 'status') return status();
    if (input.op === 'devices') return { devices: await source.devices() };
    if (input.op === 'reconcile') return reconcile(input.requestId);
    if (input.op === 'start') {
      const { op, ...job } = input;
      return start(job);
    }
    if (!['runs', 'page', 'review', 'prepare', 'cleanupStatus', 'preview'].includes(input.op))
      throw fail('INVALID_ACTION', 'Unknown phone command');
    return remote({ action: 'library' }, { json: input });
  }
  return { command, run };
}
module.exports = { createPhoneWorkbench };
