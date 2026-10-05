'use strict';

// Household conversation outranks evaluation work on a shared host (#62).
// A workload never loses its admission: Core records that the household asked
// for the host, and the workload itself yields at its next prompt boundary
// through yieldPoint(). Core never sets yieldedAt on a workload's behalf.

const { EventEmitter } = require('node:events');
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const runtimeCoordination = require('./runtimeCoordinationService');

const canonicalHost = value => runtimeCoordination._internal.canonicalHost(value);

// A household turn may follow another after a short pause; keep the host for
// that long before the workload resumes and reloads its own model.
const TURN_GRACE_MS = 20_000;
const REQUEST_FRESH_MS = 10_000;
const YIELD_POLL_MS = 2_000;
// The person is told at the first refusal (onWaiting); the wait itself stays short.
const INTERACTIVE_WAIT_MS = 60_000;

const BUSY_MESSAGE = 'Nestor est occupé par un autre travail sur son ordinateur. Réessaie dans une minute.';

const state = { activeTurns: 0, lastTurnEndedAt: 0, lastBusyAt: 0 };
const waiting = new EventEmitter();

// A turn subscribes for its duration; the first refused call notifies it so the
// person sees that Nestor is waiting instead of a silent pause.
function onWaiting(listener) {
  waiting.on('waiting', listener);
  return () => waiting.off('waiting', listener);
}

function noteWaiting(host) {
  waiting.emit('waiting', { host, waitMs: INTERACTIVE_WAIT_MS });
}

function beginHouseholdTurn(now = Date.now) {
  state.activeTurns += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    state.activeTurns = Math.max(0, state.activeTurns - 1);
    state.lastTurnEndedAt = now();
  };
}

function householdTurnActive(now = Date.now()) {
  return state.activeTurns > 0 || now - state.lastTurnEndedAt < TURN_GRACE_MS;
}

function noteBusy(now = Date.now()) {
  state.lastBusyAt = now;
}

function busySince(startedAt) {
  return state.lastBusyAt >= startedAt;
}

function householdBusyError(cause) {
  return Object.assign(new Error(BUSY_MESSAGE), { code: 'HOUSEHOLD_NESTOR_BUSY', statusCode: 503, cause });
}

// Mark every workload holding this host. Idempotent and cheap: a household
// retry may call it on each attempt, which also keeps the request fresh.
async function requestYield(host, now = new Date()) {
  const key = canonicalHost(host);
  if (!key) return { requested: false };
  // A workload's shared host does not hold the turn back, so it is not asked.
  const result = await RuntimeCoordination.updateOne(
    { _id: 'runtime', workloads: { $elemMatch: { hosts: key, sharedHosts: { $ne: key } } } },
    { $set: { 'workloads.$[w].yieldRequestedAt': now } },
    { arrayFilters: [{ 'w.hosts': key, 'w.sharedHosts': { $ne: key } }] }
  );
  return { requested: Boolean(result.modifiedCount) };
}

function ordinaryInferenceOn(runtime, hosts) {
  return (runtime?.inferences || []).some(item => !item.workloadAdmissionId
    && item.state === 'ACTIVE' && hosts.includes(canonicalHost(item.host)));
}

function demandActive(workload, runtime, nowMs) {
  if (!workload.yieldRequestedAt) return false;
  return nowMs - new Date(workload.yieldRequestedAt).getTime() < REQUEST_FRESH_MS
    || householdTurnActive(nowMs)
    || ordinaryInferenceOn(runtime, (workload.hosts || []).filter(host => !(workload.sharedHosts || []).includes(host)));
}

// Called by the workload owner before each prompt. While household demand is
// live the call renews the workload's TTL, so a long yield cannot expire it.
async function yieldPoint({ admissionId, generation, principal, inFlight = 0, ttl } = {}, now = new Date()) {
  if (!admissionId || !generation || !principal) return { yield: false, reason: 'exact workload proof required' };
  const runtime = await RuntimeCoordination.findById('runtime').lean();
  const workload = (runtime?.workloads || []).find(item => item.admissionId === admissionId
    && item.generation === generation && item.principal === principal);
  if (!workload) return { yield: false, reason: 'workload admission is not active' };
  const exact = { _id: 'runtime', workloads: { $elemMatch: { admissionId, generation, principal } } };
  if (!demandActive(workload, runtime, now.getTime())) {
    if (workload.yieldRequestedAt || workload.yieldedAt) {
      await RuntimeCoordination.updateOne(exact,
        { $set: { 'workloads.$.yieldRequestedAt': null, 'workloads.$.yieldedAt': null } });
    }
    return { yield: false, yielded: false, expiresAt: workload.expiresAt };
  }
  const renewed = await runtimeCoordination.heartbeat('workload', { id: admissionId, generation, principal, ttl });
  if (renewed.heartbeat !== true) return { yield: false, reason: renewed.reason || 'workload heartbeat refused' };
  let yielded = Boolean(workload.yieldedAt);
  if (!yielded && Number(inFlight) === 0) {
    // Only an idle owner yields: none of its own inferences may be admitted.
    const updated = await RuntimeCoordination.updateOne({
      ...exact,
      inferences: { $not: { $elemMatch: { workloadAdmissionId: admissionId, state: 'ACTIVE' } } }
    }, { $set: { 'workloads.$.yieldedAt': now } });
    yielded = Boolean(updated.modifiedCount);
  }
  return { yield: true, yielded, retryAfterMs: YIELD_POLL_MS, expiresAt: renewed.expiresAt };
}

// The benchmark host claim yields with its workload admission.
async function claimYielded(claim) {
  if (!claim?.admissionId) return false;
  const runtime = await RuntimeCoordination.findById('runtime').lean();
  return (runtime?.workloads || []).some(item => item.admissionId === claim.admissionId
    && item.generation === claim.admissionGeneration && Boolean(item.yieldedAt));
}

module.exports = {
  INTERACTIVE_WAIT_MS,
  TURN_GRACE_MS,
  beginHouseholdTurn,
  householdTurnActive,
  noteBusy,
  noteWaiting,
  onWaiting,
  busySince,
  householdBusyError,
  requestYield,
  yieldPoint,
  claimYielded,
  _state: state
};
