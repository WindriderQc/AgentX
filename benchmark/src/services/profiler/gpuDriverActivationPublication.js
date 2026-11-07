'use strict';

// Native journal publication selects already qualified owner evidence. It does
// not copy evidence or grant qualification; normal readers still verify it.
const HostProfile = require('../../../models/HostProfile');
const hosts = require('./hostProfileService');
const { inspectPrepared } = require('./gpuDriverPreparedEvidenceService');
const { assertScopeUnchanged } = require('./gpuDriverPreparationService');
const { preparedTarget, refusal } = require('./gpuDriverPreparationIdentity');
const { hash } = require('./gpuDriverPreparationScope');
const { assertWorkloadRecovery } = require('../../clients/coreWorkloadRecoveries');
const { invalidateDriverCaches } = require('../../clients/coreGpuDriverCaches');
const { confirmedCacheReceipt } = require('../../../../shared/gpuDriverTransition');

function freezeProofs(models) {
  return models.map(model => {
    const readiness = model.modelProfile.readiness?.[model.artifact.hostId];
    const { authority: _authority, runtimeDrift: _drift, measuredRuntime: _runtime, ...storedReadiness } = readiness || {};
    return {
      modelName: model.modelName, artifactDigest: model.artifact.digest,
      performanceEvidenceId: model.performanceEvidence ? String(model.performanceEvidence._id) : null,
      performanceReceiptDigest: readiness?.authorityReceipt?.digest || null,
      performanceWriteId: model.performanceEvidence?.authorityWriteId || null,
      contextEvidenceId: model.contextProfile ? String(model.contextProfile._id) : null,
      contextWriteId: model.contextProfile?.authorityWriteId || null,
      contextSnapshotId: model.contextProfile?.latestEvidence?.snapshotId || null,
      toolCampaignId: model.toolQualification?.qualified ? model.toolQualification.evidence.campaignId : null,
      toolEvidenceDigest: model.toolQualification?.qualified ? model.toolQualification.evidence.evidenceDigest : null,
      // Freeze the complete qualified owner views as a digest, not a parallel
      // authority payload. Replay must find these same native proofs.
      ownerViewsDigest: hash({ performance: model.performanceEvidence, readiness: storedReadiness,
        context: model.contextProfile, tools: model.toolQualification, thinking: model.modelProfile.thinkingProfiles })
    };
  });
}

function dependencies(overrides) {
  return { model: HostProfile, getHost: hosts.getById, inspect: inspectPrepared, assertScope: assertScopeUnchanged,
    assertRecovery: assertWorkloadRecovery, clearCaches: invalidateDriverCaches, now: () => new Date(), ...overrides };
}

async function assertOwned(record, options, d) {
  options.assertActive?.();
  const proof = await d.assertRecovery(record.workloadId, { signal: options.signal });
  if (proof?.owned !== true || proof.recoveryId !== record.recoveryId) throw refusal('The native activation reservation is no longer owned');
  options.assertActive?.();
}

function exactActivation(host, record) {
  const a = host?.gpuDriverActivation;
  const details = record.details;
  return a?.requestId === details.requestId && a.preparationId === details.preparationId
    && a.targetFingerprint === details.targetFingerprint && a.journalId === String(record._id);
}

