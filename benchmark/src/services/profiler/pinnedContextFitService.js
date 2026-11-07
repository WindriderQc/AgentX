'use strict';
const Fit = require('../../../models/PinnedContextFitCheck');
const hosts = require('../../helpers/ollamaHostConfig');
const { isEmbeddingModelName } = require('../../../../shared/embeddingModels');
const { resolveArtifactIdentity } = require('./artifactIdentityService');
const { findContextProfile } = require('../modelContextProfileService');
const { loadHostPreference } = require('./contextProposalService');
const queue = require('../../clients/coreHeavyQueue');
const { coreRequest } = require('../../clients/coreHttp');
const { CORE_OPERATIONS } = require('../../clients/coreOperations');
const { pinSet, fail, observeFit, assertTarget } = require('./pinnedContextFitObservation');
const { acquireProfilerClaimLease } = require('./profilerClaimLifecycle');
const { runJournaledProfile } = require('./profilerRunJournal');
const { createProfileCancellation } = require('./profileCancellation');
const HostProfile = require('../../../models/HostProfile');
const { recoverWorkloadAdmissionRelease } = require('../../clients/coreWorkloadRecoveries');
const { projectFit } = require('./pinnedContextFitProjection');
const { stableSerialize } = require('../../../../shared/artifactIdentity');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const active = new Map();

async function read(id) {
  if (!UUID.test(id || '')) throw Object.assign(fail('A fit request UUID is required'), { statusCode: 400 });
  const row = await Fit.findById(id).lean();
  if (!row) throw Object.assign(fail('Fit request not found'), { statusCode: 404 });
  return row;
}

async function request({ requestId, hostId, pinIndex = 0 }) {
  if (!UUID.test(requestId || '') || !Number.isInteger(pinIndex) || pinIndex < 0 || pinIndex > 31) {
    throw Object.assign(fail('requestId UUID and a pinned model index are required'), { statusCode: 400 });
  }
  let row = await Fit.findById(requestId).lean();
  if (row && (row.hostId !== hostId || row.pinIndex !== pinIndex)) throw fail('Request identity already names another intent');
  if (!row) {
    await Fit.collection.createIndex({ hostUrl: 1 }, {
      unique: true, partialFilterExpression: { blocksReplacement: true }, name: 'one_unresolved_fit_per_host'
    });
    const host = hosts.getConfiguredHosts().find(item => item.id === hostId);
    if (!host || hosts.getHostResidency(host.url) !== 'gpu') throw fail('A configured GPU host is required');
    const pins = pinSet(await loadHostPreference(host.url));
    const pin = pins[pinIndex];
    if (!pin || !Number.isSafeInteger(pin.contextSize) || pin.contextSize <= 0 || isEmbeddingModelName(pin.model)) {
      throw fail('A pinned completion model with an explicit context is required');
    }
    const artifact = await resolveArtifactIdentity(pin.model, hostId, host.url, { refresh: true });
    const context = await findContextProfile(pin.model, host.url, artifact);
    const measuredVersion = context?.measuredRuntime?.ollamaVersion || null;
    if (!context || !artifact.runtime?.ollamaVersion || !measuredVersion || artifact.runtime.ollamaVersion === measuredVersion) {
      throw fail('An exact-artifact context profile with a recorded Ollama version drift is required');
    }
    const queueRequest = { key: `pinned-fit:${requestId}`, title: 'Check allocation and GPU residency at the pinned context',
      kind: 'profiler', hosts: [host.url], estimatedMinutes: 5,
      source: { type: 'operator', ref: 'profiler-pinned-context-fit', issueUrl: 'https://github.com/WindriderQc/AgentX/issues/1130' },
      executor: { mode: 'pinned-fit', hostId, fitCheckId: requestId } };
    // Calendar may cancel an unstarted request through Core's existing control.
    // Only this explicit new intent settles its no-dispatch observation.
    const prior = await Fit.findOne({ hostUrl: host.url, blocksReplacement: true }).lean();
    if (prior?.state === 'requested' && prior.queueRequestId) {
      const previousJob = await queue.getHeavyWork(prior.queueRequestId);
      if (previousJob.state === 'cancelled' && !previousJob.dispatchId) {
        await Fit.updateOne({ _id: prior._id, state: 'requested' }, { $set: {
          state: 'cancelled', runtimeReleased: true, blocksReplacement: false, finishedAt: new Date()
        } });
      }
    }
    try {
      row = (await Fit.create({ _id: requestId, hostId, hostUrl: host.url, model: pin.model, pinIndex, pins, artifact,
        numCtx: pin.contextSize, contextProfileId: String(context._id), measuredVersion,
        queueRequest, operationId: `pinned-fit-${requestId}` })).toObject();
    } catch (error) {
      if (error.code !== 11000) throw error;
      row = await Fit.findById(requestId).lean();
      if (!row) throw fail('An earlier fit on this host is unresolved; inspect its original receipt', 'PINNED_FIT_UNRESOLVED');
      if (row.hostId !== hostId || row.pinIndex !== pinIndex) throw fail('Request identity already names another intent');
    }
  }
  // Retry only the identical queue submission, never a native launch.
  if (!row.queueRequestId) {
    const job = await queue.submitHeavyWork(row.queueRequest);
    if (!job?.id) throw fail('Core returned no queue identity; retry the same requestId', 'PINNED_FIT_QUEUE_UNKNOWN');
    await Fit.updateOne({ _id: row._id }, { $set: { queueRequestId: job.id } });
    row.queueRequestId = job.id;
  }
  return projectFit(row);
}

