'use strict';
const express = require('express');
const request = require('supertest');
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const Slots = require('../../models/PipelineAutomationSlot');
const autonomy = require('../../src/services/pipelineCodingAutonomyService');
const capacity = require('../../src/services/pipelineCodingCapacity');
const { claimEligibleTask } = require('../../src/services/pipelineTaskService');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
const { executeRoutedInference, TrustedRuntimeServiceError } = require('../../src/extensions/trustedRuntimeServices');
const { registerHermesProtocol } = require('../../integrations/runtime-bridges/hermes/protocol');
jest.mock('../../src/services/heavyWorkQueueService', () => ({ get: jest.fn() }));
const queue = require('../../src/services/heavyWorkQueueService');

const MODEL = 'synthetic-model';
const HOST = 'http://ollama.invalid:11434';
const CALL = '10000000-0000-4000-8000-000000000001';
const NEXT_CALL = '10000000-0000-4000-8000-000000000002';
const PRIOR_REQUEST = '20000000-0000-4000-8000-000000000001';
const QUEUE = '30000000-0000-4000-8000-000000000001';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function dependencies() {
  const scope = { signal: new AbortController().signal, markDispatched: jest.fn(), assertActive: jest.fn(),
    complete: jest.fn(async () => ({ released: true })), abandon: jest.fn(async () => ({ released: true })) };
  return {
    scope,
    beginInferenceAdmission: jest.fn(async ({ signal }) => ({ ...scope, signal })),
    getAdvisoryModelForTask: jest.fn(),
    getTargetForModel: jest.fn(() => HOST),
    resolveHostKey: jest.fn(() => 'synthetic'),
    validateHostUrl: jest.fn(host => ({ valid: true, host })),
    assertHostAvailableForConsumer: jest.fn(async () => null),
    hostPreferenceService: { getByHost: jest.fn(async () => ({
      pinnedModels: [{ model: MODEL, contextSize: 32768, keepAlive: -1 }] })) },
    modelsMatch: (a, b) => a === b,
    resolveInferenceContract: jest.fn(async () => ({ version: 1, contextBudget: { windowTokens: 32768 } })),
    applyContractOutputLimit: jest.fn(),
    hostGate: { acquire: jest.fn(async () => jest.fn()) },
    recordInference: jest.fn(async () => null),
    fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Map(),
      text: async () => JSON.stringify({ model: MODEL, message: { content: 'Synthetic reply' }, done: true }) })),
  };
}

async function fixture({ modelSeconds = 3600, execute, deps = dependencies() } = {}) {
  const automation = normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1', mode: 'review_only',
    policyRef: 'synthetic/v1', dataClassification: 'public', operations: ['update'], scope: ['synthetic.js'],
    lockKeys: ['file:synthetic.js'], executionProfile: 'coding-sandbox/v1', verificationProfile: 'agentx-dispatcher-tests/v1',
    budgets: { maxDurationMs: 14400000, maxAttempts: 3, maxCostNanodollars: 0 }, humanGates: ['review', 'merge', 'deploy'] });
  await Task.create({ pipelineId: '0001', title: 'Synthetic inference contract', spec: 'CPU fixture only',
    service: 'agentx-coding', status: 'queued', risk: 'low', assignee: null, automation });
  await Task.create({ pipelineId: '0002', title: 'Other owner synthetic task', spec: 'Preserve this task',
    service: 'agentx-coding', status: 'in_progress', assignee: 'other-owner' });
  const otherBefore = await Task.findOne({ pipelineId: '0002' }).lean();
  await autonomy.authorize('0001', { authorized: true, confirm: true, expectedRevision: 0, queueRequestId: QUEUE,
    limits: { modelSeconds } });
  await autonomy.configure({ confirm: true, enabled: true, expectedRevision: 0 });
  await autonomy.tick();
  const { active, revision } = await autonomy.settings();
  await autonomy.configure({ confirm: true, enabled: false, expectedRevision: revision });
  const claimed = await claimEligibleTask('0001', 'coding-team', new Date(), { automated: true, dispatchRequestId: active.requestId });
  const leaseId = claimed.automationLease.leaseId;
  await Task.updateOne({ pipelineId: '0001' }, { $set: { codingCapacity: { model: MODEL, admissionId: 'synthetic-admission', host: HOST } } });
  jest.spyOn(capacity, 'authorizeInference').mockResolvedValue({ principal: 'core-trusted-runtime',
    workloadAdmissionId: 'synthetic-admission', workloadGeneration: 'synthetic-generation' });
  const runtime = { routing: { getEffectiveSnapshot: jest.fn(async () => ({ tasks: { code_generation: { model: MODEL } } })) },
    inference: { execute: jest.fn(execute || ((input, options) => executeRoutedInference(deps, input, options))) } };
  const app = express().use(express.json()).use(registerHermesProtocol({ express, runtimeServices: runtime, logger: {} }));
  const headers = { 'x-agentx-coding-task': '0001', 'x-agentx-coding-request': active.requestId,
    'x-agentx-coding-lease': leaseId, 'x-agentx-coding-call': CALL };
  const post = (body = {}, override = {}) => request(app).post('/v1/chat/completions').set({ ...headers, ...override })
    .send({ model: MODEL, messages: [{ role: 'user', content: 'Synthetic CPU request' }], ...body });
  return { post, headers, deps, runtime, leaseId, active, otherBefore };
}

