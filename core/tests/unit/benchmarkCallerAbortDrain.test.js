'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const HostPreference = require('../../models/HostPreference');
const coordination = require('../../src/services/runtimeCoordinationService');
const { deferClaimReleaseForInferences } = require('../../src/services/benchmarkCallerAbortDrain');
const { recoverSettledWatchdogProbes, DEFAULT_SETTLE_MS } = require('../../src/services/watchdogProbeRecovery');

const HOST = 'http://drain-host:11434';
const OTHER = 'http://other-host:11434';
const resident = [{ name: 'model-a', digest: 'digest-a', context_length: 8192,
  size_vram: 0, expires_at: '2318-01-01T00:00:00Z' }];
const later = () => Date.now() + DEFAULT_SETTLE_MS + 10_000;
let parent, pref, child;

async function setup({ origin = 'caller-abort', state = 'UNKNOWN', kind = 'benchmark' } = {}) {
  parent = await coordination.acquireWorkload({ principal: 'benchmark-service', requestId: 'batch-request',
    workloadId: 'batch-a', kind, hosts: [HOST, OTHER], ttl: 30 * 60_000 });
  pref = await HostPreference.create({ hostUrl: HOST, hostKey: 'drain-host', status: 'benchmarking', benchmarkClaim: {
    batchId: 'batch-a', claimGeneration: 'claim-a', admissionId: parent.admissionId,
    admissionGeneration: parent.generation, admissionPrincipal: parent.principal,
    claimedAt: new Date(), heartbeatAt: new Date(), finalizeToken: null
  } });
  child = await coordination.acquireInference({ principal: parent.principal, requestId: 'generation-a',
    host: HOST, model: 'model-a', kind: 'inference-direct', runtimeOptions: { num_ctx: 8192 },
    workloadAdmissionId: parent.admissionId, workloadGeneration: parent.generation });
  expect(child.acquired).toBe(true);
  if (state === 'UNKNOWN') await coordination.markInferenceUnknown({ id: child.admissionId,
    generation: child.generation, principal: child.principal, reason: 'client deadline', origin });
}

const defer = () => deferClaimReleaseForInferences(HOST, pref.toObject(), { requireAdmissionProof: true });
const recover = (extra = {}) => recoverSettledWatchdogProbes(HOST, {
  readPs: async () => resident, sleep: async () => {}, now: later, ...extra
});

beforeEach(async () => {
  await RuntimeCoordination.deleteMany({}); await HostPreference.deleteMany({});
  await RuntimeCoordination.create({ _id: 'runtime' });
});
afterEach(async () => {
  await RuntimeCoordination.deleteMany({}); await HostPreference.deleteMany({});
});

test('drains the exact batch before recovering its caller abort and fences new inference', async () => {
  await setup();
  await expect(recover()).resolves.toMatchObject({ recovered: false, reason: 'workload covers host' });
  await expect(defer()).resolves.toMatchObject({ released: false, callerAbortRecoveryPending: true,
    contract: 'agentx.benchmark-caller-abort-drain/v1', hostUrl: HOST, batchId: 'batch-a',
    claimGeneration: 'claim-a', admissionId: parent.admissionId, admissionGeneration: parent.generation });
  await expect(recover({ now: () => Date.now() + 61_000 })).resolves.toMatchObject({ recovered: false });
  await expect(recover()).resolves.toMatchObject({ recovered: true });
  const doc = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  expect(doc.inferences).toEqual([]);
  expect(doc.workloads).toHaveLength(1);
  expect(doc.workloads[0].drainingHosts).toEqual([HOST]);
  expect(doc.releaseReceipts.at(-1)).toMatchObject({ admissionId: child.admissionId,
    parentWorkload: { admissionId: parent.admissionId, generation: parent.generation } });
  await expect(coordination.acquireInference({ principal: parent.principal, requestId: 'late-generation',
    host: HOST, model: 'model-a', workloadAdmissionId: parent.admissionId, workloadGeneration: parent.generation }))
    .resolves.toMatchObject({ acquired: false });
  await expect(coordination.acquireInference({ principal: parent.principal, requestId: 'other-host-generation',
    host: OTHER, model: 'model-a', workloadAdmissionId: parent.admissionId, workloadGeneration: parent.generation }))
    .resolves.toMatchObject({ acquired: true });
  await expect(defer()).resolves.toBeNull();
});

