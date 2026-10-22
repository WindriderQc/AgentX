'use strict';

// #897: Core enforces a local native agent cell's turn, tool-call and token
// ceilings before each model call on the OpenClaw bridge. The stub inference
// below stands in for Ollama and records every request that would reach it.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const cellBudgets = require('../../../src/services/benchmarkCellBudget');
const { registerOpenClawProtocol } = require('../openclaw/protocol');

const HOST = 'http://model-host.test:11434';
const CLAIM = { host: HOST, claimBatchId: 'batch', claimGeneration: 'claim', workloadAdmissionId: 'admission', workloadGeneration: 'generation' };

function fakeExpress() {
  return {
    Router() {
      const routes = [];
      const add = method => (path, ...handlers) => routes.push({ method, path, handlers });
      return { routes, use: add('use'), get: add('get'), post: add('post'), patch: add('patch'), all: add('all') };
    }
  };
}

class Request extends EventEmitter {
  constructor({ body = {}, headers = {} } = {}) {
    super();
    this.body = body;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.query = {};
    this.params = {};
    this.socket = { remoteAddress: '127.0.0.1' };
  }
  get(name) { return this.headers[String(name).toLowerCase()] || ''; }
}

class Response extends PassThrough {
  constructor() { super(); this.statusCode = 200; this.headers = {}; this.jsonBody = undefined; }
  status(code) { this.statusCode = code; return this; }
  set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; }
  type(value) { this.headers['Content-Type'] = value; return this; }
  json(value) { this.jsonBody = value; this.end(JSON.stringify(value)); return this; }
}

function snapshot() {
  const task = { taskType: 'daily_operator', model: 'model-a', configuredModel: 'model-a', hostKey: 'primary', hostUrl: HOST,
    contextSize: 32768, contextSource: 'host_preference_pin', keepAlive: -1, pinAligned: true,
    hostPreference: { loadedModel: 'model-a', loadedModels: ['model-a'], pinnedModels: [{ model: 'model-a', contextSize: 32768 }] },
    inferenceContract: { qualification: { qualified: true, state: 'qualified' }, capabilities: { tools: { supported: true } },
      contextBudget: { windowTokens: 32768 }, artifact: { digest: 'sha256:test' } } };
  return { schemaVersion: 1, generatedAt: '2026-10-22T00:00:00.000Z', tasks: { daily_operator: task }, catalog: [] };
}

function bridge(reply, { budgets = cellBudgets } = {}) {
  const requests = [];
  const services = {
    contractVersion: 1,
    routing: { getEffectiveSnapshot: async () => snapshot() },
    inference: { execute: async (request, options) => { requests.push({ request, options }); return reply(request, requests.length); } }
  };
  if (budgets) services.benchmarkCellBudgets = { reserve: budgets.reserve, admitEmbed: budgets.admitEmbed };
  const router = registerOpenClawProtocol({ express: fakeExpress(), runtimeServices: services, logger: {} });
  const call = async (claims, { stream = false, mode = 'chat', body = {} } = {}) => {
    const res = new Response();
    const req = new Request({
      body: { model: 'model-a', stream, messages: [{ role: 'user', content: 'hello' }], options: { num_predict: 64 }, ...body },
      headers: claims === undefined ? {} : { 'x-agentx-benchmark-claims': JSON.stringify(claims) }
    });
    await router.routes.find(entry => entry.method === 'post' && entry.path === `/api/${mode}`).handlers[0](req, res);
    return res;
  };
  return { call, requests };
}

const answer = ({ toolCalls = 0, input = 100, output = 10 } = {}) => () => ({
  ok: true, status: 200, metadata: {},
  body: { model: 'model-a', done: true, prompt_eval_count: input, eval_count: output,
    message: { role: 'assistant', content: 'ok', ...(toolCalls ? { tool_calls: Array.from({ length: toolCalls }, () => ({ function: { name: 'read' } })) } : {}) } }
});

async function openBudget(overrides = {}) {
  return cellBudgets.open({ principal: 'benchmark-service', cellId: 'cell-1', envelopeFingerprint: 'e'.repeat(64),
    targetFingerprint: 't'.repeat(64), claims: [CLAIM], maxTurns: 3, maxToolCalls: 4, maxTokens: 100000, ttlMs: 60000, ...overrides },
  { verifyClaims: async () => {} });
}

const withBudget = budgetId => [{ ...CLAIM, budgetId }];

test.beforeEach(() => cellBudgets.resetForTests());

