'use strict';

jest.mock('../../src/clients/coreApiClient', () => ({
  getWorkloadRecoveryIdentity: jest.fn(() => ({ admissionId: 'admission-synthetic', generation: 'generation-synthetic',
    principal: 'benchmark-service', recoveryId: 'recovery-synthetic', recoveryRequestId: 'recovery-request-synthetic' }))
}));
jest.mock('../../src/services/profiler/artifactIdentityService', () => ({
  ...jest.requireActual('../../src/services/profiler/artifactIdentityService'), resolveArtifactIdentity: jest.fn()
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ModelProfile = require('../../models/ModelProfile');
const ModelPerformanceProfile = require('../../models/ModelPerformanceProfile');
const Journal = require('../../models/BenchmarkAuthorityReconciliation');
const identity = require('../../src/services/profiler/artifactIdentityService');
const { persistProfileEvidence } = require('../../src/services/profiler/profilerEvidencePersistence');
const modelProfiles = require('../../src/services/profiler/modelProfileService');
const performanceProfiles = require('../../src/services/profiler/modelPerformanceProfileService');
const authority = require('../../src/services/benchmark/benchmarkAuthorityReconciliation');
const { createProfilerAuthorityReceipt, hasQualifiedProfilerAuthority } = require('../../src/services/profiler/profilerAuthorityReceipt');
const { publishProfilerResource } = require('../../src/services/benchmark/profilerAuthorityPublication');

const hostId = 'synthetic-host';
const modelName = 'synthetic-artifact';
const requestId = 'prepare-synthetic';
const base = { model: modelName, hostId, hostUrl: 'http://synthetic-host.example:11434', digest: 'sha256:synthetic',
  runtimeFingerprint: 'old-runtime', registryQualified: true };
const target = { ...base, runtimeFingerprint: 'driver-runtime', driverPreparationId: requestId,
  runtime: { gpuDriver: '580.95.05', ollamaVersion: 'synthetic-runtime', observedAt: new Date().toISOString() } };
const data = () => ({ profileDepth: 'standard', maxVerifiedContext: 8192,
  recommendedInteractiveContext: 8192, recommendedDocumentContext: 8192,
  requiredRetainedSamples: 2, requiredTtftSamples: 2, ttftMeasurement: 'streamed_wall_clock', ttftMs: 10,
  measurementQuality: { reliability: 'medium', passingSampleCount: 2, ttftSampleCount: 2 }, spill: { verified: true },
  thinking: { supported: true, visibleFinalAnswerOk: true, finalAnswerContractOk: true, recommendedPolicy: 'metered' } });
let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([ModelProfile.init(), ModelPerformanceProfile.init(), Journal.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  identity.resolveArtifactIdentity.mockImplementation(async (_model, _host, _url, options) => options?.driverPreparationId ? target : base);
  await Promise.all([ModelProfile.deleteMany({}), ModelPerformanceProfile.deleteMany({}), Journal.deleteMany({})]);
});

async function seedActive() {
  const old = await ModelPerformanceProfile.create({ modelName, hostId, artifact: base,
    profile: { ...data(), benchmarkQualified: true }, active: true, authorityState: 'authoritative' });
  const receipt = createProfilerAuthorityReceipt({ modelName, hostId, artifact: base, profile: old.profile, evidenceId: old._id });
  await ModelProfile.create({ name: modelName, capabilities: { thinking: true, thinkingPolicy: 'on' },
    thinkingProfiles: { [hostId]: { supported: true, recommendedPolicy: 'on', visibleFinalAnswerOk: true } },
    readiness: { [hostId]: { stage: 'profiled', artifact: base, evidenceId: old._id,
      profileDepth: 'standard', benchmarkQualified: true, authorityReceipt: receipt } } });
  return { old: await ModelPerformanceProfile.findById(old._id).lean(), profile: await ModelProfile.findOne({ name: modelName }).lean() };
}

const persist = checkpoint => persistProfileEvidence({ modelName, hostId, hostUrl: base.hostUrl,
  artifact: target, profileData: data(), claimIdentity: { claimBatchId: 'synthetic-workload' },
  assertClaimActive: checkpoint || (() => {}), signal: new AbortController().signal });

async function assertActiveUnchanged(original) {
  const profile = await ModelProfile.findOne({ name: modelName }).lean();
  expect(profile.readiness).toEqual(original.profile.readiness);
  expect(profile.thinkingProfiles).toEqual(original.profile.thinkingProfiles);
  expect(profile.capabilities).toEqual(original.profile.capabilities);
  expect(profile.preparedReadiness).toBeUndefined();
  expect(profile.preparedThinkingProfiles).toBeUndefined();
  expect(await ModelPerformanceProfile.findById(original.old._id).lean()).toEqual(original.old);
  expect((await performanceProfiles.getActiveProfile(modelName, hostId))._id).toEqual(original.old._id);
  expect((await performanceProfiles.getRoster({ hostId })).map(row => String(row._id))).toEqual([String(original.old._id)]);
}

test('native journal publication prepares new standard evidence while active proof, roster and thinking remain intact', async () => {
  const original = await seedActive();
  const candidate = await persist();
  await assertActiveUnchanged(original);
  const prepared = await ModelProfile.findOne({ name: modelName }).select('+preparedReadiness +preparedThinkingProfiles').lean();
  const readiness = prepared.preparedReadiness[hostId];
  const stored = await ModelPerformanceProfile.findById(candidate._id).lean();
  expect(stored).toMatchObject({ active: false, stale: false, authorityState: 'authoritative', artifact: { driverPreparationId: requestId } });
  expect(prepared.preparedThinkingProfiles[hostId].recommendedPolicy).toBe('metered');
  expect(hasQualifiedProfilerAuthority(readiness, stored, { modelName, hostId })).toBe(true);
  const journal = await Journal.findOne({ 'details.evidenceId': candidate._id }).lean();
  expect(journal).toMatchObject({ state: 'resolved', resolutionMode: 'publish', details: { driverPreparationId: requestId } });
  // Replaying the native durable publication targets the same prepared slot.
  await publishProfilerResource(journal);
  await assertActiveUnchanged(original);
});

test('ambiguous prepared writes compensate only the candidate and cannot republish invalidated authority', async () => {
  const original = await seedActive();
  const write = modelProfiles.updateReadiness;
  jest.spyOn(modelProfiles, 'updateReadiness').mockImplementation(async (...args) => {
    await write(...args);
    throw Object.assign(new Error('synthetic acknowledgement loss'), { code: 'BENCHMARK_CLAIM_LOST' });
  });
  await expect(persist()).rejects.toMatchObject({ retainAdmission: true, authorityInvalidationFailed: true });
  const journal = await Journal.findOne({ kind: 'profiler_evidence_write' }).lean();
  expect(journal.state).toBe('pending_reconciliation');
  await authority._invalidateResource(journal);
  await assertActiveUnchanged(original);
  const candidate = await ModelPerformanceProfile.findOne({ 'artifact.runtimeFingerprint': target.runtimeFingerprint }).lean();
  expect(candidate).toMatchObject({ active: false, stale: true, authorityState: 'authority_invalidated' });
  await expect(publishProfilerResource(journal)).rejects.toThrow(/CAS/);
  await assertActiveUnchanged(original);
});
