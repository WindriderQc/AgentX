'use strict';

// #143: the OpenClaw conversation provider degrades to the always-on brain.
const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const test = require('node:test');

const { registerOpenClawProtocol } = require('../openclaw/protocol');
const { FALLBACK_TASK_ENV, degradeRequest } = require('../openclaw/conversation-fallback');

const PRIMARY = 'qwen3.8:27b';
const LIGHT = 'gemma4:12b-it-qat';
const ROUTING = Object.freeze({
  degraded: true, reason: 'primary_busy',
  fallbackFrom: { model: PRIMARY, host: 'primary' }, fallbackTo: { model: LIGHT, host: 'tertiary' }
});
const PLAN = Object.freeze({ model: LIGHT, hostUrl: 'http://tertiary.test:11434', hostKey: 'tertiary', routing: ROUTING });

function fakeExpress() {
  return { Router() {
    const routes = [];
    const add = method => (path, ...handlers) => routes.push({ method, path, handlers });
    return { routes, use: add('use'), get: add('get'), post: add('post'), all: add('all') };
  } };
}

class Request extends EventEmitter {
  constructor({ body = {}, headers = {} } = {}) {
    super();
    this.body = body;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  }
  get(name) { return this.headers[String(name).toLowerCase()] || ''; }
}

class Response extends PassThrough {
  constructor() { super(); this.statusCode = 200; this.headers = {}; this.jsonBody = undefined; }
  status(code) { this.statusCode = code; return this; }
  set(name, value) { this.headers[name] = value; return this; }
  type(value) { this.headers['Content-Type'] = value; return this; }
  json(value) { this.jsonBody = value; this.end(JSON.stringify(value)); return this; }
}

function snapshot() {
  const task = { taskType: 'daily_operator', model: PRIMARY, configuredModel: PRIMARY, contextSize: 65536,
    inferenceContract: { capabilities: { tools: { supported: true } } } };
  return { generatedAt: '2026-09-27T00:00:00.000Z', tasks: { daily_operator: task } };
}

const conflict = (message = 'Host is busy.') => Object.assign(new Error(message), {
  code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503,
  failure: { cause: 'admission_conflict_unclassified', holder: { type: 'inference', model: 'other-model' } }
});
const answer = content => ({ ok: true, status: 200, metadata: { model: LIGHT },
  body: { model: LIGHT, message: { role: 'assistant', content }, done: true } });

// `steps` answers successive execute calls; `plans` answers planFallback calls.
function harness({ steps, plans = [], resolveConversationTarget } = {}) {
  const calls = [];
  const planned = [];
  const runtimeServices = {
    contractVersion: 1,
    routing: {
      getEffectiveSnapshot: async () => snapshot(),
      planFallback: async (request) => {
        planned.push(request);
        const next = plans.shift();
        return typeof next === 'function' ? next(request) : next ?? null;
      }
    },
    inference: { execute: async (request, options) => {
      calls.push({ request, options });
      const step = steps.shift();
      return typeof step === 'function' ? step(request, options) : step;
    } }
  };
  const router = registerOpenClawProtocol({ express: fakeExpress(), runtimeServices, logger: {}, resolveConversationTarget });
  const handler = router.routes.find(entry => entry.method === 'post' && entry.path === '/api/chat').handlers[0];
  return { calls, planned, handler };
}

const conversation = { 'x-agentx-busy-reply': 'conversation' };
const body = (extra = {}) => ({ model: PRIMARY, stream: false, think: true,
  tools: [{ type: 'function', function: { name: 'memory_search' } }],
  messages: [{ role: 'system', content: 'Tu es Nestor.' }, { role: 'user', content: 'Salut' }], ...extra });

async function send(handler, { headers = conversation, payload = body() } = {}) {
  const res = new Response();
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  await handler(new Request({ body: payload, headers }), res);
  await new Promise(resolve => (res.writableEnded ? setImmediate(resolve) : res.once('finish', resolve)));
  res.text = Buffer.concat(chunks).toString();
  return res;
}

test.beforeEach(() => { process.env[FALLBACK_TASK_ENV] = 'nestor_answer_light'; });
test.after(() => { delete process.env[FALLBACK_TASK_ENV]; });

test('an available primary answers unchanged, with a shorter yield wait', async () => {
  const { calls, planned, handler } = harness({ steps: [answer('primary')] });
  const res = await send(handler);
  assert.equal(res.jsonBody.message.content, 'primary');
  assert.equal(res.headers['X-AgentX-Degraded'], undefined);
  assert.deepEqual(planned, [{ model: PRIMARY, taskType: 'nestor_answer_light', afterRefusal: false }]);
  assert.deepEqual(calls[0].options.retry, { interactive: true, interactiveWaitMs: 30000 });
  assert.equal(calls[0].request.model, PRIMARY);
  assert.equal(calls[0].request.tools.length, 1);
});