test('the call after the turn ceiling is refused with 409 and opens no Ollama request', async () => {
  const { budgetId } = await openBudget({ maxTurns: 2 });
  const { call, requests } = bridge(answer());
  assert.equal((await call(withBudget(budgetId))).statusCode, 200);
  assert.equal((await call(withBudget(budgetId))).statusCode, 200);
  const refused = await call(withBudget(budgetId));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.jsonBody.code, 'BENCHMARK_CELL_BUDGET_EXHAUSTED');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].options.benchmarkClaims, withBudget(budgetId));
  const counts = cellBudgets.close(budgetId, { principal: 'benchmark-service' });
  assert.deepEqual({ turns: counts.turns, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens,
    refusedCalls: counts.refusedCalls, exhaustedBy: counts.exhaustedBy },
  { turns: 2, inputTokens: 200, outputTokens: 20, refusedCalls: 1, exhaustedBy: 'turns' });
});

test('the token reservation lowers num_predict, never raises it, and refuses a call that cannot fit', async () => {
  const { budgetId } = await openBudget({ maxTokens: 120 });
  const { call, requests } = bridge(answer({ input: 50, output: 20 }));
  assert.equal((await call(withBudget(budgetId), { body: { options: { num_predict: 4096 } } })).statusCode, 200);
  const sent = requests[0].request.options.num_predict;
  assert.ok(sent > 0 && sent < 120, `num_predict ${sent} must fit the remaining budget`);
  const big = 'x'.repeat(300);
  const refused = await call(withBudget(budgetId), { body: { messages: [{ role: 'user', content: big }] } });
  assert.equal(refused.statusCode, 409);
  assert.equal(requests.length, 1);
  const counts = cellBudgets.close(budgetId, { principal: 'benchmark-service' });
  assert.equal(counts.exhaustedBy, 'tokens');
  assert.equal(counts.numPredictLowered, true);

  const fresh = await openBudget({ maxTokens: 100000 });
  const second = bridge(answer());
  await second.call(withBudget(fresh.budgetId), { body: { options: { num_predict: 32 } } });
  assert.equal(second.requests[0].request.options.num_predict, 32);
});

test('tool calls returned past the ceiling refuse the call that would act on them', async () => {
  const { budgetId } = await openBudget({ maxTurns: 10, maxToolCalls: 2 });
  let turn = 0;
  const { call, requests } = bridge(() => answer({ toolCalls: [2, 1, 0][turn++] ?? 0 })());
  assert.equal((await call(withBudget(budgetId))).statusCode, 200);
  // Exactly at the ceiling: the agent may still answer from those results.
  assert.equal((await call(withBudget(budgetId))).statusCode, 200);
  assert.equal((await call(withBudget(budgetId))).statusCode, 409);
  assert.equal(requests.length, 2);
  const counts = cellBudgets.close(budgetId, { principal: 'benchmark-service' });
  assert.equal(counts.toolCalls, 3);
  assert.equal(counts.exhaustedBy, 'toolCalls');
});

test('missing, forged, foreign, closed and expired budgets are refused before any Ollama request', async () => {
  const own = await openBudget();
  const foreign = await openBudget({ claims: [{ ...CLAIM, claimGeneration: 'other' }] });
  const closed = await openBudget();
  cellBudgets.close(closed.budgetId, { principal: 'benchmark-service' });
  const { call, requests } = bridge(answer());
  const cases = [
    [[CLAIM], 'BENCHMARK_CELL_BUDGET_REQUIRED'],
    [withBudget('f'.repeat(32)), 'BENCHMARK_CELL_BUDGET_INVALID'],
    [withBudget('not-a-budget'), 'BENCHMARK_CELL_BUDGET_REQUIRED'],
    [withBudget(foreign.budgetId), 'BENCHMARK_CELL_BUDGET_INVALID'],
    [[{ ...CLAIM, workloadGeneration: 'stale', budgetId: own.budgetId }], 'BENCHMARK_CELL_BUDGET_INVALID'],
    [[{ ...CLAIM, budgetId: own.budgetId }, { ...CLAIM, host: 'http://other.test:11434', budgetId: foreign.budgetId }], 'BENCHMARK_CELL_BUDGET_REQUIRED'],
    [withBudget(closed.budgetId), 'BENCHMARK_CELL_BUDGET_INVALID']
  ];
  for (const [claims, code] of cases) {
    const res = await call(claims);
    assert.equal(res.statusCode, 409, code);
    assert.equal(res.jsonBody.code, code);
  }
  const expiring = await cellBudgets.open({ principal: 'benchmark-service', cellId: 'cell-2', envelopeFingerprint: 'e', targetFingerprint: 't',
    claims: [CLAIM], maxTurns: 3, maxToolCalls: 1, maxTokens: 1000, ttlMs: 1000 }, { now: Date.now() - 5000, verifyClaims: async () => {} });
  assert.equal((await call(withBudget(expiring.budgetId))).jsonBody.code, 'BENCHMARK_CELL_BUDGET_INVALID');
  assert.equal(requests.length, 0);
  // An ordinary call without benchmark claims is unaffected.
  assert.equal((await call(undefined)).statusCode, 200);
  assert.equal(requests.length, 1);
});

