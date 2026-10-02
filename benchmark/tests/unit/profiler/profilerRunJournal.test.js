'use strict';
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: () => [] }));
jest.mock('../../../src/helpers/ollamaTargetAdmission', () => ({ admitOllamaTargetResolved: async url => url }));
jest.mock('../../../src/clients/coreApiClient', () => ({
  getWorkloadRecoveryIdentity: () => ({ recoveryId: 'recovery-1', recoveryRequestId: 'request-1' }),
  adoptWorkloadRecovery: jest.fn(), heartbeatWorkloadRecovery: jest.fn(), assertWorkloadRecovery: jest.fn(),
  transitionWorkloadRecovery: jest.fn(), restoreWorkloadRecoveryHosts: jest.fn(),
  releaseWorkloadAdmission: jest.fn(), recoverWorkloadAdmissionRelease: jest.fn()
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/ollamaClient', () => ({ listModels: async () => ({ models: [{ name: 'fixture:1' }] }) }));
const HostProfile = require('../../../models/HostProfile');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
let mongo;
beforeAll(async () => {
  const uri = process.env.TEST_USE_EXTERNAL_MONGO === 'true' ? process.env.MONGODB_URI_TEST : (mongo = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
  await HostProfile.init();
}, 30000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
const { createRunJournal } = require('../../../src/services/profiler/profilerRunJournal');
const { observeJsonMutation, beginResponseMutation, completeResponseMutation } = require('../../../src/services/profiler/profilerMutationObservation');
const core = require('../../../src/clients/coreApiClient');
const recovery = require('../../../src/services/profiler/profilerProjectionRecovery');
const host = { hostId: 'fixture', hostUrl: 'http://fixture:11434', modelName: 'fixture:1' };
function lease() {
  return { operationId: 'profile-fixture', signal: new AbortController().signal,
    assertActive: jest.fn(), assertDispatchActive: jest.fn(async () => true), attachReconciliation: jest.fn(), abandon: jest.fn(async () => ({ abandoned: true })),
    authorityProof: () => ({ admissionId: 'admission-1', generation: 'generation-1', principal: 'benchmark-service' }) };
}
const read = () => HostProfile.findOne({ hostId: 'fixture' }).lean();
beforeEach(async () => { jest.clearAllMocks(); Object.values(core).filter(value => value?.mockReset).forEach(value => value.mockReset());
  await HostProfile.deleteMany({}); await HostProfile.create({ hostId: host.hostId, hostUrl: host.hostUrl }); });
test('the durable journal precedes dispatch and remains pending until exact restore and workload release', async () => {
  const owner = lease(); const journal = await createRunJournal(owner, host);
  expect((await read()).reconciliation).toMatchObject({ state: 'prepared', serverTerminalObserved: true, recoveryRequestId: 'request-1' });
  await journal.run(() => observeJsonMutation(async () => {
    expect((await read()).reconciliation).toMatchObject({ state: 'mutating', pendingRequests: 1, serverTerminalObserved: false });
    return { done: true };
  }));
  expect((await read()).reconciliation).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0, serverTerminalObserved: true });
  await journal.beforeWorkloadRelease({ failed: 0, details: [{ runtimeRestore: { verified: true } }] });
  expect((await read()).reconciliation.state).toBe('verified');
  await journal.afterWorkloadRelease({ released: true });
  expect((await read()).reconciliation).toMatchObject({ state: 'resolved', ownerId: null, releaseReceipt: { released: true } });
});
test('even a swallowed transport interruption blocks the next mutation and retains quarantine', async () => {
  const owner = lease(); const journal = await createRunJournal(owner, host); const laterEffect = jest.fn();
  await expect(journal.run(async () => {
    await observeJsonMutation(async () => { throw Object.assign(new Error('interrupted'), { code: 'ECONNRESET' }); }).catch(() => {});
    await observeJsonMutation(laterEffect);
  })).rejects.toMatchObject({ retainAdmission: true });
  expect(laterEffect).not.toHaveBeenCalled();
  expect(owner.abandon).toHaveBeenCalled();
  expect((await read()).reconciliation).toMatchObject({ state: 'unknown', serverTerminalObserved: false, pendingRequests: 1 });
});
test('stream response headers do not settle a mutation; only its decoded terminal receipt does', async () => {
  const journal = await createRunJournal(lease(), host);
  await journal.run(async () => {
    const response = await beginResponseMutation(async () => ({ ok: true }));
    expect((await read()).reconciliation.serverTerminalObserved).toBe(false);
    await completeResponseMutation(response);
    expect((await read()).reconciliation.serverTerminalObserved).toBe(true);
  });
});
test('process death after dispatch leaves an operator-required journal, never a TTL completion', async () => {
  const journal = await createRunJournal(lease(), host); await journal.beforeMutation();
  await HostProfile.updateOne({ hostId: host.hostId }, { $set: { 'reconciliation.ownerClaimedAt': new Date(0) } });
  const ownership = await recovery._claimProfileRecovery(await read(), 'restart-owner');
  expect(await recovery._reconcileOwnedProfile(ownership)).toMatchObject({ pending: true, operatorRequired: true });
  expect(core.restoreWorkloadRecoveryHosts).not.toHaveBeenCalled();
  expect(core.releaseWorkloadAdmission).not.toHaveBeenCalled();
});
test('a replacement owner fences all later effects from the previous writer', async () => {
  const journal = await createRunJournal(lease(), host);
  await HostProfile.updateOne({ hostId: host.hostId }, { $set: { 'reconciliation.ownerEpoch': 'replacement-epoch' } });
  const effect = jest.fn();
  await expect(journal.run(() => observeJsonMutation(effect))).rejects.toMatchObject({ code: 'PROFILER_RUN_JOURNAL_LOST' });
  expect(effect).not.toHaveBeenCalled();
});
test('preparing again cannot replace an unresolved journal even with the same admission proof', async () => {
  const owner = lease(); await createRunJournal(owner, host);
  const originalEpoch = (await read()).reconciliation.ownerEpoch;
  await expect(createRunJournal(owner, host)).rejects.toMatchObject({ code: 'HOST_PROFILE_AUTHORITY_CAS_FAILED' });
  expect((await read()).reconciliation.ownerEpoch).toBe(originalEpoch);
});
test('Core dispatch ownership rejection prevents the request even with an unchanged journal epoch', async () => {
  const owner = lease(); const journal = await createRunJournal(owner, host); const effect = jest.fn();
  owner.assertDispatchActive.mockRejectedValue(Object.assign(new Error('generation replaced'), { code: 'BENCHMARK_CLAIM_LOST', retainAdmission: true }));
  await expect(journal.run(() => observeJsonMutation(effect))).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_LOST' });
  expect(effect).not.toHaveBeenCalled(); expect(owner.abandon).toHaveBeenCalled();
});
test('a terminal host cannot restore the global workload while a peer host remains ambiguous', async () => {
  const journal = await createRunJournal(lease(), host);
  await journal.run(() => observeJsonMutation(async () => ({ done: true })));
  const peer = (await read()).reconciliation;
  await HostProfile.create({ hostId: 'peer', hostUrl: 'http://peer:11434',
    reconciliation: { ...peer, ownerId: null, serverTerminalObserved: false, state: 'unknown' } });
  await HostProfile.updateOne({ hostId: host.hostId }, { $set: { 'reconciliation.ownerClaimedAt': new Date(0) } });
  const ownership = await recovery._claimProfileRecovery(await read(), 'restart-owner');
  expect(await recovery._reconcileOwnedProfile(ownership)).toMatchObject({ pending: true, operatorRequired: true });
  expect(core.adoptWorkloadRecovery).not.toHaveBeenCalled(); expect(core.restoreWorkloadRecoveryHosts).not.toHaveBeenCalled();
});
test('a failed exact host restore remains recoverable on a later sweep and never releases early', async () => {
  const journal = await createRunJournal(lease(), host); await journal.run(() => observeJsonMutation(async () => ({ done: true })));
  await HostProfile.updateOne({ hostId: host.hostId }, { $set: { 'reconciliation.ownerClaimedAt': new Date(0) } });
  let currentOwner;
  core.adoptWorkloadRecovery.mockImplementation(async ({ ownerId }) => { currentOwner = ownerId; return { adopted: true }; });
  core.heartbeatWorkloadRecovery.mockResolvedValue({ heartbeat: true });
  core.assertWorkloadRecovery.mockImplementation(async () => ({ owned: true, recoveryOwnerId: currentOwner, recoveryState: 'UNKNOWN' }));
  core.restoreWorkloadRecoveryHosts.mockResolvedValueOnce({ restored: false, reason: 'co-resident missing' }).mockResolvedValue({ restored: true });
  core.recoverWorkloadAdmissionRelease.mockResolvedValue({ released: false });
  core.releaseWorkloadAdmission.mockResolvedValue({ released: true });
  core.transitionWorkloadRecovery.mockResolvedValue({ transitioned: true });
  const first = await recovery.recoverPendingHostProjections({ delayMs: 1 });
  expect(first.pending).toBe(1); expect(core.releaseWorkloadAdmission).not.toHaveBeenCalled();
  expect(await recovery.recoverPendingHostProjections({ delayMs: 1 })).toMatchObject({ inspected: 0 });
  await HostProfile.updateOne({ hostId: host.hostId }, { $set: { 'reconciliation.nextAttemptAt': new Date(0) } });
  const second = await recovery.recoverPendingHostProjections({ delayMs: 1 });
  expect(second.recovered).toBe(1);
  expect(core.transitionWorkloadRecovery.mock.calls.map(call => call[1])).toEqual(['VERIFIED', 'RESTORED']);
  expect((await read()).reconciliation.state).toBe('resolved');
});
test('process death after the durable workload release reconciles only the projection', async () => {
  const journal = await createRunJournal(lease(), host); await journal.beforeWorkloadRelease({ failed: 0 });
  await HostProfile.updateOne({ hostId: host.hostId }, { $set: { 'reconciliation.ownerClaimedAt': new Date(0) } });
  core.recoverWorkloadAdmissionRelease.mockResolvedValue({ released: true });
  const ownership = await recovery._claimProfileRecovery(await read(), 'restart-owner');
  expect(await recovery._reconcileOwnedProfile(ownership)).toMatchObject({ recovered: true, releaseRecovered: true });
  expect(core.restoreWorkloadRecoveryHosts).not.toHaveBeenCalled();
  expect(core.adoptWorkloadRecovery).not.toHaveBeenCalled();
});
test('multi-host drivers prepare every journal before the first runtime dispatch', async () => {
  await HostProfile.create({ hostId: 'peer', hostUrl: 'http://peer:11434' });
  const owner = lease();
  const profile = jest.fn(async (_model, hostId) => observeJsonMutation(async () => {
    const records = await HostProfile.find({}).lean();
    expect(records.every(record => record.reconciliation?.operation === 'profile_run')).toBe(true);
    expect(records.find(record => record.hostId === hostId).reconciliation.pendingRequests).toBe(1);
    return { profile: { benchmarkQualified: true } };
  }));
  const driver = require('../../../src/services/profiler/profilerPipelineDriver').createProfilerPipelineDriver({ profile, hostTestService: {} });
  const result = await driver.fullPipeline(host.modelName, [host, { hostId: 'peer', hostUrl: 'http://peer:11434' }], { journalLease: owner });
  expect(result.completed).toBe(true); expect(profile).toHaveBeenCalledTimes(2);
  expect(owner.attachReconciliation).toHaveBeenCalledTimes(2);
});
test('a 4xx rejection inside a run keeps the journal usable for the next request', async () => {
  const journal = await createRunJournal(lease(), host);
  const rejected = Object.assign(new Error('Ollama POST /api/chat returned 400: does not support thinking'), { status: 400 });
  const result = await journal.run(async () => {
    await expect(observeJsonMutation(async () => { throw rejected; })).rejects.toBe(rejected);
    return observeJsonMutation(async () => ({ done: true }));
  });
  expect(result).toEqual({ done: true });
  expect((await read()).reconciliation).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0, serverTerminalObserved: true });
});