test('a busy primary sends the turn to the always-on brain, marked and without tools', async () => {
  const { calls, handler } = harness({ steps: [answer('Bonjour')], plans: [PLAN] });
  const res = await send(handler);
  assert.equal(calls.length, 1);
  const { request, options } = calls[0];
  assert.equal(request.model, LIGHT);
  assert.equal(options.hostUrl, PLAN.hostUrl);
  assert.deepEqual(options.degraded, ROUTING);
  assert.equal(request.tools, undefined);
  assert.equal(request.think, false);
  assert.equal(request.exclusiveHost, false);
  assert.equal(request.messages.length, 2);
  assert.match(request.messages[0].content, /^Tu es Nestor\.\n\nContexte AgentX : ce tour est servi par le cerveau léger gemma4:12b-it-qat/);
  assert.match(request.messages[0].content, /qwen3\.8:27b est occupé par une autre requête/);
  assert.equal(res.headers['X-AgentX-Degraded'], 'true');
  assert.equal(res.headers['X-AgentX-Degraded-Reason'], 'primary_busy');
  assert.equal(res.headers['X-AgentX-Degraded-Primary-Model'], PRIMARY);
  assert.equal(res.headers['X-AgentX-Degraded-Actual-Model'], LIGHT);
  assert.equal(res.jsonBody.model, LIGHT);
  assert.match(res.jsonBody.message.content, /^🪶 Cerveau léger \(gemma4:12b-it-qat\) : le cerveau principal est occupé par une autre requête\.\n\nBonjour$/);
});

test('a degraded stream starts with the notice frame, then the model frames', async () => {
  const stream = new PassThrough();
  const { handler } = harness({ plans: [PLAN], steps: [() => {
    setImmediate(() => {
      stream.write(`${JSON.stringify({ model: LIGHT, message: { role: 'assistant', content: 'Oui' }, done: false })}\n`);
      stream.end(`${JSON.stringify({ model: LIGHT, message: { role: 'assistant', content: '' }, done: true })}\n`);
    });
    return { ok: true, status: 200, stream, completion: Promise.resolve({}), metadata: { model: LIGHT } };
  }] });
  const res = await send(handler, { payload: body({ stream: true }) });
  const frames = res.text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.length, 3);
  assert.match(frames[0].message.content, /^🪶 Cerveau léger/);
  assert.equal(frames[0].model, LIGHT);
  assert.deepEqual(frames.map(frame => frame.done), [false, false, true]);
});

const benchmarkRefusal = () => Object.assign(new Error('Host is reserved.'), {
  code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503,
  failure: { cause: 'workload_reserved', holder: { type: 'workload', kind: 'benchmark', principal: 'benchmark-service' } }
});
const unreachable = () => Object.assign(new Error('Routed inference failed.'), {
  code: 'INFERENCE_UPSTREAM_UNAVAILABLE', statusCode: 502, cause: { ollamaRequestNotSent: true } });

test('a primary refused before output degrades once and the notice keeps the real cause', async () => {
  for (const [refusal, reason, label] of [
    [conflict(), 'primary_busy', 'occupé par une autre requête'],
    [benchmarkRefusal(), 'benchmark_claim', 'réservé par une campagne benchmark'],
    [unreachable(), 'host_down', 'injoignable']
  ]) {
    // Like Core, the late plan names the reason the bridge observed.
    const late = request => ({ ...PLAN, routing: { ...ROUTING, reason: request.refusalReason } });
    const { calls, planned, handler } = harness({ plans: [null, late], steps: [() => { throw refusal; }, answer('Me voici')] });
    const res = await send(handler);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].request.model, LIGHT);
    assert.equal(calls[1].options.degraded.reason, reason);
    assert.deepEqual(planned.map(item => [item.afterRefusal, item.refusalReason]), [[false, undefined], [true, reason]]);
    assert.equal(res.headers['X-AgentX-Degraded-Reason'], reason);
    assert.equal(res.jsonBody.message.content, `🪶 Cerveau léger (${LIGHT}) : le cerveau principal est ${label}.\n\nMe voici`);
    assert.match(calls[1].request.messages[0].content, new RegExp(`${PRIMARY.replace('.', '\\.')} est ${label}`));
  }
});

