'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: () => [{ id: 'fixture', url: 'http://127.0.0.1:11434' }],
  getHostResidency: () => 'gpu', normalizeHostUrl: url => String(url).replace(/\/+$/, '')
}));
jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({
  resolveArtifactIdentity: jest.fn(), resolveRuntimeArtifactReceipt: jest.fn(), digestsMatch: (a, b) => a === b
}));
jest.mock('../../../src/services/modelContextProfileService', () => ({ findContextProfile: jest.fn() }));
jest.mock('../../../src/services/profiler/contextProposalService', () => ({ loadHostPreference: jest.fn() }));
jest.mock('../../../src/clients/coreHeavyQueue', () => ({
  submitHeavyWork: jest.fn(), getHeavyWork: jest.fn(), cancelHeavyWork: jest.fn()
}));
jest.mock('../../../src/clients/coreHttp', () => ({ coreRequest: jest.fn() }));
jest.mock('../../../src/clients/coreWorkloadRecoveries', () => ({ recoverWorkloadAdmissionRelease: jest.fn() }));
jest.mock('../../../src/services/profiler/profilerClaimLifecycle', () => ({ acquireProfilerClaimLease: jest.fn() }));
jest.mock('../../../src/services/profiler/profilerRunJournal', () => ({ runJournaledProfile: jest.fn() }));
jest.mock('../../../src/clients/ollamaClient', () => ({ generate: jest.fn() }));
jest.mock('../../../src/services/probeResidency', () => ({ snapshotGpuOffload: jest.fn() }));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const Fit = require('../../../models/PinnedContextFitCheck');
const Host = require('../../../models/HostProfile');
const identities = require('../../../src/services/profiler/artifactIdentityService');
const contexts = require('../../../src/services/modelContextProfileService');
const prefs = require('../../../src/services/profiler/contextProposalService');
const queue = require('../../../src/clients/coreHeavyQueue');
const http = require('../../../src/clients/coreHttp');
const claims = require('../../../src/services/profiler/profilerClaimLifecycle');
const journals = require('../../../src/services/profiler/profilerRunJournal');
const ollama = require('../../../src/clients/ollamaClient');
const residency = require('../../../src/services/probeResidency');
const fit = require('../../../src/services/profiler/pinnedContextFitService');
const { assertTarget } = require('../../../src/services/profiler/pinnedContextFitObservation');
const HOST = 'http://127.0.0.1:11434';
const MODEL = 'fixture:latest';
const ARTIFACT = { model: MODEL, hostId: 'fixture', hostUrl: HOST, digest: `sha256:${'a'.repeat(64)}`,
  runtimeFingerprint: 'physical-fixture', runtime: { ollamaVersion: '0.2', gpuDriver: null } };
const PINS = [{ model: MODEL, contextSize: 8192, keepAlive: -1, autoRestore: true }];
const NATIVE = { digest: ARTIFACT.digest, runtimeVersion: '0.2', contextLength: 8192,
  fullVram: true, observedAt: '2026-11-07T20:00:00Z' };
