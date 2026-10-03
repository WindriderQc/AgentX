'use strict';

process.env.OLLAMA_HOST = 'http://primary:11434';

const hostConfig = require('../../src/helpers/ollamaHostConfig');
const { assessHostGpuHealth } = require('../../src/services/hostGpuHealthService');
const {
  readVramSpill, verifyPinnedEntriesLoaded, buildWarmPayload, resolvePinnedRuntimeOptions
} = require('../../src/services/hostPinPrimitives');
const { inflightLimitFor, MAX_INFLIGHT } = require('../../src/services/hostGateLimits');

const CPU_URL = 'http://cpu-fixture:11435';
const GPU_URL = 'http://primary:11434';
const MODEL = 'gemma4:26b-a4b-it-qat';
const pref = { hostUrl: CPU_URL, pinnedModels: [{ model: MODEL, keepAlive: -1, numThread: 6 }] };
const resident = sizeVram => [{ name: MODEL, size: 100, size_vram: sizeVram, expires_at: '2319-01-07T00:00:00Z' }];
const originalFetch = global.fetch;

beforeEach(() => {
  hostConfig.setRegisteredHosts([{ id: 'cpu-fixture', url: CPU_URL, residency: 'cpu', maxInflight: 1 }]);
});

afterEach(() => {
  hostConfig.setRegisteredHosts([]);
  global.fetch = originalFetch;
});

describe('GPU health of a CPU host', () => {
  test('a pin held outside VRAM is healthy, and an empty GPU inventory is expected', () => {
    const telemetry = { telemetry: { status: 'fresh' }, gpus: [] };
    expect(assessHostGpuHealth(pref, resident(0), telemetry)).toMatchObject({
      status: 'healthy', residency: 'cpu', reason: null, entries: [{ model: MODEL, status: 'cpu', expected: 'cpu' }]
    });
  });

  test.each([[100, 'full'], [40, 'partial']])('a CPU pin with %s VRAM bytes degrades the host', (vram, status) => {
    expect(assessHostGpuHealth(pref, resident(vram), null))
      .toMatchObject({ status: 'degraded', reason: 'pinned_model_gpu_spill', entries: [{ status }] });
  });

  test('a GPU host keeps its contract', () => {
    const gpuPref = { ...pref, hostUrl: GPU_URL };
    expect(assessHostGpuHealth(gpuPref, resident(0), null)).toMatchObject({ status: 'degraded', residency: 'gpu' });
    expect(assessHostGpuHealth(gpuPref, resident(100), null)).toMatchObject({ status: 'healthy', residency: 'gpu' });
  });
});

describe('pin placement on a CPU host', () => {
  test('readVramSpill reads a mismatch against the declared residency', () => {
    expect(readVramSpill(resident(0)[0], 'cpu')).toBeNull();
    expect(readVramSpill(resident(30)[0], 'cpu')).toEqual({ size: 100, sizeVram: 30, expected: 'cpu' });
    expect(readVramSpill(resident(0)[0], 'gpu')).toEqual({ size: 100, sizeVram: 0 });
    expect(readVramSpill({ name: MODEL }, 'cpu')).toBeNull();
  });

  test('restore verification accepts CPU placement and refuses VRAM use', async () => {
    let vram = 0;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ models: resident(vram) }) }));
    await expect(verifyPinnedEntriesLoaded(CPU_URL, pref.pinnedModels, 1000))
      .resolves.toMatchObject({ verified: true, gpuVerified: true, residency: 'cpu' });
    vram = 100;
    await expect(verifyPinnedEntriesLoaded(CPU_URL, pref.pinnedModels, 1000))
      .resolves.toMatchObject({ verified: false, residency: 'cpu' });
  });
});

