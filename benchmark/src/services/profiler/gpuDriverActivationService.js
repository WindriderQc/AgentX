'use strict';

const crypto = require('crypto');
const HostProfile = require('../../../models/HostProfile');
const Journal = require('../../../models/BenchmarkAuthorityReconciliation');
const hosts = require('./hostProfileService');
const { inspectPrepared } = require('./gpuDriverPreparedEvidenceService');
const { freezeProofs, receipt } = require('./gpuDriverActivationPublication');
const { refusal } = require('./gpuDriverPreparationIdentity');

const { validRequestId: validId, operationWorkloadId: operationIdentity } = require('../../../../shared/gpuDriverTransition');

function dependencies(overrides) {
  return { model: HostProfile, journal: Journal, getHost: hosts.getById, inspect: inspectPrepared,
    begin: require('../benchmark/workloadAdmissionLifecycle').beginManagedWorkload,
    authority: require('../benchmark/benchmarkAuthorityReconciliation'), ...overrides };
}

async function activate({ hostId, requestId, preparationId }, overrides = {}) {
  if (!validId(requestId) || !validId(preparationId)) throw refusal('Exact stable activation and preparation requestIds are required', 'GPU_DRIVER_ACTIVATION_INPUT');
  const d = dependencies(overrides);
  const workloadId = operationIdentity(hostId, requestId);
  const resultId = `host:${workloadId}`;
  const existing = await d.journal.findOne({ resultId }).lean();
  if (existing) {
    if (existing.details?.preparationId !== preparationId || existing.details?.hostId !== hostId) throw refusal('The activation requestId binds another intent');
    const host = await d.getHost(hostId);
    const guard = await d.journal.findOne({ resultId: `workload:${workloadId}` }).lean();
    if (existing.state === 'resolved' && guard?.state === 'resolved') {
      if (existing.resolutionMode === 'publish') return existing.compensationReceipt;
      return { hostId, requestId, preparationId, state: 'compensated', journalId: String(existing._id) };
    }
    throw refusal(`The original native journal ${existing._id} is awaiting reconciliation (${host?.gpuDriverActivation?.state || existing.state})`,
      'GPU_DRIVER_ACTIVATION_RECONCILIATION_PENDING');
  }
  // An earlier attempt may have acquired admission but lost the response before
  // preparing its resource journal. Reconcile its guard; never acquire again.
  const guard = await d.journal.findOne({ resultId: `workload:${workloadId}` }).lean();
  if (guard) throw refusal('The original activation workload must be inspected through its native journal', 'GPU_DRIVER_ACTIVATION_RECONCILIATION_PENDING');
  let host = await d.getHost(hostId);
  if (!host) throw refusal('Host not found', 'GPU_DRIVER_HOST_REQUIRED');
  if (host.gpuDriverPreparation?.requestId !== preparationId || host.gpuDriverPreparation.state !== 'prepared'
    || ['pending', 'published'].includes(host.gpuDriverActivation?.state)) throw refusal('A prepared host without an uncertain activation is required');
  // A distinct acquire intent prevents concurrent writers sharing one local
  // receipt. Core's exclusive host reservation chooses the sole writer.
  const work = await d.begin(workloadId, { kind: 'gpu-driver-activation', hosts: [host.hostUrl],
    requestId: `${workloadId}:${crypto.randomUUID()}`, recoveryRequestId: `recovery:${workloadId}` });
  try {
    work.assertActive();
    host = await d.getHost(hostId);
    if (host.gpuDriverPreparation?.requestId !== preparationId || host.gpuDriverPreparation.state !== 'prepared'
      || ['pending', 'published', 'complete'].includes(host.gpuDriverActivation?.state)) throw refusal('The host activation intent changed');
    const details = { hostId, requestId, preparationId, targetFingerprint: host.gpuDriverPreparation.targetFingerprint,
      scopeFingerprint: host.gpuDriverPreparation.scopeFingerprint };
    const journal = await d.authority.prepareProfilerAuthorityWrite({ kind: 'gpu_driver_activation', resultId,
      workloadId, phase: 'gpu-driver-activation', details });
    work.assertActive();
    const pending = await d.model.findOneAndUpdate({ hostId, updatedAt: host.updatedAt,
      'gpuDriverPreparation.requestId': preparationId, 'gpuDriverPreparation.state': 'prepared',
      'gpuDriverActivation.state': { $nin: ['pending', 'published', 'complete'] }
    }, { $set: { gpuDriverActivation: { ...details, journalId: String(journal._id), state: 'pending' } } },
    { new: true, runValidators: true, signal: work.signal }).lean();
    if (!pending) throw refusal('The activation intent lost its concurrency fence');
    const inspected = await d.inspect(hostId, preparationId);
    if (!inspected.ready) throw refusal('Every currently qualified native capability needs new compatible proof', 'GPU_DRIVER_ACTIVATION_PROOF_REQUIRED');
    work.assertActive();
    const completed = await d.authority.completeProfilerAuthorityWrite(journal, {
      details: { ...details, proofs: freezeProofs(inspected.models) },
      assertAuthorityActive: work.assertActive, signal: work.signal
    });
    work.assertActive();
    await work.complete();
    return completed.publicationReceipt;
  } catch (error) {
    await work.retainForRecovery(error);
    error.retainAdmission = true;
    throw error;
  }
}

module.exports = { activate, operationIdentity, validId, receipt };
