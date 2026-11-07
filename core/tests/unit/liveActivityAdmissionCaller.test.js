'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');
const { readActiveRequests } = require('../../src/services/liveActivityService');

// The caller label is stored on the admission and read back by the Nerve
// Center live requests view; admission proofs never leave Core.
describe('admission caller label persistence', () => {
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

  test('stores a bounded caller label and lists it without proofs', async () => {
    const long = `ops-watch/${'x'.repeat(200)}`;
    const first = await service.acquireInference({ principal: 'core-inference', requestId: 'r1', host: 'http://a:11434', model: 'm1', caller: long });
    const second = await service.acquireInference({ principal: 'core-chat', requestId: 'r2', host: 'http://a:11434', model: 'm2', kind: 'chat' });
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    const { active } = await readActiveRequests();
    expect(active.map(item => item.label).sort()).toEqual(['Chat', long.slice(0, 96)].sort());
    expect(JSON.stringify(active)).not.toContain(first.admissionId);
    expect(JSON.stringify(active)).not.toContain(first.generation);
  });
});
