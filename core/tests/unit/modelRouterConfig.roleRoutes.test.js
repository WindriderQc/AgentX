'use strict';

// Routing by topology role (#360, phase 2) in the router configuration, and
// the regression proof that routing is unchanged without a declared topology
// or without a route naming a role.

const crypto = require('crypto');

process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

const LANE_A = 'http://gpu-host.example:11437';
const LANE_B = 'http://gpu-host.example:11438';
const POOLED = 'http://gpu-host.example:11434';
const TOPOLOGY = JSON.stringify({ groups: [{ id: 'dual-gpu', label: 'Dual GPU', modes: [
  { id: 'lanes', endpoints: [{ url: LANE_A, role: 'conversation' }, { url: LANE_B, role: 'background' }] },
  { id: 'pooled', endpoints: [{ url: POOLED, role: 'pooled' }] }
] }] });

const mockStoredRoutes = jest.fn(() => []);
const mockFindOneAndUpdate = jest.fn(async () => ({}));
const mockDeleteOne = jest.fn(async () => ({}));
const mockDescribe = jest.fn();
const mockAdvisory = jest.fn();
const mockLadder = jest.fn(async (_taskType, primary) => primary);

jest.mock('../../src/helpers/schedulerClient', () => ({ resolveAdvisoryHost: (...args) => mockAdvisory(...args) }));
jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({ readiness: null })),
  compareReadiness: jest.fn(() => 0)
}));
jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(async () => []),
  getByHost: jest.fn(async () => null),
  getPinnedEntries: jest.fn(() => []),
  getPinnedModelsMap: jest.fn(async () => new Map())
}));
jest.mock('../../models/RouterTaskConfig', () => ({
  find: () => ({ lean: async () => mockStoredRoutes() }),
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  deleteOne: (...args) => mockDeleteOne(...args)
}));
jest.mock('../../models/ModelRegistry', () => ({
  find: () => ({ sort: () => ({ select: () => ({ lean: async () => [] }) }) })
}));
jest.mock('../../src/services/runtimeTopologyService', () => ({
  ...jest.requireActual('../../src/services/runtimeTopologyService'),
  describeTopology: (...args) => mockDescribe(...args)
}));
jest.mock('../../src/services/routing/taskFallbackLadder', () => ({
  ...jest.requireActual('../../src/services/routing/taskFallbackLadder'),
  applyTaskFallbackLadder: (...args) => mockLadder(...args)
}));

function description(activeMode = 'lanes') {
  const endpoint = (url, role, model, contextSize, hostKey) => ({ url, role, hostKey, pins: [{ model, contextSize }] });
  return {
    configured: true, valid: true, groups: [{
      id: 'dual-gpu', state: 'active', activeMode, modes: [
        { id: 'lanes', endpoints: [endpoint(LANE_A, 'conversation', 'lane-pin', 98304, 'lane-a'),
          endpoint(LANE_B, 'background', 'lane-pin', 98304, 'lane-b')] },
        { id: 'pooled', endpoints: [endpoint(POOLED, 'pooled', 'pooled-pin', 196608, 'pooled-host')] }
      ]
    }]
  };
}

function load(env = {}) {
  jest.resetModules();
  delete process.env.AGENTX_RUNTIME_TOPOLOGY_JSON;
  process.env.AGENTX_ANALYSIS_MODEL = 'analysis-model';
  process.env.AGENTX_ANALYSIS_HOST = 'primary';
  Object.assign(process.env, env);
  return require('../../src/services/modelRouterConfig');
}

// The version digest exactly as computed before role routes existed.
function historicalVersion(config) {
  const canonical = {
    hosts: Object.fromEntries(Object.entries(config.HOSTS).sort(([a], [b]) => a.localeCompare(b))),
    taskModels: Object.fromEntries(Object.entries(config.TASK_MODELS).sort(([a], [b]) => a.localeCompare(b))
      .map(([taskType, entry]) => [taskType, { model: entry?.model || null, host: entry?.host || null }])),
    classifier: { model: config.CLASSIFICATION_MODEL, host: config.CLASSIFICATION_HOST }
  };
  return `router-${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)}`;
}

