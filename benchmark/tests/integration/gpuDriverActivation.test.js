'use strict';

jest.mock('../../src/clients/coreApiClient', () => ({
  adoptWorkloadRecovery: jest.fn(async input => ({ adopted: true, ...input })),
  heartbeatWorkloadRecovery: jest.fn(async () => ({ heartbeat: true })),
  assertWorkloadRecovery: jest.fn(async () => ({ owned: true, recoveryOwnerId: 'synthetic-recovery-owner', recoveryState: 'VERIFIED' })),
  transitionWorkloadRecovery: jest.fn(async () => ({ transitioned: true })),
  restoreWorkloadRecoveryHosts: jest.fn(async () => ({ restored: true })),
  releaseWorkloadAdmission: jest.fn(async () => ({ released: true })),
  recoverWorkloadAdmissionRelease: jest.fn(async () => ({ released: false })),
  getWorkloadRecoveryIdentity: jest.fn(workloadId => ({ workloadId, admissionId: 'synthetic-admission',
    generation: 'synthetic-generation', principal: 'benchmark-service', recoveryId: 'synthetic-recovery',
    recoveryRequestId: 'synthetic-recovery-request' }))
}));
jest.mock('../../src/clients/coreWorkloadRecoveries', () => ({
  assertWorkloadRecovery: jest.fn(async () => ({ owned: true, recoveryId: 'synthetic-recovery' }))
}));
jest.mock('../../src/clients/coreGpuDriverCaches', () => ({
  invalidateDriverCaches: jest.fn(async input => ({ contract: 'agentx.gpu-driver-cache-invalidation/v1',
    requestId: input.requestId, preparationId: input.preparationId, targetFingerprint: input.targetFingerprint,
    workloadId: input.workloadId, generations: { routing: 1, readiness: 2, context: 3, models: 4 },
    cleared: true, clearedAt: new Date().toISOString() }))
}));


const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const HostProfile = require('../../models/HostProfile');
const ModelProfile = require('../../models/ModelProfile');
const Performance = require('../../models/ModelPerformanceProfile');
const Context = require('../../models/ModelContextProfile');
const Tool = require('../../models/ToolCapabilityQualification');
const preparation = require('../../src/services/profiler/gpuDriverPreparationService');
const preparedEvidence = require('../../src/services/profiler/gpuDriverPreparedEvidenceService');
const { captureScope } = require('../../src/services/profiler/gpuDriverPreparationScope');
const { preparedTarget } = require('../../src/services/profiler/gpuDriverPreparationIdentity');
const { createProfilerAuthorityReceipt } = require('../../src/services/profiler/profilerAuthorityReceipt');
const tools = require('../../src/services/qualification/toolCapabilityQualificationService');
const fixtures = require('../../src/services/qualification/toolCallFixtures');
const { RECOMMENDATION_EVIDENCE_VERSION } = require('../../../shared/contextEvidence');
const { buildRuntimeFingerprint } = require('../../../shared/artifactIdentity');
const { buildMeasuredRuntime } = require('../../../shared/measuredRuntime');

const Journal = require('../../models/BenchmarkAuthorityReconciliation');
const activation = require('../../src/services/profiler/gpuDriverActivationService');
const publication = require('../../src/services/profiler/gpuDriverActivationPublication');
const { abandon } = require('../../src/services/profiler/gpuDriverPreparationAbandon');
const authority = require('../../src/services/benchmark/benchmarkAuthorityReconciliation');
const modelProfiles = require('../../src/services/profiler/modelProfileService');
const performanceProfiles = require('../../src/services/profiler/modelPerformanceProfileService');
const caches = require('../../src/clients/coreGpuDriverCaches');
const recovery = require('../../src/clients/coreWorkloadRecoveries');
const { inventoryForIdentity } = require('../../../shared/gpuDriverObservation');
const { GPU_DRIVER_IDENTITY_VERSION } = require('../../../shared/artifactIdentity');

