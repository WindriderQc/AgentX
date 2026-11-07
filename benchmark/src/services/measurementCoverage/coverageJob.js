'use strict';

/**
 * The coverage job: one small measurement at a time, in quiet periods, until
 * every host and model in scope is profiled and has answered the catalog.
 *
 * Rule-based on purpose. Each tick observes the original Core request; only a
 * native terminal receipt permits settlement and another bite. A cell
 * whose bites keep failing is left alone for a day instead of being retried
 * every night.
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { buildCoverage } = require('./coverageState');
const { checkIdle } = require('./coverageIdle');
const { prepareBite, followBite } = require('./coverageLauncher');
const attemptsStore = require('./coverageAttempts');
const settingsStore = require('./coverageSettings');
const coreReads = require('../../clients/coreCoverageReads');
const { hostKey, modelKey } = require('./coverageScope');

const TICK_MS = 60_000;
const MAX_FAILURES = 3;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
// A launch that is refused (busy host, judge unavailable, preflight) says
// nothing about the measurement: the pair waits a while so the others get
// their turn, and it is never counted as a failure.
const REFUSAL_COOLDOWN_MS = 30 * 60 * 1000;

// The Profiler keeps its running jobs in memory; ask it the way the UI does.
async function activeProfiles(fetchImpl = fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${process.env.PORT || 3081}/api/profiler/pipeline/profile/active`,
    { signal: AbortSignal.timeout(10000) });
  // Fail closed: an unreadable answer must not read as "no profile running".
  if (!response.ok) throw new Error(`Active profiles unavailable (HTTP ${response.status})`);
  const active = (await response.json())?.data?.active;
  return Array.isArray(active) ? active.length > 0 : Object.keys(active || {}).length > 0;
}

const cellKey = cell => `${hostKey(cell.hostUrl)}::${modelKey(cell.model)}`;
const progressOf = cell => `${cell.profile.state}:${cell.catalog.covered}`;

/**
 * Cells that still need something: the ones a supervisor asked for first (by
 * priority, then age), then those without a current profile, then the least
 * covered.
 */
function orderCells(cells, state, now) {
  return cells
    .filter(cell => cell.next && cell.hostId)
    .filter(cell => {
      const record = state.cells[cellKey(cell)];
      if (!record) return true;
      if (record.refusedAt && now - Date.parse(record.refusedAt) < REFUSAL_COOLDOWN_MS) return false;
      return !(record.failures >= MAX_FAILURES) || now - Date.parse(record.lastAttemptAt) > RETRY_AFTER_MS;
    })
    .sort((a, b) => requestRank(state, b) - requestRank(state, a)
      || requestAge(state, a) - requestAge(state, b)
      || (a.next === b.next ? 0 : a.next === 'profile' ? -1 : 1)
      || a.catalog.covered / (a.catalog.total || 1) - b.catalog.covered / (b.catalog.total || 1)
      || cellKey(a).localeCompare(cellKey(b)));
}

const requestRank = (state, cell) => state.requests?.[cellKey(cell)]?.priority || 0;
const requestAge = (state, cell) => Date.parse(state.requests?.[cellKey(cell)]?.at || 0) || 0;

/** A request is served once its pair is complete or left the scope. */
function clearServedRequests(state, cells) {
  let cleared = false;
  for (const key of Object.keys(state.requests || {})) {
    const cell = cells.find(item => cellKey(item) === key);
    if (!cell || !cell.next) { delete state.requests[key]; cleared = true; }
  }
  return cleared;
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

function nativeIdleDeps() {
  return {
    getRuntimeActive: coreReads.getRuntimeActive,
    getHouseholdIdle: coreReads.getHouseholdIdle,
    getActiveBatch: async () => (await BenchmarkBatch.getActive()).length > 0,
    getActiveProfiles: activeProfiles
  };
}

function createCoverageJob(deps = {}) {
  const now = deps.now || (() => Date.now());
  const idleDeps = deps.idleDeps || nativeIdleDeps();
  const store = deps.store || settingsStore;
  const attempts = deps.attempts || attemptsStore;
  const build = deps.buildCoverage || buildCoverage;
  const prepare = deps.prepareBite || prepareBite;
  const follow = deps.followBite || followBite;
  let timer = null;
  let ticking = false;
  let lastCheck = null;

  async function remember(attempt, result, state) {
    const cell = attempt.intent.cell;
    state.last = { cell: cellKey(cell), hostName: cell.hostName, model: cell.model, kind: attempt.intent.kind,
      at: attempt.intent.at, progressBefore: progressOf(cell), ...result };
    if (result.terminal) {
      if (result.notStarted) {
        const record = state.cells[cellKey(cell)] ||= { failures: 0 };
        record.refusedAt = new Date(now()).toISOString();
        record.lastError = result.error || 'Native request did not start';
        Object.assign(state.last, { settledAt: new Date(now()).toISOString(), outcome: 'not_started' });
      } else {
        settle(state, (await build()).cells, now());
        if (result.state === 'failed') state.last.outcome = 'failed';
      }
    }
    // This is presentation/progress only; the independent durable intent still
    // fences a lost state write, a process restart or concurrent job workers.
    await store.saveState(state);
    return state.last;
  }

  async function tick() {
    if (ticking) return null;
    ticking = true;
    try {
      const [settings, state, pending] = await Promise.all([store.getSettings(), store.getState(), attempts.active()]);
      // Reconcile even while switched off/busy/outside the window. Read-only
      // observation never requires permission to start another measurement.
      if (pending) {
        const result = await follow(pending, { attempts, allowStart: false, now: () => new Date(now()) });
        const last = await remember(pending, result, state);
        if (result.terminal || !['requested', 'reserved'].includes(result.state)) {
          return (lastCheck = { at: new Date(now()).toISOString(), idle: false,
            reasons: [result.terminal ? 'measurement finished' : 'observing original measurement'], started: last });
        }
      }
      if (!settings.enabled) return (lastCheck = { at: new Date(now()).toISOString(), idle: false, reasons: ['switched off'] });
      const idle = await checkIdle(settings, { ...idleDeps, now: () => new Date(now()) });
      lastCheck = { at: new Date(now()).toISOString(), ...idle };
      if (!idle.idle) return lastCheck;
      let attempt = pending;
      if (!attempt) {
        // Legacy pre-identity launches cannot be proven ended by an idle read.
        // Retain them for operator inspection rather than inventing a retry.
        if (state.last && !state.last.settledAt && !state.last.requestId) {
          return (lastCheck = { ...lastCheck, idle: false, reasons: ['legacy measurement needs native reconciliation'] });
        }
        const coverage = await build();
        const changed = clearServedRequests(state, coverage.cells);
        const cell = orderCells(coverage.cells, state, now())[0];
        if (!cell) {
          if (changed) await store.saveState(state);
          return (lastCheck = { ...lastCheck, reasons: ['nothing left to measure'] });
        }
        attempt = await prepare(cell, settings, { attempts, now: () => new Date(now()) });
      }
      const result = await follow(attempt, { attempts, allowStart: true, now: () => new Date(now()) });
      return (lastCheck = { ...lastCheck, started: await remember(attempt, result, state) });
    } catch (error) {
      logger.warn('[Coverage] tick failed (non-fatal)', { error: error.message });
      return (lastCheck = { at: new Date(now()).toISOString(), idle: false, reasons: [`check failed: ${error.message}`] });
    } finally { ticking = false; }
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

module.exports = { createCoverageJob, getCoverageJob, orderCells, settle, cellKey, MAX_FAILURES, REFUSAL_COOLDOWN_MS, nativeIdleDeps };
