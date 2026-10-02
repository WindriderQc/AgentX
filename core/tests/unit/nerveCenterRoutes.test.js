// nerveCenterRoutes.test.js

// Set env vars BEFORE requiring modules
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';
process.env.MODEL_HEALTH_CACHE_TTL_MS = '0';
process.env.NODE_ENV = 'test';

// Mock dependencies
jest.mock('node-fetch', () => jest.fn(() =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
));
const mockRefreshRagStatus = jest.fn();
const mockListRagDocuments = jest.fn();
jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: () => ({
    refreshStatus: mockRefreshRagStatus,
    listDocuments: mockListRagDocuments
  })
}));

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../src/services/alertService', () => {
  const getRecentAlerts = jest.fn(() => Promise.resolve([
    {
      _id: 'alert-1',
      severity: 'warning',
      status: 'active',
      message: 'High latency on primary',
      details: 'Latency > 5000ms',
      createdAt: new Date('2026-03-27T10:00:00Z')
    }
  ]));
  const mock = {
    getRecentAlerts,
    getAlertSnapshot: jest.fn(async ({ limit = 50, filters = {} } = {}) => {
      const alerts = await getRecentAlerts(limit, filters);
      return {
        alerts,
        total: alerts.length,
        summary: {
          total: alerts.length,
          activeCount: alerts.length,
          bySeverity: { warning: alerts.length },
          byStatus: { active: alerts.length },
          basis: { activePredicate: { status: 'active' } },
          observedAt: '2026-08-28T12:00:00.000Z'
        }
      };
    }),
    getStatistics: jest.fn(() => Promise.resolve({})),
    getAlertService: jest.fn()
  };
  mock.getAlertService = () => mock;
  return mock;
});

const mockInferenceLogLean = jest.fn();
const mockInferenceLogLimit = jest.fn(() => ({ lean: mockInferenceLogLean }));
const mockInferenceLogSort = jest.fn(() => ({ limit: mockInferenceLogLimit, lean: mockInferenceLogLean }));
const mockLatestInferenceLean = jest.fn(() => Promise.resolve(null));
const mockLatestInferenceSort = jest.fn(() => ({ lean: mockLatestInferenceLean }));
const mockInferenceLogFind = jest.fn(() => ({
  sort: mockInferenceLogSort,
  limit: mockInferenceLogLimit,
  lean: mockInferenceLogLean,
  select: jest.fn(() => ({ lean: mockInferenceLogLean }))
}));

jest.mock('../../models/InferenceLog', () => {
  const rows = [
    {
      _id: 'log-1',
      host: 'http://primary:11434',
      hostKey: 'primary',
      model: 'qwen2.5:7b',
      taskType: 'general_chat',
      status: 'success',
      durationMs: 1200,
      tokensIn: 1000,
      tokensOut: 250,
      timestamp: new Date('2026-03-27T09:55:00Z')
    }
  ];
  mockInferenceLogLean.mockResolvedValue(rows);
  return {
    find: mockInferenceLogFind,
    findOne: jest.fn(() => ({ sort: mockLatestInferenceSort })),
    countDocuments: jest.fn(() => Promise.resolve(0))
  };
});

jest.mock('../../src/services/costCalculator', () => ({
  calculateMessageCost: jest.fn(() => Promise.resolve({ totalCost: 0.0015 }))
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(() => Promise.resolve([
    {
      hostUrl: 'http://primary:11434',
      preferredModel: 'qwen3-2507-30b-long-48k:latest',
      state: 'ready'
    }
  ])),
  get: jest.fn(() => Promise.resolve(null)),
  upsert: jest.fn(() => Promise.resolve({})),
  reload: jest.fn(() => Promise.resolve())
}));

const mockRouterTaskOverrideState = new Map();

jest.mock('../../models/RouterTaskConfig', () => ({
  find: jest.fn(() => ({
    lean: jest.fn(() => Promise.resolve([...mockRouterTaskOverrideState.values()]))
  })),
  findOneAndUpdate: jest.fn((_query, update) => {
    mockRouterTaskOverrideState.set(update.taskType, {
      taskType: update.taskType,
      model: update.model,
      host: update.host
    });
    return Promise.resolve(update);
  }),
  deleteOne: jest.fn(({ taskType }) => {
    mockRouterTaskOverrideState.delete(taskType);
    return Promise.resolve({ deletedCount: 1 });
  }),
  deleteMany: jest.fn(() => {
    mockRouterTaskOverrideState.clear();
    return Promise.resolve({ deletedCount: mockRouterTaskOverrideState.size });
  })
}));