describe('pin CPU threads', () => {
  test('warm requests carry num_thread only when the pin sets it', () => {
    expect(buildWarmPayload(MODEL, { keepAlive: -1, contextSize: 32768, numThread: 6 }).options)
      .toEqual({ num_predict: 1, num_ctx: 32768, num_thread: 6 });
    expect(buildWarmPayload(MODEL, { keepAlive: -1 }).options).toEqual({ num_predict: 1 });
    expect(buildWarmPayload('qllama/bge-m3:f16', { keepAlive: -1 })).toEqual({ model: 'qllama/bge-m3:f16', prompt: 'warmup', keep_alive: -1 });
  });

  test('inference reuses the pin thread count so the runner is not reloaded', () => {
    expect(resolvePinnedRuntimeOptions(pref, MODEL, {}).options).toEqual({ num_thread: 6 });
    expect(resolvePinnedRuntimeOptions(pref, MODEL, { num_thread: 2 }).options).toEqual({ num_thread: 2 });
  });
});

describe('per-host request limit', () => {
  test('a registered CPU host serves one request at a time; others keep the global limit', () => {
    expect(inflightLimitFor(CPU_URL)).toBe(1);
    expect(inflightLimitFor(GPU_URL)).toBe(MAX_INFLIGHT);
  });
});

describe('routing to a registered host', () => {
  test('router host keys include registry ids, and the fallback ladder accepts them', () => {
    const defaults = require('../../src/services/modelRouterDefaults');
    defaults.refreshHosts();
    expect(defaults.HOSTS['cpu-fixture']).toBe(CPU_URL);
    process.env.AGENTX_TASK_FALLBACKS_JSON = JSON.stringify({ quick_chat: [{ model: MODEL, host: 'cpu-fixture' }] });
    try {
      expect(require('../../src/services/routing/taskFallbackLadder').validateTaskFallbackConfig().valid).toBe(true);
    } finally {
      delete process.env.AGENTX_TASK_FALLBACKS_JSON;
      hostConfig.setRegisteredHosts([]);
      defaults.refreshHosts();
    }
    expect(defaults.HOSTS['cpu-fixture']).toBeUndefined();
  });
});

describe('a task keeps to hosts of its residency', () => {
  test('a CPU-routed task never follows its model to a GPU host, and the reverse', () => {
    const defaults = require('../../src/services/modelRouterDefaults');
    defaults.refreshHosts();
    const keys = Object.keys(defaults.HOSTS).filter(key => defaults.HOSTS[key]);
    expect(keys).toEqual(expect.arrayContaining(['primary', 'cpu-fixture']));
    expect(keys.filter(defaults.sameResidencyAs('cpu-fixture'))).toEqual(['cpu-fixture']);
    expect(keys.filter(defaults.sameResidencyAs('primary'))).not.toContain('cpu-fixture');
    hostConfig.setRegisteredHosts([]);
    defaults.refreshHosts();
  });

  test('the operations watch task stays on its configured host', () => {
    const defaults = require('../../src/services/modelRouterDefaults');
    expect(defaults.DEFAULT_TASK_MODELS.ops_watch).toEqual(expect.objectContaining({ model: expect.any(String) }));
    expect(defaults.STRICT_CONFIGURED_HOST_TASKS.has('ops_watch')).toBe(true);
  });
});

describe('latency alerts on a CPU host', () => {
  test('a slow answer is an incident on a GPU host, not on a CPU host', () => {
    const alertService = require('../../src/services/alertService');
    const { evaluateResponseAlerts } = require('../../src/services/routing/inferenceAlerts');
    const evaluate = jest.spyOn(alertService, 'evaluateEvent').mockResolvedValue({});
    jest.spyOn(alertService, 'resolveRecoveredInferenceAlerts').mockResolvedValue(0);
    const slow = target => evaluateResponseAlerts({
      lane: { alert: true }, response: { ok: true }, startedAt: Date.now() - 60000, routedHostKey: 'fixture',
      target, model: MODEL, body: {}, taskType: 'ops_watch', laneName: 'automated'
    });
    slow(CPU_URL);
    expect(evaluate).not.toHaveBeenCalled();
    slow(GPU_URL);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ metric: 'latency' }));
    evaluateResponseAlerts({ lane: { alert: true }, response: { ok: false, status: 500 }, startedAt: Date.now(),
      routedHostKey: 'fixture', target: CPU_URL, model: MODEL, body: {}, taskType: 'ops_watch', laneName: 'automated' });
    expect(evaluate).toHaveBeenLastCalledWith(expect.objectContaining({ metric: 'error' }));
    jest.restoreAllMocks();
  });
});
