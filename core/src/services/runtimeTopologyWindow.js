'use strict';

/**
 * Topology windows on the heavy-work queue (#360, phase 5).
 *
 * A `topology` request switches a host group to a mode for its reserved slot,
 * then returns it: `{ groupId, targetMode, returnTo?, holdMinutes? }`. A
 * pooled window is one such request with `targetMode` the pooled mode and
 * `returnTo` the daily mode. Requests that need the pooled mode name the
 * window (`withinWindow`) and are reserved inside it; the window does not
 * return while one of them is still reserved, running or uncertain.
 *
 * - Enter: a switch with request id `<window>.enter`.
 * - Hold: until `holdMinutes` after the enter switch became active, or else
 *   until the reservation end minus the time the return needs.
 * - Return: `<window>.return-<n>`, retried on the next sweep after a refusal
 *   (a busy host), at most RETURN_ATTEMPTS times. When the group's next
 *   topology window targets the same mode and starts within FLAP_GAP_MS of
 *   this window's end, the return is skipped: consecutive windows do not flap
 *   the host.
 *
 * Every switch goes through the Core switch workload; this module never calls
 * the actuator itself. Nothing here switches on a single inference request.
 */

const { fail, text } = require('./heavyWorkQueueContract');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;
const RETURN_LEAD_MS = 15 * 60_000;
const FLAP_GAP_MS = 30 * 60_000;
const RETURN_ATTEMPTS = 5;
const BUSY = ['reserved', 'dispatching', 'running', 'uncertain'];
const SWITCH_TERMINAL = ['active', 'refused', 'rolled_back', 'uncertain'];

function switches() {
  return require('./runtimeTopologySwitchService').getTopologySwitchService();
}

/** Validate a topology executor (queue contract). */
function validateExecutor(executor) {
  if (!executor || typeof executor !== 'object' || Array.isArray(executor)
    || Object.keys(executor).some(key => !['groupId', 'targetMode', 'returnTo', 'holdMinutes'].includes(key))) {
    throw fail('topology executor contains unsupported fields');
  }
  if (!ID.test(executor.groupId || '') || !ID.test(executor.targetMode || '')) throw fail('topology groupId and targetMode required');
  if (executor.returnTo !== undefined) {
    if (!ID.test(executor.returnTo || '')) throw fail('topology returnTo must name a mode');
    if (executor.returnTo === executor.targetMode) throw fail('topology returnTo must differ from targetMode');
  }
  if (executor.holdMinutes !== undefined
    && (!Number.isInteger(executor.holdMinutes) || executor.holdMinutes < 1 || executor.holdMinutes > 10080)) {
    throw fail('topology holdMinutes needs 1 to 10080');
  }
}

