'use strict';

// #47: a Core recreate is granted while only Benchmark-owned profiler
// workloads run, and every refusal names its blockers and their cancel route.
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');

const HOST_A = 'http://host-a:11434';

async function workload(workloadId, kind, extra = {}) {
  const admission = await service.acquireWorkload({ principal: 'benchmark-service', requestId: `req-${workloadId}`,
    workloadId, kind, batchId: extra.batchId || null, hosts: extra.hosts || [HOST_A], ttl: extra.ttl || 30 * 60_000 });
  expect(admission).toMatchObject({ acquired: true });
  return admission;
}

function lease(scope, requestId = `deploy-${scope}`) {
  return service.acquireMaintenance({ principal: 'operator', requestId, scope, ttl: 900_000 });
}

describe('runtime deploy gate', () => {
  beforeEach(async () => {
    await RuntimeCoordination.deleteMany({});
    await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
  });

  afterEach(async () => {
    await RuntimeCoordination.deleteMany({});
  });

  test('a Core recreate is granted while a profile runs on a host; a full deploy is refused with the profile named', async () => {
    const profile = await workload('profile-abc123', 'profiler');
    const refused = await lease('runtime-deploy');
    expect(refused).toMatchObject({ acquired: false });
    expect(refused.blockers).toEqual([expect.objectContaining({
      type: 'workload', kind: 'profiler', id: 'profile-abc123', hosts: [HOST_A], owner: 'benchmark-service',
      startedAt: expect.any(String),
      cancel: 'Profiler panel, or Benchmark POST /api/profiler/pipeline/profile/abc123/cancel'
    })]);
    expect(refused.blockers[0].summary).toContain('profile-abc123');
    expect(JSON.stringify(refused)).not.toContain(profile.generation);

    const granted = await lease('core-recreate');
    expect(granted).toMatchObject({ acquired: true, scope: 'core-recreate' });
    // The lease keeps new work out but the running profile keeps its admission.
    await expect(service.acquireWorkload({ principal: 'benchmark-service', requestId: 'later',
      workloadId: 'profile-later', kind: 'profiler', hosts: ['http://host-b:11434'] }))
      .resolves.toMatchObject({ acquired: false });
    await expect(service.heartbeat('workload', { id: profile.admissionId, generation: profile.generation,
      principal: 'benchmark-service', ttl: 30 * 60_000 })).resolves.toMatchObject({ heartbeat: true });
  });

  test('a profile survives a simulated Core restart: no UNKNOWN while Benchmark renews it afterwards', async () => {
    const profile = await workload('profile-restart', 'profiler', { ttl: 5 * 60_000 });
    await expect(lease('core-recreate')).resolves.toMatchObject({ acquired: true });
    // Core is down for 45 s: nothing heartbeats. Core restarts and reaps.
    const restartedAt = new Date(Date.now() + 45_000);
    await service.reapExpired(restartedAt);
    const state = await RuntimeCoordination.findById('runtime').lean();
    expect(state.workloads[0]).toMatchObject({ workloadId: 'profile-restart', recoveryState: 'PREPARED' });
    await expect(service.heartbeat('workload', { id: profile.admissionId, generation: profile.generation,
      principal: 'benchmark-service', ttl: 5 * 60_000 })).resolves.toMatchObject({ heartbeat: true });
  });

  test('under a Core-recreate lease the profile keeps its own inference; other inference waits', async () => {
    const profile = await workload('profile-prime', 'profiler');
    await expect(lease('core-recreate')).resolves.toMatchObject({ acquired: true });
    await expect(service.acquireInference({ principal: 'core-chat', requestId: 'chat-during',
      host: 'http://host-b:11434', model: 'qwen3:8b' })).resolves.toMatchObject({ acquired: false,
      failure: { cause: 'maintenance_active' } });
    await expect(service.acquireInference({ principal: 'benchmark-service', requestId: 'loaded-prime',
      host: HOST_A, model: 'qwen3:8b', workloadAdmissionId: profile.admissionId,
      workloadGeneration: profile.generation })).resolves.toMatchObject({ acquired: true });
  });

  test('any other maintenance lease still refuses a workload its own inference', async () => {
    const profile = await workload('profile-pin', 'profiler');
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { maintenance: {
      leaseId: 'pin-lease', generation: 'g', principal: 'operator', requestId: 'pin', scope: 'pin-apply',
      acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000), state: 'ACTIVE' } } });
    await expect(service.acquireInference({ principal: 'benchmark-service', requestId: 'prime-under-pin',
      host: HOST_A, model: 'qwen3:8b', workloadAdmissionId: profile.admissionId,
      workloadGeneration: profile.generation })).resolves.toMatchObject({ acquired: false });
  });

  test.each([
    ['benchmark', 'batch-1', { batchId: 'batch-1' }, 'Benchmark POST /api/benchmark/batch/batch-1/stop'],
    ['judge', 'judge:xyz', {}, expect.stringContaining('no cancel route')]
  ])('a %s workload refuses a Core recreate with its cancel route', async (kind, id, extra, cancel) => {
    await workload(id, kind, extra);
    const refused = await lease('core-recreate');
    expect(refused).toMatchObject({ acquired: false });
    expect(refused.blockers).toEqual([expect.objectContaining({ type: 'workload', kind, id, cancel,
      reason: expect.stringContaining('goes through Core inference') })]);
  });

  test('a profiler workload in recovery or about to expire still blocks a Core recreate', async () => {
    await workload('profiler-queue-q1', 'profiler', { ttl: 60_000 });
    let refused = await lease('core-recreate', 'deploy-short');
    expect(refused.blockers[0]).toMatchObject({ reason: expect.stringContaining('expires'),
      cancel: 'Benchmark POST /api/profiler/pipeline/profile-host/q1/cancel' });

    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: {
      'workloads.0.expiresAt': new Date(Date.now() + 30 * 60_000), 'workloads.0.recoveryState': 'UNKNOWN' } });
    refused = await lease('core-recreate', 'deploy-unknown');
    expect(refused.blockers[0]).toMatchObject({ reason: 'it is in recovery state UNKNOWN',
      cancel: expect.stringContaining('docs/OPERATIONS.md') });

    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: {
      'workloads.0.recoveryState': 'MUTATING', 'workloads.0.recoveryOwnerId': 'recovery-worker' } });
    refused = await lease('core-recreate', 'deploy-adopted');
    expect(refused).toMatchObject({ acquired: false });
    expect(refused.blockers[0].reason).toBe('a recovery owner has adopted it');
  });

  test('a Core inference in flight blocks a Core recreate but not a Benchmark recreate', async () => {
    await service.acquireInference({ principal: 'core-chat', requestId: 'chat-1', host: HOST_A, model: 'qwen3:8b' });
    const refused = await lease('core-recreate');
    expect(refused.blockers).toEqual([expect.objectContaining({ type: 'inference', id: 'qwen3:8b',
      hosts: [HOST_A], owner: 'core-chat', reason: 'Core serves it; a Core recreate cuts it' })]);
    await expect(service.listDeployBlockers({ service: 'benchmark' }))
      .resolves.toEqual({ service: 'benchmark', allowed: true, blockers: [] });
  });

  test('a Benchmark recreate is refused while any workload runs, profiles included', async () => {
    await workload('profiler-fleet-f9', 'profiler');
    const verdict = await service.listDeployBlockers({ service: 'benchmark' });
    expect(verdict).toMatchObject({ service: 'benchmark', allowed: false });
    expect(verdict.blockers[0]).toMatchObject({ kind: 'profiler', id: 'profiler-fleet-f9',
      reason: 'Benchmark owns its writer; recreating Benchmark cuts it',
      cancel: 'Benchmark POST /api/profiler/hosts/test/run-fleet/f9/cancel' });
    await expect(service.listDeployBlockers({ service: 'core' })).resolves.toMatchObject({ allowed: true });
  });

  test('a held maintenance lease is named, and summaries stay printable by a shell', async () => {
    await workload('profile-"quoted"\\id', 'profiler');
    await expect(lease('core-recreate', 'first')).resolves.toMatchObject({ acquired: true });
    const refused = await lease('core-recreate', 'second');
    expect(refused.blockers).toEqual([expect.objectContaining({ type: 'maintenance', kind: 'core-recreate',
      owner: 'operator', reason: 'another maintenance lease is held' })]);
    const verdict = await service.listDeployBlockers({ service: 'benchmark' });
    expect(verdict.blockers[0].summary).not.toMatch(/["\\\n]/);
  });
});