test('a still-active admitted request is drained while Core records its caller abort', async () => {
  await setup({ state: 'ACTIVE' });
  await expect(defer()).resolves.toMatchObject({ callerAbortRecoveryPending: true });
  await expect(coordination.acquireInference({ principal: parent.principal, requestId: 'generation-a',
    host: HOST, model: 'model-a', kind: 'inference-direct', runtimeOptions: { num_ctx: 8192 },
    workloadAdmissionId: parent.admissionId, workloadGeneration: parent.generation }))
    .resolves.toMatchObject({ acquired: false, reason: 'workload is draining on this host' });
  await expect(recover()).resolves.toMatchObject({ recovered: false });
  await coordination.markInferenceUnknown({ id: child.admissionId, generation: child.generation,
    principal: child.principal, reason: 'client deadline', origin: 'caller-abort' });
  await expect(recover()).resolves.toMatchObject({ recovered: true });
});

test('release fences even an empty host before restoration and cannot be bypassed by yielding', async () => {
  await setup({ state: 'ACTIVE' });
  await coordination.releaseInference({ id: child.admissionId, generation: child.generation, principal: child.principal });
  await expect(defer()).resolves.toBeNull();
  expect((await RuntimeCoordination.findById('runtime').lean()).workloads[0].drainingHosts).toEqual([HOST]);
  await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.yieldedAt': new Date() } });
  await expect(coordination.acquireInference({ principal: 'core-service', requestId: 'ordinary-after-yield',
    host: HOST, model: 'model-a' })).resolves.toMatchObject({ acquired: false });
});

test.each(['benchmark', 'benchmark-cloud'])('a Core-owned deadline recovers the local host of %s', async kind => {
  await setup({ origin: 'deadline-abort', kind });
  await expect(defer()).resolves.toMatchObject({ callerAbortRecoveryPending: true });
  await expect(recover()).resolves.toMatchObject({ recovered: true, released: [expect.objectContaining({
    contract: 'agentx.inference-deadline-recovery/v1', unknownOrigin: 'deadline-abort'
  })] });
});

test('a changed child workload proof between samples prevents recovery', async () => {
  await setup(); await defer();
  await expect(recover({ sleep: async () => RuntimeCoordination.updateOne({ _id: 'runtime' }, {
    $set: { 'inferences.0.workloadGeneration': 'replacement-generation' }
  }) })).resolves.toMatchObject({ recovered: false, reason: 'coordination state changed' });
  expect((await RuntimeCoordination.findById('runtime').lean()).inferences).toHaveLength(1);
});

test.each([
  ['unknown transport outcome', { origin: null }],
  ['Profiler ownership', { kind: 'profiler' }]
])('never prepares automatic recovery for %s', async (_name, options) => {
  await setup(options);
  await expect(defer()).resolves.toBeNull();
  await expect(recover()).resolves.toMatchObject({ recovered: false });
  expect((await RuntimeCoordination.findById('runtime').lean()).inferences).toHaveLength(1);
});

test('stale claim admission generation and unproved release cannot arm the drain', async () => {
  await setup();
  pref.benchmarkClaim.admissionGeneration = 'stale';
  await expect(defer()).resolves.toBeNull();
  await expect(deferClaimReleaseForInferences(HOST, pref.toObject(), {})).resolves.toBeNull();
  expect((await RuntimeCoordination.findById('runtime').lean()).workloads[0].drainingHosts).toEqual([]);
});

test('a changed parent generation between runtime samples leaves the child quarantined', async () => {
  await setup(); await defer();
  await expect(recover({ sleep: async () => RuntimeCoordination.updateOne({ _id: 'runtime' }, {
    $set: { 'workloads.0.generation': 'replacement-generation' }
  }) })).resolves.toMatchObject({ recovered: false, reason: 'coordination state changed' });
  expect((await RuntimeCoordination.findById('runtime').lean()).inferences).toHaveLength(1);
});

test('a late foreign inference between samples prevents recovery', async () => {
  await setup(); await defer();
  await expect(recover({ sleep: async () => RuntimeCoordination.updateOne({ _id: 'runtime' }, {
    $push: { inferences: { ...child, admissionId: 'foreign', generation: 'foreign-generation',
      principal: 'operator', requestId: 'foreign', state: 'ACTIVE' } }
  }) })).resolves.toMatchObject({ recovered: false, reason: 'coordination state changed' });
  expect((await RuntimeCoordination.findById('runtime').lean()).inferences).toHaveLength(2);
});

test('a foreign workload or inference never grants a batch drain', async () => {
  await setup();
  await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'inferences.0.workloadGeneration': 'foreign' } });
  await expect(defer()).resolves.toBeNull();
  await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: {
    'inferences.0.workloadGeneration': parent.generation
  }, $push: { workloads: { admissionId: 'foreign-workload', generation: 'foreign', principal: 'operator',
    requestId: 'foreign', workloadId: 'foreign', kind: 'benchmark', hosts: [HOST],
    acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } } });
  await expect(defer()).resolves.toBeNull();
  await expect(recover()).resolves.toMatchObject({ recovered: false });
});
