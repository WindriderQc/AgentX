'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const HostProfile = require('../../models/HostProfile');
const ModelPerformanceProfile = require('../../models/ModelPerformanceProfile');
const { syncHostRuntimeSettings } = require('../../src/services/profiler/hostRuntimeSettingsService');
const { buildRuntimeFingerprint } = require('../../../shared/artifactIdentity');
const { buildMeasuredRuntime } = require('../../../shared/measuredRuntime');

const host = { hostId: 'synthetic-host', hostUrl: 'http://synthetic-host.example:11434' };
const gpus = [0, 1].map(index => ({
  index, uuid: `GPU-synthetic-${index}`, model: 'Synthetic GPU', vramTotalMiB: 24576, driver: null
}));
let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
afterEach(async () => {
  await Promise.all([HostProfile.deleteMany({}), ModelPerformanceProfile.deleteMany({})]);
});

test('observations persist separately without rewriting existing performance evidence or its identity', async () => {
  await HostProfile.create({ ...host, gpus });
  const original = await HostProfile.findOne({ hostId: host.hostId }).lean();
  const fingerprint = buildRuntimeFingerprint(original);
  const historical = await ModelPerformanceProfile.create({
    modelName: 'synthetic-artifact', hostId: host.hostId,
    artifact: { ...host, model: 'synthetic-artifact', digest: 'sha256:synthetic',
      runtimeFingerprint: fingerprint, registryQualified: true },
    profile: { profileDepth: 'standard' }
  });
  const proofBefore = await ModelPerformanceProfile.findById(historical._id).lean();

  for (const driver of ['580.95.05', '590.1']) {
    await syncHostRuntimeSettings(host, { force: true, readHardware: async () => ({
      status: 'observed', source: 'agentx-data', sampledAt: '2026-11-07T12:00:00Z', staleAfterMs: 90000,
      gpus: gpus.map(gpu => ({ ...gpu, driver }))
    }) });
    const current = await HostProfile.findOne({ hostId: host.hostId }).lean();
    expect(current.gpuDriverObservation).toMatchObject({
      source: 'agentx-data', observedAt: new Date('2026-11-07T12:00:00Z'),
      gpus: [expect.objectContaining({ driver }), expect.objectContaining({ driver })]
    });
    expect(buildMeasuredRuntime({ hostProfile: current, observedAt: '2026-11-07T12:00:01Z' }).gpuDriver).toBe(driver);
    expect(buildRuntimeFingerprint(current)).toBe(fingerprint);
    expect(current.gpus.map(gpu => gpu.driver)).toEqual([null, null]);
    expect(await ModelPerformanceProfile.findById(historical._id).lean()).toEqual(proofBefore);
  }

  const beforeUnavailable = await HostProfile.findOne({ hostId: host.hostId }).lean();
  for (const status of ['stale', 'unavailable']) {
    await syncHostRuntimeSettings(host, { force: true, readHardware: async () => ({ status }) });
    const unavailable = await HostProfile.findOne({ hostId: host.hostId }).lean();
    expect(unavailable.gpuDriverObservation.gpus).toEqual(beforeUnavailable.gpuDriverObservation.gpus);
    expect(unavailable.gpuDriverObservation.observedAt).toEqual(beforeUnavailable.gpuDriverObservation.observedAt);
    expect(unavailable.gpuDriverObservation.status).toBe(status);
    expect(buildRuntimeFingerprint(unavailable)).toBe(fingerprint);
    for (const observedAt of ['2026-11-07T12:00:01Z', '2026-11-08T15:00:00Z']) {
      expect(buildMeasuredRuntime({ hostProfile: unavailable, observedAt }).gpuDriver).toBeNull();
    }
  }

  // A real hardware change retains its existing invalidation semantics.
  await syncHostRuntimeSettings(host, { force: true, readHardware: async () => ({
    status: 'observed', source: 'agentx-data', sampledAt: '2026-11-07T12:01:00Z',
    gpus: [{ ...gpus[0], uuid: 'GPU-replacement', driver: '590.1' }, gpus[1]]
  }) });
  const changed = await HostProfile.findOne({ hostId: host.hostId }).lean();
  expect(buildRuntimeFingerprint(changed)).not.toBe(fingerprint);
  expect(buildMeasuredRuntime({ hostProfile: changed }).gpuDriver).toBeNull();
  expect(await ModelPerformanceProfile.findById(historical._id).lean()).toEqual(proofBefore);
});

test('after explicit activation native host synchronization tracks known driver drift and retains missing telemetry', async () => {
  const activated = { ...host, gpuDriverIdentityVersion: 'agentx.gpu-driver-identity/v1',
    gpus: gpus.map(gpu => ({ ...gpu, driver: '580.95.05' })) };
  await HostProfile.create(activated);
  const fingerprint = buildRuntimeFingerprint(await HostProfile.findOne({ hostId: host.hostId }).lean());
  const sync = rows => syncHostRuntimeSettings(host, { force: true, readHardware: async () => ({
    status: 'observed', source: 'agentx-data', sampledAt: new Date().toISOString(), staleAfterMs: 90000, gpus: rows }) });
  await sync(gpus);
  expect(buildRuntimeFingerprint(await HostProfile.findOne({ hostId: host.hostId }).lean())).toBe(fingerprint);
  await sync(gpus.map(gpu => ({ ...gpu, driver: '590.1' })));
  const changed = await HostProfile.findOne({ hostId: host.hostId }).lean();
  expect(changed.gpus.map(gpu => gpu.driver)).toEqual(['590.1', '590.1']);
  expect(buildRuntimeFingerprint(changed)).not.toBe(fingerprint);
});

test('a sync opened before activation cannot write its legacy inventory over the activated identity', async () => {
  await HostProfile.create({ ...host, gpus });
  const update = HostProfile.updateOne.bind(HostProfile);
  const write = jest.spyOn(HostProfile, 'updateOne').mockImplementationOnce(async (...args) => {
    await update({ hostId: host.hostId }, { $set: { gpuDriverIdentityVersion: 'agentx.gpu-driver-identity/v1',
      gpus: gpus.map(gpu => ({ ...gpu, driver: '580.95.05' })) } });
    return update(...args);
  });
  try {
    await syncHostRuntimeSettings(host, { force: true, readHardware: async () => ({
      status: 'observed', source: 'agentx-data', sampledAt: new Date().toISOString(), staleAfterMs: 90000,
      gpus: gpus.map(gpu => ({ ...gpu, driver: '590.1' })) }) });
    const current = await HostProfile.findOne({ hostId: host.hostId }).lean();
    expect(current.gpuDriverIdentityVersion).toBe('agentx.gpu-driver-identity/v1');
    expect(current.gpus.map(gpu => gpu.driver)).toEqual(['590.1', '590.1']);
    expect(write).toHaveBeenCalledTimes(2);
  } finally { write.mockRestore(); }
});