async function publishActivation(record, options = {}, overrides = {}) {
  const d = dependencies(overrides);
  const details = record.details;
  let host = await d.getHost(details.hostId);
  if (!exactActivation(host, record)) throw refusal('The journal does not match the host activation intent');
  // A lost acknowledgement after publication resumes cache confirmation only.
  // Never revalidate or replay an identity CAS against a later live runtime.
  if (host.gpuDriverActivation.state === 'complete') return receipt(host);
  await assertOwned(record, options, d);
  if (host.gpuDriverActivation.state === 'pending') {
    const inspected = await d.inspect(details.hostId, details.preparationId);
    if (!inspected.ready || hash(freezeProofs(inspected.models)) !== hash(details.proofs)) {
      throw refusal('The exact new native proofs are missing or changed', 'GPU_DRIVER_ACTIVATION_PROOF_DRIFT');
    }
    host = await d.getHost(details.hostId);
    await d.assertScope(host, details.preparationId);
    const target = preparedTarget(host, details.preparationId, host.gpuDriverPreparation.manifest[0].modelName, d.now()).target;
    const observed = host.gpuDriverObservation;
    const expirations = [new Date(observed.observedAt).getTime() + Number(observed.staleAfterMs),
      ...inspected.models.filter(model => model.toolQualification?.qualified)
        .map(model => new Date(model.toolQualification.evidence.validUntil).getTime())];
    const validUntil = Math.min(...expirations);
    if (!Number.isFinite(validUntil) || validUntil <= d.now().getTime()) throw refusal('Activation evidence expired');
    await assertOwned(record, options, d);
    options.assertActive?.();
    const saved = await d.model.findOneAndUpdate({ hostId: details.hostId, updatedAt: host.updatedAt,
      'gpuDriverPreparation.requestId': details.preparationId, 'gpuDriverPreparation.state': 'prepared',
      'gpuDriverActivation.requestId': details.requestId, 'gpuDriverActivation.journalId': String(record._id),
      'gpuDriverActivation.state': 'pending', $expr: { $lt: ['$$NOW', new Date(validUntil)] }
    }, { $set: { gpus: target.gpus, gpuDriverIdentityVersion: target.gpuDriverIdentityVersion,
      'gpuDriverPreparation.state': 'active', 'gpuDriverActivation.state': 'published',
      'gpuDriverActivation.publishedAt': d.now(), 'gpuDriverActivation.proofs': details.proofs }
    }, { new: true, runValidators: true, ...(options.signal && { signal: options.signal }) }).lean();
    if (!saved) throw refusal('The atomic host activation lost its concurrency fence', 'GPU_DRIVER_ACTIVATION_CAS_FAILED');
    host = saved;
  }
  if (host.gpuDriverActivation.state !== 'published') throw refusal('The activation is not publishable');
  await assertOwned(record, options, d);
  const cacheIntent = { host: host.hostUrl, workloadId: record.workloadId,
    requestId: details.requestId, preparationId: details.preparationId, targetFingerprint: details.targetFingerprint };
  const cacheReceipt = await d.clearCaches(cacheIntent, options);
  if (!confirmedCacheReceipt(cacheReceipt, cacheIntent)) throw refusal('Core cache confirmation is missing');
  await assertOwned(record, options, d);
  const completed = await d.model.findOneAndUpdate({ hostId: details.hostId,
    'gpuDriverActivation.requestId': details.requestId, 'gpuDriverActivation.journalId': String(record._id),
    'gpuDriverActivation.state': 'published'
  }, { $set: { 'gpuDriverActivation.state': 'complete', 'gpuDriverActivation.cacheReceipt': cacheReceipt,
    'gpuDriverActivation.completedAt': d.now() } }, { new: true, ...(options.signal && { signal: options.signal }) }).lean();
  if (!completed) throw refusal('The cache confirmation lost its activation fence');
  options.assertActive?.();
  return receipt(completed);
}

function receipt(host) {
  const a = host.gpuDriverActivation;
  return { contract: 'agentx.gpu-driver-activation/v1', hostId: host.hostId, requestId: a.requestId,
    preparationId: a.preparationId, targetFingerprint: a.targetFingerprint,
    state: a.state, publishedAt: a.publishedAt, completedAt: a.completedAt, cacheReceipt: a.cacheReceipt };
}

async function compensateActivation(record, options = {}, overrides = {}) {
  const d = dependencies(overrides);
  await assertOwned(record, options, d);
  const details = record.details;
  // A pending journal cannot have published a host identity. Fence even the
  // no-host-write case so a delayed original writer cannot create it later.
  const updated = await d.model.findOneAndUpdate({ hostId: details.hostId,
    'gpuDriverPreparation.requestId': details.preparationId, 'gpuDriverPreparation.state': 'prepared',
    $or: [{ 'gpuDriverActivation.requestId': { $exists: false } },
      { 'gpuDriverActivation.requestId': details.requestId, 'gpuDriverActivation.state': { $in: ['pending', 'compensated'] } }]
  }, { $set: { gpuDriverActivation: { ...details, journalId: String(record._id), state: 'compensated' } } },
  { new: true, ...(options.signal && { signal: options.signal }) }).lean();
  if (!updated) throw refusal('The pending activation cannot be safely compensated');
  options.assertActive?.();
  return { contract: 'agentx.authority-compensation/v1', resourceType: 'HostProfile',
    resourceId: details.hostId, requestId: details.requestId, state: 'compensated' };
}

module.exports = { freezeProofs, publishActivation, compensateActivation, receipt };
