/**
 * Characterization tests for POST /api/inference/generate — executor groundwork.
 *
 * The follow-up extracts this handler into a reusable executor "without contract change"
 * and then migrates callers one canary at a time. That requirement is only
 * checkable against an oracle, and the existing suites pin exact-artifact
 * routing, timeouts (inferenceTimeout), and the host allowlist —
 * not the invariants the card actually names: claims, host gate, cancellation,
 * and exactly-once telemetry.
 *
 * These tests pin CURRENT behaviour deliberately, including anything that later
 * turns out to be wrong. That is what a characterization suite is for: the
 * extraction must be provably behaviour-preserving first, and any correction is
 * a separate, visible change afterwards.
 *
 * The failure mode most worth guarding: an extraction that records telemetry in
 * both the new executor and the old route path. Double-counted inference logs
 * are invisible in a diff, silently corrupt cost and usage analytics, and are
 * very hard to notice after the fact.
 */

const express = require('express');
const request = require('supertest');
const fetch = require('node-fetch');

jest.mock('node-fetch');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(),
  classifyQuery: jest.fn(),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  getTargetForModel: jest.fn(() => 'http://primary:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn((url) => (url && url.includes('primary') ? 'primary' : null)),
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
  getModelReadiness: jest.fn(async () => ({
    readiness: { stage: 'available', benchmarkQualified: false, stale: false, isReady: false }
  })),
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
  hasActiveBenchmarkClaim: jest.fn((pref) => !!(pref?.status === 'benchmarking' || pref?.benchmarkClaim?.batchId)),
  get: jest.fn(async () => null),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  start: jest.fn(),
  stop: jest.fn(),
}));

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/routing/taskFallbackLadder', () => ({
  ...jest.requireActual('../../src/services/routing/taskFallbackLadder'),
  fallbackAfterRefusal: jest.fn(async () => null),
}));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null) }));

const hostGate = require('../../src/services/hostGate');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const logger = require('../../config/logger');
const { recordInference } = require('../../src/services/modelRouter');
const {
  ensureTaskModelOverridesLoaded,
  getAdvisoryModelForTask,
  getModelForTask,
} = require('../../src/services/modelRouterConfig');
const apiRoutes = require('../../routes/api');
const { fallbackAfterRefusal } = require('../../src/services/routing/taskFallbackLadder');
const { executeInference } = require('../../src/services/inferenceService');

describe('caller-neutral generation entry point', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  test.each([
    { model: 'test-model', prompt: 'hello' },
    { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], rawResponse: true },
    { model: 'test-model', prompt: 'hello', callerDetail: 'nestor/panel/ask', options: { num_ctx: 4096, num_predict: 12 } },
    { prompt: 'missing model' },
    { model: 'test-model', prompt: 'hello', useAdapted: true },
  ])('HTTP and in-process consumers preserve the same result for %j', async (body) => {
    mockOllamaOk();
    const http = await request(app).post('/api/inference/generate').send(body);
    const upstream = fetch.mock.calls.filter(([url]) => /\/api\/(chat|generate)$/.test(url));
    const records = recordInference.mock.calls.length;
    jest.clearAllMocks();
    mockOllamaOk();
    const direct = await executeInference(body);
    await new Promise(resolve => process.nextTick(resolve));
    expect(direct.status).toBe(http.status);
    expect(JSON.parse(JSON.stringify(direct.body))).toEqual(http.body);
    for (const [name, value] of Object.entries(direct.headers)) {
      expect(String(value)).toBe(http.headers[name.toLowerCase()]);
    }
    const directUpstream = fetch.mock.calls.filter(([url]) => /\/api\/(chat|generate)$/.test(url));
    expect(directUpstream.map(([url, options]) => [url, options.body]))
      .toEqual(upstream.map(([url, options]) => [url, options.body]));
    expect(recordInference).toHaveBeenCalledTimes(records);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/inference/'))).toBe(false);
  });

  test('an already-cancelled internal call neither dispatches nor invents an inference', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeInference({ model: 'test-model', prompt: 'hello' }, { signal: controller.signal }))
      .resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(recordInference).not.toHaveBeenCalled();
  });
});