async function durable(f) {
  const task = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(await Task.findOne({ pipelineId: '0002' }).lean()).toEqual(f.otherBefore);
  expect(task.automationLease.leaseId).toBe(f.leaseId);
  expect(task.codingCapacity.admissionId).toBe('synthetic-admission');
  expect(task.automationAttemptCount).toBe(1);
  return task;
}

function interceptSettlement(replace) {
  const original = Task.updateOne;
  const calls = [];
  jest.spyOn(Task, 'updateOne').mockImplementation(function (...args) {
    if (Object.hasOwn(args[1].$set || {}, 'codingAutonomy.runs.$[run].modelReceipts.$[call].state')) {
      calls.push(args);
      return replace(() => original.apply(this, args), args);
    }
    return original.apply(this, args);
  });
  return calls;
}

beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Settings.deleteMany({}), Slots.deleteMany({})]);
  autonomy.configureControl({ status: jest.fn(async () => ({ available: true, busy: false })) });
  queue.get.mockResolvedValue({ state: 'dispatching', executor: { mode: 'operator' },
    source: { type: 'coding', ref: 'synthetic-cpu-session' }, hosts: [HOST],
    reservation: { start: new Date(Date.now() - 10000).toISOString(), end: new Date(Date.now() + 600000).toISOString() } });
});
afterEach(() => { jest.restoreAllMocks(); autonomy.configureControl(null); });

test('real prepare output passes the real validator through Hermes and retains native ownership', async () => {
  const f = await fixture();
  const response = await f.post();
  expect(response.status).toBe(200);
  expect(response.body.choices[0].message.content).toBe('Synthetic reply');
  expect(f.runtime.inference.execute.mock.calls[0][1].attribution).toEqual({ workItemId: '0001',
    correlationId: f.active.requestId, attempt: 1, runtime: 'agentx' });
  expect(f.deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({ workItemId: '0001',
    correlationId: f.active.requestId, attempt: 1, runtime: 'agentx' }));
  expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts).toEqual([expect.objectContaining({ callId: CALL, state: 'completed' })]);
  expect(run.pendingInferences).toEqual([]);
});

test.each(['request', 'attribution'])('real %s validation refusal is durable before the HTTP reply, without routing, admission or retry', async kind => {
  const deps = dependencies();
  const f = await fixture({ deps, execute: (input, options) => {
    if (kind === 'attribution') options.attribution = { ...options.attribution, source: 'unsupported' };
    return executeRoutedInference(deps, input, options);
  } });
  const response = await f.post(kind === 'request' ? { n: 0 } : {});
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe(kind === 'request' ? 'INFERENCE_POLICY_INVALID' : 'INFERENCE_ATTRIBUTION_INVALID');
  expect(f.runtime.inference.execute).toHaveBeenCalledTimes(1);
  expect(deps.validateHostUrl).not.toHaveBeenCalled();
  expect(deps.resolveInferenceContract).not.toHaveBeenCalled();
  expect(deps.beginInferenceAdmission).not.toHaveBeenCalled();
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.scope.complete).not.toHaveBeenCalled();
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0]).toMatchObject({ callId: CALL, state: 'refused' });
  expect(run.pendingInferences).toEqual([]);
});

test('a delayed durable refusal holds the reply and blocks another exact run call until settlement', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  const writes = interceptSettlement(async commit => { entered.resolve(); await release.promise; return commit(); });
  let replied = false;
  const response = f.post({ n: 0 }).then(value => { replied = true; return value; });
  await entered.promise;
  expect(replied).toBe(false);
  expect((await durable(f)).codingAutonomy.runs.at(-1).pendingInferences).toEqual([CALL]);
  const blocked = await f.post({}, { 'x-agentx-coding-call': NEXT_CALL });
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe('CODING_INFERENCE_COMPLETION_PENDING');
  expect(f.runtime.inference.execute).toHaveBeenCalledTimes(1);
  release.resolve();
  expect((await response).status).toBe(400);
  expect(writes).toHaveLength(2);
  expect((await durable(f)).codingAutonomy.runs.at(-1).pendingInferences).toEqual([]);
});

