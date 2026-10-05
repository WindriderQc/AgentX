'use strict';

jest.mock('../../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn(),
  getAll: jest.fn(),
  getByUrl: jest.fn(),
  upsertMetadata: jest.fn()
}));
jest.mock('../../../src/services/hostTestService', () => ({ checkHost: jest.fn() }));
jest.mock('../../../src/clients/ollamaClient', () => ({ listRunning: jest.fn() }));
jest.mock('../../../config/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const { checkHost } = require('../../../src/services/hostTestService');
const { listRunning } = require('../../../src/clients/ollamaClient');
const { readHostHardware, ollamaOrigin } = require('../../../src/services/profiler/hardwareCollectorClient');
const { getLiveProbeStatus, _internal } = require('../../../src/services/profiler/liveProbeService');
const { _compactHardwareSnapshot } = require('../../../src/services/profiler/profilerHardwareSnapshots');

const ENV = { DATAAPI_BASE_URL: 'http://data.test:3083/' };
const gpu = (index, overrides = {}) => ({
  index, name: 'Synthetic GPU', uuid: `GPU-${index}`, busId: `00000000:0${index + 1}:00.0`,
  utilizationPct: 80, memoryUtilizationPct: 30, memoryUsedMiB: 20000, memoryTotalMiB: 24576,
  temperatureC: 70, powerDrawW: 300, powerLimitW: 350, smClockMHz: 1900, smClockMaxMHz: 2100,
  pcieGen: 4, pcieGenMax: 4, pcieWidth: 16, pcieWidthMax: 16,
  throttleReasonsActive: '0x0000000000000000', throttleReasons: [],
  ...overrides
});
const dataHost = (overrides = {}) => ({
  hostId: 'gpu-a', collectorId: 'gpu-agent', ollamaUrl: 'http://gpu-a.example:11434',
  freshness: 'fresh', stale: false, ageMs: 12000, staleAfterMs: 90000,
  lastSampleAt: '2026-09-25T12:00:00.000Z', lastError: null, gpus: [gpu(0), gpu(1)],
  ...overrides
});
const respond = (body, status = 200) => jest.fn(async () => ({ ok: status < 400, status, json: async () => body }));

describe('hardware collector client (Data)', () => {
  test('is not configured without DATAAPI_BASE_URL and never calls Data', async () => {
    const fetchImpl = jest.fn();
    await expect(readHostHardware('http://gpu-a.example:11434', { env: {}, fetchImpl }))
      .resolves.toMatchObject({ status: 'not_configured', contract: 'agentx.profiler-hardware-collector/v1' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('matches the profiled Ollama URL to the collector host and reports fresh GPUs as observed', async () => {
    const fetchImpl = respond({ ok: true, data: { hosts: [dataHost({ hostId: 'other', ollamaUrl: 'http://other:11434' }), dataHost()] } });
    const result = await readHostHardware('gpu-a.example', { env: ENV, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('http://data.test:3083/api/v1/hardware/latest', expect.any(Object));
    expect(result).toMatchObject({ status: 'observed', hostId: 'gpu-a', collectorId: 'gpu-agent', ageMs: 12000 });
    expect(result.gpus).toHaveLength(2);
    expect(ollamaOrigin('HTTP://GPU-A.example:11434/api')).toBe('http://gpu-a.example:11434');
  });

  test('carries the Ollama service observation and the known GPU count, even from a stale sample', async () => {
    const ollamaEnvironment = { source: 'systemd', unit: 'ollama.service', observedAt: '2026-09-25T11:55:00.000Z',
      ok: true, values: { OLLAMA_KV_CACHE_TYPE: 'q8_0', SECRET_TOKEN: 'never kept' } };
    const result = await readHostHardware('http://gpu-a.example:11434', {
      env: ENV, fetchImpl: respond({ ok: true, data: { hosts: [dataHost({ freshness: 'stale', stale: true, gpuCount: 2, ollamaEnvironment })] } })
    });
    expect(result).toMatchObject({ status: 'stale', knownGpuCount: 2,
      ollamaEnvironment: { ok: true, source: 'systemd', values: { OLLAMA_KV_CACHE_TYPE: 'q8_0' } } });
    expect(result.ollamaEnvironment.values).not.toHaveProperty('SECRET_TOKEN');
    expect(result.gpus).toBeUndefined();
  });

  test('stale, absent and unreachable evidence is never observed', async () => {
    await expect(readHostHardware('http://gpu-a.example:11434', {
      env: ENV, fetchImpl: respond({ ok: true, data: { hosts: [dataHost({ freshness: 'stale', stale: true, lastError: 'ssh timed out' })] } })
    })).resolves.toMatchObject({ status: 'stale', reason: 'ssh timed out' });
    await expect(readHostHardware('http://gpu-z.example:11434', {
      env: ENV, fetchImpl: respond({ ok: true, data: { hosts: [dataHost()] } })
    })).resolves.toMatchObject({ status: 'no_host' });
    await expect(readHostHardware('http://gpu-a.example:11434', {
      env: ENV, fetchImpl: respond({ ok: false, message: 'Mongo down' }, 503)
    })).resolves.toMatchObject({ status: 'unavailable', reason: 'Mongo down' });
    await expect(readHostHardware('http://gpu-a.example:11434', {
      env: ENV, fetchImpl: jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND data'); })
    })).resolves.toMatchObject({ status: 'unavailable', reason: 'getaddrinfo ENOTFOUND data' });
  });
});

describe('profiler telemetry with collector evidence', () => {
  test('fresh collector evidence makes the lab metrics observed; topology stays unknown', () => {
    const telemetry = _internal.summarizeTelemetry({ ok: true, models: [] }, { gpu: { vramTotalMiB: 49152 } }, {
      status: 'observed', source: 'agentx-data', collectorId: 'gpu-agent', hostId: 'gpu-a', ageMs: 5000,
      gpus: [gpu(0), gpu(1, { utilizationPct: 20, pcieWidth: 8, throttleReasons: ['sw_power_cap'], throttleReasonsActive: '0x4' })]
    });
    expect(telemetry.capability).toMatchObject({
      status: 'partial',
      collector: { requiredContract: 'agentx.profiler-hardware-collector/v1', status: 'observed', collectorId: 'gpu-agent', hostId: 'gpu-a' },
      unknownMetrics: ['topology']
    });
    for (const metric of ['gpu_utilization', 'temperature', 'power', 'clocks', 'throttle_reasons', 'pcie_link', 'per_gpu_balance']) {
      expect(telemetry.capability.metrics[metric]).toEqual({ status: 'observed', source: 'nvidia-smi' });
    }
    expect(telemetry.capability.metrics.vramUsedMiB).toEqual({ status: 'observed', source: 'nvidia-smi' });
    expect(telemetry).toMatchObject({
      ok: true, gpuCount: 2, utilization: 50, temperature: 70, powerDrawW: 600,
      pcieGen: 4, pcieWidth: 8, pcieWidthMax: 16, vramUsedMiB: 40000, vramTotalMiB: 49152
    });
    expect(telemetry.gpus[1]).toMatchObject({ index: 1, pcieWidth: 8, smClockMHz: 1900, throttleReasons: ['sw_power_cap'], source: 'nvidia-smi' });
    expect(telemetry.diagnostics).toMatchObject({
      gpuUtilizationPct: 50, gpuImbalancePct: 60,
      pcieWarning: 'GPU 1 PCIe x8 of x16', powerWarning: 'GPU 1 at power limit', thermalWarning: null
    });
  });

  test('a single GPU marks balance not applicable; unknown values stay null', () => {
    const telemetry = _internal.summarizeTelemetry({ ok: false, models: [], error: 'down' }, {}, {
      status: 'observed', gpus: [gpu(0, { powerDrawW: null, temperatureC: null })]
    });
    expect(telemetry.source).toBe('nvidia-smi');
    expect(telemetry.capability.metrics.per_gpu_balance).toEqual({ status: 'not_applicable', source: 'nvidia-smi' });
    expect(telemetry.capability.metrics.power).toEqual({ status: 'unknown', source: 'none' });
    expect(telemetry).toMatchObject({ powerDrawW: null, temperature: null });
  });

  test('stale evidence keeps every advanced metric unknown and says why', () => {
    const telemetry = _internal.summarizeTelemetry({ ok: true, models: [] }, {}, {
      status: 'stale', reason: 'latest GPU sample is stale', ageMs: 600000, gpus: undefined
    });
    expect(telemetry.capability.collector).toMatchObject({ status: 'stale', reason: 'latest GPU sample is stale', ageMs: 600000 });
    expect(telemetry.capability.unknownMetrics).toHaveLength(8);
    expect(telemetry).toMatchObject({ utilization: null, temperature: null, gpus: [] });
  });

  test('the live probe reads Data beside Ollama and snapshots keep the collector fields', async () => {
    const previous = process.env.DATAAPI_BASE_URL;
    const originalFetch = global.fetch;
    process.env.DATAAPI_BASE_URL = ENV.DATAAPI_BASE_URL;
    global.fetch = respond({ ok: true, data: { hosts: [dataHost()] } });
    try {
      hostProfileService.getById.mockResolvedValue({ hostId: 'gpu-a', displayName: 'GPU A', hostUrl: 'http://gpu-a.example:11434', gpu: {} });
      checkHost.mockResolvedValue({ available: true, latency: 3, models: [] });
      listRunning.mockResolvedValue({ models: [] });
      const status = await getLiveProbeStatus('gpu-a');
      expect(status.telemetry.capability.collector.status).toBe('observed');
      const snapshot = _compactHardwareSnapshot(status, 'after_throughput');
      expect(snapshot).toMatchObject({ phase: 'after_throughput', ok: true, gpuCount: 2, utilization: 80 });
      expect(snapshot.gpus[0]).toMatchObject({ smClockMHz: 1900, smClockMaxMHz: 2100, throttleReasons: [], powerLimitW: 350 });
    } finally {
      global.fetch = originalFetch;
      if (previous === undefined) delete process.env.DATAAPI_BASE_URL;
      else process.env.DATAAPI_BASE_URL = previous;
    }
  });
});
