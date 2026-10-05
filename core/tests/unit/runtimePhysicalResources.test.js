'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');
const { resourceTopology } = require('../../src/services/runtimePhysicalResources');

const a = 'http://gpu-a:11434', alias = 'http://gpu-alias:11435';
const cpu = 'http://gpu-a:11436', b = 'http://gpu-b:11434';
const topology = [{ id: 'device-a', endpoints: [a, alias] }, { id: 'device-b', endpoints: [b] }];
const inference = (host, requestId = host) => service.acquireInference({ host, requestId,
  principal: 'conversation', model: 'same-model', runtimeOptions: { num_ctx: 4096 } });
const workload = (hosts, requestId = 'image') => service.acquireWorkload({ hosts, requestId,
  principal: 'image-worker', workloadId: requestId, kind: 'images' });
const release = admission => service.releaseInference({ id: admission.admissionId,
  generation: admission.generation, principal: admission.principal });

describe('physical runtime resource admission with real Mongo CAS', () => {
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

  test('different endpoints on one device refuse even the same residency; CPU and other GPUs remain usable', async () => {
    expect(await inference(a)).toMatchObject({ acquired: true, resourceIds: ['device-a'] });
    expect(await inference(alias)).toMatchObject({ acquired: false,
      failure: { cause: 'inference_residency_active', holder: { type: 'inference' } } });
    expect(await service.hostHasActiveInferences(alias)).toBe(true);
    expect(await service.hostHasActiveInferences(cpu)).toBe(false);
    expect(await inference(cpu)).toMatchObject({ acquired: true, resourceIds: [] });
    expect(await inference(b)).toMatchObject({ acquired: true, resourceIds: ['device-b'] });
    expect(await inference(a, 'same-runner')).toMatchObject({ acquired: true });
  });

  test.each(['inference-first', 'workload-first'])('GPU image and alias inference exclude each other: %s', async order => {
    if (order === 'inference-first') {
      await inference(alias);
      expect(await workload([a])).toMatchObject({ acquired: false });
    } else {
      expect(await workload([a])).toMatchObject({ acquired: true, resourceIds: ['device-a'] });
      expect(await inference(alias)).toMatchObject({ acquired: false,
        failure: { cause: 'workload_reserved', holder: { kind: 'images' } } });
    }
    expect(await workload([b], 'other-gpu')).toMatchObject({ acquired: true });
    expect(await inference(cpu)).toMatchObject({ acquired: true });
  });

  test('racing physical consumers have one winner, including two workloads', async () => {
    for (let i = 0; i < 12; i++) {
      await RuntimeCoordination.deleteMany({});
      const acquired = await Promise.all(i % 2
        ? [workload([a], 'one'), workload([alias], 'two')]
        : [workload([a]), inference(alias)]);
      expect(acquired.filter(item => item.acquired)).toHaveLength(1);
    }
  });

  test('multi-device consumers reserve every configured GPU', async () => {
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([
      ...topology, { id: 'device-c', endpoints: [a, 'http://gpu-c:11434'] }
    ]);
    expect(await workload([a])).toMatchObject({ acquired: true, resourceIds: ['device-a', 'device-c'] });
    expect(await inference('http://gpu-c:11434')).toMatchObject({ acquired: false });
    expect(await inference(b)).toMatchObject({ acquired: true });
  });

  test('UNKNOWN inference keeps its physical fence after expiry and module reload', async () => {
    const held = await inference(a);
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'inferences.0.expiresAt': new Date(0) } });
    jest.isolateModules(() => {
      expect(require('../../src/services/runtimePhysicalResources').resourceTopology().hash)
        .toBe(resourceTopology().hash);
    });
    expect(await inference(alias)).toMatchObject({ acquired: false, recoveryRequired: true,
      failure: { cause: 'inference_recovery_required', retryable: false } });
    expect(await workload([alias])).toMatchObject({ acquired: false });
    expect(await release(held)).toMatchObject({ released: false });
    expect((await service.listActive()).inferences).toHaveLength(1);
  });

  test('expired image workload retains its physical aliases and cannot release by time alone', async () => {
    const held = await workload([a]);
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.expiresAt': new Date(0) } });
    expect(await inference(alias)).toMatchObject({ acquired: false,
      failure: { cause: 'workload_recovery_required', retryable: false } });
    expect(await workload([alias], 'replacement')).toMatchObject({ acquired: false });
    expect(await service.release('workload', { id: held.admissionId, generation: held.generation,
      principal: held.principal })).toMatchObject({ released: false });
    expect((await service.listActive()).workloads[0]).toMatchObject({ resourceIds: ['device-a'] });
  });

  test('a yielded workload admits its endpoint, never an unlisted physical alias', async () => {
    const parent = await workload([a]);
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.yieldedAt': new Date() } });
    expect(await inference(a)).toMatchObject({ acquired: true });
    expect(await inference(alias)).toMatchObject({ acquired: false, failure: { cause: 'workload_reserved' } });
    expect(await service.acquireInference({ host: alias, requestId: 'forged-child', model: 'same-model',
      principal: parent.principal, workloadAdmissionId: parent.admissionId,
      workloadGeneration: parent.generation })).toMatchObject({ acquired: false,
      failure: { cause: 'workload_proof_invalid' } });
  });

  test('exact parent proof keeps its own dispatch while other endpoints stay reserved', async () => {
    const parent = await workload([a, alias]);
    expect(await service.acquireInference({ host: a, requestId: 'child', model: 'same-model',
      principal: parent.principal, workloadAdmissionId: parent.admissionId,
      workloadGeneration: parent.generation })).toMatchObject({ acquired: true });
    expect(await inference(alias)).toMatchObject({ acquired: false });
    expect(await service.assertWorkloadAdmission({ id: parent.admissionId, generation: parent.generation,
      principal: parent.principal, workloadId: parent.workloadId, host: alias })).toMatchObject({ admitted: true });
  });

  test('Core-recreate keeps the maintenance and topology predicates together for profiler dispatch', async () => {
    const parent = await service.acquireWorkload({ hosts: [a], requestId: 'profile',
      principal: 'benchmark-service', workloadId: 'profile', kind: 'profiler', ttl: 900000 });
    expect(await service.acquireMaintenance({ principal: 'operator', requestId: 'deploy',
      scope: 'core-recreate' })).toMatchObject({ acquired: true });
    const request = { host: a, requestId: 'profile-child', model: 'same-model',
      principal: parent.principal, workloadAdmissionId: parent.admissionId,
      workloadGeneration: parent.generation };
    expect(await service.acquireInference(request)).toMatchObject({ acquired: true });
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = '';
    expect(await service.acquireInference({ ...request, requestId: 'changed-child' }))
      .toMatchObject({ acquired: false, failure: { cause: 'runtime_resource_configuration_changed' } });
    expect(await service.assertWorkloadAdmission({ id: parent.admissionId, generation: parent.generation,
      principal: parent.principal, workloadId: parent.workloadId })).toMatchObject({ admitted: false });
  });

  test('mapping changes refuse new and repeated admissions until exact owners release', async () => {
    const held = await inference(a);
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'replacement', endpoints: [a, alias] }]);
    expect(await inference(b)).toMatchObject({ acquired: false,
      failure: { cause: 'runtime_resource_configuration_changed', diagnostic: { category: 'configuration' } } });
    expect(await inference(a)).toMatchObject({ acquired: false });
    expect(await workload([b])).toMatchObject({ acquired: false });
    expect((await service.listActive()).physicalResources).toMatchObject({ configurationValid: true,
      mappingChangeBlocked: true });
    expect(await release(held)).toMatchObject({ released: true });
    expect(await inference(alias)).toMatchObject({ acquired: true, resourceIds: ['replacement'] });
  });

  test('a mapping change between read and insertion cannot win a stale admission CAS', async () => {
    await inference(b);
    const original = RuntimeCoordination.findOneAndUpdate.bind(RuntimeCoordination);
    const spy = jest.spyOn(RuntimeCoordination, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      if (!update.$push?.inferences) return original(filter, update, options);
      return { lean: async () => {
        await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { resourceTopologyHash: 'other-process-map' } });
        return original(filter, update, options).lean();
      } };
    });
    try {
      expect(await inference(a)).toMatchObject({ acquired: false,
        failure: { cause: 'runtime_resource_configuration_changed' } });
      expect((await RuntimeCoordination.findById('runtime').lean()).inferences).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  test('legacy held admissions prevent enabling a mapping; no legacy fence is discarded', async () => {
    delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    const held = await inference(a);
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify(topology);
    expect(await workload([alias])).toMatchObject({ acquired: false,
      failure: { cause: 'runtime_resource_configuration_changed' } });
    expect(await release(held)).toMatchObject({ released: true });
    expect(await workload([alias])).toMatchObject({ acquired: true });
  });

  test('invalid inventory refuses new work without preventing exact release', async () => {
    const held = await inference(a);
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = '{invalid';
    expect(await inference(alias)).toMatchObject({ acquired: false,
      failure: { cause: 'runtime_resource_configuration_invalid' } });
    expect(await workload([b])).toMatchObject({ acquired: false });
    expect((await service.listActive()).physicalResources).toMatchObject({ configurationValid: false });
    expect(await release(held)).toMatchObject({ released: true });
  });

  test('semantic order and endpoint aliases leave topology unchanged; invalid rows never shorten identities', () => {
    expect(resourceTopology(JSON.stringify([...topology].reverse().map(row => ({
      ...row, endpoints: [...row.endpoints].reverse().map(url => url + '/')
    })))).hash).toBe(resourceTopology(JSON.stringify(topology)).hash);
    for (const rows of [{}, [{ endpoints: [a] }], [{ id: 'x', endpoints: [] }],
      [{ id: 'x', endpoints: ['http://user:pass@gpu-a:11434'] }],
      [{ id: 'x', endpoints: [a + '/path'] }], [topology[0], topology[0]]]) {
      expect(() => resourceTopology(JSON.stringify(rows))).toThrow('configuration is invalid');
    }
  });
});