const hostId = 'synthetic-host';
const hostUrl = 'http://synthetic-host.example:11434';
const requestId = 'prepare-synthetic-host';
const names = ['synthetic-alpha', 'synthetic-beta'];
const digest = name => `sha256:${(name.endsWith('alpha') ? 'a' : 'b').repeat(64)}`;
let mongo, pins, deps, initial;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await Promise.all([HostProfile.init(), ModelProfile.init(), Performance.init(), Context.init(), Tool.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await Journal.deleteMany({});
  await Promise.all([HostProfile.deleteMany({}), ModelProfile.deleteMany({}), Performance.deleteMany({}), Context.deleteMany({}), Tool.deleteMany({})]);
  pins = { pinnedModels: [{ model: names[0], contextSize: 8192, numThread: 4, keepAlive: -1, autoRestore: true }] };
  const gpus = [{ index: 0, uuid: 'GPU-synthetic', model: 'Synthetic GPU', vramTotalMiB: 24576, driver: null }];
  await HostProfile.create({ hostId, hostUrl, gpus, gpuDriverObservation: {
    gpus: [{ ...gpus[0], driver: '580.95.05' }], status: 'observed',
    observedAt: new Date(Date.now() - 1000), staleAfterMs: 90000, source: 'agentx-data'
  } });
  const getHost = () => HostProfile.findOne({ hostId }).lean();
  const resolveIdentity = async (modelName, _host, _url, options = {}) => {
    const host = await getHost();
    const target = options.driverPreparationId ? preparedTarget(host, options.driverPreparationId, modelName).target : host;
    return { model: modelName, hostId, hostUrl, digest: digest(modelName), registryQualified: true,
      runtimeFingerprint: buildRuntimeFingerprint(target), runtime: buildMeasuredRuntime({ hostProfile: host }),
      ...(options.driverPreparationId && { driverPreparationId: options.driverPreparationId }) };
  };
  const capture = host => captureScope(host, { resolveIdentity, readPins: async () => pins,
    resolveWindow: async () => ({ num_ctx: 8192 }) });
  deps = { getHost, resolveIdentity, capture, sync: jest.fn(async () => ({ synced: false })),
    assertScope: (host, id) => preparation.assertScopeUnchanged(host, id, { capture }) };
  for (const name of names) await seedActive(name);
  initial = await getHost();
});

async function seedActive(name, depth = 'standard', extra = {}) {
  const artifact = await deps.resolveIdentity(name);
  const profile = { profileDepth: depth, benchmarkQualified: true, maxVerifiedContext: 8192,
    recommendedInteractiveContext: 8192, recommendedDocumentContext: 8192, ...extra };
  const evidence = await Performance.create({ modelName: name, hostId, artifact, profile });
  await ModelProfile.create({ name, readiness: { [hostId]: { stage: 'profiled', artifact,
    profileDepth: depth, benchmarkQualified: true, evidenceId: evidence._id,
    authorityReceipt: createProfilerAuthorityReceipt({ modelName: name, hostId, artifact, profile, evidenceId: evidence._id }) } } });
  await seedContext(name, artifact);
  await seedTool(name, artifact);
}

async function seedContext(name, artifact, id) {
  return Context.create({ modelName: name, hostId, hostUrl, artifactDigest: artifact.digest,
    runtimeFingerprint: artifact.runtimeFingerprint, ...(id && { driverPreparationId: id }),
    maxVerifiedContext: 8192, verifiedMaxContext: 8192, recommendedInteractiveContext: 8192,
    recommendedDocumentContext: 8192, recommendationStatus: 'verified',
    recommendationEvidenceVersion: RECOMMENDATION_EVIDENCE_VERSION, revalidationRequired: false,
    measuredRuntime: artifact.runtime, lastValidatedAt: new Date(), profileDepth: 'full' });
}

