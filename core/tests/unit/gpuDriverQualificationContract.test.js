'use strict';

jest.mock('../../src/services/artifactIdentityService', () => ({
  ...jest.requireActual('../../src/services/artifactIdentityService'),
  resolveArtifactIdentity: jest.fn(async (model, host, deps) => ({
    model: model.replace(/:latest$/, ''), hostUrl: host, hostId: deps.hostProfile.hostId,
    digest: `sha256:${'a'.repeat(64)}`, registryQualified: true, identityQualified: true,
    runtimeFingerprint: require('../../../shared/artifactIdentity').buildRuntimeFingerprint(deps.hostProfile)
  }))
}));
const { resolvePreparedDriverContract } = require('../../src/services/gpuDriverQualificationContract');
const { resolveInferenceContractSnapshot } = require('../../src/services/inferenceContractService');
const { buildRuntimeFingerprint } = require('../../../shared/artifactIdentity');

const host = 'http://synthetic-host.example:11434';
const hostId = 'synthetic-host';
const model = 'synthetic-artifact';
const requestId = 'prepare-synthetic';
const base = { hostId, hostUrl: host, gpus: [{ index: 0, uuid: 'GPU-synthetic', model: 'Synthetic GPU', driver: null }] };
const target = { ...base, gpuDriverIdentityVersion: 'agentx.gpu-driver-identity/v1', gpus: [{ ...base.gpus[0], driver: '580.95.05' }] };
const input = { model, host, principal: 'benchmark-service', driverPreparationId: requestId,
  workloadId: 'tool-synthetic', claimBatchId: 'tool-synthetic', claimGeneration: 'claim-generation',
  workloadAdmissionId: 'admission-synthetic', workloadGeneration: 'admission-generation' };

function data(profile = target) {
  const artifact = { model, hostId, hostUrl: host, digest: `sha256:${'a'.repeat(64)}`,
    runtimeFingerprint: buildRuntimeFingerprint(profile), registryQualified: true };
  return { driverPreparationId: requestId, hostProfile: profile, servingContext: 8192,
    contextProfile: { maxVerifiedContext: 8192 }, toolQualification: null,
    modelProfile: { name: model, readiness: { [hostId]: { artifact,
      stage: 'profiled', benchmarkQualified: true, stale: false, authorityVerified: true,
      authority: { contract: 'agentx.profiler-readiness/v2', verified: true, liveIdentityVerified: true } } } } };
}
function dependencies() {
  return {
    hostIdentity: () => ({ host, hostId }),
    assertAdmission: jest.fn(async () => ({ admitted: true, kind: 'tool-capability-qualification' })),
    getClaim: jest.fn(async () => ({ batchId: input.workloadId, claimGeneration: input.claimGeneration,
      admissionId: input.workloadAdmissionId, admissionGeneration: input.workloadGeneration, admissionPrincipal: input.principal })),
    client: { getPreparedDriverEvidence: jest.fn(async () => data()) },
    contextInfo: jest.fn(async () => ({ num_ctx: 8192, verifiedMaxContext: 8192, source: 'model_context_profile_interactive' }))
  };
}

test('native Core snapshot qualifies only the prepared target at unchanged context, without requiring its own tools first', async () => {
  const d = dependencies();
  const snapshot = await resolvePreparedDriverContract(input, d);
  expect(snapshot.artifact.runtimeFingerprint).toBe(buildRuntimeFingerprint(target));
  expect(snapshot.artifact.runtimeFingerprint).not.toBe(buildRuntimeFingerprint(base));
  expect(snapshot.qualification.qualified).toBe(true);
  expect(snapshot.capabilities.tools.qualified).toBe(false);
  expect(snapshot.snapshot).toMatchObject({ scope: 'prepared_gpu_driver_qualification', driverPreparationId: requestId });
  expect(snapshot.contextBudget.windowTokens).toBe(8192);
  expect(d.assertAdmission).toHaveBeenCalledTimes(2);
  expect(d.getClaim).toHaveBeenCalledTimes(2);

  // Dependency injection is local to the explicit qualification call. The
  // ordinary native snapshot still reads the current Benchmark projection.
  const current = data(base);
  const ordinary = await resolveInferenceContractSnapshot({ model, host }, {
    benchmarkClient: { getInferenceEvidence: async () => current, getHostProfile: async () => base },
    resolveContextDetails: async () => ({ num_ctx: 8192, verifiedMaxContext: 8192 })
  });
  expect(ordinary.artifact.runtimeFingerprint).toBe(buildRuntimeFingerprint(base));
  expect(ordinary.snapshot.scope).toBe('deployed_artifact_host');
  expect(ordinary.snapshot.driverPreparationId).toBeUndefined();
});

