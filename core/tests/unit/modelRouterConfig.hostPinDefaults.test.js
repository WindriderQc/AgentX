'use strict';

process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

const mockPinnedModelsMap = jest.fn(async () => new Map());
const mockStoredRoutes = jest.fn(() => []);

jest.mock('../../src/helpers/schedulerClient', () => ({ resolveAdvisoryHost: jest.fn() }));
jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({ readiness: null })),
  compareReadiness: jest.fn(() => 0)
}));
jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(async () => null),
  getPinnedEntries: jest.fn(() => []),
  getPinnedModelsMap: (...args) => mockPinnedModelsMap(...args)
}));
jest.mock('../../models/RouterTaskConfig', () => ({
  find: () => ({ lean: async () => mockStoredRoutes() })
}));

const PIN = 'huihui_ai/Qwen3.8-abliterated:27b-q8_0';
const EMBEDDING = 'qllama/bge-m3:f16';

function load(env = {}) {
  jest.resetModules();
  process.env.AGENTX_ANALYSIS_MODEL = 'qwen3.8:27b-mtp-q8_0';
  process.env.AGENTX_ANALYSIS_HOST = 'primary';
  process.env.AGENTX_ROUTER_EMBEDDING_MODEL = EMBEDDING;
  process.env.AGENTX_ROUTER_EMBEDDING_HOST = 'primary';
  delete process.env.AGENTX_ROUTE_DEFAULTS_FOLLOW_HOST_PIN;
  Object.assign(process.env, env);
  return require('../../src/services/modelRouterConfig');
}

function pins(map) {
  mockPinnedModelsMap.mockResolvedValue(new Map(Object.entries(map)));
}

afterEach(async () => {
  mockStoredRoutes.mockReturnValue([]);
  for (const key of ['AGENTX_ANALYSIS_MODEL', 'AGENTX_ANALYSIS_HOST', 'AGENTX_ROUTER_EMBEDDING_MODEL',
    'AGENTX_ROUTER_EMBEDDING_HOST', 'AGENTX_ROUTE_DEFAULTS_FOLLOW_HOST_PIN']) delete process.env[key];
});

describe('route defaults follow their host pin', () => {
  it('moves an unstored default pinned nowhere onto its host first chat pin', async () => {
    pins({ 'http://primary:11434': [EMBEDDING, PIN] });
    const config = load();
    await config.refreshPinCacheNow();

    expect(config.getEffectiveTaskModels().plant_identify).toEqual({ model: PIN, host: 'primary' });
    expect(config.getEffectiveTaskModels().analysis.model).toBe(PIN);
    const state = config.getTaskModelConfigState().plant_identify;
    expect(state.default.model).toBe('qwen3.8:27b-mtp-q8_0');
    expect(state.followsHostPin).toBe(true);
    expect(state.isOverride).toBe(false);
    expect(config.getHostPinFollowers()).toContain('plant_identify');
  });

  it('keeps an embedding default on its pinned embedding model', async () => {
    pins({ 'http://primary:11434': [PIN, EMBEDDING] });
    const config = load();
    await config.refreshPinCacheNow();

    expect(config.getEffectiveTaskModels().embeddings.model).toBe(EMBEDDING);
    expect(config.getTaskModelConfigState().embeddings.followsHostPin).toBe(false);
  });

  it('lets a stored route win over the host pin', async () => {
    pins({ 'http://primary:11434': [PIN] });
    mockStoredRoutes.mockReturnValue([{ taskType: 'plant_identify', model: 'vision-special', host: 'primary' }]);
    const config = load();
    await config.ensureTaskModelOverridesLoaded({ force: true });
    await config.refreshPinCacheNow();

    expect(config.getEffectiveTaskModels().plant_identify.model).toBe('vision-special');
    expect(config.getTaskModelConfigState().plant_identify.followsHostPin).toBe(false);
  });

  it('keeps a default that is pinned on another host, so it can follow its model there', async () => {
    pins({ 'http://primary:11434': [PIN], 'http://secondary:11434': ['qwen3.8:27b-mtp-q8_0'] });
    const config = load();
    await config.refreshPinCacheNow();

    expect(config.getEffectiveTaskModels().plant_identify.model).toBe('qwen3.8:27b-mtp-q8_0');
  });

  it('leaves a default already pinned on its host unchanged', async () => {
    pins({ 'http://primary:11434': ['qwen3.8:27b-mtp-q8_0'] });
    const config = load();
    await config.refreshPinCacheNow();

    expect(config.getEffectiveTaskModels().plant_identify.model).toBe('qwen3.8:27b-mtp-q8_0');
    expect(config.getHostPinFollowers()).not.toContain('plant_identify');
  });

  it('can be switched off with AGENTX_ROUTE_DEFAULTS_FOLLOW_HOST_PIN=false', async () => {
    pins({ 'http://primary:11434': [PIN] });
    const config = load({ AGENTX_ROUTE_DEFAULTS_FOLLOW_HOST_PIN: 'false' });
    await config.refreshPinCacheNow();

    expect(config.getEffectiveTaskModels().plant_identify.model).toBe('qwen3.8:27b-mtp-q8_0');
    expect(config.getHostPinFollowers()).toEqual([]);
  });
});
