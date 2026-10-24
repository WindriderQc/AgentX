'use strict';

// Dispatch of topology role routes (#360, phase 2): an unresolved role and a
// request that does not fit its lane are refused before any Ollama call.

const fetch = require('node-fetch');

jest.mock('node-fetch');
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(),
  classifyQuery: jest.fn(),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  getTargetForModel: jest.fn(() => 'http://primary:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn((url) => (url && url.includes('11437') ? 'lane-a' : null)),
}));
jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: { primary: 'http://primary:11434' },
  TASK_MODELS: {},
  buildRouterConfigPayload: jest.fn(),
  ensureTaskModelOverridesLoaded: jest.fn(),
  getAdvisoryModelForTask: jest.fn(),
  getDefaultTaskModels: jest.fn(() => ({})),
  getModelForTask: jest.fn(),
  resolvePreferredTaskEntry: jest.fn(),
  resetAllTaskModelOverrides: jest.fn(),
  resetTaskModelOverride: jest.fn(),
  saveTaskModelOverride: jest.fn(),
}));
jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({ readiness: { stage: 'available', isReady: false } })),
}));
jest.mock('../../src/services/inferenceAdmissionService', () => ({
  beginInferenceAdmission: jest.fn(async ({ signal } = {}) => ({
    signal: signal || new AbortController().signal,
    markDispatched: jest.fn(),
    assertActive: jest.fn(),
    complete: jest.fn(async () => ({ released: true })),
    abandon: jest.fn(async () => ({ released: true })),
  })),
}));
jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(async () => []),
  getByHost: jest.fn(async () => null),
  hasActiveBenchmarkClaim: jest.fn(() => false),
  get: jest.fn(async () => null),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  start: jest.fn(),
  stop: jest.fn(),
}));
jest.mock('../../src/services/runtimeWorkloadAdmission', () => ({
  ...jest.requireActual('../../src/services/runtimeWorkloadAdmission'),
  workloadSharesHost: jest.fn(async () => false)
}));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/routing/taskFallbackLadder', () => ({
  ...jest.requireActual('../../src/services/routing/taskFallbackLadder'),
  fallbackAfterRefusal: jest.fn(async () => null),
}));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null) }));

const hostGate = require('../../src/services/hostGate');
const { recordInference } = require('../../src/services/modelRouter');
const { getAdvisoryModelForTask, getModelForTask } = require('../../src/services/modelRouterConfig');
const { estimateInputTokens } = require('../../src/services/inferenceContractService');
const { executeInference } = require('../../src/services/inferenceService');

const LANE = 'http://gpu-host.example:11437';
const PROMPT = 'Summarize the household calendar for next week in three short bullet points.';
const OUTPUT = 200;

function laneRecommendation(laneContext) {
  return {
    model: 'lane-pin', host: 'lane-a', url: LANE, source: 'topology_role',
    reason: 'Role conversation resolved in mode lanes of group dual-gpu.',
    claimId: null, claimExpiresAt: null, recommendation: null, readiness: null,
    topology: { role: 'conversation', group: 'dual-gpu', mode: 'lanes', laneContext }
  };
}

function mockOllamaOk() {
  fetch.mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('/api/show')) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ model: 'lane-pin', response: 'ok', done: true }),
      text: async () => JSON.stringify({ model: 'lane-pin', response: 'ok', done: true }),
    });
  });
}

const dispatched = () => fetch.mock.calls.filter(([url]) => /\/api\/(chat|generate)$/.test(url));
const body = () => ({ taskType: 'general_chat', prompt: PROMPT, options: { num_predict: OUTPUT } });

beforeEach(() => {
  jest.clearAllMocks();
  hostGate._resetForTests();
  delete process.env.REQUIRE_PROFILED_MODELS;
  getModelForTask.mockReturnValue({ model: null, host: null, url: null, role: 'conversation' });
  mockOllamaOk();
});

describe('role routes at dispatch', () => {
  const estimate = () => estimateInputTokens({ prompt: PROMPT }).tokens;

  it('dispatches a request that fits the lane exactly to the resolved endpoint', async () => {
    getAdvisoryModelForTask.mockResolvedValue(laneRecommendation(estimate() + OUTPUT));
    const result = await executeInference(body());
    expect(result.status).toBe(200);
    expect(dispatched().map(([url]) => url)).toEqual([`${LANE}/api/generate`]);
    expect(result.headers['X-Routing-Source']).toBe('topology_role');
  });

  it('refuses one token over with LANE_CONTEXT_EXCEEDED and the sizes, without dispatching', async () => {
    getAdvisoryModelForTask.mockResolvedValue(laneRecommendation(estimate() + OUTPUT - 1));
    const result = await executeInference(body());
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({
      status: 'error', code: 'LANE_CONTEXT_EXCEEDED', suggestion: 'queue_for_pooled',
      data: {
        estimatedInputTokens: estimate(), outputBudget: OUTPUT, laneContext: estimate() + OUTPUT - 1,
        role: 'conversation', mode: 'lanes', suggestion: 'queue_for_pooled'
      }
    });
    expect(result.headers['X-AgentX-Route-Outcome']).toBe('lane_context_exceeded');
    expect(dispatched()).toHaveLength(0);
    await new Promise(resolve => process.nextTick(resolve));
    expect(recordInference).toHaveBeenCalledTimes(1);
    const entry = recordInference.mock.calls[0][0];
    expect(entry).toMatchObject({ status: 'error', error: 'lane_context_exceeded', routedHostUrl: LANE });
    expect(entry.routeDecision.outcome).toMatchObject({ code: 'lane_context_exceeded', reasonCode: 'lane_context_exceeded' });
    expect(entry.routingTrace.topology).toMatchObject({ role: 'conversation', laneRefusal: { suggestion: 'queue_for_pooled' } });
  });

  it('refuses an unresolved role with its typed reason, without dispatching', async () => {
    getAdvisoryModelForTask.mockResolvedValue({
      model: null, host: null, url: null, source: 'topology_role_unresolved',
      reason: 'Role conversation does not resolve: transitional.',
      claimId: null, claimExpiresAt: null, recommendation: null, readiness: null,
      topology: { role: 'conversation', group: 'dual-gpu', mode: null, laneContext: null },
      refusal: {
        status: 503, code: 'TOPOLOGY_ROLE_UNRESOLVED', reason: 'transitional',
        message: 'The conversation role does not resolve (transitional); the request was not dispatched.',
        data: { role: 'conversation', group: 'dual-gpu', mode: null, reason: 'transitional' }
      }
    });
    const result = await executeInference(body());
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      code: 'TOPOLOGY_ROLE_UNRESOLVED',
      data: { role: 'conversation', reason: 'transitional' }
    });
    expect(result.headers['X-AgentX-Route-Outcome']).toBe('topology_role_unresolved');
    expect(dispatched()).toHaveLength(0);
  });

  it('never checks the lane for a host route', async () => {
    getAdvisoryModelForTask.mockResolvedValue({
      model: 'task-model', host: 'primary', url: 'http://primary:11434', source: 'scheduler', recommendation: null
    });
    getModelForTask.mockReturnValue({ model: 'task-model', host: 'primary', url: 'http://primary:11434' });
    const result = await executeInference({ ...body(), options: { num_predict: 10 ** 7 } });
    expect(result.status).toBe(200);
    expect(dispatched()).toHaveLength(1);
  });
});
