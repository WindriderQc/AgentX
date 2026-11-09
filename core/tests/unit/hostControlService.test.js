'use strict';

const A = 'http://machine-a.test:11434';
const CPU = 'http://machine-a.test:11435';
const ALIAS = 'http://alias-a.test:11434';
const B = 'http://machine-b.test:11434';
const mockHosts = [{ id: 'a', url: A }, { id: 'a-cpu', url: CPU }, { id: 'alias', url: ALIAS }, { id: 'b', url: B }];
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  ...jest.requireActual('../../src/helpers/ollamaHostConfig'), getConfiguredHosts: () => mockHosts
}));
jest.mock('../../config/logger', () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const HostPreference = require('../../models/HostPreference');
const controls = require('../../src/services/hostControlService');
const runtime = require('../../src/services/runtimeCoordinationService');
const fence = require('../../src/services/hostControlFence');
const pause = (id = 'a', revision = 0, requestId = 'pause-a') => controls.changeHostControl(id,
  { action: 'pause', expectedRevision: revision, requestId });
const play = (revision = 1, requestId = 'play-a') => controls.changeHostControl('a',
  { action: 'play', expectedRevision: revision, requestId });
const inference = (host = A, requestId = 'turn', extra = {}) => runtime.acquireInference({
  host, requestId, principal: 'test', model: 'example-model', ...extra
});
const workload = (hosts = [A], requestId = 'batch') => runtime.acquireWorkload({
  hosts, requestId, workloadId: requestId, principal: 'test', kind: 'benchmark'
});
const releaseInference = item => runtime.releaseInference({ id: item.admissionId, generation: item.generation, principal: item.principal });

describe('host Pause/Play with real runtime coordination', () => {
  const saved = process.env.AGENTX_RUNTIME_RESOURCES_JSON;
  beforeEach(async () => {
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'device-a', endpoints: [A, ALIAS] }]);
    await Promise.all([RuntimeCoordination.deleteMany({}), HostPreference.deleteMany({})]);
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    else process.env.AGENTX_RUNTIME_RESOURCES_JSON = saved;
    await Promise.all([RuntimeCoordination.deleteMany({}), HostPreference.deleteMany({})]);
  });

  test('pauses CPU/GPU lanes and physical aliases; other hosts keep serving', async () => {
    expect(await pause()).toMatchObject({ state: 'paused', revision: 1, hosts: [ALIAS, A, CPU].sort() });
    for (const host of [A, CPU, ALIAS, 'http://machine-a.test:11499']) {
      expect(await inference(host, host)).toMatchObject({ acquired: false, failure: { cause: 'host_control_paused', retryable: false } });
      expect(await workload([host], host)).toMatchObject({ acquired: false });
    }
    expect(await workload([], 'global')).toMatchObject({ acquired: false });
    expect(await inference(B)).toMatchObject({ acquired: true });
    expect(await workload(['http://machine-c.test:11434'], 'other')).toMatchObject({ acquired: true });
    const rows = await controls.listHostControls(mockHosts);
    expect(rows.map(row => row.control.state)).toEqual(['paused', 'paused', 'paused', 'playing']);
  });

  test('drains active inference, refuses new arrivals, and does not cancel the owner', async () => {
    const active = await inference();
    expect(await pause()).toMatchObject({ state: 'draining', blockers: [{ type: 'inference' }] });
    expect(await inference(A, 'new')).toMatchObject({ acquired: false });
    expect((await runtime.listActive()).inferences).toHaveLength(1);
    expect(await releaseInference(active)).toMatchObject({ released: true });
    expect((await controls.listHostControls(mockHosts))[0].control.state).toBe('paused');
  });

  test('lets the existing workload finish proof-bound inference while draining', async () => {
    const parent = await workload();
    expect(await pause()).toMatchObject({ state: 'draining' });
    expect(await inference(A, 'parent-child', { workloadAdmissionId: parent.admissionId,
      workloadGeneration: parent.generation })).toMatchObject({ acquired: true });
    expect(await workload([A], 'new')).toMatchObject({ acquired: false });
  });

  test('UNKNOWN remains draining after expiry; Play does not clear its quarantine', async () => {
    const active = await inference();
    await runtime.markInferenceUnknown({ id: active.admissionId, generation: active.generation,
      principal: active.principal, reason: 'synthetic lost outcome' });
    expect(await pause()).toMatchObject({ state: 'draining', blockers: [{ recoveryRequired: true }] });
    await play();
    expect(await inference(A, 'after-play')).toMatchObject({ acquired: false, recoveryRequired: true });
  });

  test('persists without a timer or heartbeat and Play restores admission without rewriting pins', async () => {
    await HostPreference.create({ hostUrl: A, hostKey: 'a', pinnedModels: [{ model: 'saved-pin', contextSize: 8192 }] });
    await pause();
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'hostControls.0.acquiredAt': new Date(0) } });
    await runtime.reapExpired(new Date(Date.now() + 86400_000));
    expect((await runtime.listActive()).hostControls[0].active).toBe(true);
    expect(await play()).toMatchObject({ state: 'playing', revision: 2 });
    expect(await inference()).toMatchObject({ acquired: true });
    expect((await HostPreference.findOne({ hostUrl: A }).lean()).pinnedModels[0])
      .toMatchObject({ model: 'saved-pin', contextSize: 8192 });
  });

  test('replays the same intent and rejects stale Play/Pause and reused identities', async () => {
    const first = await pause();
    expect(await pause()).toMatchObject({ pauseId: first.pauseId, revision: 1 });
    await play();
    await pause('a', 2, 'pause-again');
    await expect(play()).rejects.toMatchObject({ statusCode: 409 });
    await expect(pause()).rejects.toMatchObject({ statusCode: 409 });
    await expect(pause('b', 0, 'pause-again')).rejects.toMatchObject({ statusCode: 409 });
    expect((await controls.listHostControls(mockHosts))[0].control.state).toBe('paused');
  });

  test('pause races inference safely and concurrent Pause/Play has one winner', async () => {
    const [paused, turn] = await Promise.all([pause(), inference()]);
    expect(paused.state).toMatch(/paused|draining/);
    const row = (await controls.listHostControls(mockHosts))[0];
    expect(row.control.state).toBe(turn.acquired ? 'draining' : 'paused');
    const results = await Promise.allSettled([play(1, 'play-1'), play(1, 'play-2')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  });

  test('blocks host mutations and permits a Core restart while the fence persists', async () => {
    await pause();
    const lease = (scope, hosts = [A], requestId = scope) => runtime.acquireMaintenance({ principal: 'test', scope, hosts, requestId });
    expect(await lease('host')).toMatchObject({ acquired: false });
    expect(await lease('global-operation')).toMatchObject({ acquired: false });
    const restart = await lease('core-recreate');
    expect(restart).toMatchObject({ acquired: true });
    expect((await runtime.listActive()).hostControls[0].active).toBe(true);
  });

  test('a resource mapping change cannot bypass a paused alias', async () => {
    await pause();
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = '[]';
    expect(await inference(ALIAS)).toMatchObject({ acquired: false,
      failure: { cause: 'runtime_resource_configuration_changed' } });
  });

  test.each(['[]', 'invalid-config'])('Play releases only its stored fence after mapping drift: %s', async mapping => {
    await pause();
    const active = await inference(B, 'other-machine');
    const before = await RuntimeCoordination.findById('runtime').lean();
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = mapping;
    expect(await play()).toMatchObject({ state: 'playing', revision: 2 });
    expect(await play()).toMatchObject({ state: 'playing', revision: 2 });
    const after = await RuntimeCoordination.findById('runtime').lean();
    expect(after.resourceTopologyHash).toBe(before.resourceTopologyHash);
    expect(after.inferences[0].admissionId).toBe(active.admissionId);
    expect(after.inferences).toHaveLength(1);
  });

  test('an active fence takes precedence over historical overlapping control records', () => {
    const history = { active: false, hostnames: ['machine-a.test'], resourceIds: [] };
    const active = { active: true, hostnames: ['machine-a.test'], resourceIds: [] };
    expect(fence.matchingControl([history, active], [A])).toBe(active);
  });

  test('multiple machines pause independently and a host lease on another machine still works', async () => {
    await pause();
    await pause('b', 0, 'pause-b');
    await controls.changeHostControl('b', { action: 'play', requestId: 'play-b', expectedRevision: 1 });
    expect((await controls.listHostControls(mockHosts)).map(row => row.control.state))
      .toEqual(['paused', 'paused', 'paused', 'playing']);
    expect(await runtime.acquireMaintenance({ principal: 'test', requestId: 'maintain-b', scope: 'host', hosts: [B] }))
      .toMatchObject({ acquired: true });
  });

  test('supports an existing singleton from before host controls were installed', async () => {
    await RuntimeCoordination.collection.insertOne({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
    expect(await pause()).toMatchObject({ state: 'paused', revision: 1 });
  });

  test('session and benchmark owners remain visible until they release the machine', async () => {
    await HostPreference.create({ hostUrl: CPU, hostKey: 'a-cpu', status: 'benchmarking',
      benchmarkClaim: { batchId: 'held-batch' },
      sessionHold: { holdId: 'held-session', model: 'held-model', expiresAt: new Date(Date.now() + 60_000) } });
    const result = await pause();
    expect(result.state).toBe('draining');
    expect(result.blockers.map(item => item.type)).toEqual(['session', 'benchmark']);
    await HostPreference.updateOne({ hostUrl: CPU }, { $set: { status: 'ready', benchmarkClaim: null, sessionHold: null } });
    expect((await controls.listHostControls(mockHosts))[0].control.state).toBe('paused');
  });

  test('reconciler and watchdog leave a paused host alone', async () => {
    await HostPreference.create({ hostUrl: A, hostKey: 'a', pinnedModels: [{ model: 'saved-pin' }] });
    await pause();
    const originalFetch = global.fetch;
    global.fetch = jest.fn();
    try {
      await require('../../src/services/pinReconciler').checkAndReloadDefaults();
      expect(global.fetch).not.toHaveBeenCalled();
      const state = await runtime.listActive();
      const observe = jest.fn(), failures = new Map([[A, 3]]);
      expect(fence.observePausedHost({ url: A }, state, observe, failures)).toBe(true);
      expect(observe).toHaveBeenCalledWith({ url: A }, { reason: 'host_control_paused' }, false);
      expect(failures.get(A)).toBe(0);
    } finally { global.fetch = originalFetch; }
  });
});
