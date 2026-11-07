'use strict';

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
const prepare = () => preparation.prepare({ hostId, requestId, expectedFingerprint: buildRuntimeFingerprint(initial) }, deps);

test('preparation freezes every qualified model and native requirement while retaining the active fingerprint', async () => {
  const before = await ModelProfile.find({}).lean();
  const result = await prepare();
  expect(result.manifest.map(row => row.modelName)).toEqual(names);
  for (const entry of result.manifest) {
    expect(entry).toMatchObject({ servingContext: 8192, performance: { sourceProfileDepth: 'standard' },
      context: { recommendationStatus: 'verified' }, tools: { state: 'supported' } });
  }
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(buildRuntimeFingerprint(initial));
  expect(await ModelProfile.find({}).lean()).toEqual(before);
  expect(await prepare()).toEqual(result);
  await expect(preparation.prepare({ hostId, requestId, expectedFingerprint: 'f'.repeat(64) }, deps)).rejects.toThrow(/another intent/);
  const status = await preparedEvidence.inspectPrepared(hostId, requestId, deps);
  expect(status.ready).toBe(false);
  expect(status.models.every(row => row.reasons.includes('tools_required'))).toBe(true);
});

test('context-only, performance-only and tool-only native capabilities remain distinct and complete, including tag aliases', async () => {
  await ModelProfile.deleteOne({ name: names[0] });
  await Tool.deleteMany({ modelName: { $in: names } });
  await Context.deleteOne({ modelName: names[1] });
  const aliased = 'owner/synthetic-alpha:latest';
  await seedTool(aliased, await deps.resolveIdentity('owner/synthetic-alpha'));
  const result = await prepare();
  expect(result.manifest.map(row => row.modelName)).toEqual(['owner/synthetic-alpha', ...names]);
  expect(result.manifest[0]).toMatchObject({ context: null, performance: null, tools: { state: 'supported' } });
  expect(result.manifest[1]).toMatchObject({ context: { maxVerifiedContext: 8192 }, performance: null, tools: null });
  expect(result.manifest[2]).toMatchObject({ context: null, performance: { sourceProfileDepth: 'standard' }, tools: null });
  pins.pinnedModels[0].model += ':latest';
  await expect(preparedEvidence.inspectPrepared(hostId, requestId, deps)).resolves.toMatchObject({ ready: false });
});

test('an already known manual driver still gets a distinct target without colliding with its active proof', async () => {
  // Recreate the same native fixtures with a driver that predates the rollout.
  await Promise.all([ModelProfile.deleteMany({}), Performance.deleteMany({}), Context.deleteMany({}), Tool.deleteMany({})]);
  await HostProfile.updateOne({ hostId }, { $set: { 'gpus.0.driver': '580.95.05' } });
  for (const name of names) await seedActive(name);
  initial = await deps.getHost();
  const result = await prepare();
  expect(result.targetFingerprint).not.toBe(result.activeFingerprint);
  await seedCandidates();
  expect((await preparedEvidence.inspectPrepared(hostId, requestId, deps)).ready).toBe(true);
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(result.activeFingerprint);
});

test('native standard/full eligibility stays native, while a verified quality capability cannot disappear', async () => {
  await Promise.all([ModelProfile.deleteMany({}), Performance.deleteMany({}), Context.deleteMany({}), Tool.deleteMany({})]);
  for (const name of names) await seedActive(name, 'full');
  await prepare(); await seedCandidates();
  // A qualified standard proof satisfies the native performance gate even if
  // the prior depth was full; no new universal Full requirement is introduced.
  expect((await preparedEvidence.inspectPrepared(hostId, requestId, deps)).ready).toBe(true);
});

test('native verified quality is a preserved capability across its existing context/performance sources', async () => {
  await Promise.all([ModelProfile.deleteMany({}), Performance.deleteMany({}), Context.deleteMany({}), Tool.deleteMany({})]);
  for (const name of names) await seedActive(name, 'full', { qualityContextStatus: 'verified', qualityVerifiedContext: 8192 });
  await prepare(); await seedCandidates();
  const status = await preparedEvidence.inspectPrepared(hostId, requestId, deps);
  expect(status.ready).toBe(false);
  expect(status.models.every(row => row.reasons.includes('quality_context_required'))).toBe(true);
});