function declaredGroup(groupId) {
  let declared;
  try { declared = require('./runtimeTopologyService').parseTopology(); } catch {
    throw fail('The runtime topology declaration is invalid', 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
  }
  const group = declared.groups.find(item => item.id === groupId);
  if (!group) throw fail(`No topology group ${groupId} is declared`, 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
  return group;
}

function groupHosts(group) {
  return [...new Set(group.modes.flatMap(mode => mode.endpoints.map(endpoint => endpoint.url)))].sort();
}

function modeEndpoints(group, modeId) {
  return group.modes.find(mode => mode.id === modeId)?.endpoints.map(endpoint => endpoint.url) || null;
}

/** The modes of a group that have an endpoint with the pooled role. */
function pooledModes(group) {
  return group.modes.filter(mode => mode.endpoints.some(endpoint => endpoint.role === 'pooled')).map(mode => mode.id);
}

/** Checks before the dispatch mark; a refusal here is retried on the next sweep. */
async function preDispatch(job, { exactHosts }) {
  const executor = job.executor;
  const group = declaredGroup(executor.groupId);
  for (const mode of [executor.targetMode, executor.returnTo].filter(Boolean)) {
    if (!modeEndpoints(group, mode)) throw fail(`Group ${group.id} declares no mode ${mode}`, 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
  }
  exactHosts(job, groupHosts(group));
  const actuator = require('./runtimeTopologyActuator').createActuatorClient();
  if (!actuator.configured(group.id)) throw fail(`No host actuator is configured for ${group.id}`, 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
  const open = await switches().openSwitches();
  if (open.has(group.id)) throw fail(`A topology switch is already running for ${group.id}`, 409, 'HEAVY_QUEUE_CONFLICT');
}

/** Start the window: request its enter switch. Returns the receipt identity. */
async function start(begun) {
  try {
    await switches().request({ groupId: begun.executor.groupId, targetMode: begun.executor.targetMode,
      requestId: `${begun.id}.enter`, principal: 'heavy-work-queue', source: 'queue' });
  } catch (error) {
    // A typed refusal means no switch began: the queue releases its fence.
    if (error.statusCode && error.statusCode < 500) throw Object.assign(error, { notStarted: true });
    throw error;
  }
  return { id: begun.id };
}

async function queueJobs() {
  const state = await require('../../models/HeavyWorkQueue').findById('heavy-work').lean();
  return state?.jobs || [];
}

/** Requests bracketed by a window that still need it. */
function bracketedBusy(jobs, windowId) {
  return jobs.filter(job => job.withinWindow === windowId && BUSY.includes(job.state))
    .map(job => ({ id: job.id, title: job.title, state: job.state }));
}

/** The group's next window to the same mode, starting within the flap gap. */
function nextSameTarget(jobs, window, fromMs) {
  return jobs.filter(job => job.id !== window.id && job.kind === 'topology' && job.state === 'reserved'
    && job.executor?.groupId === window.executor.groupId && job.executor?.targetMode === window.executor.targetMode
    && Date.parse(job.reservation?.start) >= fromMs - 60_000
    && Date.parse(job.reservation?.start) - fromMs <= FLAP_GAP_MS)
    .sort((a, b) => a.reservation.start.localeCompare(b.reservation.start))[0] || null;
}

function holdUntil(job, enter) {
  const entered = Date.parse(enter.finishedAt || enter.updatedAt);
  if (job.executor.holdMinutes) return entered + job.executor.holdMinutes * 60_000;
  return Date.parse(job.reservation.end) - RETURN_LEAD_MS;
}

function failedSwitch(record, phase) {
  if (record.state === 'uncertain') {
    return { terminal: false, uncertain: true, phase,
      reason: `The ${phase} switch ${record.requestId} ended uncertain (${record.reason}); recover it before this request` };
  }
  return { terminal: true, receipt: { state: 'failed', authority: 'core.runtime-topology', phase,
    switchId: record.requestId, switchState: record.state, reason: record.reason || null } };
}

/**
 * Observe a running window and advance it: hold, then request the return.
 * Returns `{ operationId, terminal, phase, ... }`, with `receipt` when terminal.
 */
async function observe(job, { now = Date.now() } = {}) {
  const operationId = job.operation?.id || job.id;
  const service = switches();
  const enter = await service.get(`${job.id}.enter`);
  if (!enter) throw fail('No enter switch is recorded for this window; inspect before recovery', 409);
  if (!SWITCH_TERMINAL.includes(enter.state)) return { operationId, terminal: false, phase: 'entering', switchState: enter.state };
  if (enter.state !== 'active') return { operationId, ...failedSwitch(enter, 'enter') };
  if (!job.executor.returnTo) {
    return { operationId, terminal: true, receipt: { state: 'completed', authority: 'core.runtime-topology',
      phase: 'entered', enterSwitch: enter.requestId, mode: job.executor.targetMode } };
  }

  const jobs = await queueJobs();
  const until = holdUntil(job, enter);
  const returns = [];
  for (let attempt = 1; attempt <= RETURN_ATTEMPTS; attempt += 1) {
    const record = await service.get(`${job.id}.return-${attempt}`);
    if (!record) break;
    returns.push(record);
  }
  const last = returns[returns.length - 1] || null;
  if (!last) {
    if (now < until) return { operationId, terminal: false, phase: 'holding', holdUntil: new Date(until).toISOString() };
    const busy = bracketedBusy(jobs, job.id);
    if (busy.length) return { operationId, terminal: false, phase: 'waiting_for_bracketed', bracketed: busy };
    // Measured from this window's end: back-to-back windows keep the mode.
    const next = nextSameTarget(jobs, job, Math.max(now, Date.parse(job.reservation.end)));
    if (next) {
      return { operationId, terminal: true, receipt: { state: 'completed', authority: 'core.runtime-topology',
        phase: 'return_skipped', enterSwitch: enter.requestId, mode: job.executor.targetMode,
        nextWindow: { id: next.id, start: next.reservation.start } } };
    }
  }
  if (last && !SWITCH_TERMINAL.includes(last.state)) {
    return { operationId, terminal: false, phase: 'returning', switchState: last.state };
  }
  if (last?.state === 'active') {
    return { operationId, terminal: true, receipt: { state: 'completed', authority: 'core.runtime-topology',
      phase: 'returned', enterSwitch: enter.requestId, returnSwitch: last.requestId, mode: job.executor.returnTo } };
  }
  if (last && last.state !== 'refused') return { operationId, ...failedSwitch(last, 'return') };
  if (last && returns.length >= RETURN_ATTEMPTS) {
    // The group stays in the window's mode, which is a known good state.
    return { operationId, terminal: true, receipt: { state: 'failed', authority: 'core.runtime-topology', phase: 'return',
      reason: `return refused ${RETURN_ATTEMPTS} times (${last.reason}); the group stays in ${job.executor.targetMode}`,
      switchId: last.requestId } };
  }
  const attempt = returns.length + 1;
  try {
    await service.request({ groupId: job.executor.groupId, targetMode: job.executor.returnTo,
      expectedActiveMode: job.executor.targetMode, requestId: `${job.id}.return-${attempt}`,
      principal: 'heavy-work-queue', source: 'queue' });
  } catch (error) {
    if (error.code === 'TOPOLOGY_MODE_CHANGED') {
      // Someone moved the group meanwhile: the return is done, or no longer ours.
      const back = error.data?.activeMode === job.executor.returnTo;
      return { operationId, terminal: true, receipt: { state: back ? 'completed' : 'failed', authority: 'core.runtime-topology',
        phase: back ? 'already_returned' : 'return', enterSwitch: enter.requestId,
        reason: back ? null : `the group runs ${error.data?.activeMode || 'another mode'}, not ${job.executor.targetMode}` } };
    }
    // Not admitted now (for example a switch or other work on the group):
    // keep the window open and ask again on the next sweep.
    return { operationId, terminal: false, phase: 'return_waiting', reason: text(error.message || 'refused', 'reason', 500) };
  }
  return { operationId, terminal: false, phase: 'returning', attempt };
}

/** Checks for a request reserved inside a window, before its dispatch mark. */
async function assertWindowReady(job) {
  const window = (await queueJobs()).find(item => item.id === job.withinWindow);
  if (!window || window.kind !== 'topology') throw fail('The window this request belongs to is gone', 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
  const enter = await switches().get(`${window.id}.enter`);
  if (window.state !== 'running' || enter?.state !== 'active') {
    throw fail('Its topology window has not reached its mode yet', 409, 'HEAVY_QUEUE_WINDOW_NOT_READY');
  }
}

/**
 * Reservation rules for a request inside a window: the window exists, is a
 * topology request that has not ended, and the request fits in its slot on
 * endpoints of the window's mode.
 */
function checkBracket(state, job, start, end) {
  const window = state.jobs.find(item => item.id === job.withinWindow);
  if (!window || window.kind !== 'topology' || !['reserved', 'dispatching', 'running'].includes(window.state)) {
    throw fail('withinWindow must name a planned or running topology request', 409, 'HEAVY_QUEUE_WINDOW_INVALID');
  }
  if (!window.reservation || start < window.reservation.start || end > window.reservation.end) {
    throw fail('A request inside a window must fit in the window\'s slot', 409, 'HEAVY_QUEUE_WINDOW_INVALID',
      { window: { id: window.id, reservation: window.reservation } });
  }
  const group = declaredGroup(window.executor.groupId);
  const allowed = modeEndpoints(group, window.executor.targetMode) || [];
  if (!job.hosts.every(host => allowed.includes(host))) {
    throw fail('A request inside a window may use only the endpoints of the window\'s mode', 409, 'HEAVY_QUEUE_WINDOW_INVALID');
  }
  return window;
}

/** A window and the requests it brackets do not collide with each other. */
function bracketPair(a, b) {
  return (a.withinWindow && a.withinWindow === b.id && b.kind === 'topology')
    || (b.withinWindow && b.withinWindow === a.id && a.kind === 'topology');
}

// ------------------------------------------------------- next pooled window

let windowCache = { at: 0, windows: [] };

/** Refresh the planned pooled windows (queue observer sweep). */
async function refreshWindows({ jobs } = {}) {
  const all = jobs || await queueJobs();
  let declared;
  try { declared = require('./runtimeTopologyService').parseTopology(); } catch { declared = { groups: [] }; }
  const now = Date.now();
  const windows = [];
  for (const job of all) {
    if (job.kind !== 'topology' || !['reserved', 'dispatching', 'running'].includes(job.state) || !job.reservation) continue;
    if (Date.parse(job.reservation.end) <= now) continue;
    const group = declared.groups.find(item => item.id === job.executor?.groupId);
    if (!group || !pooledModes(group).includes(job.executor.targetMode)) continue;
    windows.push({ id: job.id, groupId: group.id, mode: job.executor.targetMode,
      start: job.reservation.start, end: job.reservation.end, state: job.state });
  }
  windows.sort((a, b) => a.start.localeCompare(b.start));
  windowCache = { at: now, windows };
  return windows;
}

/** The next planned pooled window of a group, from the last refresh. Sync. */
function nextPooledWindow(groupId) {
  const now = Date.now();
  return windowCache.windows.find(item => (!groupId || item.groupId === groupId) && Date.parse(item.end) > now) || null;
}

module.exports = {
  RETURN_LEAD_MS, FLAP_GAP_MS, RETURN_ATTEMPTS,
  validateExecutor, preDispatch, start, observe, assertWindowReady, checkBracket, bracketPair,
  groupHosts, pooledModes, refreshWindows, nextPooledWindow,
  _setWindows(windows) { windowCache = { at: Date.now(), windows }; }
};
