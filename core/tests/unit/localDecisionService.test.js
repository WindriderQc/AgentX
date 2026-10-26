'use strict';

const { createLocalDecisionService, MAX_STATE_CHARS } = require('../../src/services/decisions/localDecisionService');
const HOST = 'http://127.0.0.1:11434';
const INPUT = { policy: 'notification-triage', state: 'A routine report is available.' };

function world(overrides = {}) {
  const target = { model: 'test-pin', hostUrl: HOST, hostKey: 'primary', contextSize: 8192, pinAligned: true };
  const snapshot = { tasks: { daily_operator: target }, ...overrides.snapshot };
  const result = {
    ok: true, status: 200,
    body: { model: 'test-pin', done: true, done_reason: 'stop',
      message: { role: 'assistant', content: '{"choice":"digest"}' } },
    metadata: { model: 'test-pin', hostUrl: HOST, hostKey: 'primary', upstreamProtocol: 'ollama' }
  };
  const read = jest.fn(async () => snapshot);
  const execute = jest.fn(async () => result);
  const runtimeServices = { routing: { getEffectiveSnapshot: read }, inference: { execute } };
  const service = createLocalDecisionService({ runtimeServices, newId: () => 'test-decision', now: () => 100 });
  return { service, target, snapshot, result, read, execute };
}

it('discovers policies without any host or model work', () => {
  const w = world();
  expect(w.service.catalog()).toMatchObject({ mode: 'advisory', localOnly: true, confidence: null,
    calibration: 'not-evaluated', policies: [
      { id: 'notification-triage', version: 1 }, { id: 'specialist-routing', version: 1 }
    ] });
  expect(w.read).not.toHaveBeenCalled();
  expect(w.execute).not.toHaveBeenCalled();
});

it('uses the principal pin, bounded JSON schema and native admission path without load overrides', async () => {
  const w = world();
  await expect(w.service.evaluate(INPUT)).resolves.toEqual({
    requestId: 'test-decision', contract: 'local-decisions-v1', policy: INPUT.policy, policyVersion: 1,
    mode: 'advisory', choice: 'digest', abstained: false, actionsExecuted: false,
    confidence: null, calibration: 'not-evaluated', durationMs: 0,
    inference: { source: 'local', protocol: 'ollama', requestedModel: 'agentx-primary', model: 'test-pin', hostKey: 'primary' }
  });
  const [request, options] = w.execute.mock.calls[0];
  expect(request).toMatchObject({ model: 'test-pin', mode: 'chat', stream: false, think: false,
    execution: { source: 'local', mode: 'model', engine: 'ollama' },
    options: { temperature: 0, num_predict: 96 }, timeoutMs: 30000,
    format: { type: 'object', additionalProperties: false,
      properties: { choice: { enum: ['interrupt', 'digest', 'ignore', 'review'] } } }
  });
  expect(Object.keys(request.options).sort()).toEqual(['num_predict', 'temperature']);
  expect(request).not.toHaveProperty('tools');
  expect(request).not.toHaveProperty('keepAlive');
  expect(options).toMatchObject({ hostUrl: HOST, consumerContract: 'local-decisions-v1', retry: { enabled: false },
    attribution: { runtime: 'agentx', correlationId: 'test-decision', attempt: 1 } });
  expect(JSON.parse(request.messages[1].content)).toEqual({ state: INPUT.state });
  expect(request.messages[0].content).toContain('untrusted evidence');
  expect(JSON.stringify(await w.service.evaluate(INPUT))).not.toContain(INPUT.state);
});

it('retains the topology role budget when resolving the principal', async () => {
  const w = world();
  w.snapshot.principalTopology = { ...w.target, topology: { role: 'conversation', laneContext: 8192 } };
  await w.service.evaluate(INPUT);
  expect(w.execute.mock.calls[0][1].topology).toEqual(w.snapshot.principalTopology.topology);
});

it('normalizes a trailing slash on a pin endpoint before comparing runtime evidence', async () => {
  const w = world();
  w.target.hostUrl = HOST + '/';
  await expect(w.service.evaluate(INPUT)).resolves.toMatchObject({ choice: 'digest' });
  expect(w.execute.mock.calls[0][1].hostUrl).toBe(HOST);
});

