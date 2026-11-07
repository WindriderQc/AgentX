'use strict';

const coordination = require('./runtimeCoordinationService');
const { getActiveBenchmarkClaim } = require('./benchmarkClaimGuard');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');
const { resolveInferenceContractSnapshot, resolveHostIdentity } = require('./inferenceContractService');
const { getContextInfo } = require('./modelContextInfoService');
const { buildRuntimeFingerprint, normalizeHostUrl } = require('../../../shared/artifactIdentity');

const refused = message => Object.assign(new Error(message), {
  code: 'GPU_DRIVER_QUALIFICATION_CONTRACT_REFUSED', statusCode: 409
});

async function assertAuthority(input, d) {
  if (![input.driverPreparationId, input.workloadId, input.workloadAdmissionId, input.workloadGeneration, input.claimBatchId, input.claimGeneration].every(value => typeof value === 'string' && value.trim())
    || input.principal !== 'benchmark-service' || !input.driverPreparationId || !input.workloadId
    || input.claimBatchId !== input.workloadId) throw refused('An owned tool qualification workload is required');
  const admission = await d.assertAdmission({ id: input.workloadAdmissionId, generation: input.workloadGeneration,
    principal: input.principal, workloadId: input.workloadId, host: input.host });
  const claim = await d.getClaim(input.host);
  if (admission?.admitted !== true || admission.kind !== 'tool-capability-qualification'
    || !claim || claim.batchId !== input.workloadId || claim.claimGeneration !== input.claimGeneration
    || claim.admissionId !== input.workloadAdmissionId || claim.admissionGeneration !== input.workloadGeneration
    || claim.admissionPrincipal !== input.principal) throw refused('The exact active qualification admission and host claim are required');
}

async function resolvePreparedDriverContract(input, overrides = {}) {
  const d = { assertAdmission: coordination.assertWorkloadAdmission, getClaim: getActiveBenchmarkClaim,
    client: getBenchmarkServiceClient(), resolveSnapshot: resolveInferenceContractSnapshot,
    hostIdentity: resolveHostIdentity, contextInfo: getContextInfo, ...overrides };
  for (const value of [input.requestedNumCtx, input.requestedMaxOutputTokens]) {
    if (value != null && (!Number.isSafeInteger(value) || value <= 0)) throw refused('Context and response budgets must be positive integers');
  }
  await assertAuthority(input, d);
  const configured = d.hostIdentity(input.host);
  if (!configured.hostId) throw refused('The qualification host must be registered');
  const { principal: _principal, model, host, driverPreparationId: requestId, ...authority } = input;
  const evidence = await d.client.getPreparedDriverEvidence({ hostId: configured.hostId, modelName: model, requestId, authority });
  if (evidence?.driverPreparationId !== requestId || evidence.hostProfile?.hostId !== configured.hostId
    || normalizeHostUrl(evidence.hostProfile?.hostUrl) !== normalizeHostUrl(host)) throw refused('Prepared evidence identifies another host or request');
  const numCtx = evidence.servingContext;
  if (!Number.isSafeInteger(numCtx) || numCtx <= 0
    || (input.requestedNumCtx != null && input.requestedNumCtx !== numCtx)) throw refused('The prepared contract must retain the frozen serving context');
  // Reuse the native Core contract and context resolver, with a narrowly scoped
  // Benchmark-owned read. Ordinary inference never receives this dependency.
  const client = {
    getHostProfile: async () => evidence.hostProfile,
    getInferenceEvidence: async () => evidence,
    getContextProfile: async () => evidence.contextProfile
  };
  const snapshot = await d.resolveSnapshot({ model, host, requestedNumCtx: numCtx,
    requestedMaxOutputTokens: input.requestedMaxOutputTokens, numCtxSource: 'caller' }, {
    benchmarkClient: client,
    resolveContextDetails: (name, options) => d.contextInfo(name, host, {
      workload: options.workload,
      deps: { hostProfile: evidence.hostProfile, benchmarkClient: client }
    })
  });
  if (snapshot.qualification?.qualified !== true || snapshot.qualification?.exactArtifact !== true
    || snapshot.artifact?.runtimeFingerprint !== buildRuntimeFingerprint(evidence.hostProfile)
    || snapshot.artifact?.identityQualified !== true || snapshot.artifact?.registryQualified !== true
    || snapshot.contextBudget?.windowTokens !== numCtx
    || !Number.isSafeInteger(snapshot.contextBudget?.validatedWindowTokens) || snapshot.contextBudget.validatedWindowTokens < numCtx) {
    throw refused('The native target contract is not qualified at the frozen context');
  }
  await assertAuthority(input, d);
  return { ...snapshot, snapshot: { ...snapshot.snapshot,
    scope: 'prepared_gpu_driver_qualification', driverPreparationId: requestId } };
}

module.exports = { resolvePreparedDriverContract, assertAuthority };