async function assertQueue(row, queueDispatchId) {
  const job = await queue.getHeavyWork(row.queueRequestId);
  if (job.kind !== 'profiler' || job.executor?.mode !== 'pinned-fit' || job.executor.fitCheckId !== row._id
    || job.executor.hostId !== row.hostId || job.dispatchId !== queueDispatchId
    || job.hosts?.length !== 1 || hosts.normalizeHostUrl(job.hosts[0]) !== hosts.normalizeHostUrl(row.hostUrl)
    || job.reservation?.autoStart === true) throw fail('Exact manual Core queue dispatch is required');
  const answer = await coreRequest(`/api/cluster/schedule/work-queue/${row.queueRequestId}/assert-dispatch`, {
    method: 'POST', operationId: CORE_OPERATIONS.HEAVY_QUEUE_ASSERT, body: JSON.stringify({ dispatchId: queueDispatchId })
  });
  if (answer?.data?.admitted !== true || answer.data.id !== row.queueRequestId || answer.data.dispatchId !== queueDispatchId) {
    throw fail('Core returned no exact execution window receipt', 'PINNED_FIT_WINDOW_UNKNOWN');
  }
}

async function execute(row, queueDispatchId) {
  const started = Date.now();
  let lease = null, result = null, error = null, released = false, admissionAttempted = false;
  const cancellation = createProfileCancellation({ hostUrl: row.hostUrl });
  active.set(row._id, cancellation);
  try {
    await assertQueue(row, queueDispatchId);
    await assertTarget(row);
    admissionAttempted = true;
    lease = await acquireProfilerClaimLease([row.hostUrl], row.operationId, 5 * 60_000);
    result = await runJournaledProfile(lease, { hostId: row.hostId, hostUrl: row.hostUrl, modelName: row.model },
      async () => {
        const observation = await observeFit(row, lease, cancellation, { assertQueue: () => assertQueue(row, queueDispatchId) });
        result = observation;
        await Fit.updateOne({ _id: row._id, queueDispatchId }, { $set: {
          result: observation, checkedAt: new Date(observation.native.observedAt)
        } });
        return observation;
      }, { cancellation });
  } catch (cause) {
    error = cause;
  }
  try {
    if (lease) {
      if (error?.retainAdmission) await lease.abandon(error);
      else { await lease.finalize(); released = true; }
    } else if (error && error.retainAdmission !== true) {
      // A failed acquisition can already have a durable Core recovery; only
      // the native lifecycle's explicit clean refusal establishes no holder.
      released = !admissionAttempted || error.code === 'PROFILER_CLAIM_UNAVAILABLE'
        && error.cause?.code === 'WORKLOAD_ADMISSION_REJECTED' && error.cause?.statusCode === 409;
    }
  } catch (cause) { error = cause; }
  const state = !released ? 'unknown' : error?.code === 'PROFILE_CANCELLED' ? 'cancelled'
    : error || result?.status !== 'pass' ? 'failed' : 'completed';
  await Fit.updateOne({ _id: row._id, queueDispatchId }, { $set: {
    state, result, runtimeReleased: released, blocksReplacement: !released,
    checkedAt: result?.native?.observedAt ? new Date(result.native.observedAt) : null,
    finishedAt: new Date(), durationMs: Date.now() - started,
    reason: error?.code || result?.reason || null
  } });
  active.delete(row._id);
}

