'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { executeRoutedInference } = require('../../src/extensions/trustedRuntimeServices');
const { registerOpenClawProtocol } = require('../../integrations/runtime-bridges/openclaw/protocol');
const { handleChat, listModels } = require('../../integrations/runtime-bridges/llm-gateway/chat');
const { buildRuntimeConfigExport } = require('../../integrations/runtime-bridges/runtime-config');

const HOST = 'http://lane.test:11437';
const CLIENT = { consumerContract: 'test-gateway-v1', callerDetail: 'test-gateway', label: 'Test' };

function snapshot(role = 'conversation') {
  const principal = {
    taskType: 'daily_operator', model: 'lane-pin', hostKey: 'lane-a', hostUrl: HOST,
    contextSize: 1200, pinAligned: true,
    hostPreference: { loadedModels: ['lane-pin'], pinnedModels: [{ model: 'lane-pin', contextSize: 1200 }] },
    topology: { role, group: 'test', mode: role === 'pooled' ? 'pooled' : 'lanes', laneContext: 1200 }
  };
  return { generatedAt: '2030-01-01T00:00:00Z', principalTopology: principal,
    tasks: { daily_operator: role === 'pooled' ? { model: null } : principal } };
}

function dependencies(estimatedTokens = 1000) {
  return {
    beginInferenceAdmission: jest.fn(async ({ signal }) => ({ signal, markDispatched() {}, assertActive() {},
      complete: async () => ({ released: true }), abandon: async () => ({ released: true }) })),
    getAdvisoryModelForTask: jest.fn(), getTargetForModel: jest.fn(() => HOST), resolveHostKey: () => 'lane-a',
    validateHostUrl: host => ({ valid: true, host }), assertHostAvailableForConsumer: jest.fn(),
    hostPreferenceService: { getByHost: async () => ({ pinnedModels: [{ model: 'lane-pin', contextSize: 1200, keepAlive: -1 }] }) },
    modelsMatch: (a, b) => a === b,
    resolveInferenceContract: jest.fn(async () => ({ version: 1,
      contextBudget: { windowTokens: 1200, input: { estimatedTokens }, output: { reservedTokens: 200 } } })),
    applyContractOutputLimit: jest.fn(), observePromptPrefix: () => null,
    hostGate: { acquire: async () => () => {}, acquireExclusive: async () => () => {} },
    recordInference: jest.fn(async () => null),
    fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({
      model: 'lane-pin', message: { role: 'assistant', content: 'ok' }, response: 'ok', done: true
    }) }))
  };
}

function response() {
  const res = new PassThrough();
  Object.assign(res, { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    set(key, value) { if (typeof key === 'object') Object.assign(this.headers, key); else this.headers[key] = value; return this; },
    json(body) { this.jsonBody = body; this.end(JSON.stringify(body)); return this; } });
  res.resume();
  return res;
}

function bridge(current, deps) {
  const calls = [];
  const services = {
    routing: { getEffectiveSnapshot: async () => current, hasFallbackLadder: () => true,
      planFallback: jest.fn(async () => { throw new Error('Role aliases must not plan a fallback'); }) },
    inference: { execute: (request, options) => {
      calls.push({ request, options });
      return executeRoutedInference(deps, request, options);
    } }
  };
  const routes = new Map();
  registerOpenClawProtocol({ runtimeServices: services, logger: {}, express: { Router: () => ({
    get: (path, fn) => routes.set(path, fn), post: (path, fn) => routes.set(path, fn), all() {}
  }) } });
  return {
    services, calls,
    async run(transport, body = {}, headers = {}) {
      const req = Object.assign(new EventEmitter(), { headers, get: name => headers[name.toLowerCase()] || '',
        body: { model: 'agentx-primary', messages: [{ role: 'user', content: 'hello' }], prompt: 'hello', ...body } });
      const res = response();
      if (transport === 'OpenAI') await handleChat(req, res, { runtimeServices: services, logger: {}, client: CLIENT, body: req.body });
      else await routes.get(transport === 'OpenClaw generate' ? '/api/generate' : '/api/chat')(req, res);
      return res;
    },
    async discover(path) {
      const res = response();
      await routes.get(path)({}, res);
      return res.jsonBody.models;
    }
  };
}

