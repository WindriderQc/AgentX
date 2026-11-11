'use strict';

// Core records the stop intent in the exact admission. Benchmark observes its
// heartbeat refusal, aborts its writer and retains native recovery ownership.
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CALIBRATION = /^judge-(?:accuracy-|matrix-)?calibration:([a-f0-9-]+)$/i;
const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };

function isJudgeCalibration(item) {
  const match = CALIBRATION.exec(item?.workloadId || '');
  return item?.principal === 'benchmark-service' && item.kind === 'judge'
    && !item.batchId && Boolean(match && UUID.test(match[1]));
}

function project(item) {
  const released = item.released === true;
  return {
    admissionId: item.admissionId, workloadId: item.workloadId,
    hosts: item.hosts || [], owner: item.principal,
    state: released ? 'released' : item.cancellation ? 'cancellation_requested' : 'owned',
    released, cancellation: item.cancellation || null,
    acquiredAt: item.acquiredAt || null, heartbeatAt: item.heartbeatAt || null,
    expiresAt: item.expiresAt || null, releasedAt: item.releasedAt || null,
    recoveryRequired: !released && item.recoveryRequired === true,
    recoveryState: item.recoveryState || null,
    nextAction: released ? 'inspect_native_result' : item.cancellation
      ? 'observe_native_owner_and_recovery' : 'request_targeted_cancellation'
  };
}

async function snapshot() {
  return await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean() || {};
}

function find(state, id) {
  return (state.workloads || []).find(item => item.admissionId === id)
    || [...(state.releaseReceipts || [])].reverse().find(item =>
      item.coordinationKind === 'workload' && item.admissionId === id);
}

function exactTarget(item, workloadId) {
  if (!isJudgeCalibration(item)) fail(404, 'CALIBRATION_NOT_FOUND', 'No standalone judge calibration with this admission ID.');
  if (workloadId && item.workloadId !== workloadId)
    fail(409, 'CALIBRATION_IDENTITY_CONFLICT', 'The workload ID does not match this admission.');
}

function replay(item, input) {
  if (!item.cancellation) return false;
  if (item.cancellation.requestId !== input.requestId || item.cancellation.reason !== input.reason)
    fail(409, 'CALIBRATION_CANCELLATION_CONFLICT', 'An existing cancellation binds a different request or reason. Read it before proceeding.');
  return true;
}

function checkRequestIdentity(state, input) {
  const prior = [...(state.workloads || []), ...(state.releaseReceipts || [])]
    .find(item => item.cancellation?.requestId === input.requestId);
  if (prior && (prior.admissionId !== input.id || prior.workloadId !== input.workloadId))
    fail(409, 'CALIBRATION_CANCELLATION_CONFLICT', 'This requestId already identifies another calibration.');
}

async function operate(input = {}, actor = 'owner-mcp') {
  const { action, id, workloadId, requestId, reason } = input;
  if (!['list', 'show', 'cancel'].includes(action)
    || Object.keys(input).some(key => !['action', 'id', 'workloadId', 'requestId', 'reason'].includes(key)))
    fail(400, 'INVALID_ARGUMENTS', 'Choose list, show or cancel with bounded arguments.');
  if (action === 'list' ? Object.keys(input).length !== 1
    : !UUID.test(id || '') || (action === 'show' && Object.keys(input).some(key => !['action', 'id'].includes(key))))
    fail(400, 'INVALID_ARGUMENTS', 'Read all active calibrations or one exact admission ID.');
  if (action === 'cancel' && (!workloadId || !UUID.test(requestId || '')
    || typeof reason !== 'string' || !reason.trim() || reason !== reason.trim() || reason.length > 300))
    fail(400, 'INVALID_ARGUMENTS', 'Cancellation requires the exact workload ID, a stable UUID requestId and a reason of at most 300 characters.');
  const envelope = data => ({ schema: 'agentx.judge-calibration-control/v1', observedAt: new Date().toISOString(), ...data });
  const state = await snapshot();
  if (action === 'list') return envelope({ calibrations: (state.workloads || []).filter(isJudgeCalibration).map(project) });
  const item = find(state, id);
  exactTarget(item, workloadId);
  if (action === 'show') return envelope({ calibration: project(item) });
  checkRequestIdentity(state, input);
  if (replay(item, input)) return envelope({ accepted: true, idempotent: true, calibration: project(item) });
  if (item.released) fail(409, 'CALIBRATION_ALREADY_RELEASED', 'This admission is already released; no cancellation was recorded.');
  const cancellation = { requestId, reason, requestedBy: String(actor).slice(0, 160), requestedAt: new Date() };
  const updated = await RuntimeCoordination.findOneAndUpdate({
    _id: 'runtime',
    'workloads.cancellation.requestId': { $ne: requestId },
    'releaseReceipts.cancellation.requestId': { $ne: requestId },
    workloads: { $elemMatch: {
      admissionId: id, generation: item.generation, workloadId,
      principal: item.principal, kind: 'judge', batchId: null, cancellation: null
    } }
  }, { $set: { 'workloads.$.cancellation': cancellation } }, { new: true }).lean();
  if (updated) return envelope({ accepted: true, calibration: project(find(updated, id)) });
  // A lost/racing reply is recovered from the original admission or native
  // release receipt. Never cancel another admission or release a quarantine.
  const racedState = await snapshot();
  checkRequestIdentity(racedState, input);
  const raced = find(racedState, id);
  exactTarget(raced, workloadId);
  if (replay(raced, input)) return envelope({ accepted: true, idempotent: true, calibration: project(raced) });
  fail(409, 'CALIBRATION_CHANGED', 'The native owner changed this admission; read its original result.');
}

module.exports = { operate, isJudgeCalibration };