async function seedTool(name, artifact, id) {
  const campaignId = randomUUID();
  const identity = { modelName: name, hostId, hostUrl, artifactDigest: artifact.digest,
    runtimeFingerprint: artifact.runtimeFingerprint, ...tools.currentEvidenceContract() };
  await tools.beginQualification({ ...identity, campaignId, contractFingerprint: 'f'.repeat(64), repetitionsRequested: 3,
    measuredRuntime: artifact.runtime, ...(id && { driverPreparationId: id, measuredContext: 8192 }),
    claim: { batchId: campaignId, claimGeneration: randomUUID(), hostUrl } });
  const report = { harnessVersion: fixtures.HARNESS_VERSION, fixtureVersion: fixtures.FIXTURE_VERSION,
    fixtureFingerprint: fixtures.fixtureFingerprint(),
    artifact: { model: name, host: hostUrl, hostId, digest: artifact.digest, runtimeFingerprint: artifact.runtimeFingerprint },
    toolCallOutcomes: { scenarios: fixtures.SCENARIOS_V1.map(row => ({ scenarioId: row.id, classification: 'ok', pass: true })) } };
  for (let index = 0; index < 3; index++) await tools.recordRepetition(campaignId, identity, report);
  return tools.finalizeQualification(campaignId, identity);
}

async function seedCandidates({ omit } = {}) {
  for (const name of names) {
    const artifact = await deps.resolveIdentity(name, hostId, hostUrl, { driverPreparationId: requestId });
    if (omit !== 'performance' || name !== names[1]) {
      const profile = { profileDepth: 'standard', benchmarkQualified: true, maxVerifiedContext: 8192,
        recommendedInteractiveContext: 8192, recommendedDocumentContext: 8192, artifact };
      const evidence = await Performance.create({ modelName: name, hostId, artifact, profile, active: false });
      const receipt = createProfilerAuthorityReceipt({ modelName: name, hostId, artifact, profile, evidenceId: evidence._id });
      await ModelProfile.updateOne({ name }, { $set: { [`preparedReadiness.${hostId}`]: {
        stage: 'profiled', artifact, profileDepth: 'standard', benchmarkQualified: true,
        evidenceId: evidence._id, authorityReceipt: receipt
      } } });
    }
    if (omit !== 'context' || name !== names[1]) await seedContext(name, artifact, requestId);
    if (omit !== 'tools' || name !== names[1]) await seedTool(name, artifact, requestId);
  }
}
const nativePublish = publication.publishActivation;
const prepare = () => preparation.prepare({ hostId, requestId, expectedFingerprint: buildRuntimeFingerprint(initial) }, deps);

async function harness({ thinking = null } = {}) {
  if (thinking) for (const name of names) await ModelProfile.updateOne({ name }, { $set: { [`thinkingProfiles.${hostId}`]: thinking } });
  const prepared = await prepare();
  await seedCandidates();
  if (thinking) for (const name of names) {
    const evidence = await Performance.findOne({ modelName: name, 'artifact.driverPreparationId': requestId }).lean();
    const authorityWriteId = randomUUID();
    const profile = { ...evidence.profile, thinking };
    await Performance.updateOne({ _id: evidence._id }, { $set: { profile, authorityWriteId } });
    await ModelProfile.updateOne({ name }, { $set: {
      [`preparedThinkingProfiles.${hostId}`]: { ...thinking, authorityWriteId },
      [`preparedReadiness.${hostId}.authorityWriteId`]: authorityWriteId,
      [`preparedReadiness.${hostId}.authorityReceipt`]: createProfilerAuthorityReceipt({
        modelName: name, hostId, artifact: evidence.artifact, profile, evidenceId: evidence._id })
    } });
  }
  const original = await ModelProfile.find({}).lean();
  const works = [];
  const begin = jest.fn(async workloadId => {
    await authority.prepareWorkloadAuthority({ workloadId, phase: 'synthetic-driver-action' });
    const work = { workloadId, signal: new AbortController().signal, assertActive: jest.fn(),
      retainForRecovery: jest.fn(), complete: jest.fn(async () => {
        await authority.verifyWorkloadAuthority(workloadId);
        await authority.resolveWorkloadAuthority(workloadId, { released: true });
      }) };
    works.push(work);
    return work;
  });
  const inspect = jest.fn((id, prep) => preparedEvidence.inspectPrepared(id, prep, deps));
  jest.spyOn(publication, 'publishActivation').mockImplementation((record, options) => nativePublish(record, options,
    { ...deps, inspect }));
  const activate = (id = 'activate-synthetic-host') => activation.activate({ hostId, requestId: id, preparationId: requestId }, { ...deps, inspect, begin });
  return { original, prepared, works, begin, activate, inspect };
}

