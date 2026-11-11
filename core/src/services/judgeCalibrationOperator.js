'use strict';

// Restart-free compatibility path for a Core that predates the cancellation API.
// Reuse Core's control, native recovery transition and settled-abort proofs.
const Runtime = require('../../models/RuntimeCoordination');
const control = require('./judgeCalibrationControl');
const { transitionWorkloadRecovery } = require('./runtimeWorkloadRecovery');
const { recoverSettledWatchdogProbes } = require('./watchdogProbeRecovery');
const { localUrl } = require('./images/config');

async function target(input) {
  const state = await Runtime.findById('runtime').lean();
  const row = state?.workloads?.find(item => item.admissionId === input.id);
  if (!control.isJudgeCalibration(row) || row.workloadId !== input.workloadId
    || row.cancellation?.requestId !== input.requestId || row.cancellation?.reason !== input.reason) {
    throw new Error('The exact cancelled calibration no longer owns this admission. Read its original receipt.');
  }
  return row;
}

async function readPs(host) {
  const url = new URL('/api/ps', localUrl(host));
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Runtime residency read failed');
  const body = await response.json();
  if (!Array.isArray(body.models)) throw new Error('Runtime residency response is unverified');
  return body.models;
}

async function operate(operation, input, actor, deps = {}) {
  if (!['cancel', 'settle'].includes(operation)) throw new Error('Choose cancel or settle');
  // Validates the same strict input/identity and recovers the same lost reply as the API.
  const accepted = operation === 'cancel' ? await control.operate({ ...input, action: 'cancel' }, actor)
    : await control.operate({ action: 'show', id: input.id }, actor);
  if (accepted.calibration.workloadId !== input.workloadId) throw new Error('Workload identity differs');
  // Old Core releases may predate cancellation metadata. Report only their
  // actual release, never fabricate a matching stop acknowledgement.
  if (accepted.calibration.released) return { ...accepted, alreadyReleased: true,
    cancellationConfirmed: accepted.calibration.cancellation?.requestId === input.requestId };
  if (accepted.calibration.cancellation?.requestId !== input.requestId
    || accepted.calibration.cancellation?.reason !== input.reason)
    throw new Error('No matching cancellation receipt; settle cannot create a stop request');
  const row = await target(input);
  if (operation === 'cancel') {
    if (row.recoveryOwnerId) return { ...accepted, handoff: { transitioned: false, reason: 'Native recovery owner already adopted it' } };
    if (row.recoveryState !== 'MUTATING') return { ...accepted, handoff: { transitioned: false, reason: 'Observe existing native recovery' } };
    // UNKNOWN is an existing native owner handoff, not a manually expired lease.
    // It revokes the old heartbeat proof and retains the parent/child quarantine.
    const handoff = await transitionWorkloadRecovery({ recoveryId: row.recoveryId,
      recoveryGeneration: row.recoveryGeneration, principal: row.principal,
      expectedVersion: row.recoveryVersion, state: 'UNKNOWN', receipt: {
        contract: 'agentx.judge-calibration-cancel-handoff/v1', requestId: input.requestId,
        admissionId: row.admissionId, workloadId: row.workloadId, requestedBy: actor,
        observation: 'stop requested; terminal inference outcome remains unverified'
      } });
    return { ...accepted, handoff };
  }
  if (new Date(row.expiresAt).getTime() > Date.now()) {
    return { ...accepted, recoveries: [], reason: 'Original owner still has a live admission' };
  }
  const recoveries = [];
  for (const host of row.hosts || []) recoveries.push({ host,
    result: await recoverSettledWatchdogProbes(host, { readPs: deps.readPs || readPs,
      ...(deps.sleep && { sleep: deps.sleep }) }) });
  return { ...accepted, recoveries };
}

module.exports = { operate };
