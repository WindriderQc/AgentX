'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');
const priority = require('../../src/services/interactivePriorityService');
const ladder = require('../../src/services/routing/taskFallbackLadder');

// A benchmark judged on a separate host holds that host as shared (#396):
// other models keep being served there, a model handoff does not happen, and
// the measured execution host stays exclusive.
const EXEC = 'http://exec:11434';
const JUDGE = 'http://judge:11434';

const benchmark = (overrides = {}) => service.acquireWorkload({
  principal: 'benchmark-service', requestId: 'benchmark:batch-1', workloadId: 'batch-1', kind: 'benchmark',
  hosts: [EXEC, JUDGE], sharedHosts: [JUDGE], ttl: 60_000, ...overrides
});
const ordinary = (host, model, extra = {}) => service.acquireInference({
  principal: 'core-service', requestId: `${host}:${model}:${extra.mode || 'shared'}`, host, model, ...extra
});

describe('shared hosts of a workload', () => {
  const saved = process.env.AGENTX_RUNTIME_RESOURCES_JSON;
  beforeEach(async () => {
    delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    await RuntimeCoordination.deleteMany({});
    await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    else process.env.AGENTX_RUNTIME_RESOURCES_JSON = saved;
    await RuntimeCoordination.deleteMany({});
  });

  test('a shared host keeps serving other callers; the execution host and model handoffs stay reserved', async () => {
    const workload = await benchmark();
    expect(workload).toMatchObject({ acquired: true, hosts: [EXEC, JUDGE], sharedHosts: [JUDGE] });
    await expect(ordinary(JUDGE, 'bge-m3')).resolves.toMatchObject({ acquired: true });
    await expect(ordinary(JUDGE, 'voice-model', { mode: 'exclusive' })).resolves.toMatchObject({
      acquired: false, failure: { cause: 'workload_reserved', holder: { type: 'workload', kind: 'benchmark' } }
    });
    await expect(ordinary(EXEC, 'chat-model')).resolves.toMatchObject({
      acquired: false, failure: { cause: 'workload_reserved' }
    });
    // The judge's own proof-bound call runs beside the ordinary one.
    await expect(service.acquireInference({
      principal: 'benchmark-service', requestId: 'judge-call', host: JUDGE, model: 'judge-model',
      workloadAdmissionId: workload.admissionId, workloadGeneration: workload.generation
    })).resolves.toMatchObject({ acquired: true });
  });

  test('acquisition waits only for an exclusive or UNKNOWN inference on a shared host', async () => {
    const embedding = await ordinary(JUDGE, 'bge-m3');
    await expect(benchmark()).resolves.toMatchObject({ acquired: true, sharedHosts: [JUDGE] });
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { workloads: [] } });
    await service.markInferenceUnknown({ id: embedding.admissionId, generation: embedding.generation,
      principal: embedding.principal, reason: 'connection lost' });
    await expect(benchmark({ requestId: 'benchmark:batch-2', workloadId: 'batch-2' }))
      .resolves.toMatchObject({ acquired: false });
  });

  test('an unshared host still waits for every inference, and only held hosts can be shared', async () => {
    await ordinary(EXEC, 'chat-model');
    await expect(benchmark()).resolves.toMatchObject({ acquired: false });
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { inferences: [] } });
    await expect(benchmark({ sharedHosts: [JUDGE, 'http://elsewhere:11434'] }))
      .resolves.toMatchObject({ acquired: true, sharedHosts: [JUDGE] });
  });

  test('a host on the same GPU as an unshared host is not shared', async () => {
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'gpu-0', endpoints: [EXEC, JUDGE] }]);
    await RuntimeCoordination.deleteMany({});
    await expect(benchmark()).resolves.toMatchObject({ acquired: true, sharedHosts: [] });
    await expect(ordinary(JUDGE, 'bge-m3')).resolves.toMatchObject({ acquired: false });
  });

  test('a household turn on a shared host does not ask the batch to yield', async () => {
    const workload = await benchmark();
    await expect(priority.requestYield(JUDGE)).resolves.toEqual({ requested: false });
    await ordinary(JUDGE, 'bge-m3');
    await expect(priority.yieldPoint({ admissionId: workload.admissionId, generation: workload.generation,
      principal: workload.principal, inFlight: 0 })).resolves.toMatchObject({ yield: false });
    await expect(priority.requestYield(EXEC)).resolves.toEqual({ requested: true });
  });

  test('the fallback ladder sees a shared host as available', async () => {
    await benchmark();
    const runtime = await RuntimeCoordination.findById('runtime').lean();
    const { coordinationBlock } = ladder._internal;
    expect(coordinationBlock(runtime, JUDGE, Date.now())).toBeNull();
    expect(coordinationBlock(runtime, EXEC, Date.now())).not.toBeNull();
  });
});
