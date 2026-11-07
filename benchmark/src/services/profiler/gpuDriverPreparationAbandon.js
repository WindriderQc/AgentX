'use strict';

const crypto = require('crypto');
const HostProfile = require('../../../models/HostProfile');
const Journal = require('../../../models/BenchmarkAuthorityReconciliation');
const hosts = require('./hostProfileService');
const { refusal } = require('./gpuDriverPreparationIdentity');
const { validRequestId: validId, operationWorkloadId } = require('../../../../shared/gpuDriverTransition');

async function abandon({ hostId, requestId, preparationId }, overrides = {}) {
  if (!validId(requestId) || !validId(preparationId)) throw refusal('Exact stable abandon and preparation requestIds are required', 'GPU_DRIVER_ABANDON_INPUT');
  const d = { model: HostProfile, journal: Journal, getHost: id => hosts.getById(id, { includeDriverHistory: true }),
    begin: require('../benchmark/workloadAdmissionLifecycle').beginManagedWorkload, now: () => new Date(), ...overrides };
  const workloadId = operationWorkloadId(hostId, requestId, 'abandon');
  const replay = host => {
    const row = host?.gpuDriverPreparationHistory?.find(item => item.abandon?.requestId === requestId);
    if (row && row.requestId !== preparationId) throw refusal('The abandon requestId binds another preparation');
    return row?.abandon || null;
  };
  let host = await d.getHost(hostId);
  if (!host) throw refusal('Host not found', 'GPU_DRIVER_HOST_REQUIRED');
  const recorded = replay(host);
  const guard = await d.journal.findOne({ resultId: `workload:${workloadId}` }).lean();
  if (recorded && guard?.state === 'resolved') return recorded;
  if (guard) throw refusal('The original abandon workload needs native reconciliation', 'GPU_DRIVER_ABANDON_RECONCILIATION_PENDING');
  const assertAbandonable = async current => {
    if (current?.gpuDriverPreparation?.requestId !== preparationId || current.gpuDriverPreparation.state !== 'prepared'
      || ['pending', 'published', 'complete'].includes(current.gpuDriverActivation?.state)) throw refusal('Only an unactivated preparation can be abandoned');
    if (await d.journal.findOne({ kind: 'gpu_driver_activation', state: { $ne: 'resolved' },
      'details.hostId': hostId }).lean()) throw refusal('Reconcile the original activation before abandoning its preparation');
  };
  await assertAbandonable(host);
  const work = await d.begin(workloadId, { kind: 'gpu-driver-preparation-abandon', hosts: [host.hostUrl],
    requestId: `${workloadId}:${crypto.randomUUID()}`, recoveryRequestId: `recovery:${workloadId}` });
  try {
    host = await d.getHost(hostId);
    await assertAbandonable(host);
    work.assertActive();
    const result = { contract: 'agentx.gpu-driver-preparation-abandon/v1', hostId, requestId, preparationId,
      state: 'abandoned', abandonedAt: d.now().toISOString() };
    const saved = await d.model.findOneAndUpdate({ hostId, updatedAt: host.updatedAt,
      'gpuDriverPreparation.requestId': preparationId, 'gpuDriverPreparation.state': 'prepared',
      'gpuDriverActivation.state': { $nin: ['pending', 'published', 'complete'] }
    }, { $set: { 'gpuDriverPreparation.state': 'abandoned' },
      $push: { gpuDriverPreparationHistory: { ...host.gpuDriverPreparation, state: 'abandoned', abandon: result } }
    }, { new: true, runValidators: true, signal: work.signal }).lean();
    if (!saved) throw refusal('The abandon operation lost its concurrency fence');
    work.assertActive();
    await work.complete();
    return result;
  } catch (error) {
    await work.retainForRecovery(error);
    error.retainAdmission = true;
    throw error;
  }
}

module.exports = { abandon };
