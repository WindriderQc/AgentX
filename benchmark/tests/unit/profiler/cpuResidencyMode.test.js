jest.mock('node-fetch', () => (...args) => global.fetch(...args));
'use strict';

jest.mock('../../../src/services/hostTestService');
jest.mock('../../../src/services/contextProbeService', () => jest.requireActual('../../../src/services/contextProbeService'));
jest.mock('../../../src/services/profiler/modelProfileService');
jest.mock('../../../src/services/profiler/hostProfileService');
jest.mock('../../../src/services/profiler/settingsService');
jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const hostConfig = require('../../../src/helpers/ollamaHostConfig');
const { placementVerified, placementMismatch, cpuProbeLimits } = require('../../../src/services/probePlacement');
const { assessStep } = require('../../../src/services/profiler/contextProposal');
const contextProbeService = require('../../../src/services/contextProbeService');
const orchestrator = require('../../../src/services/profiler/profilerOrchestrator');
const { syncRegisteredHosts } = require('../../../src/services/registeredHostSync');

const CPU_URL = 'http://192.0.2.66:11435';
const GPU_URL = 'http://192.0.2.66:11434';
const MODEL = 'gemma4:26b-a4b-it-qat';
const originalFetch = global.fetch;

beforeEach(() => {
  hostConfig.setRegisteredHosts([{ id: 'cpu-fixture', url: CPU_URL, residency: 'cpu', maxInflight: 1 }]);
});

afterEach(() => {
  hostConfig.setRegisteredHosts([]);
  global.fetch = originalFetch;
});

describe('placement rule', () => {
  test('CPU hosts need no VRAM share; GPU hosts need all of it; partial never proves', () => {
    expect(placementVerified(100, 0, 'cpu')).toBe(true);
    expect(placementVerified(100, 100, 'cpu')).toBe(false);
    expect(placementVerified(100, 100, 'gpu')).toBe(true);
    expect(placementVerified(100, 40, 'gpu')).toBe(false);
    expect(placementVerified(100, 40, 'cpu')).toBe(false);
    expect(placementVerified(null, 0, 'cpu')).toBe(false);
    expect(placementMismatch(CPU_URL, 100, 0)).toBe(false);
    expect(placementMismatch(GPU_URL, 100, 0)).toBe(true);
  });

  test('a CPU probe is capped and waits longer; a GPU probe keeps its defaults', () => {
    delete process.env.CONTEXT_PROBE_CPU_MAX_CTX;
    expect(cpuProbeLimits(CPU_URL)).toEqual({ maxCtx: 32768, timeoutMs: 1200000 });
    process.env.CONTEXT_PROBE_CPU_MAX_CTX = '16384';
    try { expect(cpuProbeLimits(CPU_URL).maxCtx).toBe(16384); } finally { delete process.env.CONTEXT_PROBE_CPU_MAX_CTX; }
    expect(cpuProbeLimits(GPU_URL)).toEqual({});
  });
});

describe('context probe step on a CPU host', () => {
  const step = (vram, residency) => ({ passed: true, numCtx: 8192, tokensPerSec: 9, gpuPercent: vram ? 100 : 0,
    gpuSizeTotal: 1000, gpuSizeVram: vram, ollamaContextLength: 8192, promptCoveragePct: 80, residency });

  test('a CPU-resident sample passes on a CPU host and fails on a GPU host', () => {
    const assess = contextProbeService._internal.assessProbeStep;
    expect(assess(step(0, 'cpu'), 9).passed).toBe(true);
    expect(assess(step(0, 'gpu'), 9).passed).toBe(false);
    const leaked = assess(step(1000, 'cpu'), 9);
    expect(leaked.passed).toBe(false);
    expect(leaked.reason).toMatch(/^CPU host uses VRAM/);
  });
});

describe('profiler spill detection on a CPU host', () => {
  const ps = vram => ({ ok: true, json: async () => ({ models: [{ name: MODEL, size: 17e9, size_vram: vram }] }) });

  test('no VRAM is no spill on a CPU host, and VRAM use is', async () => {
    global.fetch = jest.fn().mockResolvedValue(ps(0));
    await expect(orchestrator._detectSpill(CPU_URL, MODEL)).resolves.toMatchObject({ verified: true, spillDetected: false });
    global.fetch = jest.fn().mockResolvedValue(ps(4e9));
    await expect(orchestrator._detectSpill(CPU_URL, MODEL)).resolves.toMatchObject({ verified: true, spillDetected: true });
  });
});

describe('context proposal evidence on a CPU host', () => {
  test('samples and co-residents are read against the CPU residency', () => {
    const sample = { passed: true, residency: 'cpu', gpuSizeTotal: 1000, gpuSizeVram: 0,
      coResidents: [{ model: 'bge-m3:latest', size: 200, sizeVram: 0, contextLength: 8192 }] };
    const otherPins = [{ model: 'bge-m3:latest', contextSize: 0 }];
    expect(assessStep({ passed: true, samples: [sample, sample] }, otherPins)).toEqual({ proven: true, recorded: true, missing: [] });
    const gpuSample = { ...sample, residency: 'gpu' };
    expect(assessStep({ passed: true, samples: [gpuSample] }, otherPins).proven).toBe(false);
  });
});

describe('host registry sync from Core', () => {
  test('a host registered in Core becomes a Benchmark target with its residency', async () => {
    hostConfig.setRegisteredHosts([]);
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { hosts: [
      { id: 'frank-cpu', name: 'Frank CPU', url: CPU_URL, residency: 'cpu', maxInflight: 1, source: 'registry' }
    ] } }) });
    await expect(syncRegisteredHosts({ coreUrl: 'http://core:3080', fetchImpl })).resolves.toEqual({ synced: true, count: 1 });
    expect(fetchImpl.mock.calls[0][1].headers['X-AgentX-Caller']).toBe('benchmark-service');
    expect(hostConfig.getHostResidency(CPU_URL)).toBe('cpu');
    expect(hostConfig.validateHostUrl(CPU_URL).valid).toBe(true);
  });

  test('an unreachable Core keeps the last snapshot', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(syncRegisteredHosts({ coreUrl: 'http://core:3080', fetchImpl })).resolves.toMatchObject({ synced: false });
    expect(hostConfig.getHostResidency(CPU_URL)).toBe('cpu');
  });
});