describe.each(['OpenAI', 'OpenClaw chat', 'OpenClaw generate'])('%s principal alias', transport => {
  it('dispatches an exact fit on the resolved host and records its role', async () => {
    const deps = dependencies();
    const current = snapshot();
    const b = bridge(current, deps);
    const res = await b.run(transport, {}, { 'x-agentx-busy-reply': 'conversation' });
    expect(res.statusCode).toBe(200);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch.mock.calls[0][0]).toMatch(new RegExp(`^${HOST}/api/`));
    expect(deps.beginInferenceAdmission).toHaveBeenCalledTimes(1);
    expect(deps.recordInference).toHaveBeenCalledWith(expect.objectContaining({ routingTrace: expect.objectContaining({
      selected: { routingSource: 'topology_role' }, topology: current.principalTopology.topology
    }) }));
    expect(b.services.routing.planFallback).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses one token over before admission, including stream=%s', async stream => {
    const deps = dependencies(1001);
    const b = bridge(snapshot(), deps);
    const res = await b.run(transport, { stream }, { 'x-agentx-busy-reply': 'conversation' });
    expect(res.statusCode).toBe(413);
    const error = transport === 'OpenAI' ? res.jsonBody.error : res.jsonBody;
    expect(error).toMatchObject({ code: 'LANE_CONTEXT_EXCEEDED', data: {
      estimatedInputTokens: 1001, outputBudget: 200, laneContext: 1200, role: 'conversation', suggestion: 'queue_for_pooled'
    } });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.beginInferenceAdmission).not.toHaveBeenCalled();
    expect(b.services.routing.planFallback).not.toHaveBeenCalled();
  });

  it('uses the pooled endpoint when conversation has no endpoint and suggests reducing pooled overflow', async () => {
    const deps = dependencies();
    const b = bridge(snapshot('pooled'), deps);
    expect((await b.run(transport)).statusCode).toBe(200);
    expect(b.calls[0].request.model).toBe('lane-pin');
    expect(b.calls[0].options.hostUrl).toBe(HOST);
    deps.resolveInferenceContract.mockResolvedValueOnce({ contextBudget: { input: { estimatedTokens: 1001 }, output: { reservedTokens: 200 } } });
    const res = await b.run(transport);
    expect(res.statusCode).toBe(413);
    const error = transport === 'OpenAI' ? res.jsonBody.error : res.jsonBody;
    expect(error.data).toMatchObject({ role: 'pooled', suggestion: 'reduce_input' });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['transitional', 'none_active', 'conflict'])('preserves the unresolved reason %s', async reason => {
    const deps = dependencies();
    const current = snapshot();
    current.principalTopology = { model: null, topology: { role: 'conversation', reason } };
    const b = bridge(current, deps);
    const res = await b.run(transport);
    expect(res.statusCode).toBe(409);
    expect(transport === 'OpenAI' ? res.jsonBody.error : res.jsonBody).toMatchObject({
      code: 'PRINCIPAL_MODEL_UNAVAILABLE', data: { reason }
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('keeps explicit model calls and host-routed aliases outside the role budget policy', async () => {
    const deps = dependencies(1001);
    const b = bridge(snapshot(), deps);
    expect((await b.run(transport, { model: 'lane-pin', topology: { role: 'conversation', laneContext: 1 } })).statusCode).toBe(200);
    expect(b.calls[0].options).not.toHaveProperty('topology');
    const current = snapshot();
    delete current.principalTopology;
    delete current.tasks.daily_operator.topology;
    const hostBridge = bridge(current, deps);
    expect((await hostBridge.run(transport)).statusCode).toBe(200);
    expect(hostBridge.calls[0].options).not.toHaveProperty('topology');
  });
});

it('keeps the pooled principal in both discovery protocols, resident models and runtime exports', async () => {
  const b = bridge(snapshot('pooled'), dependencies());
  const tags = await b.discover('/api/tags');
  expect(tags.map(row => row.name)).toEqual(['lane-pin', 'agentx-primary']);
  expect((await b.discover('/api/ps')).map(row => row.model)).toEqual(['lane-pin']);
  const res = response();
  await listModels(res, { runtimeServices: b.services, client: CLIENT, logger: {} });
  expect(res.jsonBody.data.map(row => row.id)).toEqual(expect.arrayContaining(['lane-pin', 'agentx-primary']));
  const exported = await buildRuntimeConfigExport(b.services, { coreBaseUrl: 'http://core.test:3180' });
  expect(exported.lanes.daily).toMatchObject({ model: 'lane-pin', hostUrl: HOST, contextSize: 1200 });
  expect(exported.openclaw.provider.models[0]).toMatchObject({ id: 'agentx-primary', contextWindow: 1200 });
});

it('settles a coding call refused by the lane budget as not dispatched', async () => {
  const coding = require('../../src/services/pipelineCodingInferenceService');
  const finish = jest.fn(async () => null);
  const prepare = jest.spyOn(coding, 'prepare').mockResolvedValueOnce({ options: {}, finish });
  try {
    const deps = dependencies(1001);
    const res = await bridge(snapshot(), deps).run('OpenAI');
    expect(res.statusCode).toBe(413);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith('refused');
  } finally {
    prepare.mockRestore();
  }
});