async function recover(record) {
  const owner = await authority._claimRecoveryRecord(record, 'synthetic-recovery-owner');
  return authority._reconcileOwnedRecord(owner);
}

test('one host CAS publishes the complete native scope and current owner readers select the new evidence', async () => {
  const h = await harness();
  const before = await modelProfiles.getAll();
  expect(before.map(row => row.readiness[hostId].artifact.runtimeFingerprint))
    .toEqual(names.map(() => buildRuntimeFingerprint(initial)));
  const result = await h.activate();
  expect(result).toMatchObject({ state: 'complete', targetFingerprint: h.prepared.targetFingerprint, cacheReceipt: { cleared: true } });
  expect(h.works[0].complete).toHaveBeenCalledTimes(1);
  expect(caches.invalidateDriverCaches).toHaveBeenCalledTimes(1);
  const active = await deps.getHost();
  expect(buildRuntimeFingerprint(active)).toBe(h.prepared.targetFingerprint);
  expect(active.gpuDriverPreparation.state).toBe('active');
  expect(active.gpuDriverActivation.proofs).toHaveLength(names.length);
  expect(await ModelProfile.find({}).lean()).toEqual(h.original);
  const selected = await modelProfiles.getAll();
  expect((await modelProfiles.readCurrentModelProfile({ name: names[0] }, 'readiness'))
    .readiness[hostId].artifact.runtimeFingerprint).toBe(h.prepared.targetFingerprint);
  for (const row of selected) {
    expect(row.preparedReadiness).toBeUndefined();
    expect(row.nativePublishedReadiness).toBeUndefined();
    expect(row.readiness[hostId].artifact.runtimeFingerprint).toBe(h.prepared.targetFingerprint);
    const evidence = await performanceProfiles.getActiveProfile(row.name, hostId);
    expect(evidence).toMatchObject({ active: true, artifact: { runtimeFingerprint: h.prepared.targetFingerprint } });
    expect((await Performance.findById(evidence._id).lean()).active).toBe(false);
    expect(await performanceProfiles.readCurrentPerformance({ modelName: row.name, hostId,
      'artifact.runtimeFingerprint': buildRuntimeFingerprint(initial) })).toBeNull();
  }
  expect((await performanceProfiles.getRoster({ hostId })).map(row => row.artifact.runtimeFingerprint))
    .toEqual(names.map(() => h.prepared.targetFingerprint));
  expect(await h.activate()).toEqual(result);
  expect(h.begin).toHaveBeenCalledTimes(1);
  await expect(activation.activate({ hostId, requestId: result.requestId, preparationId: 'different-preparation' }, { ...deps, begin: h.begin }))
    .rejects.toThrow(/another intent/);
});