test('a Core without cell budgets refuses benchmark claims on the bridge', async () => {
  const { budgetId } = await openBudget();
  const { call, requests } = bridge(answer(), { budgets: null });
  const res = await call(withBudget(budgetId));
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonBody.code, 'BENCHMARK_CELL_BUDGET_UNAVAILABLE');
  assert.equal(requests.length, 0);
});

test('a second concurrent call of one cell is refused while the first is in flight', async () => {
  const { budgetId } = await openBudget();
  let release;
  const { call, requests } = bridge(() => new Promise(resolve => { release = () => resolve(answer()()); }));
  const first = call(withBudget(budgetId));
  await new Promise(resolve => setImmediate(resolve));
  const second = await call(withBudget(budgetId));
  assert.equal(second.statusCode, 409);
  assert.equal(second.jsonBody.code, 'BENCHMARK_CELL_BUDGET_CONCURRENT');
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal(requests.length, 1);
  assert.equal(cellBudgets.close(budgetId, { principal: 'benchmark-service' }).turns, 1);
});

test('a stream settles from its terminal frame and counts streamed tool calls; a broken stream keeps its reservation', async () => {
  const { budgetId } = await openBudget({ maxTurns: 5 });
  const upstreams = [];
  const { call } = bridge(() => {
    const stream = new PassThrough();
    upstreams.push(stream);
    return { ok: true, status: 200, stream, metadata: {} };
  });
  const res = await call(withBudget(budgetId), { stream: true });
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk.toString('utf8')));
  upstreams[0].write('{"message":{"content":"","tool_calls":[{"function":{"name":"read"}}]},"done":false}\n');
  upstreams[0].end('{"done":true,"prompt_eval_count":40,"eval_count":7}\n');
  await new Promise(resolve => res.once('finish', resolve));
  assert.match(chunks.join(''), /"done":true/);

  const broken = await call(withBudget(budgetId), { stream: true });
  broken.on('error', () => {});
  upstreams[1].write('{"message":{"content":"partial"},"done":false}\n');
  upstreams[1].destroy(new Error('connection reset'));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const counts = cellBudgets.close(budgetId, { principal: 'benchmark-service' });
  assert.equal(counts.turns, 2);
  assert.equal(counts.toolCalls, 1);
  assert.equal(counts.unsettledTurns, 1);
  assert.ok(counts.inputTokens > 40 && counts.outputTokens > 7, 'the broken call keeps its whole reservation');
  assert.equal(counts.inFlight, false);
});

test('an embedding call needs an open budget but is not a model turn', async () => {
  const { budgetId } = await openBudget();
  const { call, requests } = bridge(() => ({ ok: true, status: 200, metadata: {}, body: { embeddings: [[0.1]] } }));
  assert.equal((await call([CLAIM], { mode: 'embed', body: { input: 'x' } })).statusCode, 409);
  assert.equal((await call(withBudget(budgetId), { mode: 'embed', body: { input: 'x' } })).statusCode, 200);
  assert.equal(requests.length, 1);
  const counts = cellBudgets.close(budgetId, { principal: 'benchmark-service' });
  assert.equal(counts.turns, 0);
  assert.equal(counts.embedCalls, 1);
});

test('budgets open only on exact active claims, and close only for their opener', async () => {
  await assert.rejects(cellBudgets.open({ principal: 'benchmark-service', cellId: 'c', envelopeFingerprint: 'e', targetFingerprint: 't',
    claims: [CLAIM], maxTurns: 0, maxToolCalls: 0, maxTokens: 1, ttlMs: 60000 }, { verifyClaims: async () => {} }), /maxTurns/);
  await assert.rejects(cellBudgets.open({ principal: 'benchmark-service', cellId: 'c', envelopeFingerprint: 'e', targetFingerprint: 't',
    claims: [], maxTurns: 1, maxToolCalls: 0, maxTokens: 1, ttlMs: 60000 }, { verifyClaims: async () => {} }), /claims/);
  await assert.rejects(openBudget().then(() => cellBudgets.open({ principal: 'benchmark-service', cellId: 'c', envelopeFingerprint: 'e',
    targetFingerprint: 't', claims: [CLAIM], maxTurns: 1, maxToolCalls: 0, maxTokens: 1, ttlMs: 60000 },
  { verifyClaims: async () => { throw new cellBudgets.CellBudgetError('BENCHMARK_CELL_BUDGET_CLAIM_INACTIVE', 'inactive'); } })), /inactive/);
  const { budgetId } = await openBudget();
  assert.throws(() => cellBudgets.close(budgetId, { principal: 'operator' }), /No such cell budget/);
  assert.equal(cellBudgets.close(budgetId, { principal: 'benchmark-service' }).budgetId, budgetId);
});