async function start({ fitCheckId, hostId, queueRequestId, queueDispatchId }) {
  const row = await read(fitCheckId);
  if (row.hostId !== hostId || row.queueRequestId !== queueRequestId || !UUID.test(queueDispatchId || '')) {
    throw fail('Fit request and queue identity differ');
  }
  // A retry, even after a restart, observes the original and never dispatches.
  if (row.state !== 'requested') {
    if (row.queueDispatchId !== queueDispatchId) throw fail('Fit already belongs to another dispatch');
    return get(row._id);
  }
  await assertQueue(row, queueDispatchId);
  const winner = await Fit.updateOne({ _id: row._id, state: 'requested' }, {
    $set: { state: 'dispatching', queueDispatchId, startedAt: new Date() }
  });
  if (winner.modifiedCount === 1) {
    execute(row, queueDispatchId).catch(async () => {
      active.delete(row._id);
      // No retry/release on a lost persistence acknowledgement.
      await Fit.updateOne({ _id: row._id, queueDispatchId }, { $set: { state: 'unknown', reason: 'FIT_RECEIPT_WRITE_UNKNOWN' } }).catch(() => {});
    });
  }
  return get(row._id);
}

async function cancel(id) {
  const row = await read(id);
  const running = active.get(id);
  if (running) { await running.cancel(); return projectFit(await read(id)); }
  if (row.state !== 'requested') throw fail('Use the existing native recovery for this original operation; no writer is available');
  const job = await queue.getHeavyWork(row.queueRequestId);
  if (!['requested', 'reserved', 'cancelled'].includes(job.state)) throw fail('Core dispatch already crossed; inspect the original operation');
  if (job.state !== 'cancelled') await queue.cancelHeavyWork(job.id, job.revision);
  await Fit.updateOne({ _id: id, state: 'requested' }, { $set: {
    state: 'cancelled', runtimeReleased: true, blocksReplacement: false, finishedAt: new Date()
  } });
  return projectFit(await read(id));
}

async function reconcile(id, nativeIdentity = null) {
  const row = await read(id);
  if (active.has(id)) throw fail('The original native writer is still present');
  const host = await HostProfile.findOne({ hostId: row.hostId }).lean();
  const journal = host?.reconciliation;
  let nativeReleased = journal?.operationId === row.operationId && journal.state === 'resolved'
    && journal.releaseReceipt?.released === true;
  // If admission's ACK was lost before a HostProfile journal existed, the
  // native operator can supply the original Core identity for read-back.
  // This endpoint neither restores nor releases that admission.
  if (!nativeReleased && nativeIdentity) {
    const identity = { ...nativeIdentity, workloadId: row.operationId };
    const receipt = await recoverWorkloadAdmissionRelease(identity);
    nativeReleased = receipt?.released === true && receipt.workloadId === row.operationId;
  }
  if (!nativeReleased) {
    throw fail('The original native restoration and Core release receipt are required');
  }
  // Recovery settles capacity only; a partial fit never becomes a pass.
  await Fit.updateOne({ _id: id, state: { $in: ['dispatching', 'unknown'] } }, { $set: {
    state: 'failed', runtimeReleased: true, blocksReplacement: false, finishedAt: new Date(), reason: 'NATIVE_RECOVERY_RELEASED_FIT_UNKNOWN'
  } });
  return projectFit(await read(id));
}

async function get(id) {
  return projectFit(await read(id), { writerPresent: active.has(id) });
}

async function latest({ model, hostId, artifact, pinContext }) {
  const row = await Fit.findOne({ hostId, model }).sort({ createdAt: -1 }).lean();
  if (!row) return null;
  const pins = pinSet(await loadHostPreference(row.hostUrl));
  const matchesCurrent = Boolean(artifact?.digest === row.artifact?.digest
    && artifact?.runtimeFingerprint === row.artifact?.runtimeFingerprint
    && artifact?.runtime?.ollamaVersion === row.artifact?.runtime?.ollamaVersion
    && artifact?.runtime?.gpuDriver === row.artifact?.runtime?.gpuDriver
    && pinContext === row.numCtx && stableSerialize(pins) === stableSerialize(row.pins));
  if (row.state === 'requested' && row.queueRequestId) {
    const job = await queue.getHeavyWork(row.queueRequestId).catch(() => null);
    if (job?.state === 'cancelled' && !job.dispatchId) {
      return projectFit({ ...row, state: 'cancelled', runtimeReleased: true }, { matchesCurrent });
    }
  }
  return projectFit(row, { writerPresent: active.has(row._id), matchesCurrent });
}

module.exports = { read, get, latest, request, start, cancel, reconcile, assertQueue };