test.each(['performance', 'context', 'tools'])('missing %s on any manifest model refuses activation and native compensation leaves old identity usable', async missing => {
  const h = await harness();
  if (missing === 'performance') await Performance.deleteOne({ modelName: names[1], 'artifact.driverPreparationId': requestId });
  if (missing === 'context') await Context.deleteOne({ modelName: names[1], driverPreparationId: requestId });
  if (missing === 'tools') await Tool.deleteOne({ modelName: names[1], driverPreparationId: requestId });
  await expect(h.activate()).rejects.toMatchObject({ code: 'GPU_DRIVER_ACTIVATION_PROOF_REQUIRED', retainAdmission: true });
  expect(h.works[0].complete).not.toHaveBeenCalled();
  expect(h.works[0].retainForRecovery).toHaveBeenCalledTimes(1);
  const journal = await Journal.findOne({ kind: 'gpu_driver_activation' }).lean();
  await recover(journal);
  expect((await deps.getHost()).gpuDriverActivation.state).toBe('compensated');
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(buildRuntimeFingerprint(initial));
  expect(await ModelProfile.find({}).lean()).toEqual(h.original);
  expect(caches.invalidateDriverCaches).not.toHaveBeenCalled();
  await expect(h.activate()).rejects.toMatchObject({ code: 'GPU_DRIVER_ACTIVATION_RECONCILIATION_PENDING' });
  expect(h.begin).toHaveBeenCalledTimes(1);
});

test('cache acknowledgement loss retains quarantine; the native adopted journal resumes only cache confirmation', async () => {
  const h = await harness();
  caches.invalidateDriverCaches.mockRejectedValueOnce(new Error('synthetic cache response lost'));
  await expect(h.activate()).rejects.toThrow(/cache response lost/);
  expect(h.works[0].complete).not.toHaveBeenCalled();
  expect(h.works[0].retainForRecovery).toHaveBeenCalledTimes(1);
  const host = await deps.getHost();
  expect(host.gpuDriverActivation.state).toBe('published');
  const journal = await Journal.findOne({ kind: 'gpu_driver_activation' }).lean();
  expect(journal).toMatchObject({ state: 'verified', resolutionMode: 'publish' });
  const calls = h.inspect.mock.calls.length;
  // Drift after a published action invalidates current evidence normally. It
  // must not make recovery replay its old identity CAS or run qualifications.
  await HostProfile.updateOne({ hostId }, { $set: { gpus: inventoryForIdentity(host.gpus,
    host.gpus.map(gpu => ({ ...gpu, driver: 'synthetic-next-driver' })), GPU_DRIVER_IDENTITY_VERSION) } });
  await expect(h.activate()).rejects.toMatchObject({ code: 'GPU_DRIVER_ACTIVATION_RECONCILIATION_PENDING' });
  await recover(journal);
  expect(h.inspect).toHaveBeenCalledTimes(calls);
  expect((await deps.getHost()).gpus[0].driver).toBe('synthetic-next-driver');
  expect((await deps.getHost()).gpuDriverActivation).toMatchObject({ state: 'complete', cacheReceipt: { cleared: true } });
  expect(caches.invalidateDriverCaches).toHaveBeenCalledTimes(2);
  expect(h.begin).toHaveBeenCalledTimes(1);
});

test('lost host CAS response never repeats the switch and recovery returns the original cache receipt', async () => {
  const h = await harness();
  const update = HostProfile.findOneAndUpdate.bind(HostProfile);
  jest.spyOn(HostProfile, 'findOneAndUpdate').mockImplementation((filter, change, options) => {
    const query = update(filter, change, options);
    if (change.$set?.['gpuDriverActivation.state'] === 'published') return { lean: async () => {
      await query.lean(); throw new Error('synthetic host CAS response lost');
    } };
    return query;
  });
  await expect(h.activate()).rejects.toThrow(/CAS response lost/);
  const journal = await Journal.findOne({ kind: 'gpu_driver_activation' }).lean();
  expect((await deps.getHost()).gpuDriverActivation.state).toBe('published');
  await recover(journal);
  expect(caches.invalidateDriverCaches).toHaveBeenCalledTimes(1);
  const changes = HostProfile.findOneAndUpdate.mock.calls.filter(call => call[1].$set?.['gpuDriverActivation.state'] === 'published');
  expect(changes).toHaveLength(1);
});

