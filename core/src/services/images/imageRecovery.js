'use strict';
const crypto = require('node:crypto');
const RuntimeCoordination = require('../../../models/RuntimeCoordination');
const coordination = require('../runtimeCoordinationService');
const { restoreSnapshots, PRINCIPAL } = require('./gpuReservation');

// Explicit recovery observes the original job. It never submits another prompt.
async function recoverOperation(op, client, persist, archive) {
  if (op.state !== 'unknown') throw Object.assign(new Error('Only uncertain operations need runtime recovery'), { statusCode: 409 });
  await coordination.reapExpired();
  const runtime = await RuntimeCoordination.findById('runtime').lean();
  const old = runtime?.workloads?.find(x => x.workloadId === op._id && x.principal === PRINCIPAL);
  if (!old && !op.dispatchStarted && !op.admission && !op.snapshot) return persist({ state: 'failed', runtimeRestored: true,
    error: 'Demande interrompue avant la préparation GPU. Une nouvelle demande explicite est possible.' }, { workerSlot: 1, references: 1 });
  if (!old) {
    const proof = op.admission;
    const release = proof && await coordination.recoverRelease('workload', {
      id: proof.admissionId, generation: proof.generation, principal: PRINCIPAL });
    if (!release?.released) throw new Error('Runtime release receipt is missing; operator reconciliation is required');
    return persist({ state: op.artifact ? 'completed' : 'archive_failed', runtimeRestored: true, error: null }, { workerSlot: 1, references: 1 });
  }
  // A timeout or an empty queue cannot prove that a pending Ollama unload ended.
  if (!op.dispatchStarted || !op.snapshot) throw new Error('Pre-generation mutation requires native runtime reconciliation');
  const history = await client.json(`/history/${op.jobId}`);
  const terminal = history[op.jobId];
  if (!['success', 'error'].includes(terminal?.status?.status_str)) throw Object.assign(new Error('Original image job is not proven terminal. Recovery waits for its outcome.'), { statusCode: 409 });
  const ownerId = `image-recovery:${crypto.randomUUID()}`;
  const lease = await coordination.adoptWorkloadRecovery({ recoveryId: old.recoveryId, principal: PRINCIPAL,
    recoveryRequestId: old.recoveryRequestId, ownerId, ttl: 120000 });
  if (!lease.adopted) throw Object.assign(new Error(lease.reason || 'Recovery is already owned'), { statusCode: 409 });
  const proof = { recoveryId: lease.recoveryId, recoveryGeneration: lease.recoveryGeneration, principal: PRINCIPAL, ownerId };
  let lost = false, version = lease.recoveryVersion;
  const assertOwned = async () => {
    if (lost || !(await coordination.assertWorkloadRecovery(proof)).owned) throw new Error('Image recovery reservation lost');
  };
  const timer = setInterval(() => coordination.heartbeatWorkloadRecovery({ ...proof, ttl: 120000 })
    .then(r => { if (!r.heartbeat) lost = true; }).catch(() => { lost = true; }), 20000);
  timer.unref();
  const transition = async state => {
    await assertOwned();
    const r = await coordination.transitionWorkloadRecovery({ ...proof, expectedVersion: version, state,
      receipt: { contract: 'agentx.image-runtime/v1', operationId: op._id, originalJobTerminal: true } });
    if (!r.transitioned) throw new Error('Recovery journal transition refused');
    version = r.recoveryVersion;
  };
  try {
    if (lease.recoveryState === 'UNKNOWN') await transition('VERIFIED');
    else if (!['VERIFIED', 'RESTORED'].includes(lease.recoveryState)) throw new Error('Unexpected image recovery state');
    if (lease.recoveryState !== 'RESTORED') {
      // Some captured residents may already have been restored before the crash.
      // Observe Comfy's allocation, then verify the complete resident set below.
      await client.free(assertOwned, false);
      await restoreSnapshots(op.snapshot, assertOwned);
      await transition('RESTORED');
    }
    const released = await coordination.resolveWorkloadRecovery(proof);
    if (!released.released) throw new Error('Recovery release is unverified');
    const output = terminal.outputs?.save?.images?.[0];
    let artifact = op.artifact;
    if (terminal.status.status_str === 'success' && terminal.status.completed && output) {
      await persist({ runtimeRestored: true, output }, { workerSlot: 1, references: 1 });
      if (!artifact) {
        try { artifact = await archive(output); }
        catch { return persist({ state: 'archive_failed', runtimeRestored: true, error: 'Reprise de l’archive nécessaire.' }, { workerSlot: 1 }); }
      }
    }
    return persist({ state: artifact ? 'completed' : 'failed', artifact: artifact || null,
      runtimeRestored: true, error: artifact ? null : 'Génération initiale terminée sans image. Aucune relance automatique.' }, { workerSlot: 1, references: 1 });
  } finally { clearInterval(timer); }
}
module.exports = { recoverOperation };