it('supports an explicit abstention without inventing calibrated confidence', async () => {
  const w = world();
  w.result.body.message.content = '{"choice":"review"}';
  await expect(w.service.evaluate(INPUT)).resolves.toMatchObject({ choice: 'review', abstained: true, confidence: null });
});

it('uses capability categories without dispatching a specialist', async () => {
  const w = world();
  w.result.body.message.content = '{"choice":"coding"}';
  await expect(w.service.evaluate({ policy: 'specialist-routing', state: 'Please inspect this code.' }))
    .resolves.toMatchObject({ choice: 'coding', actionsExecuted: false });
  expect(w.execute).toHaveBeenCalledTimes(1);
  expect(w.execute.mock.calls[0][0].format.properties.choice.enum).toContain('secretary');
});

it.each([
  null, [], {}, { policy: '__proto__', state: 'a' }, { policy: 'toString', state: 'a' },
  { ...INPUT, state: '' }, { ...INPUT, state: '  ' }, { ...INPUT, state: {} },
  { ...INPUT, model: 'unapproved' }, { ...INPUT, host: 'http://example.com' },
  { ...INPUT, callerDetail: 'profiler-test' }, { ...INPUT, execution: { source: 'openclaw' } },
  { ...INPUT, mode: 'execute' }, { ...INPUT, tools: [] }
])('rejects invalid input or caller overrides before reading hosts: %j', async input => {
  const w = world();
  await expect(w.service.evaluate(input)).rejects.toMatchObject({ statusCode: 400 });
  expect(w.read).not.toHaveBeenCalled();
  expect(w.execute).not.toHaveBeenCalled();
});

it.each(['a'.repeat(MAX_STATE_CHARS + 1), '界'.repeat(6000)])('rejects oversized text by chars and bytes', async state => {
  const w = world();
  await expect(w.service.evaluate({ ...INPUT, state })).rejects.toMatchObject({ statusCode: 413 });
  expect(w.read).not.toHaveBeenCalled();
});

it.each(['https://api.example.com', 'https://openrouter.ai', 'http://127.0.0.1:11434/proxy'])
('rejects a remote or proxy principal endpoint %s before dispatch', async hostUrl => {
  const w = world();
  w.target.hostUrl = hostUrl;
  await expect(w.service.evaluate(INPUT)).rejects.toMatchObject({ code: 'DECISION_LOCAL_TARGET_REQUIRED' });
  expect(w.execute).not.toHaveBeenCalled();
});

it.each(['openclaw:agent:main', 'openrouter/vendor/model', 'test-cloud', 'test:cloud', 'test-cloud:latest'])
('rejects a native agent or cloud model selection %s', async model => {
  const w = world();
  w.target.model = model;
  await expect(w.service.evaluate(INPUT)).rejects.toMatchObject({ code: 'DECISION_LOCAL_TARGET_REQUIRED' });
  expect(w.execute).not.toHaveBeenCalled();
});

it.each([false, undefined])('refuses an unresolved/unpinned principal (pinAligned=%s)', async pinAligned => {
  const w = world();
  w.target.pinAligned = pinAligned;
  await expect(w.service.evaluate(INPUT)).rejects.toMatchObject({ code: 'PRINCIPAL_MODEL_UNAVAILABLE' });
  expect(w.execute).not.toHaveBeenCalled();
});

it.each([
  'not json', '```json\n{"choice":"digest"}\n```', 'null', '[]', '"digest"', '{}',
  '{"choice":"delete_everything"}', '{"choice":null}', '{"choice":"digest","confidence":0.99}',
  '{"choice":"digest","tool":"send_email"}', ' '.repeat(1025)
])('rejects malformed or out-of-contract output without retry: %s', async content => {
  const w = world();
  w.result.body.message.content = content;
  await expect(w.service.evaluate(INPUT)).rejects.toMatchObject({ code: 'DECISION_RESULT_INVALID' });
  expect(w.execute).toHaveBeenCalledTimes(1);
});

