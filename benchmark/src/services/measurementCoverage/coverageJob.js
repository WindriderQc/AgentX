'use strict';

/**
 * The coverage job: one small measurement at a time, in quiet periods, until
 * every host and model in scope is profiled and has answered the catalog.
 *
 * Rule-based on purpose. Each tick: settle the previous bite against the
 * matrix, check the quiet period, pick the next cell, launch one bite. A cell
 * whose bites keep failing is left alone for a day instead of being retried
 * every night.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { buildCoverage } = require('./coverageState');
const { checkIdle } = require('./coverageIdle');
const { launchBite } = require('./coverageLauncher');
const settingsStore = require('./coverageSettings');
const coreReads = require('../../clients/coreCoverageReads');
const { hostKey, modelKey } = require('./coverageScope');

const TICK_MS = 60_000;
const MAX_FAILURES = 3;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

// The Profiler keeps its running jobs in memory; ask it the way the UI does.
async function activeProfiles(fetchImpl = fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${process.env.PORT || 3081}/api/profiler/pipeline/profile/active`,
    { signal: AbortSignal.timeout(10000) });
  const active = (await response.json())?.data?.active;
  return Array.isArray(active) ? active.length > 0 : Object.keys(active || {}).length > 0;
}

const cellKey = cell => `${hostKey(cell.hostUrl)}::${modelKey(cell.model)}`;
const progressOf = cell => `${cell.profile.state}:${cell.catalog.covered}`;

/** Cells that still need something, the ones without a current profile first, then the least covered. */
function orderCells(cells, state, now) {
  return cells
    .filter(cell => cell.next && cell.hostId)
    .filter(cell => {
      const record = state.cells[cellKey(cell)];
      return !record || record.failures < MAX_FAILURES || now - Date.parse(record.lastAttemptAt) > RETRY_AFTER_MS;
    })
    .sort((a, b) => (a.next === b.next ? 0 : a.next === 'profile' ? -1 : 1)
      || a.catalog.covered / (a.catalog.total || 1) - b.catalog.covered / (b.catalog.total || 1)
      || cellKey(a).localeCompare(cellKey(b)));
}

/** Compare the last bite with the matrix: did its cell move forward? */
function settle(state, cells, now) {
  const last = state.last;
  if (!last || last.settledAt) return false;
  const cell = cells.find(item => cellKey(item) === last.cell);
  const record = state.cells[last.cell] = state.cells[last.cell] || { failures: 0 };
  const advanced = Boolean(cell) && progressOf(cell) !== last.progressBefore;
  record.failures = advanced ? 0 : record.failures + 1;
  record.lastAttemptAt = last.at;
  record.lastError = advanced ? null : 'The measurement ended without progress';
  last.settledAt = new Date(now).toISOString();
  last.outcome = advanced ? 'advanced' : 'no_progress';
  return true;
}

function createCoverageJob(deps = {}) {
  const now = deps.now || (() => Date.now());
  const idleDeps = deps.idleDeps || {
    getRuntimeActive: coreReads.getRuntimeActive,
    getHouseholdIdle: coreReads.getHouseholdIdle,
    getActiveBatch: async () => (await BenchmarkBatch.getActive()).length > 0,
    getActiveProfiles: activeProfiles
  };
  const store = deps.store || settingsStore;
  const build = deps.buildCoverage || buildCoverage;
  const launch = deps.launchBite || launchBite;
  let timer = null;
  let ticking = false;
  let lastCheck = null;

  async function tick() {
    if (ticking) return null;
    ticking = true;
    try {
      const settings = await store.getSettings();
      if (!settings.enabled) return (lastCheck = { at: new Date(now()).toISOString(), idle: false, reasons: ['switched off'] });
      const idle = await checkIdle(settings, { ...idleDeps, now: () => new Date(now()) });
      lastCheck = { at: new Date(now()).toISOString(), ...idle };
      if (!idle.idle) return lastCheck;

      const [coverage, state] = await Promise.all([build(), store.getState()]);
      const settled = settle(state, coverage.cells, now());
      const cell = orderCells(coverage.cells, state, now())[0];
      if (!cell) {
        if (settled) await store.saveState(state);
        return (lastCheck = { ...lastCheck, reasons: ['nothing left to measure'] });
      }
      const attempt = { cell: cellKey(cell), hostName: cell.hostName, model: cell.model, kind: cell.next,
        at: new Date(now()).toISOString(), progressBefore: progressOf(cell) };
      try {
        Object.assign(attempt, await launch(cell, settings));
        logger.info('[Coverage] Measurement started', attempt);
      } catch (error) {
        // A refusal (busy host, preflight) is not a failed measurement: try again later.
        const record = state.cells[attempt.cell] = state.cells[attempt.cell] || { failures: 0 };
        record.lastAttemptAt = attempt.at;
        record.lastError = error.message;
        if (!error.statusCode || error.statusCode >= 500 || error.statusCode === 400) record.failures += 1;
        Object.assign(attempt, { settledAt: attempt.at, outcome: 'not_started', error: error.message });
        logger.warn('[Coverage] Measurement not started', { cell: attempt.cell, error: error.message });
      }
      state.last = attempt;
      await store.saveState(state);
      return (lastCheck = { ...lastCheck, started: attempt });
    } catch (error) {
      logger.warn('[Coverage] tick failed (non-fatal)', { error: error.message });
      return (lastCheck = { at: new Date(now()).toISOString(), idle: false, reasons: [`check failed: ${error.message}`] });
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return false;
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, status: () => ({ running: Boolean(timer), lastCheck }) };
}

let shared = null;
function getCoverageJob() {
  if (!shared) shared = createCoverageJob();
  return shared;
}

module.exports = { createCoverageJob, getCoverageJob, orderCells, settle, cellKey, MAX_FAILURES };