test.each([
  { principal: 'operator' }, { workloadGeneration: undefined }, { claimGeneration: undefined },
  { claimBatchId: 'another-workload' }, { driverPreparationId: undefined }
])('missing or unrelated authority never reaches prepared Benchmark evidence: %j', async changes => {
  const d = dependencies();
  await expect(resolvePreparedDriverContract({ ...input, ...changes }, d)).rejects.toMatchObject({ code: 'GPU_DRIVER_QUALIFICATION_CONTRACT_REFUSED' });
  expect(d.client.getPreparedDriverEvidence).not.toHaveBeenCalled();
});

test('other workload kinds and absent claims cannot read target contracts', async () => {
  for (const kind of ['benchmark', 'profiler', undefined]) {
    const d = dependencies();
    d.assertAdmission.mockResolvedValue({ admitted: true, kind });
    await expect(resolvePreparedDriverContract(input, d)).rejects.toThrow(/exact active/);
    expect(d.client.getPreparedDriverEvidence).not.toHaveBeenCalled();
  }
  const d = dependencies(); d.getClaim.mockResolvedValue(null);
  await expect(resolvePreparedDriverContract(input, d)).rejects.toThrow(/exact active/);
});

test.each(['admission', 'claim'])('loss of %s after Benchmark reading refuses before a usable contract is returned', async source => {
  const d = dependencies();
  if (source === 'admission') d.assertAdmission.mockResolvedValueOnce({ admitted: true, kind: 'tool-capability-qualification' }).mockResolvedValueOnce({ admitted: false });
  else d.getClaim.mockResolvedValueOnce({ batchId: input.workloadId, claimGeneration: input.claimGeneration,
    admissionId: input.workloadAdmissionId, admissionGeneration: input.workloadGeneration, admissionPrincipal: input.principal })
    .mockResolvedValueOnce({ batchId: 'another-workload' });
  await expect(resolvePreparedDriverContract(input, d)).rejects.toThrow(/exact active/);
  expect(d.client.getPreparedDriverEvidence).toHaveBeenCalledTimes(1);
});

test('changed context, missing native context proof or unqualified native projections are refused', async () => {
  const d = dependencies();
  await expect(resolvePreparedDriverContract({ ...input, requestedNumCtx: 4096 }, d)).rejects.toThrow(/frozen serving context/);
  d.contextInfo.mockResolvedValue({ num_ctx: 8192, verifiedMaxContext: 4096 });
  await expect(resolvePreparedDriverContract(input, d)).rejects.toThrow(/not qualified/);
  d.contextInfo.mockResolvedValue({ num_ctx: 8192, verifiedMaxContext: 8192 });
  const unqualified = data(); unqualified.modelProfile.readiness[hostId].authorityVerified = false;
  d.client.getPreparedDriverEvidence.mockResolvedValue(unqualified);
  await expect(resolvePreparedDriverContract(input, d)).rejects.toThrow(/not qualified/);
});


test('Core refuses an unknown driver identity marker transported by the owner read', async () => {
  const d = dependencies();
  const invalid = data(); invalid.hostProfile.gpuDriverIdentityVersion = 'agentx.gpu-driver-identity/v999';
  d.client.getPreparedDriverEvidence.mockResolvedValue(invalid);
  await expect(resolvePreparedDriverContract(input, d)).rejects.toMatchObject({ code: 'GPU_DRIVER_IDENTITY_VERSION_UNSUPPORTED' });
});
