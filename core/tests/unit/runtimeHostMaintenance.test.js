'use strict';

// Host-scoped maintenance lease (#933): restart one Ollama machine without
// waiting for, or stopping, work on the others.
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');

// gpu-a and its alias (for example the CPU instance) are one physical machine.
const a = 'http://gpu-a:11434', alias = 'http://gpu-a:11436', b = 'http://gpu-b:11434';
const topology = [{ id: 'machine-a', endpoints: [a, alias] }, { id: 'machine-b', endpoints: [b] }];
const inference = (host, requestId = host, extra = {}) => service.acquireInference({ host, requestId,
  principal: 'conversation', model: 'same-model', runtimeOptions: { num_ctx: 4096 }, ...extra });
const hostLease = (hosts, requestId = 'upgrade-a') => service.acquireMaintenance({
  principal: 'operator', requestId, scope: 'host', hosts, ttl: 900_000 });
const releaseLease = lease => service.release('maintenance', {
  id: lease.leaseId, generation: lease.generation, principal: lease.principal });

describe('host-scoped maintenance lease', () => {
  const saved = process.env.AGENTX_RUNTIME_RESOURCES_JSON;
  beforeEach(async () => {
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify(topology);
    await RuntimeCoordination.deleteMany({});
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    else process.env.AGENTX_RUNTIME_RESOURCES_JSON = saved;
    await RuntimeCoordination.deleteMany({});
  });

  test('is granted while another host is busy; a global lease still waits', async () => {
    expect(await inference(b)).toMatchObject({ acquired: true });
    expect(await service.acquireMaintenance({ principal: 'operator', requestId: 'deploy', scope: 'runtime-deploy' }))
      .toMatchObject({ acquired: false });
    expect(await hostLease([a + '/'])).toMatchObject({ acquired: true, scope: 'host',
      hosts: [a], resourceIds: ['machine-a'] });
  });

  test('is refused while the same machine is busy, naming only that work', async () => {
    await inference(b);
    expect(await inference(alias)).toMatchObject({ acquired: true });
    const refused = await hostLease([a]);
    expect(refused).toMatchObject({ acquired: false });
    expect(refused.blockers).toHaveLength(1);
    expect(refused.blockers[0]).toMatchObject({ type: 'inference', hosts: [alias] });
  });

  test('is refused while a workload holds the machine', async () => {
    expect(await service.acquireWorkload({ hosts: [alias], requestId: 'batch', principal: 'benchmark-service',
      workloadId: 'batch', kind: 'benchmark' })).toMatchObject({ acquired: true });
    expect(await hostLease([a])).toMatchObject({ acquired: false });
  });

  test('refuses inference only on the leased machine while held', async () => {
    const parent = await service.acquireWorkload({ hosts: [b], requestId: 'batch', principal: 'benchmark-service',
      workloadId: 'batch', kind: 'benchmark' });
    expect(await hostLease([a])).toMatchObject({ acquired: true });
    expect(await inference(a)).toMatchObject({ acquired: false,
      failure: { cause: 'maintenance_active', holder: { type: 'maintenance' } } });
    expect(await inference(alias)).toMatchObject({ acquired: false, failure: { cause: 'maintenance_active' } });
    expect(await service.acquireInference({ host: b, requestId: 'child', model: 'same-model',
      principal: parent.principal, workloadAdmissionId: parent.admissionId,
      workloadGeneration: parent.generation })).toMatchObject({ acquired: true });
  });

  test('a topology switch lease names itself in the refusal (#360)', async () => {
    const lease = await service.acquireMaintenance({ principal: 'core-topology-switch', requestId: 'switch-1',
      scope: 'host', hosts: [a], ttl: 900_000, purpose: 'topology-switch' });
    expect(lease).toMatchObject({ acquired: true, purpose: 'topology-switch' });
    expect(await inference(a)).toMatchObject({ acquired: false, failure: { cause: 'topology_switch_in_progress',
      retryable: true, holder: { type: 'maintenance', kind: 'topology-switch' } } });
    expect(await inference(b)).toMatchObject({ acquired: true });
  });

  test('an unknown purpose is not stored', async () => {
    const lease = await service.acquireMaintenance({ principal: 'operator', requestId: 'x', scope: 'host',
      hosts: [a], ttl: 900_000, purpose: 'anything else' });
    expect(lease.purpose).toBeNull();
    expect(await inference(a)).toMatchObject({ failure: { cause: 'maintenance_active' } });
  });

  test('ordinary inference on another host keeps working while held', async () => {
    expect(await hostLease([a])).toMatchObject({ acquired: true });
    expect(await inference(b)).toMatchObject({ acquired: true });
  });

  test('a quarantined host lease keeps fencing only its machine', async () => {
    const lease = await hostLease([a]);
    expect(await service.markMaintenanceUnknown({ id: lease.leaseId, generation: lease.generation,
      principal: lease.principal, reason: 'restart outcome unknown' })).toMatchObject({ quarantined: true });
    expect(await inference(a)).toMatchObject({ acquired: false, recoveryRequired: true,
      failure: { cause: 'maintenance_recovery_required' } });
    expect(await inference(b)).toMatchObject({ acquired: true });
  });

  test('release reopens the machine so its pins can be warmed back', async () => {
    const lease = await hostLease([a]);
    expect(await releaseLease(lease)).toMatchObject({ released: true, scope: 'host', hosts: [a] });
    expect(await inference(a, 'pin-warm')).toMatchObject({ acquired: true });
    expect((await service.listActive()).maintenance).toBeNull();
  });

  test('requires hosts and binds them to the idempotency key', async () => {
    expect(await hostLease([])).toMatchObject({ acquired: false, reason: 'a host lease names at least one host' });
    const lease = await hostLease([a]);
    expect(await hostLease([a])).toMatchObject({ acquired: true, idempotent: true, leaseId: lease.leaseId });
    expect(await hostLease([b])).toMatchObject({ acquired: false,
      reason: 'idempotency key already binds a different maintenance intent' });
    expect(await hostLease([b], 'upgrade-b')).toMatchObject({ acquired: false });
  });
});
