'use strict';

const { PassThrough } = require('stream');

jest.mock('../../src/services/alertService', () => ({ evaluateEvent: jest.fn(async () => null) }));
jest.mock('../../src/services/modelRouter', () => ({ resolveHostKey: jest.fn(() => 'primary') }));

const InferenceLog = require('../../models/InferenceLog');
const { ollamaPhaseTimings } = require('../../src/helpers/ollamaResponseHandler');
const { executeRoutedInference } = require('../../src/extensions/trustedRuntimeServices');
const { recordInference } = require('../../src/services/routing/inferenceTelemetry');
const { projectInferenceLog } = require('../../src/services/routing/inferenceLogReadProjection');
const { createPromptPrefixTracker } = require('../../src/services/routing/promptPrefixFingerprint');

const PRIVATE_TEXT = 'synthetic-private-turn-7781';
const DURATIONS = { load_duration: 1_500_000, prompt_eval_duration: 2_345_678_901, eval_duration: 987_654_321 };

function response({ ok = true, status = 200, body = {}, stream = null } = {}) {
  return { ok, status, headers: new Map(), body: stream, text: jest.fn(async () => JSON.stringify(body)) };
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
    hostGate: { acquire: jest.fn(async () => jest.fn()) },
    recordInference: jest.fn(async () => null),
    fetch: jest.fn(async () => response({ body: { model: 'model-a', message: { content: 'ok' }, done: true } })),
    ...overrides
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function drain(stream) {
  for await (const _chunk of stream) { /* consume through verified EOF */ }
}

function chat(content = PRIVATE_TEXT) {
  return {
    mode: 'chat', model: 'model-a',
    messages: [{ role: 'system', content: `Preamble\n## Workspace\n${PRIVATE_TEXT}` }, { role: 'user', content }],
    tools: [{ type: 'function', function: { name: 'read' } }]
  };
}

describe('Ollama phase timings', () => {
  test('nanoseconds become rounded milliseconds and unreported phases stay absent', () => {
    expect(ollamaPhaseTimings({ done: true, ...DURATIONS })).toEqual({ loadMs: 2, promptEvalMs: 2346, evalMs: 988 });
    expect(ollamaPhaseTimings({ done: true, eval_duration: 0 })).toEqual({ evalMs: 0 });
    expect(ollamaPhaseTimings({ done: true, load_duration: null, eval_duration: '5' })).toEqual({});
    expect(ollamaPhaseTimings({ firstTokenMs: 41.6 })).toEqual({ firstTokenMs: 42 });
    expect(ollamaPhaseTimings(null)).toEqual({});
  });

  test('a buffered trusted-runtime call records the final response phases', async () => {
    const deps = inferenceDeps({ fetch: jest.fn(async () => response({
      body: { model: 'model-a', message: { content: 'ok' }, done: true, prompt_eval_count: 17000, eval_count: 46, ...DURATIONS }
    })) });
    await executeRoutedInference(deps, chat());
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({
      tokensIn: 17000, tokensOut: 46, loadMs: 2, promptEvalMs: 2346, evalMs: 988
    }));
    expect(deps.recordInference.mock.calls[0][0]).not.toHaveProperty('firstTokenMs');
  });

  test('a buffered response without durations records no phase fields', async () => {
    const deps = inferenceDeps();
    await executeRoutedInference(deps, chat());
    const entry = deps.recordInference.mock.calls[0][0];
    for (const field of ['loadMs', 'promptEvalMs', 'evalMs', 'firstTokenMs']) expect(entry).not.toHaveProperty(field);
  });

  test('a streamed trusted-runtime call records terminal phases and time to first output', async () => {
    const upstream = new PassThrough();
    const deps = inferenceDeps({ fetch: jest.fn(async () => response({ stream: upstream })) });
    const result = await executeRoutedInference(deps, { ...chat(), stream: true });
    const reading = drain(result.stream);
    upstream.write(`${JSON.stringify({ done: false, message: { role: 'assistant', content: '' } })}\n`);
    upstream.write(`${JSON.stringify({ done: false, message: { tool_calls: [{ function: { name: 'read', arguments: {} } }] } })}\n`);
    upstream.end(`${JSON.stringify({ done: true, prompt_eval_count: 17000, eval_count: 46, ...DURATIONS })}\n`);
    await reading;
    await expect(result.completion).resolves.toMatchObject({ completed: true, ...DURATIONS });
    await settle();
    const entry = deps.recordInference.mock.calls[0][0];
    expect(entry).toMatchObject({ status: 'success', tokensIn: 17000, loadMs: 2, promptEvalMs: 2346, evalMs: 988 });
    expect(entry.firstTokenMs).toEqual(expect.any(Number));
    expect(entry.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  test('a stream without output frames or durations records no phase fields', async () => {
    const upstream = new PassThrough();
    const deps = inferenceDeps({ fetch: jest.fn(async () => response({ stream: upstream })) });
    const result = await executeRoutedInference(deps, { ...chat(), stream: true });
    const reading = drain(result.stream);
    upstream.end(`${JSON.stringify({ done: true, message: { content: '' } })}\n`);
    await reading;
    await result.completion;
    await settle();
    const entry = deps.recordInference.mock.calls[0][0];
    for (const field of ['loadMs', 'promptEvalMs', 'evalMs', 'firstTokenMs']) expect(entry).not.toHaveProperty(field);
  });
});

describe('prompt prefix on the trusted runtime', () => {
  test('an opted-in chat call records its divergence without changing the Ollama request', async () => {
    const tracker = createPromptPrefixTracker();
    const deps = inferenceDeps({ observePromptPrefix: tracker.observe });
    const plain = inferenceDeps();
    await executeRoutedInference(plain, chat());
    await executeRoutedInference(deps, chat(), { observePromptPrefix: true });
    await executeRoutedInference(deps, chat('second synthetic turn'), { observePromptPrefix: true });

    expect(deps.fetch.mock.calls[0][1].body).toBe(plain.fetch.mock.calls[0][1].body);
    for (const [, init] of deps.fetch.mock.calls) {
      expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(['messages', 'model', 'stream', 'tools']);
    }
    expect(deps.recordInference.mock.calls[0][0].promptPrefix.divergence).toEqual({ kind: 'first', index: null, heading: null });
    const second = deps.recordInference.mock.calls[1][0].promptPrefix;
    expect(second).toEqual({ systemSections: 2, messages: 1, toolsHash: expect.stringMatching(/^[0-9a-f]{8}$/),
      divergence: { kind: 'message', index: 0, heading: null } });
    expect(JSON.stringify(deps.recordInference.mock.calls)).not.toContain(PRIVATE_TEXT);
    expect(plain.recordInference.mock.calls[0][0]).not.toHaveProperty('promptPrefix');
  });

  test('a call refused before admission neither records nor replaces the compared prompt', async () => {
    const tracker = createPromptPrefixTracker();
    const deps = inferenceDeps({ observePromptPrefix: tracker.observe });
    await executeRoutedInference(deps, chat(), { observePromptPrefix: true });
    deps.beginInferenceAdmission.mockRejectedValueOnce(Object.assign(new Error('busy'), {
      code: 'RUNTIME_INFERENCE_ADMISSION_DENIED'
    }));
    await expect(executeRoutedInference(deps, chat('refused synthetic turn'), { observePromptPrefix: true }))
      .rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' });
    await executeRoutedInference(deps, chat(), { observePromptPrefix: true });
    const rows = deps.recordInference.mock.calls.map(([entry]) => entry);
    expect(rows[1]).toMatchObject({ status: 'error' });
    expect(rows[1]).not.toHaveProperty('promptPrefix');
    expect(rows[2].promptPrefix.divergence.kind).toBe('none');
  });

  test('only chat calls are fingerprinted', async () => {
    const observePromptPrefix = jest.fn();
    const deps = inferenceDeps({ observePromptPrefix });
    await executeRoutedInference(deps, { mode: 'generate', model: 'model-a', prompt: 'hello' }, { observePromptPrefix: true });
    expect(observePromptPrefix).not.toHaveBeenCalled();
    expect(deps.recordInference.mock.calls[0][0]).not.toHaveProperty('promptPrefix');
  });
});

describe('InferenceLog persistence and read projection', () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(async () => {
    process.env.NODE_ENV = 'development'; // recordInference is a no-op under test
    await InferenceLog.deleteMany({});
  });
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  test('reported timings and a sanitized prompt prefix are stored and projected', async () => {
    await recordInference({
      host: 'http://ollama.test:11434', model: 'model-a', caller: 'proxy', tokensIn: 17000, tokensOut: 46,
      loadMs: 2, promptEvalMs: 2346, evalMs: 988, firstTokenMs: 2410.4, durationMs: 3500,
      promptPrefix: {
        systemSections: 9, messages: 14, toolsHash: 'abcdef12', content: PRIVATE_TEXT,
        divergence: { kind: 'system', index: 7, heading: 'Runtime', text: PRIVATE_TEXT }
      }
    });
    const row = await InferenceLog.findOne({ model: 'model-a' }).lean();
    expect(row).toMatchObject({ loadMs: 2, promptEvalMs: 2346, evalMs: 988, firstTokenMs: 2410 });
    expect(row.promptPrefix).toEqual({ systemSections: 9, messages: 14, toolsHash: 'abcdef12',
      divergence: { kind: 'system', index: 7, heading: 'Runtime' } });
    expect(JSON.stringify(row)).not.toContain(PRIVATE_TEXT);
    expect(projectInferenceLog(row)).toMatchObject({
      loadMs: 2, promptEvalMs: 2346, evalMs: 988, firstTokenMs: 2410, promptPrefix: row.promptPrefix
    });
  });

  test('unreported timings stay absent rather than zero', async () => {
    await recordInference({ host: 'http://ollama.test:11434', model: 'model-b', caller: 'proxy', loadMs: -1, evalMs: NaN });
    const row = await InferenceLog.findOne({ model: 'model-b' }).lean();
    const projected = projectInferenceLog(row);
    for (const field of ['loadMs', 'promptEvalMs', 'evalMs', 'firstTokenMs', 'promptPrefix']) {
      expect(row).not.toHaveProperty(field);
      expect(projected).not.toHaveProperty(field);
    }
  });
});