test('when both brains refuse, the busy reply names why the primary could not answer', async () => {
  const rungBusy = () => { throw Object.assign(new Error('rung busy'), { code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 503 }); };
  const down = harness({ plans: [null, PLAN], steps: [() => { throw unreachable(); }, rungBusy] });
  const downRes = await send(down.handler);
  assert.equal(downRes.headers['x-agentx-inference-outcome'], 'host-busy');
  assert.match(downRes.jsonBody.message.content,
    /le cerveau principal est injoignable et le cerveau léger ne répond pas non plus\. Rien n'est envoyé vers le cloud/);
  assert.doesNotMatch(downRes.jsonBody.message.content, /http|tertiary|campagne/);

  const planned = harness({ plans: [PLAN], steps: [rungBusy] });
  const plannedRes = await send(planned.handler);
  assert.match(plannedRes.jsonBody.message.content, /le cerveau principal est occupé par une autre requête et le cerveau léger/);
});

test('without an available fallback the conversation keeps the busy reply', async () => {
  const { calls, handler } = harness({ plans: [null, null], steps: [() => { throw conflict(); }] });
  const res = await send(handler);
  assert.equal(calls.length, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-agentx-inference-outcome'], 'host-busy');
  assert.match(res.jsonBody.message.content, /occupé par un autre modèle \(other-model\)/);
});

test('a fallback rung that refuses too yields the primary busy reply', async () => {
  const { calls, handler } = harness({ plans: [null, PLAN], steps: [() => { throw conflict(); }, () => {
    throw Object.assign(new Error('rung busy'), { code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 503 });
  }] });
  const res = await send(handler);
  assert.equal(calls.length, 2);
  assert.equal(res.headers['x-agentx-inference-outcome'], 'host-busy');
  assert.match(res.jsonBody.message.content, /other-model/);
});

test('a pre-planned rung that cannot be reached gives the busy reply, not a transport error', async () => {
  const { handler } = harness({ plans: [PLAN], steps: [() => {
    throw Object.assign(new Error('Routed inference failed.'), { code: 'INFERENCE_UPSTREAM_UNAVAILABLE', statusCode: 502,
      cause: { ollamaRequestNotSent: true } });
  }] });
  const res = await send(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-agentx-inference-outcome'], 'host-busy');
  assert.match(res.jsonBody.message.content, /cerveau principal est occupé par une autre requête/);
});

test('cron turns and unconfigured instances stay strict', async () => {
  const cron = harness({ plans: [PLAN], steps: [() => { throw conflict(); }] });
  const strict = await send(cron.handler, { headers: {} });
  assert.equal(strict.statusCode, 409);
  assert.equal(cron.planned.length, 0);
  assert.equal(cron.calls[0].options.retry, undefined);

  delete process.env[FALLBACK_TASK_ENV];
  const off = harness({ plans: [PLAN], steps: [() => { throw conflict(); }] });
  const busy = await send(off.handler);
  assert.equal(busy.headers['x-agentx-inference-outcome'], 'host-busy');
  assert.equal(off.planned.length, 0);
  assert.deepEqual(off.calls[0].options.retry, { interactive: true, interactiveWaitMs: 45000 });
});

test('a model already served by a configured conversation host never degrades', async () => {
  const target = { model: LIGHT, hostUrl: 'http://tertiary.test:11434', exclusiveHost: false };
  const { planned, handler } = harness({ plans: [PLAN], steps: [answer('brutal')],
    resolveConversationTarget: async model => (model === LIGHT ? target : null) });
  const res = await send(handler, { payload: body({ model: LIGHT }) });
  assert.equal(res.jsonBody.message.content, 'brutal');
  assert.equal(planned.length, 0);
});

test('a cancelled turn or an outcome unknown after dispatch is never replayed on the fallback', async () => {
  const unknown = harness({ plans: [null, PLAN], steps: [() => {
    throw Object.assign(new Error('Routed inference failed.'), { code: 'INFERENCE_UPSTREAM_UNAVAILABLE', statusCode: 502 });
  }] });
  const res = await send(unknown.handler);
  assert.equal(res.statusCode, 502);
  assert.equal(unknown.calls.length, 1);
  assert.equal(unknown.planned.length, 1);

  let request;
  const cancelled = harness({ plans: [null, PLAN], steps: [() => { request.emit('aborted'); throw conflict(); }] });
  request = new Request({ body: body(), headers: conversation });
  await cancelled.handler(request, new Response());
  assert.equal(cancelled.calls.length, 1);
  assert.equal(cancelled.planned.length, 1);
});

test('a partial primary stream that fails is not replayed on the fallback', async () => {
  const stream = new PassThrough();
  const { calls, planned, handler } = harness({ plans: [null, PLAN], steps: [() => {
    setImmediate(() => {
      stream.write(`${JSON.stringify({ model: PRIMARY, message: { role: 'assistant', content: 'Déb' }, done: false })}\n`);
      setImmediate(() => stream.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
    });
    return { ok: true, status: 200, stream, completion: Promise.resolve({}), metadata: { model: PRIMARY } };
  }] });
  const res = new Response();
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('error', () => {}); // the bridge destroys the response with the stream error
  const closed = new Promise(resolve => res.once('close', resolve));
  await handler(new Request({ body: body({ stream: true }), headers: conversation }), res);
  await closed;
  assert.match(Buffer.concat(chunks).toString(), /Déb/);
  assert.equal(calls.length, 1);
  assert.equal(planned.length, 1);
});

test('generate turns carry the brain context in the system prompt', () => {
  const degraded = degradeRequest({ mode: 'generate', model: PRIMARY, prompt: 'x', system: 'Base', tools: [] }, PLAN);
  assert.match(degraded.system, /^Contexte AgentX .*\n\nBase$/s);
  assert.equal(degraded.tools, undefined);
  const bare = degradeRequest({ mode: 'chat', model: PRIMARY, messages: [{ role: 'user', content: 'x' }] }, PLAN);
  assert.equal(bare.messages[0].role, 'system');
  assert.equal(bare.messages.length, 2);
});