test.each(['pins', 'driver', 'proof'])('%s drift between journal verification and publication cannot switch the host', async drift => {
  const h = await harness();
  const publish = publication.publishActivation.getMockImplementation();
  publication.publishActivation.mockImplementationOnce(async (record, options) => {
    if (drift === 'pins') pins.pinnedModels[0].contextSize = 4096;
    if (drift === 'driver') await HostProfile.updateOne({ hostId }, { $set: { 'gpuDriverObservation.gpus.0.driver': 'synthetic-other-driver' } });
    if (drift === 'proof') await Performance.updateOne({ modelName: names[1], 'artifact.driverPreparationId': requestId }, { $set: { stale: true } });
    return publish(record, options);
  });
  await expect(h.activate()).rejects.toMatchObject({ retainAdmission: true });
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(buildRuntimeFingerprint(initial));
  expect(h.works[0].complete).not.toHaveBeenCalled();
  expect(caches.invalidateDriverCaches).not.toHaveBeenCalled();
});

test('Mongo publication refuses a driver sample that expires after final validation', async () => {
  const h = await harness();
  const publish = publication.publishActivation.getMockImplementation();
  publication.publishActivation.mockImplementationOnce(async (record, options) => {
    await HostProfile.updateOne({ hostId }, { $set: { 'gpuDriverObservation.observedAt': new Date(), 'gpuDriverObservation.staleAfterMs': 1000 } });
    return publish(record, options);
  });
  const update = HostProfile.findOneAndUpdate.bind(HostProfile);
  jest.spyOn(HostProfile, 'findOneAndUpdate').mockImplementation((filter, change, options) => {
    if (change.$set?.['gpuDriverActivation.state'] === 'published') return { lean: async () => {
      await new Promise(resolve => setTimeout(resolve, 1100));
      return update(filter, change, options).lean();
    } };
    return update(filter, change, options);
  });
  await expect(h.activate()).rejects.toMatchObject({ code: 'GPU_DRIVER_ACTIVATION_CAS_FAILED' });
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(buildRuntimeFingerprint(initial));
  expect(h.works[0].complete).not.toHaveBeenCalled();
});

test('a lost journal verification response resumes that verified native operation once', async () => {
  const h = await harness();
  const update = Journal.findOneAndUpdate.bind(Journal);
  jest.spyOn(Journal, 'findOneAndUpdate').mockImplementation((filter, change, options) => {
    const query = update(filter, change, options);
    if (change.$set?.resolutionMode === 'publish') return { lean: async () => {
      await query.lean(); throw new Error('synthetic journal response lost');
    } };
    return query;
  });
  await expect(h.activate()).rejects.toThrow(/journal response lost/);
  const journal = await Journal.findOne({ kind: 'gpu_driver_activation' }).lean();
  expect(journal.state).toBe('verified');
  expect((await deps.getHost()).gpuDriverActivation.state).toBe('pending');
  await recover(journal);
  expect((await deps.getHost()).gpuDriverActivation.state).toBe('complete');
  expect(h.begin).toHaveBeenCalledTimes(1);
  expect(caches.invalidateDriverCaches).toHaveBeenCalledTimes(1);
});