/** Ollama answers normally for the exact requested model. */
function mockOllamaOk(capture = {}) {
  fetch.mockImplementation((url, opts) => {
    if (typeof url === 'string' && url.includes('/api/show')) {
      return Promise.resolve({ ok: false, status: 404 });
    }
    capture.url = url;
    capture.opts = opts;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ model: 'test-model', response: 'hi', done: true }),
      text: async () => JSON.stringify({ model: 'test-model', response: 'hi', done: true }),
    });
  });
}

describe('POST /api/inference/generate — behaviour contract', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  describe('exactly-once telemetry', () => {
    test('a successful request records exactly one inference', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(200);

      // The single most important invariant for the extraction. Recording in
      // both the new executor and the old path is invisible in a diff and
      // silently corrupts cost and usage analytics.
      expect(recordInference).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        '[InferenceProxy] route outcome',
        expect.objectContaining({
          outcomeCode: 'execution_succeeded',
          routeDecision: expect.objectContaining({
            actual: expect.objectContaining({ model: 'test-model', host: 'primary' })
          })
        })
      );
    });

    test('a failed request also records exactly one inference', async () => {
      fetch.mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/api/show')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        return Promise.reject(new Error('connection refused'));
      });

      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' });

      expect(recordInference).toHaveBeenCalledTimes(1);
      expect(recordInference).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' })
      );
    });

    test('a request rejected before dispatch records nothing', async () => {
      // Validation failures never reached Ollama, so they are not inferences.
      // An extraction that records on every entry would invent traffic.
      const response = await request(app)
        .post('/api/inference/generate')
        .send({ prompt: 'no model and no taskType' })
        .expect(400);

      expect(response.headers['x-agentx-route-outcome']).toBe('request_target_required');
      expect(recordInference).not.toHaveBeenCalled();
    });

    test('a route-policy rejection exposes one stable reason without inventing an inference', async () => {
      const response = await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello', host: 'http://not-allowlisted.invalid:11434' })
        .expect(400);

      expect(response.headers['x-agentx-route-outcome']).toBe('host_override_rejected');
      expect(recordInference).not.toHaveBeenCalled();
    });

    test('an internal pre-dispatch failure returns a stable outcome header without inventing an inference', async () => {
      ensureTaskModelOverridesLoaded.mockRejectedValueOnce(new Error('router config unavailable'));

      const response = await request(app)
        .post('/api/inference/generate')
        .send({ taskType: 'quick_chat', prompt: 'hello' })
        .expect(500);

      expect(response.body).toEqual({ status: 'error', message: 'router config unavailable' });
      expect(response.headers['x-agentx-route-outcome']).toBe('pre_dispatch_error');
      expect(recordInference).not.toHaveBeenCalled();
    });

    test('a benchmark-claim dependency error preserves the established response envelope', async () => {
      hostPreferenceService.getByHost.mockRejectedValueOnce(new Error('claim store unavailable'));

      const response = await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(503);

      expect(response.body).toEqual({
        status: 'error',
        code: 'BENCHMARK_CLAIM_ACTIVE',
        message: 'claim store unavailable',
        data: {
          host: 'http://primary:11434',
          batchId: null,
          lane: 'automated',
        },
      });
      expect(response.headers['x-agentx-route-outcome']).toBe('pre_dispatch_error');
      expect(recordInference).not.toHaveBeenCalled();
    });

    test('an Open hold returns actionable retry metadata without dispatching another model', async () => {
      const expiresAt = new Date(Date.now() + 60000);
      hostPreferenceService.getByHost.mockResolvedValueOnce({ sessionHold: {
        holdId: 'open-hold', owner: 'household/open', model: 'open-model', expiresAt
      } });
      const response = await request(app).post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' }).expect(503);
      expect(response.body).toMatchObject({ code: 'HOST_SESSION_HOLD_ACTIVE', data: {
        holdModel: 'open-model', holdExpiresAt: expiresAt.toISOString(), retryAfterMs: expect.any(Number)
      } });
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(response.headers['retry-after'])).toBe(Math.ceil(response.body.data.retryAfterMs / 1000));
      expect(recordInference).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    test('operator callers cannot replay a redacted claim identity as Benchmark capability', async () => {
      hostPreferenceService.getByHost.mockResolvedValueOnce({
        status: 'benchmarking',
        benchmarkClaim: {
          batchId: 'batch-secret',
          claimGeneration: 'generation-secret'
        }
      });
      const response = await request(app)
        .post('/api/inference/generate')
        .send({
          model: 'test-model',
          prompt: 'hello',
          callerDetail: 'benchmark-batch-secret',
          claimBatchId: 'batch-secret',
          claimGeneration: 'generation-secret'
        })
        .expect(503);
      expect(response.body.code).toBe('BENCHMARK_CLAIM_ACTIVE');
      expect(fetch).not.toHaveBeenCalled();
      expect(recordInference).not.toHaveBeenCalled();
    });

    test('telemetry carries the caller attribution the request supplied', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello', callerDetail: 'nestor/panel/ask' })
        .expect(200);

      expect(recordInference).toHaveBeenCalledWith(
        expect.objectContaining({ callerDetail: 'nestor/panel/ask' })
      );
    });

    test('telemetry carries a safe contract/outcome observation without response text', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(200);

      const entry = recordInference.mock.calls[0][0];
      expect(entry.observability).toEqual(expect.objectContaining({
        contract: expect.objectContaining({ version: 'agentx.inference-contract.v1' }),
        outcome: expect.objectContaining({ visibleFinal: true, completed: true }),
      }));
      expect(entry.observability.outcome).not.toHaveProperty('content');
      expect(entry.observability.outcome).not.toHaveProperty('response');
      expect(entry.observability.contract).not.toHaveProperty('prompt');
    });
  });

  describe('host gate', () => {
    test('a non-stream request acquires and releases exactly one slot', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(200);

      const entry = hostGate.stats().entries['http://primary:11434::test-model'];
      expect(entry.totalAcquired).toBe(1);
      expect(entry.totalReleased).toBe(1);
      // Leaking a slot starves every other caller for that (host, model).
      expect(entry.inFlight).toBe(0);
    });

    test('the direct lane skips semaphore admission but remains visible to the pre-claim drain', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .set('X-AgentX-Caller', 'benchmark-service')
        .send({
          model: 'test-model',
          prompt: 'hello',
          callerDetail: 'benchmark-batch-abc123',
          workloadAdmissionId: 'workload-admission-abc123',
          workloadGeneration: 'workload-generation-abc123'
        })
        .expect(200);

      // Bench/profiler self-sequence per host, but passive tracking is required
      // so a claim snapshot cannot race a direct request already in flight.
      const entry = hostGate.stats().entries['http://primary:11434::test-model'];
      expect(entry).toMatchObject({
        totalAcquired: 0,
        totalTracked: 1,
        trackedInFlight: 0,
        inFlight: 0
      });
    });

    test('forwards native tool schemas only for an admitted benchmark campaign', async () => {
      mockOllamaOk();
      const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
      await request(app)
        .post('/api/inference/generate')
        .set('X-AgentX-Caller', 'benchmark-service')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'use a tool' }],
          tools,
          rawResponse: true,
          callerDetail: 'benchmark-batch-tool-qualification',
          workloadAdmissionId: 'workload-admission-tools',
          workloadGeneration: 'workload-generation-tools'
        })
        .expect(200);

      const chatCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/api/chat'));
      expect(JSON.parse(chatCall[1].body)).toMatchObject({ tools, stream: false });

      const denied = await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', messages: [], tools })
        .expect(403);
      expect(denied.body).toMatchObject({ code: 'INFERENCE_TOOLS_FORBIDDEN' });
    });

    test('the interactive lane KEEPS admission', async () => {
      mockOllamaOk();
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello', callerDetail: 'chat-playground' })
        .expect(200);

      // Load-bearing: skipping this would let interactive callers cut in line
      // on a cron job mid-call and force model swaps.
      const entry = hostGate.stats().entries['http://primary:11434::test-model'];
      expect(entry.totalAcquired).toBe(1);
      expect(entry.inFlight).toBe(0);
    });
  });

  describe('cancellation', () => {
    test('a non-stream request passes an abort signal to the upstream call', async () => {
      const capture = {};
      mockOllamaOk(capture);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hello' })
        .expect(200);

      // Without a signal there is no way to stop a hung generation, and the
      // timeout path in inferenceTimeout.api.test.js depends on this wiring.
      expect(capture.opts.signal).toBeDefined();
    });
  });

  describe('request shape', () => {
    test('messages route to /api/chat and prompt routes to /api/generate', async () => {
      const chat = {};
      mockOllamaOk(chat);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })
        .expect(200);
      expect(chat.url).toContain('/api/chat');

      jest.clearAllMocks();
      hostGate._resetForTests();
      const generate = {};
      mockOllamaOk(generate);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hi' })
        .expect(200);
      expect(generate.url).toContain('/api/generate');
    });

    test('caller-supplied options survive to the upstream payload', async () => {
      const capture = {};
      mockOllamaOk(capture);
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model', prompt: 'hi', options: { num_ctx: 8192, temperature: 0.2 } })
        .expect(200);

      // Explicit caller options always win — benchmark and profiler sweeps
      // depend on getting exactly what they asked for.
      const payload = JSON.parse(capture.opts.body);
      expect(payload.options.num_ctx).toBe(8192);
      expect(payload.options.temperature).toBe(0.2);
    });

    test('a structured-output format reaches the upstream payload only when supplied', async () => {
      const capture = {};
      mockOllamaOk(capture);
      const format = { type: 'string', enum: ['YES', 'NO'] };
      await request(app).post('/api/inference/generate').send({ model: 'test-model', prompt: 'hi', format }).expect(200);
      expect(JSON.parse(capture.opts.body).format).toEqual(format);

      mockOllamaOk(capture);
      await request(app).post('/api/inference/generate').send({ model: 'test-model', prompt: 'hi' }).expect(200);
      expect(JSON.parse(capture.opts.body)).not.toHaveProperty('format');
    });

    test('both required-field validations reject before any upstream call', async () => {
      await request(app)
        .post('/api/inference/generate')
        .send({ model: 'test-model' })
        .expect(400);
      await request(app)
        .post('/api/inference/generate')
        .send({ prompt: 'hi' })
        .expect(400);

      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe('RouteDecision attribution is populated', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    hostGate._resetForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  test('every recorded attempt carries a RouteDecision v1', async () => {
    // The gap this closes: the contract shipped with a schema field nothing
    // populated. 403 production calls over 24h carried zero decisions, so lane
    // alerting had an empty field to read. A shape assertion is not enough —
    // this asserts the field is actually present on the telemetry row.
    mockOllamaOk();
    const response = await request(app)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'hello', callerDetail: 'nestor/panel/ask' })
      .expect(200);

    const entry = recordInference.mock.calls[0][0];
    expect(entry.routeDecision).toBeTruthy();
    expect(entry.routeDecision.decisionVersion).toBe(1);
    expect(entry.routeDecision.attribution).toMatchObject({
      caller: 'proxy',
      callerDetail: 'nestor/panel/ask',
    });
    expect(entry.routeDecision.selected.model).toBe('test-model');
    expect(entry.routeDecision.selectionSource).toBe('model_router');
    expect(entry.routeDecision.policy).toMatchObject({
      requested: 'nestor',
      effective: 'nestor',
      lane: 'interactive',
      downgraded: false,
    });
    expect(entry.routeDecision.outcome).toEqual({
      stage: 'execution',
      code: 'execution_succeeded',
      reasonCode: null,
    });
    expect(entry.routeDecision.fallbackUsed).toBe(false);
    expect(response.headers['x-agentx-route-outcome']).toBe('execution_succeeded');
  });

  test('a fallback ladder rung is marked degraded in headers, body and telemetry', async () => {
    getModelForTask.mockReturnValue({
      model: 'task-model', host: 'primary', url: 'http://primary:11434'
    });
    const degraded = {
      degraded: true,
      fallbackFrom: { model: 'task-model', host: 'primary' },
      fallbackTo: { model: 'small-model', host: 'tertiary' },
      reason: 'host_down',
      rung: 1,
    };
    getAdvisoryModelForTask.mockResolvedValue({
      model: 'small-model',
      host: 'tertiary',
      url: 'http://tertiary:11434',
      source: 'task_fallback_ladder',
      reason: 'primary unavailable',
      recommendation: null,
      degraded,
    });
    const capture = {};
    mockOllamaOk(capture);

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', prompt: 'hello' })
      .expect(200);

    expect(capture.url).toBe('http://tertiary:11434/api/generate');
    expect(response.headers).toMatchObject({
      'x-agentx-degraded': 'true',
      'x-agentx-degraded-reason': 'host_down',
      'x-agentx-degraded-primary-model': 'task-model',
      'x-agentx-degraded-actual-model': 'small-model',
      'x-routing-source': 'task_fallback_ladder',
    });
    expect(response.body.agentx_routing).toEqual({
      degraded: true,
      fallbackFrom: { model: 'task-model', host: 'primary' },
      fallbackTo: { model: 'small-model', host: 'tertiary' },
      reason: 'host_down',
    });
    const entry = recordInference.mock.calls[0][0];
    expect(entry).toMatchObject({ fallbackUsed: true, fallbackReason: 'task_fallback_host_down' });
    expect(entry.routeDecision).toMatchObject({
      selectionSource: 'task_fallback_ladder',
      fallbackUsed: true,
      fallbackReason: 'task_fallback_host_down',
      degraded: true,
    });
  });

  test('a light task refused by a claim before dispatch is sent to the next rung once', async () => {
    getModelForTask.mockReturnValue({ model: 'task-model', host: 'primary', url: 'http://primary:11434' });
    getAdvisoryModelForTask.mockResolvedValue({
      model: 'task-model', host: 'primary', url: 'http://primary:11434', source: 'scheduler', recommendation: null,
    });
    hostPreferenceService.getByHost.mockImplementation(async (hostUrl) => (hostUrl === 'http://primary:11434'
      ? { hostUrl, status: 'benchmarking', benchmarkClaim: { batchId: 'batch-1' } } : null));
    fallbackAfterRefusal.mockResolvedValueOnce({
      model: 'small-model', host: 'tertiary', url: 'http://tertiary:11434', source: 'task_fallback_ladder',
      recommendation: null,
      degraded: { degraded: true, fallbackFrom: { model: 'task-model', host: 'primary' },
        fallbackTo: { model: 'small-model', host: 'tertiary' }, reason: 'dispatch_refused', rung: 1 },
    });
    const capture = {};
    mockOllamaOk(capture);

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', prompt: 'hello' })
      .expect(200);

    expect(fallbackAfterRefusal).toHaveBeenCalledTimes(1);
    expect(fallbackAfterRefusal).toHaveBeenCalledWith('quick_chat',
      { model: 'task-model', host: 'primary', url: 'http://primary:11434', degraded: null });
    expect(capture.url).toBe('http://tertiary:11434/api/generate');
    expect(response.headers['x-agentx-degraded-reason']).toBe('dispatch_refused');
    expect(response.body.agentx_routing).toMatchObject({ degraded: true, reason: 'dispatch_refused' });
    hostPreferenceService.getByHost.mockImplementation(async () => null);
  });

  test('a strict task whose only host is claimed gets the busy refusal, never a dispatch', async () => {
    getModelForTask.mockReturnValue({ model: 'task-model', host: 'primary', url: 'http://primary:11434' });
    getAdvisoryModelForTask.mockResolvedValue({
      model: 'task-model', host: null, url: null, source: 'scheduler-blocked',
      reason: 'task-model is only installed on primary, which is held by an active benchmark claim',
      recommendation: { blockedByBenchmarkClaim: true },
    });
    mockOllamaOk();

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'analysis', messages: [{ role: 'user', content: 'hello' }] })
      .expect(503);

    expect(response.body).toMatchObject({
      status: 'error',
      code: 'NO_UNCLAIMED_OLLAMA_HOST',
      message: expect.stringContaining('held by an active benchmark claim'),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fallbackAfterRefusal).not.toHaveBeenCalled();
  });

  test('a strict task refused by runtime admission answers with the refusal code, not a 500', async () => {
    const { beginInferenceAdmission } = require('../../src/services/inferenceAdmissionService');
    getModelForTask.mockReturnValue({ model: 'task-model', host: 'primary', url: 'http://primary:11434' });
    getAdvisoryModelForTask.mockResolvedValue({
      model: 'task-model', host: 'primary', url: 'http://primary:11434', source: 'scheduler', recommendation: null,
    });
    beginInferenceAdmission.mockRejectedValueOnce(Object.assign(
      new Error('maintenance, workload, UNKNOWN inference, or incompatible residency blocks inference on this host'),
      { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503 }
    ));
    mockOllamaOk();

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'deep_reasoning', messages: [{ role: 'user', content: 'hello' }] })
      .expect(503);

    expect(response.body).toMatchObject({
      status: 'error',
      code: 'RUNTIME_INFERENCE_ADMISSION_DENIED',
      message: expect.stringContaining('blocks inference on this host'),
    });
    expect(response.headers['x-agentx-route-outcome']).not.toBe('response_processing_error');
    expect(fetch.mock.calls.filter(([url]) => /\/api\/(chat|generate)$/.test(url))).toHaveLength(0);
    // Strict: the ladder is consulted and has no rung for this task.
    expect(fallbackAfterRefusal).toHaveBeenCalledTimes(1);
  });

  test('an explicit model or a failure after dispatch is never sent to another rung', async () => {
    fetch.mockImplementation((url) => (String(url).includes('/api/show')
      ? Promise.resolve({ ok: false, status: 404 })
      : Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', type: 'system' }))));
    getModelForTask.mockReturnValue({ model: 'task-model', host: 'primary', url: 'http://primary:11434' });
    getAdvisoryModelForTask.mockResolvedValue({ model: 'task-model', host: 'primary', url: 'http://primary:11434', source: 'scheduler' });

    await request(app).post('/api/inference/generate').send({ taskType: 'quick_chat', prompt: 'hello' }).expect(502);
    hostPreferenceService.getByHost.mockImplementation(async (hostUrl) => ({ hostUrl, status: 'benchmarking', benchmarkClaim: { batchId: 'b' } }));
    await request(app).post('/api/inference/generate').send({ taskType: 'quick_chat', model: 'test-model', prompt: 'hello' }).expect(503);
    hostPreferenceService.getByHost.mockImplementation(async () => null);
    expect(fallbackAfterRefusal).not.toHaveBeenCalled();
  });

  test('task routing records the already-selected advisory source without changing the target', async () => {
    getModelForTask.mockReturnValue({
      model: 'task-model', host: 'primary', url: 'http://primary:11434'
    });
    getAdvisoryModelForTask.mockResolvedValue({
      model: 'task-model',
      host: 'primary',
      url: 'http://primary:11434',
      source: 'scheduler',
      reason: 'model already loaded',
      recommendation: null,
    });
    mockOllamaOk();

    const response = await request(app)
      .post('/api/inference/generate')
      .send({ taskType: 'quick_chat', prompt: 'hello' })
      .expect(200);

    const entry = recordInference.mock.calls[0][0];
    expect(entry.routeDecision).toMatchObject({
      selectionSource: 'scheduler',
      intent: { taskType: 'quick_chat', mode: 'explicit_task' },
      selected: { model: 'task-model', host: 'primary', hostUrl: 'http://primary:11434' },
      outcome: { stage: 'execution', code: 'execution_succeeded' },
    });
    expect(response.headers).toMatchObject({
      'x-agentx-route-outcome': 'execution_succeeded',
      'x-routing-source': 'scheduler',
    });
  });

  test('a failed attempt is attributed too, not just successful ones', async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/api/show')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.reject(new Error('connection refused'));
    });

    await request(app)
      .post('/api/inference/generate')
      .send({ model: 'test-model', prompt: 'hello' });

      // Failures are exactly the rows an alerting surface most needs attributed.
      const entry = recordInference.mock.calls[0][0];
      expect(entry.routeDecision?.decisionVersion).toBe(1);
      expect(entry.routeDecision.outcome).toEqual(expect.objectContaining({
        code: 'upstream_error', reasonCode: 'connection_failure'
      }));
    });

  test('the decision carries no prompt or response payload', async () => {
    const secret = 'ROUTE_SECRET_FIXTURE_83af';
    mockOllamaOk();
    await request(app)
      .post('/api/inference/generate')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: secret }],
        system: secret,
        keep_alive: secret,
        options: { stop: [secret], temperature: 0.2 },
      })
      .expect(200);

    // 30-day retention on inferencelogs — a leak here would quietly build a
    // transcript archive. buildRouteDecision enforces this, and persisting it
    // per request is exactly when that guarantee has to hold.
    const entry = recordInference.mock.calls[0][0];
    expect(JSON.stringify(entry.routeDecision)).not.toContain(secret);
    expect(JSON.stringify(entry.routingTrace)).not.toContain(secret);
    expect(entry.routingTrace.request.summary).toMatchObject({
      mode: 'chat',
      messageCount: 1,
      messageShape: [{ index: 0, role: 'user', chars: secret.length }],
    });
    expect(entry.routingTrace.ollama).not.toHaveProperty('options');
    expect(entry.routingTrace.ollama).not.toHaveProperty('think');
    expect(entry.routingTrace.ollama).not.toHaveProperty('keepAlive');
    expect(entry.routingTrace.ollama.optionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });
});