jest.mock('../../models/ModelRegistry', () => ({
  find: jest.fn(() => {
    const chain = {
      sort: jest.fn(() => chain),
      select: jest.fn(() => chain),
      lean: jest.fn(() => Promise.resolve([
        { modelName: 'qwen3.5:9b' },
        { modelName: 'qwen3-2507-30b-long-48k' },
        { modelName: 'qwen2.5:7b' }
      ]))
    };
    return chain;
  })
}));

jest.mock('../../src/services/ollamaVramService', () => ({
  getVramForHosts: jest.fn(async (hosts) => hosts.map(host => ({
    ...host, memoryTotalMiBTotal: 0, memoryUsedMiBTotal: 0, _source: 'none'
  })))
}));

const express = require('express');
const request = require('supertest');
const nerveCenterRouter = require('../../routes/nerve-center');
const { buildIntelligenceSummary, getRoutingConfig, buildInferenceStats, buildRoutingAnalytics } = nerveCenterRouter;
const { calculateMessageCost } = require('../../src/services/costCalculator');
const { resetAllTaskModelOverrides, saveTaskModelOverride } = require('../../src/services/modelRouterConfig');

describe('Nerve Center Routes — Unit Tests', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRouterTaskOverrideState.clear();
    mockInferenceLogLean.mockResolvedValue([
      {
        _id: 'log-1',
        host: 'http://primary:11434',
        hostKey: 'primary',
        model: 'qwen2.5:7b',
        taskType: 'general_chat',
        status: 'success',
        durationMs: 1200,
        tokensIn: 1000,
        tokensOut: 250,
        timestamp: new Date('2026-03-27T09:55:00Z')
      }
    ]);
    await resetAllTaskModelOverrides();
  });

  describe('getRoutingConfig()', () => {
    it('should return taskModels, hosts, and routing explainer metadata', async () => {
      const config = await getRoutingConfig();

      expect(config).toHaveProperty('taskModels');
      expect(config).toHaveProperty('hosts');
      expect(config).toHaveProperty('taskMetadata');
      expect(config).toHaveProperty('explainerSteps');
      expect(config).toHaveProperty('classification');
      expect(config).toHaveProperty('defaults');
      expect(config).toHaveProperty('overrides');
      expect(config).toHaveProperty('taskConfigState');
      expect(config).toHaveProperty('availableModels');
      expect(typeof config.taskModels).toBe('object');
      expect(typeof config.hosts).toBe('object');
      expect(typeof config.taskMetadata).toBe('object');
      expect(Array.isArray(config.explainerSteps)).toBe(true);
      expect(config.classification).toHaveProperty('prompt');
      expect(Array.isArray(config.availableModels)).toBe(true);
    });

    it('should include known host keys', async () => {
      const config = await getRoutingConfig();
      expect(config.hosts).toHaveProperty('primary');
      expect(config.hosts).toHaveProperty('secondary');
      expect(config.hosts).toHaveProperty('tertiary');
    });

    it('should have TASK_MODELS with model and host per task type', async () => {
      const config = await getRoutingConfig();
      const taskKeys = Object.keys(config.taskModels);
      expect(taskKeys.length).toBeGreaterThan(0);

      for (const key of taskKeys) {
        const entry = config.taskModels[key];
        expect(entry).toHaveProperty('model');
        expect(entry).toHaveProperty('host');
      }
    });

    it('should expose default-vs-override state per task', async () => {
      await saveTaskModelOverride('quick_chat', {
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });

      const config = await getRoutingConfig();

      expect(config.taskConfigState.quick_chat.isOverride).toBe(true);
      expect(config.taskConfigState.quick_chat.override).toEqual({
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });
      expect(config.taskModels.quick_chat).toEqual({
        model: 'qwen2.5:7b',
        host: 'tertiary'
      });
      expect(config.defaults.taskModels.quick_chat).toEqual({
        model: 'gemma4:26b-a4b-it-qat',
        host: 'secondary'
      });
    });
  });

  describe('buildIntelligenceSummary()', () => {
    it('should return expected top-level keys', async () => {
      const summary = await buildIntelligenceSummary();

      expect(summary).toHaveProperty('cluster');
      expect(summary).toHaveProperty('routing');
      expect(summary).toHaveProperty('hostPreferences');
      expect(summary).toHaveProperty('alerts');
      expect(summary).toHaveProperty('alertSummary');
      expect(summary).toHaveProperty('recentRouting');
    });

    it('should return routing with failover state fields', async () => {
      const summary = await buildIntelligenceSummary();

      expect(summary.routing).toHaveProperty('currentHost');
      expect(summary.routing).toHaveProperty('isFailedOver');
      expect(summary.routing).toHaveProperty('primaryHost');
    });

    it('should return hostPreferences as an array', async () => {
      const summary = await buildIntelligenceSummary();

      expect(Array.isArray(summary.hostPreferences)).toBe(true);
      expect(summary.hostPreferences.length).toBeGreaterThan(0);
      expect(summary.hostPreferences[0]).toHaveProperty('hostUrl');
      expect(summary.hostPreferences[0]).toHaveProperty('preferredModel');
    });

    it('should return alerts as an array', async () => {
      const summary = await buildIntelligenceSummary();

      expect(Array.isArray(summary.alerts)).toBe(true);
      expect(summary.alerts.length).toBeGreaterThan(0);
      expect(summary.alerts[0]).toHaveProperty('severity');
      expect(summary.alertSummary).toEqual(expect.objectContaining({
        activeCount: 1,
        basis: { activePredicate: { status: 'active' } }
      }));
    });

    it('should return recentRouting as an array of inference logs', async () => {
      const summary = await buildIntelligenceSummary();

      expect(Array.isArray(summary.recentRouting)).toBe(true);
      expect(summary.recentRouting.length).toBeGreaterThan(0);
      expect(summary.recentRouting[0]).toHaveProperty('model');
      expect(summary.recentRouting[0]).toHaveProperty('host');
    });
  });

  describe('buildRoutingAnalytics()', () => {
    it('should summarize task, model, and host distributions for chat routing telemetry', async () => {
      const analyticsRows = [
        {
          taskType: 'analysis',
          autoRouted: true,
          classificationMs: 25,
          routedModel: 'qwen3-2507-30b-long-48k',
          routedHost: 'primary',
          durationMs: 1500
        },
        {
          taskType: 'analysis',
          autoRouted: true,
          classificationMs: 35,
          routedModel: 'qwen3-2507-30b-long-48k',
          routedHost: 'primary',
          durationMs: 2500
        },
        {
          taskType: 'translation',
          autoRouted: false,
          classificationMs: 0,
          routedModel: 'qwen3.5:9b',
          routedHost: 'secondary',
          durationMs: 1000
        }
      ];

      mockInferenceLogLean.mockResolvedValueOnce(analyticsRows);

      const analytics = await buildRoutingAnalytics(6, new Date('2026-03-27T12:00:00Z'));

      expect(analytics.summary).toEqual(expect.objectContaining({
        windowHours: 6,
        totalRequests: 3,
        autoRoutedCount: 2,
        autoRoutedPct: 66.7,
        avgDurationMs: 1666.7,
        avgClassificationMs: 30,
        avgTotalForClassifiedMs: 2000,
        classificationOverheadPct: 1.5,
        classificationSamples: 2
      }));
      expect(analytics.taskDistribution[0]).toEqual(expect.objectContaining({
        taskType: 'analysis',
        count: 2,
        avgDurationMs: 2000,
        avgClassificationMs: 30,
        percentage: 66.7
      }));
      expect(analytics.modelDistribution[0]).toEqual(expect.objectContaining({
        model: 'qwen3-2507-30b-long-48k',
        count: 2
      }));
      expect(analytics.hostDistribution[0]).toEqual(expect.objectContaining({
        host: 'primary',
        count: 2
      }));
    });

    it('uses unknown rates instead of healthy zeroes when the window has no chat requests', async () => {
      mockInferenceLogLean.mockResolvedValueOnce([]);
      const analytics = await buildRoutingAnalytics(24, new Date('2026-03-27T12:00:00Z'));

      expect(analytics.summary).toEqual(expect.objectContaining({
        totalRequests: 0,
        autoRoutedCount: 0,
        avgDurationMs: null,
        avgClassificationMs: null,
        classificationOverheadPct: null,
      }));
      expect(analytics.summary.autoRoutedPct).toBeUndefined();
    });
  });

  describe('buildInferenceStats()', () => {
    it('should return today inference count and total cost', async () => {
      const stats = await buildInferenceStats(new Date('2026-03-27T12:00:00Z'));

      expect(stats).toEqual({
        count: 1,
        totalCost: 0.0015,
        nonSuccessCount: 0,
        byCaller: { unknown: 1 },
        byStatus: { success: 1 },
        observedAt: '2026-03-27T12:00:00.000Z',
        scope: 'All internal inference-log records since 00:00 UTC; this is not a conversation count.'
      });
      expect(calculateMessageCost).toHaveBeenCalledWith('qwen2.5:7b', expect.objectContaining({
        usage: expect.objectContaining({
          promptTokens: 1000,
          completionTokens: 250,
          totalTokens: 1250
        })
      }));
    });
  });
});