test('native coding-agent readiness is preserved through the existing lane thresholds', async () => {
  await Promise.all([ModelProfile.deleteMany({}), Performance.deleteMany({}), Context.deleteMany({}), Tool.deleteMany({})]);
  const { AGENT_MINIMUMS } = require('../../src/services/profiler/laneCapability');
  const agentWorkload = { summary: {
    sessionLatencyKneeContext: AGENT_MINIMUMS.stepContext, sessionAccuracyContext: AGENT_MINIMUMS.stepContext,
    verificationVerifiedContext: AGENT_MINIMUMS.stepContext, reliableToolTurns: AGENT_MINIMUMS.toolTurns,
    reliableOutputTokens: AGENT_MINIMUMS.outputTokens, toolChecksCorrect: 10, toolChecksTotal: 10
  } };
  for (const name of names) await seedActive(name, 'full', { agentWorkload });
  const frozen = await prepare();
  expect(frozen.manifest.every(row => row.nativeReadiness.codingAgent === 'ready')).toBe(true);
  await seedCandidates();
  const status = await preparedEvidence.inspectPrepared(hostId, requestId, deps);
  expect(status.ready).toBe(false);
  expect(status.models.every(row => row.reasons.includes('native_codingAgent_required'))).toBe(true);
});

test('thinking requalification retains the native visible-final and enabled-mode contract', async () => {
  const thinking = { supported: true, visibleFinalAnswerOk: true, finalAnswerContractOk: true,
    thinkingOnlyResponse: false, recommendedPolicy: 'on' };
  for (const name of names) await ModelProfile.updateOne({ name }, { $set: { [`thinkingProfiles.${hostId}`]: thinking } });
  await prepare(); await seedCandidates();
  expect((await preparedEvidence.inspectPrepared(hostId, requestId, deps)).ready).toBe(false);
  for (const change of [{ thinkingOnlyResponse: true }, { recommendedPolicy: 'disallowed' }]) {
    for (const name of names) await ModelProfile.updateOne({ name }, { $set: { [`preparedThinkingProfiles.${hostId}`]: { ...thinking, ...change } } });
    const status = await preparedEvidence.inspectPrepared(hostId, requestId, deps);
    expect(status.models.every(row => row.reasons.includes('thinking_required'))).toBe(true);
  }
  for (const name of names) await ModelProfile.updateOne({ name }, { $set: { [`preparedThinkingProfiles.${hostId}`]: thinking } });
  expect((await preparedEvidence.inspectPrepared(hostId, requestId, deps)).ready).toBe(true);
});

test('concurrent preparations commit exactly one immutable manifest', async () => {
  const results = await Promise.allSettled([requestId, 'another-preparation'].map(id => preparation.prepare({
    hostId, requestId: id, expectedFingerprint: buildRuntimeFingerprint(initial)
  }, deps)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
});

test.each(['performance', 'context', 'tools'])('one missing %s proof on the second model prevents readiness for the whole host', async omit => {
  await prepare(); await seedCandidates({ omit });
  const status = await preparedEvidence.inspectPrepared(hostId, requestId, deps);
  expect(status.ready).toBe(false);
  expect(status.models[1].reasons).toContain(`${omit}_required`);
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(buildRuntimeFingerprint(initial));
});

test('all new native proofs qualify together; prepared tool freezing has no circular dependency on its own proof', async () => {
  await prepare(); await seedCandidates({ omit: 'tools' });
  const first = await preparedEvidence.qualificationEvidence(hostId, requestId, names[1], deps);
  expect(first.contextProfile).not.toBeNull();
  expect(first.performanceEvidence).not.toBeNull();
  expect(first.toolQualification.qualified).toBe(false);
  await seedTool(names[1], first.artifact, requestId);
  expect((await preparedEvidence.inspectPrepared(hostId, requestId, deps)).ready).toBe(true);
  expect((await ModelProfile.findOne({ name: names[0] }).lean()).readiness[hostId].artifact.runtimeFingerprint)
    .toBe(buildRuntimeFingerprint(initial));
});

test('pin, driver, complete scope, target identity and evidence integrity drift are refused', async () => {
  await prepare(); await seedCandidates();
  pins.pinnedModels[0].contextSize = 4096;
  await expect(preparedEvidence.inspectPrepared(hostId, requestId, deps)).rejects.toMatchObject({ code: 'GPU_DRIVER_SCOPE_DRIFT' });
  pins.pinnedModels[0].contextSize = 8192;
  await Tool.collection.updateOne({ driverPreparationId: requestId, modelName: names[1] }, { $set: { measuredContext: 4096 } });
  expect((await preparedEvidence.inspectPrepared(hostId, requestId, deps)).models[1].reasons).toContain('tools_required');
  await HostProfile.updateOne({ hostId }, { $set: { 'gpuDriverObservation.gpus.0.driver': '590.1' } });
  await expect(preparedEvidence.inspectPrepared(hostId, requestId, deps)).rejects.toMatchObject({ code: 'GPU_DRIVER_PREPARATION_DRIFT' });
  expect(buildRuntimeFingerprint(await deps.getHost())).toBe(buildRuntimeFingerprint(initial));
});
