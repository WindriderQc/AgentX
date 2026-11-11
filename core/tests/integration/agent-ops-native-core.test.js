'use strict';

jest.mock('../../integrations/runtime-bridges/evidence-service', () => {
  const actual = jest.requireActual('../../integrations/runtime-bridges/evidence-service');
  const { buildAgentOpsProjection } = jest.requireActual('../../integrations/runtime-bridges/agent-ops/projection');
  return { ...actual, createAioOpsEvidenceService: jest.fn(options => actual.createAioOpsEvidenceService({
    ...options,
    openClawProvider: async () => ({ source: { degraded: true }, status: {} }),
    hermesProvider: async () => ({ gateway: { running: false } }),
    cronProvider: async () => ({}),
    agentOpsBuilder: readOptions => buildAgentOpsProjection({ ...readOptions,
      readText: async () => { throw new Error('Synthetic instance evidence unavailable'); },
      now: () => new Date('2026-11-08T00:00:00Z') })
  })) };
});

const previousEnabled = process.env.AGENTX_RUNTIME_BRIDGES_ENABLED;
process.env.AGENTX_RUNTIME_BRIDGES_ENABLED = 'true';
const request = require('supertest');
const { app } = require('../../src/app');
const InferenceLog = require('../../models/InferenceLog');
const nerveCenter = require('../../routes/nerve-center');
const budgets = require('../../routes/budget');
const { buildEcosystemSnapshot } = require('../../src/services/ecosystemSnapshotService');
const { createAioOpsEvidenceService } = require('../../integrations/runtime-bridges/evidence-service');
const { buildAgentOpsProjection } = require('../../integrations/runtime-bridges/agent-ops/projection');
const { createProductReads } = require('../../integrations/runtime-bridges/agent-ops/product-reads');

describe('integrated Agent Ops Core reads', () => {
  let nativeReads, ecosystem, budget;
  const now = () => new Date('2026-11-08T00:00:00Z');
  const inputs = { readText: async () => { throw new Error('Synthetic instance evidence unavailable'); },
    getOpenClawRuntimeEvidence: async () => ({ source: { degraded: true }, status: {} }), now };

  beforeAll(async () => {
    nativeReads = createAioOpsEvidenceService.mock.calls[0][0].productReads;
    await InferenceLog.create({ host: 'http://synthetic.example.test', model: 'synthetic-local',
      caller: 'chat', status: 'success', tokensIn: 12, tokensOut: 3, durationMs: 100 });
  });
  beforeEach(() => {
    ecosystem = jest.spyOn(nerveCenter, 'buildEcosystemSnapshot').mockImplementation(() => buildEcosystemSnapshot({
      now,
      buildIntelligence: async () => ({
        cluster: [{ hostKey: 'primary', status: 'offline', models: [], hostUrl: 'PRIVATE_HOST' }],
        routing: { authority: 'inference_log', privateInput: 'PRIVATE_SOURCE' }, hostPreferences: [], alerts: [], recentRouting: [],
        alertSummary: { activeCount: 0, basis: { activePredicate: { status: 'active' } }, observedAt: now().toISOString() }
      }),
      buildRoutingConfig: async () => ({ hosts: {}, taskModels: {}, taskConfigState: {} }),
      buildServiceStatus: async () => ({ generatedAt: now().toISOString(), services: [],
        summary: { status: 'degraded' }, consistency: { status: 'ok', issues: [] } })
    }));
    budget = jest.spyOn(budgets, 'buildBudgetStatus');
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Synthetic transport unavailable'));
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  afterAll(() => {
    if (previousEnabled === undefined) delete process.env.AGENTX_RUNTIME_BRIDGES_ENABLED;
    else process.env.AGENTX_RUNTIME_BRIDGES_ENABLED = previousEnabled;
  });

  test('Core explicitly supplies two producers to the real registration and Agent Ops endpoint', async () => {
    expect(Object.keys(nativeReads).sort()).toEqual(['budget', 'ecosystem']);
    const apiBudget = (await request(app).get('/api/budget/status').expect(200)).body;
    expect(apiBudget).toMatchObject({ period: '24h', total_requests: 1, total_prompt_tokens: 12, total_completion_tokens: 3 });
    const { data } = (await request(app).get('/api/agent-ops').expect(200)).body;
    expect(ecosystem).toHaveBeenCalledWith(); expect(budget).toHaveBeenCalledWith();
    expect(data.sources.ecosystem.status).toBe('ok');
    expect(data.sources.pipeline.status).toBe('degraded');
    expect(data.utilization).toMatchObject({ period: '24h', localRequests: apiBudget.local_requests,
      localTokens: apiBudget.local_tokens, localHealth: apiBudget.budget_health });
    for (const [url] of global.fetch.mock.calls) expect(String(url)).not.toMatch(/\/api\/nerve-center\/ecosystem|\/api\/budget\/status/);
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE_HOST|PRIVATE_SOURCE/);
  });

  test('real canonical producers and consumer keep the same projection over native and HTTP bodies', async () => {
    // Source activity is timestamped before chronological sorting. Freeze only
    // Date so the two reads have identical observations, not just normalized
    // timestamps after sorting. MongoDB and transport timers remain real.
    jest.useFakeTimers({ now: Date.now(), doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask',
      'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout'
    ] });
    const ecosystemBody = await nativeReads.ecosystem(), budgetBody = await nativeReads.budget();
    expect(ecosystemBody.data.health.status).toBe('degraded');
    const native = createProductReads({ nativeReads });
    const http = createProductReads({ baseUrl: 'http://core.example.test', options: {
      fetchImpl: async url => {
        if (url.endsWith('/ecosystem')) return new Response(JSON.stringify(ecosystemBody));
        if (url.endsWith('/api/budget/status')) return new Response(JSON.stringify(budgetBody));
        throw new Error('Synthetic transport unavailable');
      }
    } });
    const nativeProjection = await buildAgentOpsProjection({ ...inputs, fetchJson: native });
    const httpProjection = await buildAgentOpsProjection({ ...inputs, fetchJson: http });
    // Transport collection durations can differ. All data, timestamps,
    // disclosures and chronological ordering must agree exactly.
    const stable = value => JSON.parse(JSON.stringify(value, (key, field) => {
      if (key === 'durationMs') return 0;
      if (key === 'timestamp') expect(Number.isFinite(Date.parse(field))).toBe(true);
      return field;
    }));
    expect(stable(nativeProjection)).toEqual(stable(httpProjection));
  });

  test('native budget errors remain unknown and partial; ecosystem errors still fail closed', async () => {
    budget.mockRejectedValue(new Error('PRIVATE_COLLECTOR_ERROR'));
    const read = createProductReads({ nativeReads });
    const data = await buildAgentOpsProjection({ ...inputs, fetchJson: read });
    expect(data.utilization.localHealth).toBe('unknown'); expect(data.utilization.cloudHealth).toBe('unknown');
    expect(JSON.stringify(data)).not.toContain('PRIVATE_COLLECTOR_ERROR');
    ecosystem.mockRejectedValue(new Error('PRIVATE_ECOSYSTEM_ERROR'));
    await expect(buildAgentOpsProjection({ ...inputs, fetchJson: read })).rejects.toMatchObject({
      code: 'AGENT_OPS_ECOSYSTEM_UNAVAILABLE', statusCode: 503
    });
    for (const [url] of global.fetch.mock.calls) expect(String(url)).not.toMatch(/\/api\/nerve-center\/ecosystem|\/api\/budget\/status/);
  });
});
