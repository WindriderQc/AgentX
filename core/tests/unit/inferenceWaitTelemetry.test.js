'use strict';

jest.mock('../../src/services/alertService', () => ({ evaluateEvent: jest.fn(async () => null) }));
jest.mock('../../src/services/modelRouter', () => ({ resolveHostKey: jest.fn(() => 'primary') }));

const InferenceLog = require('../../models/InferenceLog');
const { executeRoutedInference } = require('../../src/extensions/trustedRuntimeServices');
const { recordInference } = require('../../src/services/routing/inferenceTelemetry');
const { projectInferenceLog } = require('../../src/services/routing/inferenceLogReadProjection');
const {
  MAX_RETRY_HISTORY, attemptWaits, inferenceWaitFields, sanitizeRetry
} = require('../../src/services/routing/inferenceWaitTelemetry');
const { METRICS, buildDistributionPipeline } = require('../../src/services/inferenceDistributionService');

const GATE_DELAY_MS = 30;

function response(body = { model: 'model-a', message: { content: 'ok' }, done: true }) {
  return { ok: true, status: 200, headers: new Map(), body: null, text: jest.fn(async () => JSON.stringify(body)) };
}

function inferenceDeps(overrides = {}) {
  return {
    beginInferenceAdmission: jest.fn(async ({ signal } = {}) => ({
      signal: signal || new AbortController().signal,
      markDispatched: jest.fn(), assertActive: jest.fn(),
      complete: jest.fn(async () => ({ released: true })), abandon: jest.fn(async () => ({ released: true }))
    })),
    getTargetForModel: jest.fn(() => 'http://ollama.test:11434'),
    resolveHostKey: jest.fn(() => 'primary'),
    assertHostAvailableForConsumer: jest.fn(async () => null),
    validateHostUrl: jest.fn(host => ({ valid: true, host })),
    hostPreferenceService: { getByHost: jest.fn(async () => ({ pinnedModels: [] })) },
    modelsMatch: (left, right) => left === right,
    resolveInferenceContract: jest.fn(async () => ({ version: 1, contextBudget: { windowTokens: 32768 } })),
    applyContractOutputLimit: jest.fn(),
    hostGate: { acquire: jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, GATE_DELAY_MS));
      return jest.fn();
    }) },
    recordInference: jest.fn(async () => null),
    fetch: jest.fn(async () => response()),
    ...overrides
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('inference wait fields', () => {
  test('measured waits are rounded and unmeasured or invalid waits stay absent', () => {
    expect(attemptWaits({ admissionMs: 3.6, hostGateMs: 0 })).toEqual({ admissionMs: 4, hostGateMs: 0 });
    expect(attemptWaits({ admissionMs: null, hostGateMs: -1 })).toEqual({});
    expect(attemptWaits({ admissionMs: 'x', hostGateMs: Infinity })).toEqual({});
    expect(attemptWaits(undefined)).toEqual({});
    expect(inferenceWaitFields({ waits: { admissionMs: 12, hostGateMs: null } })).toEqual({ admissionWaitMs: 12 });
    expect(inferenceWaitFields()).toEqual({});
  });

  test('a retry history keeps codes and durations only, bounded', () => {
    const history = Array.from({ length: MAX_RETRY_HISTORY + 3 }, (_, index) => ({
      attempt: index + 1, cause: index === 0 ? 'free text with spaces' : 'workload_reserved',
      delayMs: 2000, admissionMs: 5, prompt: 'never kept', nextRetryAt: '2026-10-05T00:00:00Z'
    }));
    const sanitized = sanitizeRetry({ state: 'completed', attempts: 2, elapsedMs: 9, history, cause: 'x y' });
    expect(sanitized.history).toHaveLength(MAX_RETRY_HISTORY);
    expect(sanitized.history[0]).toEqual({ attempt: 1, cause: 'other', delayMs: 2000, admissionMs: 5 });
    expect(sanitized.history[1].cause).toBe('workload_reserved');
    expect(sanitized).toEqual({ attempts: 2, delayMs: 2000 * MAX_RETRY_HISTORY, history: sanitized.history });
    expect(sanitizeRetry({ attempts: 1, history: [{ cause: 'ECONNREFUSED', delayMs: -3 }] }))
      .toEqual({ attempts: 1, delayMs: 0, history: [{ attempt: 1, cause: 'ECONNREFUSED', delayMs: 0 }] });
    expect(sanitizeRetry({ attempts: 1, history: [] })).toBeNull();
    expect(sanitizeRetry('retry')).toBeNull();
  });
});