beforeEach(() => {
  mockStoredRoutes.mockReturnValue([]);
  mockFindOneAndUpdate.mockClear();
  mockDeleteOne.mockClear();
  mockDescribe.mockReset();
  mockDescribe.mockResolvedValue(description());
  mockLadder.mockClear();
  mockAdvisory.mockReset();
  mockAdvisory.mockImplementation(async (input) => ({
    hostId: input.fallbackHostId, hostUrl: input.fallbackHostUrl, source: 'scheduler', reason: 'test',
    claimId: null, claimExpiresAt: null, recommendation: null
  }));
});

afterAll(() => {
  for (const key of ['AGENTX_RUNTIME_TOPOLOGY_JSON', 'AGENTX_ANALYSIS_MODEL', 'AGENTX_ANALYSIS_HOST']) delete process.env[key];
});

describe.each([
  ['no topology is declared', {}],
  ['a topology is declared but no route names a role', { AGENTX_RUNTIME_TOPOLOGY_JSON: TOPOLOGY }]
])('routing is unchanged when %s', (_name, env) => {
  async function loaded() {
    mockStoredRoutes.mockReturnValue([{ taskType: 'code_review', model: 'stored-model', host: 'secondary' }]);
    const config = load(env);
    await config.ensureTaskModelOverridesLoaded({ force: true });
    return config;
  }

  it('keeps every route in its historical { model, host } shape and version', async () => {
    const config = await loaded();
    for (const entry of Object.values(config.getEffectiveTaskModels())) expect(Object.keys(entry).sort()).toEqual(['host', 'model']);
    for (const state of Object.values(config.getTaskModelConfigState())) {
      expect(Object.keys(state.effective).sort()).toEqual(['host', 'model']);
      if (state.override) expect(Object.keys(state.override).sort()).toEqual(['host', 'model']);
    }
    expect(config.getRoutingConfigVersion()).toBe(historicalVersion(config));
  });

  it('routes tasks through the scheduler and the fallback ladder as before, observing no topology', async () => {
    const config = await loaded();
    const advisory = await config.getAdvisoryModelForTask('code_review', { caller: 'test' });
    expect(advisory).toEqual({
      model: 'stored-model', host: 'secondary', url: 'http://secondary:11434', source: 'scheduler', reason: 'test',
      claimId: null, claimExpiresAt: null, recommendation: null, readiness: null
    });
    expect(mockLadder).toHaveBeenCalledWith('code_review', advisory);
    expect(config.getModelForTask('code_review')).toEqual({ model: 'stored-model', host: 'secondary', url: 'http://secondary:11434' });
    await expect(config.resolvePreferredTaskEntry('code_review')).resolves.not.toHaveProperty('topology');
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('saves a host route with its historical write', async () => {
    const config = await loaded();
    await config.saveTaskModelOverride('analysis', { model: 'other-model', host: 'secondary' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { taskType: 'analysis' },
      { taskType: 'analysis', model: 'other-model', host: 'secondary' },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  });

  it('adds role state to the payload only when a topology is declared, without observing it', async () => {
    const config = await loaded();
    const payload = await config.buildRouterConfigPayload();
    if (env.AGENTX_RUNTIME_TOPOLOGY_JSON) {
      expect(payload.topology).toEqual({
        declared: true, valid: true, roles: ['conversation', 'background', 'pooled'],
        groups: [{ id: 'dual-gpu', label: 'Dual GPU' }], resolutions: {}, principal: null
      });
    } else {
      expect(payload).not.toHaveProperty('topology');
    }
    expect(mockDescribe).not.toHaveBeenCalled();
    await expect(config.resolvePrincipalTopology()).resolves.toBeNull();
  });
});

describe('role routes', () => {
  async function withRole(route, stored = [{ taskType: 'analysis', ...route }]) {
    mockStoredRoutes.mockReturnValue(stored);
    const config = load({ AGENTX_RUNTIME_TOPOLOGY_JSON: TOPOLOGY });
    await config.ensureTaskModelOverridesLoaded({ force: true });
    return config;
  }

  it('loads a stored role route and exposes it in the effective configuration and version', async () => {
    const config = await withRole({ role: 'background' });
    expect(config.getEffectiveTaskModels().analysis).toEqual({ model: null, host: null, role: 'background' });
    expect(config.getTaskModelConfigState().analysis).toMatchObject({
      override: { model: null, host: null, role: 'background' }, isOverride: true
    });
    expect(config.getRoutingConfigVersion()).not.toBe(historicalVersion(config));
  });

  it('resolves the role to the endpoint pin, never through the scheduler or the fallback ladder', async () => {
    const config = await withRole({ role: 'background' });
    const advisory = await config.getAdvisoryModelForTask('analysis', { caller: 'test' });
    expect(advisory).toMatchObject({
      model: 'lane-pin', host: 'lane-b', url: LANE_B, source: 'topology_role',
      topology: { role: 'background', group: 'dual-gpu', mode: 'lanes', laneContext: 98304 }
    });
    expect(advisory).not.toHaveProperty('refusal');
    expect(mockAdvisory).not.toHaveBeenCalled();
    expect(mockLadder).not.toHaveBeenCalled();
    expect(config.getModelForTask('analysis')).toEqual({ model: 'lane-pin', host: 'lane-b', url: LANE_B, role: 'background' });
  });

  it('refuses an unresolved role with its reason instead of rerouting', async () => {
    mockDescribe.mockResolvedValue(description('pooled'));
    const config = await withRole({ role: 'background' });
    const advisory = await config.getAdvisoryModelForTask('analysis', { caller: 'test' });
    expect(advisory).toMatchObject({
      model: null, host: null, url: null, source: 'topology_role_unresolved',
      refusal: { status: 503, code: 'TOPOLOGY_ROLE_UNRESOLVED', reason: 'role_not_in_active_mode',
        data: { role: 'background', group: 'dual-gpu', mode: 'pooled', reason: 'role_not_in_active_mode' } }
    });
    expect(mockLadder).not.toHaveBeenCalled();
    await expect(config.resolvePreferredTaskEntry('analysis')).resolves.toMatchObject({
      model: null, url: null, refusal: { code: 'TOPOLOGY_ROLE_UNRESOLVED' }
    });
  });

  it('shares one topology observation across tasks within the cache window', async () => {
    const config = await withRole(null, [
      { taskType: 'analysis', role: 'background' }, { taskType: 'code_review', role: 'conversation' }
    ]);
    await Promise.all([config.getAdvisoryModelForTask('analysis'), config.getAdvisoryModelForTask('code_review')]);
    const payload = await config.buildRouterConfigPayload();
    expect(payload.topology.resolutions).toMatchObject({
      analysis: { ok: true, role: 'background', url: LANE_B }, code_review: { ok: true, role: 'conversation', url: LANE_A }
    });
    expect(mockDescribe).toHaveBeenCalledTimes(1);
  });

  it('saves a role route and drops the host fields', async () => {
    const config = await withRole(null, []);
    const state = await config.saveTaskModelOverride('analysis', { role: 'conversation' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { taskType: 'analysis' },
      { $set: { taskType: 'analysis', role: 'conversation' }, $unset: { model: 1, host: 1, group: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    expect(state.effective).toEqual({ model: null, host: null, role: 'conversation' });
  });

  it('drops the role fields when a host route replaces a role route', async () => {
    const config = await withRole({ role: 'background' });
    await config.saveTaskModelOverride('analysis', { model: 'other-model', host: 'secondary' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { taskType: 'analysis' },
      { taskType: 'analysis', model: 'other-model', host: 'secondary', $unset: { role: 1, group: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  });

  it.each([
    ['host and role', { host: 'primary', role: 'conversation' }, TOPOLOGY],
    ['a model with a role', { model: 'x', role: 'conversation' }, TOPOLOGY],
    ['a role without a declared topology', { role: 'conversation' }, undefined]
  ])('refuses to save %s', async (_name, entry, topology) => {
    mockStoredRoutes.mockReturnValue([]);
    const config = load(topology ? { AGENTX_RUNTIME_TOPOLOGY_JSON: topology } : {});
    await config.ensureTaskModelOverridesLoaded({ force: true });
    await expect(config.saveTaskModelOverride('analysis', entry)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses at dispatch a stored role route whose topology was removed', async () => {
    mockStoredRoutes.mockReturnValue([{ taskType: 'analysis', role: 'background' }]);
    const config = load();
    await config.ensureTaskModelOverridesLoaded({ force: true });
    await expect(config.getAdvisoryModelForTask('analysis')).resolves.toMatchObject({
      url: null, refusal: { code: 'TOPOLOGY_ROLE_UNRESOLVED', reason: 'topology_not_declared' }
    });
  });
});

describe('the principal alias follows the topology only through a role route', () => {
  async function principal(route, activeMode) {
    mockDescribe.mockResolvedValue(description(activeMode));
    mockStoredRoutes.mockReturnValue(route ? [{ taskType: 'daily_operator', ...route }] : []);
    const config = load({ AGENTX_RUNTIME_TOPOLOGY_JSON: TOPOLOGY });
    await config.ensureTaskModelOverridesLoaded({ force: true });
    return config.resolvePrincipalTopology();
  }

  it('is not followed while the principal route names a host', async () => {
    await expect(principal(null, 'lanes')).resolves.toBeNull();
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('follows the conversation lane when the lanes mode is active', async () => {
    await expect(principal({ role: 'conversation' }, 'lanes')).resolves.toMatchObject({
      ok: true, role: 'conversation', url: LANE_A, model: 'lane-pin', laneContext: 98304
    });
  });

  it('follows the pooled pin when the active mode has no conversation role', async () => {
    await expect(principal({ role: 'conversation' }, 'pooled')).resolves.toMatchObject({
      ok: true, role: 'pooled', requestedRole: 'conversation', url: POOLED, model: 'pooled-pin'
    });
  });

  it('is refused with the reason when nothing serves it', async () => {
    mockDescribe.mockResolvedValue({ ...description(), groups: [{ ...description().groups[0], state: 'transitional', activeMode: null }] });
    mockStoredRoutes.mockReturnValue([{ taskType: 'daily_operator', role: 'conversation' }]);
    const config = load({ AGENTX_RUNTIME_TOPOLOGY_JSON: TOPOLOGY });
    await config.ensureTaskModelOverridesLoaded({ force: true });
    await expect(config.resolvePrincipalTopology()).resolves.toMatchObject({ ok: false, reason: 'transitional' });
  });
});

describe('chat routing', () => {
  it('refuses a task routed to an unresolved role instead of returning an empty target', async () => {
    mockDescribe.mockResolvedValue(description('pooled'));
    mockStoredRoutes.mockReturnValue([{ taskType: 'analysis', role: 'background' }]);
    load({ AGENTX_RUNTIME_TOPOLOGY_JSON: TOPOLOGY });
    const modelRouter = require('../../src/services/modelRouter');
    await expect(modelRouter.routeRequest('hello', { taskType: 'analysis' })).rejects.toMatchObject({
      code: 'TOPOLOGY_ROLE_UNRESOLVED', statusCode: 503,
      details: { role: 'background', reason: 'role_not_in_active_mode' }
    });
  });

  it('routes a task with a resolved role to its endpoint pin', async () => {
    mockStoredRoutes.mockReturnValue([{ taskType: 'analysis', role: 'conversation' }]);
    load({ AGENTX_RUNTIME_TOPOLOGY_JSON: TOPOLOGY });
    const modelRouter = require('../../src/services/modelRouter');
    await expect(modelRouter.routeRequest('hello', { taskType: 'analysis' })).resolves.toMatchObject({
      model: 'lane-pin', target: LANE_A, source: 'topology_role'
    });
  });
});
