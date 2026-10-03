'use strict';

jest.unmock('../../src/services/routing/ollamaRuntimeVersion');
const http = require('http');
const fetch = require('node-fetch');
const { protectContext, supportsRefusal } = require('../../src/services/routing/contextIntegrityPolicy');
const { readRuntimeVersion } = require('../../src/services/routing/ollamaRuntimeVersion');
const { executeAdmittedOllamaAttempt, settleAdmissionFailure } = require('../../src/services/routing/inferenceAttemptExecutor');
const { executeAdmittedOllamaStream } = require('../../src/services/routing/inferenceStreamExecutor');

let server, hostUrl, version, wire, rejectInput;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === '/api/version') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    wire.push({ url: req.url, payload });
    res.setHeader('Content-Type', 'application/json');
    if (rejectInput) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'input exceeds the configured context' }));
    } else if (req.url === '/api/embed') {
      res.end(JSON.stringify({ embeddings: [[1, 2]] }));
    } else {
      res.end(JSON.stringify({ done: true, response: 'fixture' }) + (payload.stream ? '\n' : ''));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  hostUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => { version = '0.30.10'; wire = []; rejectInput = false; });

function scope() {
  const admission = { signal: new AbortController().signal, markDispatched: jest.fn(),
    assertActive: jest.fn(), complete: jest.fn(async () => {}), abandon: jest.fn(async () => {}) };
  const release = jest.fn(async () => {});
  const dependencies = { fetch, beginInferenceAdmission: jest.fn(async () => admission),
    hostGate: { acquire: jest.fn(async () => release) } };
  return { admission, release, dependencies };
}
function request(overrides = {}) {
  return { hostUrl, model: 'exact-artifact', principal: 'core-inference', useChat: true,
    admissionKind: 'inference-direct', timeoutMs: 1000, ...overrides };
}

test.each(['0.30.10', '0.30.11', '0.31.0', '0.33.2', '1.0.0'])('qualified stable runtime %s', v => {
  expect(supportsRefusal(v)).toBe(true);
});
test.each([null, '', '0.30.9', '0.29.99', '0.30.10-rc1', 'custom', '0.30.10+build'])('unqualified runtime %s', v => {
  expect(supportsRefusal(v)).toBe(false);
});