describe('waits on the trusted runtime path', () => {
  test('a buffered call records its admission and host gate waits', async () => {
    const deps = inferenceDeps();
    await executeRoutedInference(deps, { mode: 'generate', model: 'model-a', prompt: 'hello' });
    const entry = deps.recordInference.mock.calls[0][0];
    expect(entry.waits.admissionMs).toBeGreaterThanOrEqual(0);
    expect(entry.waits.hostGateMs).toBeGreaterThanOrEqual(GATE_DELAY_MS - 10);
    expect(entry.retry).toBeNull();
  });

  test('a streamed call records its waits once the stream settles', async () => {
    const { PassThrough } = require('stream');
    const stream = new PassThrough();
    const deps = inferenceDeps({ fetch: jest.fn(async () => ({ ...response(), body: stream })) });
    const result = await executeRoutedInference(deps, { mode: 'generate', model: 'model-a', prompt: 'hello', stream: true });
    stream.end(`${JSON.stringify({ model: 'model-a', response: 'ok', done: true })}\n`);
    for await (const _chunk of result.stream) { /* consume through verified EOF */ }
    await result.completion;
    await settle();
    expect(deps.recordInference.mock.calls[0][0].waits.hostGateMs).toBeGreaterThanOrEqual(GATE_DELAY_MS - 10);
  });

  test('a refused admission records its admission wait and no host gate wait', async () => {
    const deps = inferenceDeps();
    deps.beginInferenceAdmission.mockRejectedValueOnce(Object.assign(new Error('busy'), {
      code: 'RUNTIME_INFERENCE_ADMISSION_DENIED'
    }));
    await expect(executeRoutedInference(deps, { mode: 'generate', model: 'model-a', prompt: 'hello' })).rejects.toBeDefined();
    const entry = deps.recordInference.mock.calls[0][0];
    expect(entry.waits).toEqual({ admissionMs: expect.any(Number) });
    expect(deps.hostGate.acquire).not.toHaveBeenCalled();
  });

  test('a retried call records the waits and backoff of each failed attempt', async () => {
    const deps = inferenceDeps();
    deps.fetch.mockRejectedValueOnce(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED', type: 'system' }));
    await executeRoutedInference(deps, { mode: 'generate', model: 'model-a', prompt: 'hello' },
      { retry: { enabled: true, wait: async () => {} } });
    const entry = deps.recordInference.mock.calls[0][0];
    expect(entry.retry.attempts).toBe(2);
    expect(entry.retry.history).toEqual([expect.objectContaining({
      attempt: 1, cause: 'connection_unavailable', delayMs: 2000,
      admissionMs: expect.any(Number), hostGateMs: expect.any(Number)
    })]);
    expect(entry.retry.history[0].hostGateMs).toBeGreaterThanOrEqual(GATE_DELAY_MS - 10);
    expect(entry.waits.hostGateMs).toBeGreaterThanOrEqual(GATE_DELAY_MS - 10);
  });
});

describe('waits in InferenceLog and its readers', () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(async () => {
    process.env.NODE_ENV = 'development'; // recordInference is a no-op under test
    await InferenceLog.deleteMany({});
  });
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  test('waits and a sanitized retry history are stored and projected', async () => {
    await recordInference({
      host: 'http://ollama.test:11434', model: 'model-wait', caller: 'proxy', durationMs: 4100,
      waits: { admissionMs: 12.4, hostGateMs: 3900 },
      retry: { state: 'completed', attempts: 2, elapsedMs: 4000,
        history: [{ attempt: 1, cause: 'workload_reserved', delayMs: 2000, admissionMs: 3, note: 'dropped' }] }
    });
    const row = await InferenceLog.findOne({ model: 'model-wait' }).lean();
    expect(row).toMatchObject({ admissionWaitMs: 12, hostGateWaitMs: 3900 });
    expect(row.retry).toEqual({ attempts: 2, delayMs: 2000,
      history: [{ attempt: 1, cause: 'workload_reserved', delayMs: 2000, admissionMs: 3 }] });
    expect(projectInferenceLog(row)).toMatchObject({ admissionWaitMs: 12, hostGateWaitMs: 3900, retry: row.retry });
  });

  test('a row without measured waits stores none', async () => {
    await recordInference({ host: 'http://ollama.test:11434', model: 'model-nowait', caller: 'proxy' });
    const row = await InferenceLog.findOne({ model: 'model-nowait' }).lean();
    const projected = projectInferenceLog(row);
    for (const field of ['admissionWaitMs', 'hostGateWaitMs', 'retry']) {
      expect(row).not.toHaveProperty(field);
      expect(projected).not.toHaveProperty(field);
    }
  });

  test('a legacy retry value is projected only in its sanitized form', () => {
    expect(projectInferenceLog({ retry: { attempts: 1, history: [{ cause: 'Bad cause!', prompt: 'x' }] } }).retry)
      .toEqual({ attempts: 1, delayMs: 0, history: [{ attempt: 1, cause: 'other', delayMs: 0 }] });
    expect(projectInferenceLog({ retry: 'text' }).retry).toBeNull();
  });

  test('the distribution reports both waits as metrics', () => {
    expect(METRICS).toHaveProperty('admissionWaitMs');
    expect(METRICS).toHaveProperty('hostGateWaitMs');
    const [, project] = buildDistributionPipeline({ match: {}, groupBy: ['host'], limit: 5 });
    expect(project.$project).toHaveProperty('admissionWaitMs');
    expect(project.$project).toHaveProperty('hostGateWaitMs');
  });
});
