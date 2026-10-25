'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');
const { registerOpenClawProtocol } = require('../openclaw/protocol');
const { serveContinuity } = require('../openclaw/conversation-continuity');

class Response extends PassThrough {
  constructor() { super(); this.statusCode = 200; this.headers = {}; this.text = ''; this.on('data', part => { this.text += part; }); }
  status(code) { this.statusCode = code; return this; }
  set(key, value) { if (typeof key === 'object') Object.assign(this.headers, key); else this.headers[key] = value; return this; }
  type(value) { this.headers['Content-Type'] = value; return this; }
  json(value) { this.jsonBody = value; this.end(JSON.stringify(value)); return this; }
}
function request(body = {}, headers = {}) {
  return Object.assign(new EventEmitter(), { body: { model: 'agentx-primary', messages: [{ role: 'user', content: 'bonjour' }], ...body },
    headers: { 'x-agentx-busy-reply': 'conversation', 'x-agentx-continuity': 'conversation', ...headers },
    get(name) { return this.headers[name.toLowerCase()] || ''; } });
}
const primary = () => ({ model: 'main', hostUrl: 'http://127.0.0.1:11434', contextSize: 32768, pinAligned: true });
function services(conversation) {
  return { inference: { conversation, execute: async () => { throw new Error('Strict path unexpected'); } },
    routing: { getEffectiveSnapshot: async () => ({ tasks: { daily_operator: primary() } }) } };
}
function protocol(runtimeServices) {
  const handlers = new Map();
  registerOpenClawProtocol({ runtimeServices, logger: {}, express: { Router: () => ({
    get: (path, fn) => handlers.set(path, fn), post: (path, fn) => handlers.set(path, fn), all() {}
  }) } });
  return path => handlers.get(path);
}

test('only an explicitly opted-in conversation invokes the shared continuity capability', async () => {
  let calls = 0;
  const runtimeServices = services(async () => { calls++; return null; });
  for (const [req, mode] of [[request({}, { 'x-agentx-continuity': '' }), 'chat'],
    [request({}, { 'x-agentx-busy-reply': '' }), 'chat'], [request(), 'embed'],
    [request({ model: 'agentx-pipeline' }), 'chat'], [request({}, { 'x-agentx-benchmark-claims': '[]' }), 'chat']]) {
    assert.equal(await serveContinuity(req, new Response(), { mode, runtimeServices }), false);
  }
  assert.equal(calls, 0);
  assert.equal(await serveContinuity(request(), new Response(), { mode: 'chat', runtimeServices }), false);
  assert.equal(calls, 1);
});

test('the real protocol delegates original text and server-selected target without client context overrides', async () => {
  let seen;
  const runtimeServices = services(async (input, options) => {
    seen = { input, options };
    return { ok: true, status: 200, body: { model: 'small', message: { content: 'Mode limité' }, done: true },
      metadata: { model: 'small', conversationContinuity: { state: 'backup', reason: 'benchmark_claim', limited: true } } };
  });
  const res = new Response();
  await protocol(runtimeServices)('/api/chat')(request({ options: { num_ctx: 999999, temperature: 0.2 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-AgentX-Conversation-State'], 'backup');
  assert.equal(res.headers['X-AgentX-Degraded'], 'true');
  assert.deepEqual(seen.input.options, { temperature: 0.2 });
  assert.equal(seen.options.consumerContract, 'openclaw-runtime-v1');
  assert.deepEqual(seen.input.messages, [{ role: 'user', content: 'bonjour' }]);
});

test('a model-free reply preserves the native stream shape with a terminal frame', async () => {
  const runtimeServices = services(async () => ({ ok: true, status: 200, body: { model: 'agentx-status',
    message: { role: 'assistant', content: 'Travail en cours, durée inconnue.' }, done: true },
    metadata: { model: 'agentx-status', conversationContinuity: { state: 'status_only', reason: 'none_active', limited: true } } }));
  const res = new Response();
  await protocol(runtimeServices)('/api/chat')(request({ stream: true }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.text).done, true);
  assert.match(res.text, /durée inconnue/);
});

test('backup streaming preserves Core terminal settlement and states its limitations first', async () => {
  const stream = new PassThrough();
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  const runtimeServices = services(async () => ({ ok: true, status: 200, stream, completion,
    conversationNotice: 'Mode de secours local', metadata: { model: 'small',
      conversationContinuity: { state: 'backup', reason: 'busy', limited: true } } }));
  const res = new Response();
  await protocol(runtimeServices)('/api/chat')(request({ stream: true }), res);
  stream.write('{"message":{"content":"réponse"},"done":false}\n');
  stream.end('{"done":true}\n');
  await tick();
  assert.match(res.text, /Mode de secours local/);
  assert.doesNotMatch(res.text, /"done":true/);
  const ended = once(res, 'end');
  release({ completed: true });
  await ended;
  assert.match(res.text, /"done":true/);
});

test('plain providers keep the existing principal refusal instead of opting automations into a successful status reply', async () => {
  let calls = 0;
  const runtimeServices = services(async () => { calls++; });
  runtimeServices.routing.getEffectiveSnapshot = async () => ({ tasks: {}, principalTopology: { model: null,
    topology: { reason: 'none_active' } } });
  const res = new Response();
  await protocol(runtimeServices)('/api/chat')(request({}, { 'x-agentx-busy-reply': '', 'x-agentx-continuity': '' }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonBody.code, 'PRINCIPAL_MODEL_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('an uncertain call gets a native 409 with no successful model-free answer or replay', async () => {
  let calls = 0;
  const runtimeServices = services(async () => { calls++; throw Object.assign(new Error('unknown'), { code: 'INFERENCE_TIMEOUT', statusCode: 504 }); });
  const res = new Response();
  await protocol(runtimeServices)('/api/chat')(request(), res);
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonBody.executionState, 'unknown');
  assert.equal(res.jsonBody.code, 'INFERENCE_TIMEOUT');
});

test('the existing server no-thinking policy survives the opt-in transport', async () => {
  let seen;
  const runtimeServices = services(async input => { seen = input; return { ok: true, status: 200, body: { done: true } }; });
  await serveContinuity(request({ think: true }), new Response(), { mode: 'chat', runtimeServices,
    noThinkModels: new Set(['agentx-primary']) });
  assert.equal(seen.think, false);
  await serveContinuity(request({ think: false }, { 'x-agentx-think': 'on' }), new Response(), { mode: 'chat', runtimeServices,
    noThinkModels: new Set(['agentx-primary']) });
  assert.equal(seen.think, true);
});