const SNAPSHOT = { sizeTotal: 100, sizeVram: 100, contextLength: 8192, coResidents: [] };
let mongo, lease, job;
beforeAll(async () => {
  const uri = process.env.TEST_USE_EXTERNAL_MONGO === 'true' ? process.env.MONGODB_URI_TEST
    : (mongo = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri); await Fit.init(); await Host.init();
}, 30000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  jest.resetAllMocks(); await Fit.deleteMany({}); await Host.deleteMany({});
  job = { id: crypto.randomUUID(), kind: 'profiler', state: 'dispatching', dispatchId: crypto.randomUUID(),
    hosts: [HOST], reservation: { autoStart: false } };
  lease = { signal: new AbortController().signal, assertActive: jest.fn(), identityFor: () => ({ claimGeneration: 'fixture' }),
    finalize: jest.fn(async () => ({ failed: 0 })), abandon: jest.fn(async () => ({})) };
  prefs.loadHostPreference.mockResolvedValue({ pinnedModels: structuredClone(PINS) });
  identities.resolveArtifactIdentity.mockResolvedValue(structuredClone(ARTIFACT));
  identities.resolveRuntimeArtifactReceipt.mockResolvedValue(structuredClone(NATIVE));
  contexts.findContextProfile.mockResolvedValue({ _id: 'profile-before-upgrade', measuredRuntime: { ollamaVersion: '0.1' } });
  queue.submitHeavyWork.mockImplementation(async request => { job.executor = request.executor; return job; });
  queue.getHeavyWork.mockImplementation(async () => job);
  queue.cancelHeavyWork.mockImplementation(async () => { job.state = 'cancelled'; delete job.dispatchId; return job; });
  http.coreRequest.mockImplementation(async () => ({ data: { admitted: true, id: job.id, dispatchId: job.dispatchId } }));
  claims.acquireProfilerClaimLease.mockResolvedValue(lease);
  journals.runJournaledProfile.mockImplementation(async (_, __, run) => run());
  ollama.generate.mockResolvedValue({ done: true });
  residency.snapshotGpuOffload.mockResolvedValue(structuredClone(SNAPSHOT));
});
async function prepare() {
  const requestId = crypto.randomUUID();
  const receipt = await fit.request({ requestId, hostId: 'fixture', pinIndex: 0 });
  return { receipt, input: { fitCheckId: requestId, hostId: 'fixture', queueRequestId: job.id, queueDispatchId: job.dispatchId } };
}
async function settled(id) {
  for (let i = 0; i < 300; i++) {
    const row = await Fit.findById(id).lean();
    if (row.state !== 'dispatching') return row;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic fit did not settle');
}

test('request/retry/read are model-free and use the same manual queue intent', async () => {
  const { receipt } = await prepare();
  expect(await fit.request({ requestId: receipt.id, hostId: 'fixture' })).toMatchObject({ id: receipt.id, state: 'requested' });
  await fit.get(receipt.id);
  expect(queue.submitHeavyWork).toHaveBeenCalledTimes(1);
  expect(queue.submitHeavyWork.mock.calls[0][0]).toMatchObject({ executor: { mode: 'pinned-fit', fitCheckId: receipt.id }, estimatedMinutes: 5 });
  expect(ollama.generate).not.toHaveBeenCalled(); expect(claims.acquireProfilerClaimLease).not.toHaveBeenCalled();
});
test('lost queue ACK retries the identical frozen queue submission', async () => {
  queue.submitHeavyWork.mockRejectedValueOnce(new Error('lost ACK'));
  const requestId = crypto.randomUUID();
  await expect(fit.request({ requestId, hostId: 'fixture' })).rejects.toThrow('lost ACK');
  await fit.request({ requestId, hostId: 'fixture' });
  expect(queue.submitHeavyWork.mock.calls[0][0]).toEqual(queue.submitHeavyWork.mock.calls[1][0]);
  expect(ollama.generate).not.toHaveBeenCalled();
});
test('concurrent manual starts run once and persist the observation before native release', async () => {
  const { receipt, input } = await prepare();
  lease.finalize.mockImplementation(async () => {
    expect((await Fit.findById(receipt.id).lean()).result.status).toBe('pass');
    return { failed: 0 };
  });
  await Promise.all([fit.start(input), fit.start(input)]);
  const row = await settled(receipt.id);
  expect(row).toMatchObject({ state: 'completed', runtimeReleased: true, blocksReplacement: false, result: { status: 'pass' } });
  expect(journals.runJournaledProfile).toHaveBeenCalledTimes(1);
  expect(ollama.generate).toHaveBeenCalledTimes(1);
  expect(ollama.generate.mock.calls[0][1]).toMatchObject({ options: { num_ctx: 8192 }, keep_alive: -1 });
  await fit.start(input); expect(ollama.generate).toHaveBeenCalledTimes(1);
  expect(contexts.findContextProfile).toHaveBeenCalledTimes(1); // Historical evidence is read only.
});
test('same id cannot name another host/pin or dispatch', async () => {
  const { receipt, input } = await prepare();
  await expect(fit.request({ requestId: receipt.id, hostId: 'other' })).rejects.toThrow('another intent');
  await Fit.updateOne({ _id: receipt.id }, { $set: { state: 'dispatching', queueDispatchId: input.queueDispatchId } });
  await expect(fit.start({ ...input, queueDispatchId: crypto.randomUUID() })).rejects.toThrow('another dispatch');
});
test('a restarted writer returns the original unknown receipt and blocks a replacement id', async () => {
  const { receipt, input } = await prepare();
  await Fit.updateOne({ _id: receipt.id }, { $set: { state: 'dispatching', queueDispatchId: input.queueDispatchId } });
  expect(await fit.start(input)).toMatchObject({ id: receipt.id, state: 'unknown', status: 'unknown', runtimeReleased: false });
  await expect(fit.request({ requestId: crypto.randomUUID(), hostId: 'fixture' })).rejects.toMatchObject({ code: 'PINNED_FIT_UNRESOLVED' });
  expect(ollama.generate).not.toHaveBeenCalled(); expect(lease.finalize).not.toHaveBeenCalled();
});
test.each([
  ['pin', () => prefs.loadHostPreference.mockResolvedValue({ pinnedModels: [{ ...PINS[0], contextSize: 4096 }] })],
  ['version', () => identities.resolveArtifactIdentity.mockResolvedValue({ ...ARTIFACT, runtime: { ollamaVersion: '0.3' } })],
  ['artifact', () => identities.resolveArtifactIdentity.mockResolvedValue({ ...ARTIFACT, digest: `sha256:${'b'.repeat(64)}` })]
])('a changed %s before dispatch refuses without a model load or pin write', async (_, change) => {
  const { receipt, input } = await prepare(); change();
  await fit.start(input);
  expect(await settled(receipt.id)).toMatchObject({ state: 'failed', runtimeReleased: true, numCtx: 8192 });
  expect(ollama.generate).not.toHaveBeenCalled(); expect(claims.acquireProfilerClaimLease).not.toHaveBeenCalled();
});
test('a native admission refusal records failure and performs no inference', async () => {
  const { receipt, input } = await prepare();
  claims.acquireProfilerClaimLease.mockRejectedValue(Object.assign(new Error('busy'), {
    code: 'PROFILER_CLAIM_UNAVAILABLE', cause: { code: 'WORKLOAD_ADMISSION_REJECTED', statusCode: 409 }
  }));
  await fit.start(input); expect(await settled(receipt.id)).toMatchObject({ state: 'failed', runtimeReleased: true });
  expect(ollama.generate).not.toHaveBeenCalled();
});
test('an ambiguous admission ACK is unknown and cannot be substituted', async () => {
  const { receipt, input } = await prepare();
  claims.acquireProfilerClaimLease.mockRejectedValue(Object.assign(new Error('lost'), { code: 'PROFILER_CLAIM_UNAVAILABLE' }));
  await fit.start(input); expect(await settled(receipt.id)).toMatchObject({ state: 'unknown', blocksReplacement: true, runtimeReleased: false });
});
test.each([
  ['spill', { ...SNAPSHOT, sizeVram: 99 }, 'fail'],
  ['CPU', { ...SNAPSHOT, sizeVram: 0 }, 'fail'],
  ['unavailable', { ...SNAPSHOT, sizeVram: null }, 'unknown'],
  ['absent', { ...SNAPSHOT, sizeTotal: null, sizeVram: null }, 'unknown']
])('%s is explicit and never reduces the pin', async (_, snapshot, status) => {
  const { receipt, input } = await prepare(); residency.snapshotGpuOffload.mockResolvedValue(snapshot);
  await fit.start(input); const row = await settled(receipt.id);
  expect(row).toMatchObject({ state: 'failed', numCtx: 8192, pins: PINS, result: { status }, runtimeReleased: true });
  expect(await fit.get(receipt.id)).toMatchObject({ revalidationRequired: true });
});
test('a different effective context fails even with all bytes on GPU', async () => {
  const { receipt, input } = await prepare();
  identities.resolveRuntimeArtifactReceipt.mockResolvedValue({ ...NATIVE, contextLength: 4096 });
  await fit.start(input); expect(await settled(receipt.id)).toMatchObject({ state: 'failed', numCtx: 8192 });
});
test('version/pin drift after load invalidates the fit while native restore still runs', async () => {
  const { receipt, input } = await prepare();
  ollama.generate.mockImplementation(async () => {
    prefs.loadHostPreference.mockResolvedValue({ pinnedModels: [{ ...PINS[0], contextSize: 4096 }] }); return { done: true };
  });
  await fit.start(input); expect(await settled(receipt.id)).toMatchObject({ state: 'failed', numCtx: 8192 });
  expect(lease.finalize).toHaveBeenCalledTimes(1);
});
test('an incomplete native response retains the original journal/quarantine', async () => {
  const { receipt, input } = await prepare();
  journals.runJournaledProfile.mockRejectedValue(Object.assign(new Error('partial'), { retainAdmission: true, code: 'OLLAMA_RESPONSE_INCOMPLETE' }));
  await fit.start(input); expect(await settled(receipt.id)).toMatchObject({ state: 'unknown', runtimeReleased: false });
  expect(lease.abandon).toHaveBeenCalledTimes(1); expect(lease.finalize).not.toHaveBeenCalled();
});
test('a passed observation is never a completed fit without native release', async () => {
  const { receipt, input } = await prepare(); lease.finalize.mockRejectedValue(new Error('restore unknown'));
  await fit.start(input); expect(await settled(receipt.id)).toMatchObject({ state: 'unknown', result: { status: 'pass' }, runtimeReleased: false });
  expect(await fit.get(receipt.id)).toMatchObject({ status: 'unknown', revalidationRequired: true });
  expect(await fit.start(input)).toMatchObject({ id: receipt.id, state: 'unknown' });
  expect(ollama.generate).toHaveBeenCalledTimes(1);
});
test('native recovery reconciles the original receipt only after exact release, without inference', async () => {
  const { receipt, input } = await prepare();
  await Fit.updateOne({ _id: receipt.id }, { $set: { state: 'unknown', queueDispatchId: input.queueDispatchId } });
  await expect(fit.reconcile(receipt.id)).rejects.toThrow('native restoration');
  const row = await Fit.findById(receipt.id).lean();
  await Host.create({ hostId: 'fixture', hostUrl: HOST, reconciliation: {
    state: 'resolved', operationId: row.operationId, releaseReceipt: { released: true }
  } });
  expect(await fit.reconcile(receipt.id)).toMatchObject({ id: receipt.id, state: 'failed', runtimeReleased: true, status: 'unknown' });
  expect(ollama.generate).not.toHaveBeenCalled(); expect(lease.finalize).not.toHaveBeenCalled();
});
test('unstarted cancellation uses Core and permits a new explicit intent', async () => {
  const { receipt } = await prepare(); job.state = 'reserved'; delete job.dispatchId;
  expect(await fit.cancel(receipt.id)).toMatchObject({ state: 'cancelled', runtimeReleased: true });
  job.id = crypto.randomUUID();
  await expect(fit.request({ requestId: crypto.randomUUID(), hostId: 'fixture' })).resolves.toMatchObject({ state: 'requested' });
});
test('an uncertain original operation cannot be cancelled or released by this surface', async () => {
  const { receipt } = await prepare(); await Fit.updateOne({ _id: receipt.id }, { $set: { state: 'unknown' } });
  await expect(fit.cancel(receipt.id)).rejects.toThrow('native recovery');
  expect(queue.cancelHeavyWork).not.toHaveBeenCalled(); expect(lease.finalize).not.toHaveBeenCalled();
});
test('read projections keep history and drift outside the exact measured pin', async () => {
  const { receipt, input } = await prepare(); await fit.start(input); await settled(receipt.id);
  const before = await Fit.findById(receipt.id).lean();
  const current = await fit.latest({ model: MODEL, hostId: 'fixture', artifact: ARTIFACT, pinContext: 8192 });
  const other = await fit.latest({ model: MODEL, hostId: 'fixture', artifact: ARTIFACT, pinContext: 16384 });
  expect(current).toMatchObject({ status: 'pass', matchesCurrent: true, qualificationAuthority: 'none' });
  expect(other.matchesCurrent).toBe(false);
  expect(await Fit.findById(receipt.id).lean()).toEqual(before);
  expect(JSON.stringify(current)).not.toMatch(/admissionId|generation|ownerEpoch/);
});
test('missing versions and unknown pins never create an invented fit', async () => {
  identities.resolveArtifactIdentity.mockResolvedValue({ ...ARTIFACT, runtime: { ollamaVersion: null } });
  await expect(fit.request({ requestId: crypto.randomUUID(), hostId: 'fixture' })).rejects.toThrow('recorded Ollama version drift');
  expect(await Fit.countDocuments()).toBe(0);
  const row = { pins: PINS, model: MODEL, hostUrl: HOST, hostId: 'fixture', artifact: ARTIFACT };
  prefs.loadHostPreference.mockResolvedValue(undefined);
  await expect(assertTarget(row)).rejects.toMatchObject({ code: 'PINNED_FIT_PINS_UNKNOWN' });
});

test.each([
  ['full', { model: 'fixture-embed:latest', size: 20, sizeVram: 20, contextLength: 4096 }, 'pass'],
  ['spill', { model: 'fixture-embed:latest', size: 20, sizeVram: 19, contextLength: 4096 }, 'fail'],
  ['unknown', null, 'unknown'],
  ['wrong context', { model: 'fixture-embed:latest', size: 20, sizeVram: 20, contextLength: 2048 }, 'unknown']
])('co-resident %s is included in the bounded fit result', async (_, resident, expected) => {
  prefs.loadHostPreference.mockResolvedValue({ pinnedModels: [...PINS,
    { model: 'fixture-embed:latest', contextSize: 4096, keepAlive: -1, autoRestore: true }] });
  const { receipt, input } = await prepare();
  residency.snapshotGpuOffload.mockResolvedValue({ ...SNAPSHOT, coResidents: resident ? [resident] : [] });
  await fit.start(input); expect((await settled(receipt.id)).result.status).toBe(expected);
  expect(ollama.generate).toHaveBeenCalledTimes(1); // Never loads another resident to manufacture evidence.
});
test.each(['version', 'artifact'])('%s changing during the load invalidates the fit', async kind => {
  const { receipt, input } = await prepare();
  ollama.generate.mockImplementation(async () => {
    identities.resolveArtifactIdentity.mockResolvedValue(kind === 'version'
      ? { ...ARTIFACT, runtime: { ollamaVersion: '0.3' } } : { ...ARTIFACT, digest: `sha256:${'c'.repeat(64)}` });
    return { done: true };
  });
  await fit.start(input); expect(await settled(receipt.id)).toMatchObject({ state: 'failed', numCtx: 8192 });
});
test('cancel of an in-progress load uses the native checkpoint and restoration', async () => {
  const { receipt, input } = await prepare(); let finishLoad;
  ollama.generate.mockImplementation(() => new Promise(resolve => { finishLoad = resolve; }));
  await fit.start(input);
  for (let i = 0; !finishLoad && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(finishLoad).toBeDefined();
  await fit.cancel(receipt.id); finishLoad({ done: true });
  expect(await settled(receipt.id)).toMatchObject({ state: 'cancelled', runtimeReleased: true });
  expect(lease.finalize).toHaveBeenCalledTimes(1);
});
test('a missing Core execution-window acknowledgement launches no native work', async () => {
  const { input } = await prepare(); http.coreRequest.mockResolvedValue({ data: {} });
  await expect(fit.start(input)).rejects.toMatchObject({ code: 'PINNED_FIT_WINDOW_UNKNOWN' });
  expect(claims.acquireProfilerClaimLease).not.toHaveBeenCalled(); expect(ollama.generate).not.toHaveBeenCalled();
});
test('admission-ACK loss can only reconcile from Core read-back of its exact original release', async () => {
  const { receipt } = await prepare();
  await Fit.updateOne({ _id: receipt.id }, { $set: { state: 'unknown' } });
  const native = require('../../../src/clients/coreWorkloadRecoveries');
  const identity = { admissionId: 'original', generation: 'generation', principal: 'benchmark', recoveryId: 'recovery' };
  native.recoverWorkloadAdmissionRelease.mockResolvedValue({ released: false });
  await expect(fit.reconcile(receipt.id, identity)).rejects.toThrow('native restoration');
  const row = await Fit.findById(receipt.id).lean();
  native.recoverWorkloadAdmissionRelease.mockResolvedValue({ released: true, workloadId: row.operationId });
  expect(await fit.reconcile(receipt.id, identity)).toMatchObject({ state: 'failed', runtimeReleased: true, status: 'unknown' });
  expect(native.recoverWorkloadAdmissionRelease).toHaveBeenCalledWith({ ...identity, workloadId: row.operationId });
  expect(lease.finalize).not.toHaveBeenCalled(); expect(ollama.generate).not.toHaveBeenCalled();
});
test('a lost journal ACK preserves an already recorded observation without promoting it to a pass', async () => {
  const { receipt, input } = await prepare();
  journals.runJournaledProfile.mockImplementation(async (_, __, run) => {
    await run(); throw Object.assign(new Error('lost journal ACK'), { retainAdmission: true });
  });
  await fit.start(input);
  expect(await settled(receipt.id)).toMatchObject({ state: 'unknown', result: { status: 'pass' }, runtimeReleased: false });
  expect(await fit.get(receipt.id)).toMatchObject({ status: 'unknown' });
  expect(lease.finalize).not.toHaveBeenCalled(); expect(lease.abandon).toHaveBeenCalledTimes(1);
});