describe('Nerve Center RAG evidence proxy', () => {
  const originalFetch = global.fetch;

  function createApp() {
    const app = express();
    app.use(nerveCenterRouter);
    return app;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns fresh dependency evidence without caching a healthy projection', async () => {
    mockRefreshRagStatus.mockResolvedValueOnce({
      healthy: false,
      queryReady: false,
      observedAt: '2026-08-30T12:00:00.000Z',
      dependencies: { qdrant: { healthy: false } }
    });

    const response = await request(createApp()).get('/rag/status').expect(200);

    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({
      status: 'success',
      data: {
        queryReady: false,
        dependencies: { qdrant: { healthy: false } }
      },
      meta: { source: 'rag.status.refresh' }
    });
    expect(mockRefreshRagStatus).toHaveBeenCalledWith({ timeoutMs: 5000 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when upstream readiness evidence is unavailable', async () => {
    mockRefreshRagStatus.mockRejectedValueOnce(new Error('connect private-host:6333'));

    const response = await request(createApp()).get('/rag/status').expect(502);

    expect(response.body).toEqual({
      status: 'error',
      code: 'RAG_STATUS_UNAVAILABLE',
      message: 'RAG readiness evidence is unavailable.'
    });
    expect(JSON.stringify(response.body)).not.toContain('private-host');
  });

  it('reads bounded documents through the typed owner client', async () => {
    const payload = { documents: [{ documentId: 'one' }], total: 351 };
    mockListRagDocuments.mockResolvedValueOnce(payload);
    const response = await request(createApp()).get('/rag/documents?limit=999').expect(200);
    expect(mockListRagDocuments).toHaveBeenCalledWith({ limit: 100 }, { timeoutMs: 5000 });
    expect(response.body.data).toEqual(payload);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Nerve Center GPU status from Data', () => {
  const originalFetch = global.fetch;
  const dataResponse = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const gpu = { index: 0, name: 'Synthetic GPU', utilizationPct: 64, temperatureC: 61, memoryUsedMiB: 9000,
    memoryTotalMiB: 24576, powerDrawW: 210, powerLimitW: 350, throttleReasons: ['sw_power_cap'] };

  function createApp() {
    const app = express();
    app.use(nerveCenterRouter);
    return app;
  }

  afterEach(() => { global.fetch = originalFetch; });

  it('shows fresh collector values and states staleness instead of frozen numbers', async () => {
    global.fetch = jest.fn(async (url) => {
      expect(url).toMatch(/\/api\/v1\/hardware\/latest$/);
      return dataResponse({ ok: true, data: { hosts: [
        { hostId: 'gpu-primary', collectorId: 'gpu-agent', ollamaUrl: 'http://primary:11434', freshness: 'fresh',
          ageMs: 4000, lastSampleAt: '2026-09-25T12:00:00.000Z', gpus: [gpu] },
        { hostId: 'gpu-secondary', ollamaUrl: 'http://secondary:11434', freshness: 'stale', ageMs: 3600000,
          lastError: 'ssh: connect timed out', consecutiveFailures: 40, gpus: [gpu] }
      ] } });
    });

    const response = await request(createApp()).get('/inference/gpu-status').expect(200);
    const byId = Object.fromEntries(response.body.data.map(row => [row.hostId, row]));
    expect(byId.primary).toMatchObject({
      gpuName: 'Synthetic GPU', utilization: 64, temperature: 61, gpuCount: 1,
      vramTotalMiB: 24576, vramUsedMiB: 9000, source: 'gpu-collector',
      telemetry: { status: 'fresh', ageMs: 4000, collectorHostId: 'gpu-primary' }
    });
    expect(byId.primary.gpus[0]).toMatchObject({ powerDraw: 210, powerLimit: 350, throttleReasons: ['sw_power_cap'] });
    expect(byId.secondary).toMatchObject({
      utilization: null, temperature: null, gpus: [], gpuCount: 0,
      telemetry: { status: 'stale', ageMs: 3600000, lastError: 'ssh: connect timed out' }
    });
    expect(byId.tertiary.telemetry).toMatchObject({ status: 'no_collector_host' });
  });

  it('reports Data as unavailable without failing the cluster view', async () => {
    global.fetch = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND data'); });
    const response = await request(createApp()).get('/inference/gpu-status').expect(200);
    expect(response.body.data.every(row => row.telemetry.status === 'unavailable' && row.gpus.length === 0)).toBe(true);
  });
});