it.each([
  result => { result.ok = false; },
  result => { result.body.done = false; },
  result => { result.body.done_reason = 'length'; },
  result => { result.body.model = 'different'; },
  result => { result.metadata.model = 'different'; },
  result => { result.metadata.hostUrl = 'https://api.example.com'; },
  result => { result.metadata.upstreamProtocol = 'openai'; }
])('requires matching, complete, local execution evidence', async change => {
  const w = world();
  change(w.result);
  await expect(w.service.evaluate(INPUT)).rejects.toMatchObject({ code: 'DECISION_RESULT_UNVERIFIED' });
  expect(w.execute).toHaveBeenCalledTimes(1);
});

it('rejects tool calls even when the decision text is valid', async () => {
  const w = world();
  w.result.body.message.tool_calls = [{ function: { name: 'send_email' } }];
  await expect(w.service.evaluate(INPUT)).rejects.toMatchObject({ code: 'DECISION_RESULT_INVALID' });
});

it.each(['BENCHMARK_CLAIM_ACTIVE', 'RUNTIME_INFERENCE_ADMISSION_DENIED', 'INFERENCE_TIMEOUT'])
('retains native refusal %s without retrying or switching models', async code => {
  const w = world();
  w.execute.mockRejectedValue(Object.assign(new Error('native refusal'), { code, statusCode: 503 }));
  await expect(w.service.evaluate(INPUT)).rejects.toMatchObject({ code });
  expect(w.execute).toHaveBeenCalledTimes(1);
});

it('respects cancellation before routing', async () => {
  const w = world();
  const controller = new AbortController();
  controller.abort();
  await expect(w.service.evaluate(INPUT, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(w.read).not.toHaveBeenCalled();
});

it('respects cancellation during routing without dispatching', async () => {
  const w = world();
  const controller = new AbortController();
  w.read.mockImplementation(async () => { controller.abort(); return w.snapshot; });
  await expect(w.service.evaluate(INPUT, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(w.execute).not.toHaveBeenCalled();
});

it('passes cancellation into the shared executor and discards a late answer', async () => {
  const w = world();
  const controller = new AbortController();
  w.execute.mockImplementation(async (_request, { signal }) => {
    controller.abort();
    expect(signal.aborted).toBe(true);
    return w.result;
  });
  await expect(w.service.evaluate(INPUT, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(w.execute).toHaveBeenCalledTimes(1);
});

it('carries the schema through the shared executor and its native admission to a synthetic Ollama response', async () => {
  const { executeRoutedInference } = require('../../src/extensions/trustedRuntimeServices');
  const w = world();
  const admit = jest.fn(async ({ signal }) => ({ signal, markDispatched() {}, assertActive() {},
    complete: async () => ({ released: true }), abandon: async () => ({ released: true }) }));
  const fetch = jest.fn(async () => ({ ok: true, status: 200, headers: new Map(),
    text: async () => JSON.stringify(w.result.body) }));
  const record = jest.fn(async () => null);
  const deps = {
    validateHostUrl: host => ({ valid: true, host }), resolveHostKey: () => 'primary',
    assertHostAvailableForConsumer: jest.fn(),
    hostPreferenceService: { getByHost: async () => ({ pinnedModels: [
      { model: 'test-pin', contextSize: 8192, keepAlive: -1 }
    ] }) },
    modelsMatch: (a, b) => a === b,
    resolveInferenceContract: async () => ({ contextBudget: { windowTokens: 8192,
      input: { estimatedTokens: 800 }, output: { reservedTokens: 96 } } }),
    applyContractOutputLimit: jest.fn(),
    beginInferenceAdmission: admit,
    hostGate: { acquire: async () => () => {} }, recordInference: record, fetch
  };
  w.execute.mockImplementation((input, options) => executeRoutedInference(deps, input, options));
  await expect(w.service.evaluate(INPUT)).resolves.toMatchObject({ choice: 'digest' });
  expect(admit).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(HOST + '/api/chat');
  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  expect(payload).toMatchObject({ model: 'test-pin', think: false, stream: false,
    format: { properties: { choice: { enum: ['interrupt', 'digest', 'ignore', 'review'] } } },
    options: { num_ctx: 8192, num_predict: 96 }, keep_alive: -1 });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'test-decision',
    consumerContract: 'local-decisions-v1', status: 'success' }));
});