test.each(['rejected', 'unacknowledged', 'no_match'])('a %s settlement never acknowledges refusal, retries inference or clears an uncertain journal', async kind => {
  const f = await fixture();
  const writes = interceptSettlement(() => {
    if (kind === 'rejected') return Promise.reject(new Error('Synthetic persistence failure'));
    return Promise.resolve({ acknowledged: kind !== 'unacknowledged', modifiedCount: kind === 'no_match' ? 0 : 1 });
  });
  const response = await f.post({ n: 0 });
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('CODING_INFERENCE_SETTLEMENT_UNVERIFIED');
  expect(writes).toHaveLength(1);
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0]).toMatchObject({ callId: CALL, state: 'pending' });
  expect(run.pendingInferences).toEqual([CALL]);
  expect((await f.post()).body.error.code).toBe('CODING_INFERENCE_ALREADY_RECEIVED');
  expect((await f.post({}, { 'x-agentx-coding-call': NEXT_CALL })).body.error.code).toBe('CODING_INFERENCE_COMPLETION_PENDING');
  expect(f.runtime.inference.execute).toHaveBeenCalledTimes(1);
  expect(f.deps.fetch).not.toHaveBeenCalled();
});

test('an applied native-outcome write with a lost acknowledgement retains unknown and pending without cleanup', async () => {
  const f = await fixture();
  const writes = interceptSettlement(async commit => {
    await commit();
    throw new Error('Synthetic acknowledgement lost after durable write');
  });
  const response = await f.post({ n: 0 });
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('CODING_INFERENCE_SETTLEMENT_UNVERIFIED');
  expect(writes).toHaveLength(1);
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0]).toMatchObject({ callId: CALL, state: 'unknown', settlement: { state: 'refused' } });
  expect(run.pendingInferences).toEqual([CALL]);
  expect((await f.post()).body.error.code).toBe('CODING_INFERENCE_ALREADY_RECEIVED');
  expect((await f.post({}, { 'x-agentx-coding-call': NEXT_CALL })).body.error.code).toBe('CODING_INFERENCE_COMPLETION_PENDING');
  expect(f.runtime.inference.execute).toHaveBeenCalledTimes(1);
  expect(f.deps.fetch).not.toHaveBeenCalled();
});

test.each(['rejected', 'unacknowledged', 'no_match', 'lost_after_commit'])('a %s cleanup preserves acknowledged native proof without replay or a false persistence error', async kind => {
  const f = await fixture();
  let phase = 0;
  const writes = interceptSettlement(async commit => {
    if (++phase === 1) return commit();
    if (kind === 'lost_after_commit') await commit();
    if (kind === 'rejected' || kind === 'lost_after_commit') throw new Error('Synthetic cleanup failure');
    return { acknowledged: kind !== 'unacknowledged', modifiedCount: kind === 'no_match' ? 0 : 1 };
  });
  const response = await f.post({ n: 0 });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INFERENCE_POLICY_INVALID');
  expect(writes).toHaveLength(2);
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  const cleaned = kind === 'lost_after_commit';
  expect(run.modelReceipts[0]).toMatchObject({ callId: CALL, state: cleaned ? 'refused' : 'unknown', settlement: { state: 'refused' } });
  expect(run.pendingInferences).toEqual(cleaned ? [] : [CALL]);
  expect((await f.post()).body.error.code).toBe('CODING_INFERENCE_ALREADY_RECEIVED');
  if (!cleaned) expect((await f.post({}, { 'x-agentx-coding-call': NEXT_CALL })).body.error.code).toBe('CODING_INFERENCE_COMPLETION_PENDING');
  expect(f.runtime.inference.execute).toHaveBeenCalledTimes(1);
  expect(f.deps.fetch).not.toHaveBeenCalled();
});