test.each([false, true])('complete chat content and options reach the wire (stream=%s)', async stream => {
  const { admission, release, dependencies } = scope();
  const payload = { model: 'exact-artifact', stream, truncate: true, shift: true,
    messages: [{ role: 'system', content: 'system'.repeat(8000) },
      { role: 'user', content: 'history'.repeat(20000), images: ['synthetic-image'] }],
    tools: [{ type: 'function', function: { name: 'example', parameters: { type: 'object' } } }],
    options: { num_ctx: 32768, num_predict: 19, num_thread: 6 }, keep_alive: -1, think: false };
  const original = JSON.stringify(payload);
  const execute = stream ? executeAdmittedOllamaStream : executeAdmittedOllamaAttempt;
  const result = await execute(request({ payload, stream }), dependencies);
  if (stream) {
    for await (const _chunk of result.stream) { /* consume exact upstream EOF */ }
    expect(await result.completion).toMatchObject({ completed: true });
  } else expect(result.ok).toBe(true);
  expect(wire).toEqual([{ url: '/api/chat', payload: { ...payload, truncate: false, shift: false } }]);
  expect(JSON.stringify(payload)).toBe(original);
  expect(admission.complete).toHaveBeenCalledTimes(1);
  expect(admission.abandon).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

test.each(['generate', 'embed'])('preserves %s input and context values', async mode => {
  const { dependencies } = scope();
  const payload = { model: 'exact-artifact', stream: false, truncate: true,
    ...(mode === 'embed' ? { input: ['a'.repeat(80000), 'b'] } : { prompt: 'p'.repeat(80000), system: 's', raw: true }),
    options: { num_ctx: 32768 } };
  await executeAdmittedOllamaAttempt(request({ mode, useChat: false, payload }), dependencies);
  expect(wire).toEqual([{ url: `/api/${mode}`, payload: { ...payload, truncate: false,
    ...(mode === 'generate' && { shift: false }) } }]);
});

test.each([false, true])('an unqualified runtime refuses before admission or inference (stream=%s)', async stream => {
  version = '0.30.9';
  const { dependencies } = scope();
  const execute = stream ? executeAdmittedOllamaStream : executeAdmittedOllamaAttempt;
  const error = await execute(request({ payload: { model: 'exact-artifact', prompt: 'hello' }, stream }), dependencies).catch(e => e);
  expect(error).toMatchObject({ code: 'INFERENCE_CONTEXT_POLICY_UNAVAILABLE', statusCode: 503 });
  expect(settleAdmissionFailure(error).response).toMatchObject({ status: 503, body: { code: error.code } });
  expect(dependencies.beginInferenceAdmission).not.toHaveBeenCalled();
  expect(wire).toEqual([]);
});

test.each([false, true])('a complete native refusal releases admission without retry or quarantine (stream=%s)', async stream => {
  rejectInput = true;
  const { dependencies, admission } = scope();
  const execute = stream ? executeAdmittedOllamaStream : executeAdmittedOllamaAttempt;
  const result = await execute(request({ payload: { model: 'exact-artifact', prompt: 'oversized' }, stream,
    useChat: false, verifyRejection: true }), dependencies);
  expect(result).toMatchObject({ status: 400, ok: false, data: { error: 'input exceeds the configured context' } });
  expect(wire).toHaveLength(1);
  expect(admission.complete).toHaveBeenCalledTimes(1);
  expect(admission.abandon).not.toHaveBeenCalled();
});

test('a Benchmark probe keeps its exact payload only with a workload identity', async () => {
  const payload = { model: 'exact-artifact', prompt: 'probe', options: { num_ctx: 8192 } };
  const read = jest.fn(async () => null);
  expect(await protectContext(request({ payload, principal: 'benchmark-service',
    workloadAdmissionId: 'owned', workloadGeneration: 'exact' }), { readRuntimeVersion: read })).toBe(payload);
  expect(read).not.toHaveBeenCalled();
  await expect(protectContext(request({ payload, principal: 'benchmark-service' }),
    { readRuntimeVersion: read })).rejects.toMatchObject({ code: 'INFERENCE_CONTEXT_POLICY_UNAVAILABLE' });
});

test('a forged workload identity cannot reach inference', async () => {
  const { dependencies } = scope();
  dependencies.beginInferenceAdmission = require('../../src/services/inferenceAdmissionService').beginInferenceAdmission;
  await expect(executeAdmittedOllamaAttempt(request({ payload: { model: 'exact-artifact', prompt: 'probe' },
    principal: 'benchmark-service', workloadAdmissionId: 'forged', workloadGeneration: 'forged' }), dependencies))
    .rejects.toMatchObject({ code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' });
  expect(wire).toEqual([]);
});

test('a real Core workload keeps the probe intact and releases only its inference', async () => {
  const coordination = require('../../src/services/runtimeCoordinationService');
  const workload = await coordination.acquireWorkload({ principal: 'benchmark-service', requestId: 'qualified-probe',
    workloadId: 'synthetic-probe', kind: 'benchmark', hosts: [hostUrl], ttl: 60000 });
  expect(workload.acquired).toBe(true);
  try {
    version = '0.30.9'; // The controlled probe deliberately exercises this runtime.
    const { dependencies } = scope();
    dependencies.beginInferenceAdmission = require('../../src/services/inferenceAdmissionService').beginInferenceAdmission;
    const payload = { model: 'exact-artifact', prompt: 'synthetic probe', stream: false, options: { num_ctx: 8192 } };
    await executeAdmittedOllamaAttempt(request({ payload, useChat: false, principal: 'benchmark-service',
      workloadAdmissionId: workload.admissionId, workloadGeneration: workload.generation }), dependencies);
    expect(wire).toEqual([{ url: '/api/generate', payload }]);
    const state = await coordination.listActive();
    expect(state.inferences).toEqual([]);
    expect(state.workloads).toHaveLength(1);
  } finally {
    await coordination.release({ id: workload.admissionId, generation: workload.generation, principal: 'benchmark-service' });
  }
});

test('only an internal session-hold warmup bypasses qualification', async () => {
  const payload = { model: 'exact-artifact', prompt: 'warmup' };
  const read = jest.fn(async () => null);
  expect(await protectContext(request({ payload, principal: 'core-session-hold',
    admissionKind: 'session-hold-warm' }), { readRuntimeVersion: read })).toBe(payload);
  await expect(protectContext(request({ payload, admissionKind: 'session-hold-warm' }),
    { readRuntimeVersion: read })).rejects.toMatchObject({ code: 'INFERENCE_CONTEXT_POLICY_UNAVAILABLE' });
});

test('unavailable or malformed version evidence is unqualified', async () => {
  expect(await readRuntimeVersion(hostUrl, async () => ({ ok: false }))).toBeNull();
  expect(await readRuntimeVersion(hostUrl, async () => { throw new Error('offline'); })).toBeNull();
  expect(await readRuntimeVersion(hostUrl, async () => ({ ok: true, json: async () => { throw new Error('malformed'); } }))).toBeNull();
});

test('caller cancellation interrupts the version read before admission', async () => {
  const controller = new AbortController();
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  const { dependencies } = scope();
  dependencies.fetch = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = executeAdmittedOllamaStream(request({ payload: { model: 'exact-artifact' },
    signal: controller.signal }), dependencies).catch(e => e);
  await reading;
  controller.abort(new Error('caller stopped'));
  expect(await pending).toMatchObject({ message: 'Ollama attempt cancelled by caller' });
  expect(dependencies.beginInferenceAdmission).not.toHaveBeenCalled();
});

test('a stalled version read has its own bounded timeout', async () => {
  jest.useFakeTimers();
  try {
    const read = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = readRuntimeVersion(hostUrl, read);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