test('first pending ordinary write keeps the selector; a finalized ordinary write owns every later invalidation', async () => {
  const h = await harness();
  await h.activate();
  const selected = await modelProfiles.getByName(names[0]);
  const preparedEvidenceId = selected.readiness[hostId].evidenceId;
  const artifact = { ...selected.readiness[hostId].artifact };
  delete artifact.driverPreparationId;
  const ordinary = await Performance.create({ modelName: names[0], hostId, artifact: { ...artifact, digest: 'synthetic-new-digest' },
    profile: { profileDepth: 'standard', benchmarkQualified: true }, active: true, authorityWriteId: 'synthetic-ordinary-write', authorityState: 'pending_reconciliation' });
  await ModelProfile.updateOne({ name: names[0] }, { $set: { [`readiness.${hostId}`]: { stage: 'profiled', artifact,
    profileDepth: 'standard', benchmarkQualified: true, evidenceId: ordinary._id,
    authorityState: 'pending_reconciliation', authorityWriteId: ordinary.authorityWriteId } } });
  expect((await modelProfiles.getByName(names[0])).readiness[hostId].evidenceId).toEqual(preparedEvidenceId);
  await authority._publishProfilerResource({ _id: new mongoose.Types.ObjectId(), kind: 'profiler_evidence_write',
    details: { modelName: names[0], hostId, evidenceId: ordinary._id, authorityWriteId: ordinary.authorityWriteId,
      runtimeFingerprint: artifact.runtimeFingerprint } });
  expect((await modelProfiles.getByName(names[0])).readiness[hostId].evidenceId).toEqual(ordinary._id);
  await Performance.updateOne({ _id: ordinary._id }, { $set: { stale: true } });
  await ModelProfile.updateOne({ name: names[0] }, { $set: { [`readiness.${hostId}.stale`]: true } });
  expect((await modelProfiles.getByName(names[0])).readiness[hostId].evidenceId).toEqual(ordinary._id);
  expect(await performanceProfiles.getActiveProfile(names[0], hostId)).toBeNull();
});

test('the selected thinking projection remains bound to the exact newly published proof', async () => {
  const h = await harness({ thinking: { supported: true, recommendedPolicy: 'on',
    visibleFinalAnswerOk: true, finalAnswerContractOk: true, thinkingOnlyResponse: false } });
  await h.activate();
  expect((await modelProfiles.getByName(names[0])).thinkingProfiles[hostId]).toMatchObject({ supported: true, recommendedPolicy: 'on' });
  await ModelProfile.updateOne({ name: names[0] }, { $set: { [`preparedThinkingProfiles.${hostId}.recommendedPolicy`]: 'off' } });
  expect((await modelProfiles.getByName(names[0])).thinkingProfiles[hostId]).toBeUndefined();
});

test('abandon archives the exact operation and permits a new preparation without changing active evidence', async () => {
  const h = await harness();
  const getHost = () => HostProfile.findOne({ hostId }).select('+gpuDriverPreparationHistory').lean();
  const input = { hostId, requestId: 'abandon-synthetic-host', preparationId: requestId };
  const result = await abandon(input, { ...deps, getHost, begin: h.begin });
  expect(result.state).toBe('abandoned');
  expect(await abandon(input, { ...deps, getHost, begin: h.begin })).toEqual(result);
  expect(h.begin).toHaveBeenCalledTimes(1);
  await expect(abandon({ ...input, preparationId: 'different-preparation' }, { ...deps, getHost, begin: h.begin })).rejects.toThrow(/another preparation/);
  const next = await preparation.prepare({ hostId, requestId: 'prepare-synthetic-next', expectedFingerprint: buildRuntimeFingerprint(initial) }, { ...deps, getHost });
  expect(next.state).toBe('prepared');
  expect((await preparation.prepare({ hostId, requestId, expectedFingerprint: buildRuntimeFingerprint(initial) }, { ...deps, getHost })).state).toBe('abandoned');
  expect((await getHost()).gpuDriverPreparation.requestId).toBe(next.requestId);
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(buildRuntimeFingerprint(initial));
  expect(await ModelProfile.find({}).lean()).toEqual(h.original);
});

test('an uncertain activation cannot be abandoned or replaced', async () => {
  const h = await harness();
  caches.invalidateDriverCaches.mockRejectedValueOnce(new Error('synthetic cache failure'));
  await expect(h.activate()).rejects.toThrow();
  await expect(abandon({ hostId, requestId: 'abandon-synthetic-host', preparationId: requestId }, { ...deps, begin: h.begin }))
    .rejects.toThrow(/unactivated preparation/);
  expect(h.begin).toHaveBeenCalledTimes(1);
});