test('settlement targets the exact current task/run/call and preserves an older run with the same call UUID', async () => {
  const f = await fixture();
  const prior = { requestId: PRIOR_REQUEST, parentRequestId: null, startedAt: new Date(Date.now() - 10000).toISOString(),
    finishedAt: new Date(Date.now() - 9000).toISOString(), modelReceipts: [{ callId: CALL, state: 'completed',
      startedAt: new Date(Date.now() - 10000).toISOString(), finishedAt: new Date(Date.now() - 9000).toISOString() }], pendingInferences: [] };
  const current = (await Task.findOne({ pipelineId: '0001' }).lean()).codingAutonomy.runs[0];
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.runs': [prior, current] } });
  const writes = interceptSettlement(commit => commit());
  const stale = await f.post({}, { 'x-agentx-coding-request': PRIOR_REQUEST });
  expect(stale.status).toBe(409);
  expect(f.runtime.inference.execute).not.toHaveBeenCalled();
  expect((await f.post({ n: 0 })).status).toBe(400);
  const task = await durable(f);
  expect(task.codingAutonomy.runs[0]).toEqual(prior);
  expect(task.codingAutonomy.runs[1].modelReceipts[0]).toMatchObject({ callId: CALL, state: 'refused' });
  expect(writes).toHaveLength(2);
  expect(writes[0][0]).toMatchObject({ pipelineId: '0001', 'codingAutonomy.runs': { $elemMatch: { requestId: f.active.requestId } } });
  expect(writes[0][2].writeConcern).toEqual({ w: 1, j: true });
  expect(writes[1][2].arrayFilters[1]).toEqual({ 'call.callId': CALL, 'call.state': 'unknown',
    'call.settlement.state': 'refused', 'call.settlement.finishedAt': task.codingAutonomy.runs[1].modelReceipts[0].finishedAt });
});

test('the same validator code after dispatch remains unknown and retains the inference fence', async () => {
  const f = await fixture();
  f.deps.fetch.mockRejectedValue(new TrustedRuntimeServiceError('Synthetic provider failure', {
    code: 'INFERENCE_ATTRIBUTION_INVALID', statusCode: 400 }));
  const response = await f.post();
  expect(response.status).toBe(502);
  expect(f.deps.beginInferenceAdmission).toHaveBeenCalledTimes(1);
  expect(f.deps.scope.markDispatched).toHaveBeenCalledTimes(1);
  expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0]).toMatchObject({ callId: CALL, state: 'unknown' });
  expect(run.pendingInferences).toEqual([CALL]);
  expect((await f.post({}, { 'x-agentx-coding-call': NEXT_CALL })).status).toBe(409);
  expect(f.deps.fetch).toHaveBeenCalledTimes(1);
});

test('a validation proof from another invocation cannot settle the current call as refused', async () => {
  const deps = dependencies();
  const old = await executeRoutedInference(deps, { mode: 'chat', model: MODEL, messages: [], n: 0 }, {}).catch(error => error);
  const f = await fixture({ deps, execute: async () => { throw old; } });
  expect((await f.post()).status).toBe(400);
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0].state).toBe('unknown');
  expect(run.pendingInferences).toEqual([CALL]);
});

async function expectTimedOutInferenceUnknown(f, status, code) {
  f.deps.fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Synthetic timeout'), { name: 'AbortError' })), { once: true });
  }));
  const response = await f.post();
  expect(response.status).toBe(status);
  expect(response.body.code || response.body.error?.code).toBe(code);
  expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  expect(f.deps.scope.complete).not.toHaveBeenCalled();
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0].state).toBe('unknown');
  expect(run.pendingInferences).toEqual([CALL]);
}

test('Core model deadline preserves unknown after dispatch without a fabricated native completion', async () => {
  const deps = dependencies();
  let budgetSignal;
  const f = await fixture({ modelSeconds: 1, deps, execute: (input, options) => {
    budgetSignal = options.signal;
    // This case tests the real Core budget timer. The separate runtime backup
    // timer uses the same deadline and can otherwise win the race by a tick.
    const { codingDeadlineAt: _backupDeadline, ...budgetOptions } = options;
    return executeRoutedInference(deps, { ...input, timeoutMs: 60000 }, budgetOptions);
  } });
  await expectTimedOutInferenceUnknown(f, 499, 'INFERENCE_CANCELLED');
  expect(budgetSignal.aborted).toBe(true);
  expect(budgetSignal.reason.code).toBe('CODING_MODEL_BUDGET');
});

test('runtime timeout preserves unknown after dispatch without a fabricated native completion', async () => {
  const priorTimeout = process.env.HERMES_OPENAI_TIMEOUT_MS;
  process.env.HERMES_OPENAI_TIMEOUT_MS = '1000';
  try {
    const f = await fixture({ modelSeconds: 3600 });
    await expectTimedOutInferenceUnknown(f, 504, 'INFERENCE_TIMEOUT');
  }
  finally {
    if (priorTimeout === undefined) delete process.env.HERMES_OPENAI_TIMEOUT_MS;
    else process.env.HERMES_OPENAI_TIMEOUT_MS = priorTimeout;
  }
});

test('caller interruption retains unknown even when the original validation refusal was proven before routing', async () => {
  const f = await fixture({ execute: async (input, options) => {
    const error = await executeRoutedInference(dependencies(), { ...input, n: 0 }, options).catch(value => value);
    // The actual request abort controller is exercised by the route below.
    abortRequest();
    throw error;
  } });
  let abortRequest;
  const { EventEmitter } = require('node:events');
  const routes = [];
  const fakeExpress = { Router: () => Object.fromEntries(['get', 'post', 'all'].map(method => [method,
    (path, ...handlers) => routes.push({ path, handlers })])) };
  registerHermesProtocol({ express: fakeExpress, runtimeServices: f.runtime, logger: {} });
  const req = new EventEmitter(); req.headers = f.headers;
  req.body = { model: MODEL, messages: [{ role: 'user', content: 'Synthetic interrupted request' }] };
  abortRequest = () => req.emit('aborted');
  const res = new EventEmitter(); res.status = jest.fn(() => res); res.set = jest.fn(() => res);
  res.json = jest.fn(() => { res.headersSent = true; res.writableEnded = true; return res; });
  await routes.find(route => route.path === '/v1/chat/completions').handlers[0](req, res);
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0].state).toBe('unknown');
  expect(run.pendingInferences).toEqual([CALL]);
  expect(f.runtime.inference.execute).toHaveBeenCalledTimes(1);
});

test.each(['persistence_rejected', 'persistence_ack_lost', 'native_completion_failed'])('real Ollama stream %s closes Hermes safely without a success terminal or inference replay', async kind => {
  const { EventEmitter } = require('node:events');
  const { PassThrough, Readable } = require('node:stream');
  const f = await fixture();
  f.deps.fetch.mockResolvedValue({ ok: true, status: 200, headers: new Map(),
    body: Readable.from(['{"message":{"content":"Synthetic stream"},"done":false}\n', '{"done":true}\n']) });
  if (kind === 'native_completion_failed') f.deps.scope.complete.mockRejectedValue(new Error('Synthetic native completion failure'));
  else interceptSettlement(async commit => {
    if (kind === 'persistence_ack_lost') await commit();
    throw new Error('Synthetic stream persistence failure');
  });
  const routes = [];
  const fakeExpress = { Router: () => Object.fromEntries(['get', 'post', 'all'].map(method => [method,
    (path, ...handlers) => routes.push({ path, handlers })])) };
  registerHermesProtocol({ express: fakeExpress, runtimeServices: f.runtime, logger: {} });
  const req = new EventEmitter(); req.headers = f.headers;
  req.body = { model: MODEL, stream: true, messages: [{ role: 'user', content: 'Synthetic CPU stream' }] };
  const res = new PassThrough(); res.status = () => res; res.set = () => res;
  res.json = value => { throw new Error(JSON.stringify(value)); };
  let output = ''; let error;
  res.on('data', chunk => { output += chunk.toString(); });
  res.on('error', value => { error = value; });
  const closed = new Promise(resolve => res.once('close', resolve));
  await routes.find(route => route.path === '/v1/chat/completions').handlers[0](req, res);
  await closed;
  expect(error.code).toBe(kind === 'native_completion_failed'
    ? 'RUNTIME_INFERENCE_COMPLETION_FAILED' : 'CODING_INFERENCE_SETTLEMENT_UNVERIFIED');
  expect(output).toContain('Synthetic stream');
  expect(output).not.toContain('[DONE]');
  const run = (await durable(f)).codingAutonomy.runs.at(-1);
  expect(run.modelReceipts[0].state).toBe(kind === 'persistence_rejected' ? 'pending' : 'unknown');
  expect(run.pendingInferences).toEqual([CALL]);
  expect(f.runtime.inference.execute).toHaveBeenCalledTimes(1);
  expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  expect(f.deps.scope.complete).toHaveBeenCalledTimes(1);
});

test('near-ceiling request is refused before a model journal, admission or inference dispatch', async () => {
  const f = await fixture({ modelSeconds: 600 });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { 'codingAutonomy.runs.0.currentUsage': { modelSeconds: 481 } } });
  const response = await f.post();
  expect(response.status).toBe(409); expect(response.body.code || response.body.error.code).toBe('CODING_MODEL_RESERVE');
  expect(f.runtime.inference.execute).not.toHaveBeenCalled();
  expect(f.deps.beginInferenceAdmission).not.toHaveBeenCalled(); expect(f.deps.fetch).not.toHaveBeenCalled();
  const run = (await durable(f)).codingAutonomy.runs[0];
  expect(run.modelReceipts || []).toEqual([]); expect(run.pendingInferences).toEqual([]);
});
